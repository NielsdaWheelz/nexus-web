"""Authorization predicates for visibility and access control.

These predicates are the single source of truth for all visibility logic.
They are used by routes and services to enforce access control consistently.

All functions:
- Accept an explicit SQLAlchemy Session
- Return booleans or mappings only (no HTTP exceptions)
- Must not leak existence: "not found" and "not visible" both return False

Query Semantics:
- Membership role values: 'admin', 'member' (lowercase strings, not enums)
- LibraryMedia is the join table between libraries and media
- Media readability is via s4 provenance: non-default membership, intrinsic, or active closure edge

S4 Provenance Rules (can_read_media):
- Non-default path: exists non-default library L with viewer membership and library_media(L, media)
- Default intrinsic path: viewer owns default library D, row in default_library_intrinsics(D, media)
- Default closure path: viewer owns default library D, closure edge (D, media, source_L), viewer member of source_L
- Raw (default_library_id, media_id) in library_media is NOT sufficient without provenance

S4 Conversation Visibility (can_read_conversation):
- Viewer is owner, OR
- Conversation is public, OR
- Conversation is library-shared and both viewer+owner are members of a share-target library

S4 Highlight Visibility (can_read_highlight):
- Viewer can read anchor media (via can_read_media), AND
- Exists a library containing that media where both viewer and highlight author are members
"""

from uuid import UUID

from sqlalchemy import exists, literal, select, union_all
from sqlalchemy.orm import Session

from nexus.db.models import (
    Conversation,
    ConversationShare,
    DefaultLibraryClosureEdge,
    DefaultLibraryIntrinsic,
    Highlight,
    Library,
    LibraryMedia,
    Membership,
)


def can_read_media(session: Session, viewer_user_id: UUID, media_id: UUID) -> bool:
    """Check if viewer can read a media item under s4 provenance rules.

    True iff any of:
    1. Non-default path: exists non-default library L where viewer is member and media is in L
    2. Default intrinsic path: viewer owns default library D and (D, media) is in default_library_intrinsics
    3. Default closure path: viewer owns default library D, closure edge (D, media, source_L) exists,
       and viewer currently has membership in source_L

    Returns False if media_id does not exist (no existence leak).
    """
    # Path 1: non-default library membership
    non_default = exists().where(
        LibraryMedia.media_id == media_id,
        LibraryMedia.library_id == Membership.library_id,
        Membership.user_id == viewer_user_id,
        LibraryMedia.library_id == Library.id,
        Library.is_default == False,  # noqa: E712
    )

    # Path 2: default intrinsic
    default_intrinsic = exists().where(
        DefaultLibraryIntrinsic.media_id == media_id,
        DefaultLibraryIntrinsic.default_library_id == Library.id,
        Library.owner_user_id == viewer_user_id,
        Library.is_default == True,  # noqa: E712
    )

    # Path 3: default closure edge with active source membership
    default_closure = exists().where(
        DefaultLibraryClosureEdge.media_id == media_id,
        DefaultLibraryClosureEdge.default_library_id == Library.id,
        Library.owner_user_id == viewer_user_id,
        Library.is_default == True,  # noqa: E712
        DefaultLibraryClosureEdge.source_library_id == Membership.library_id,
        Membership.user_id == viewer_user_id,
    )

    query = select(non_default | default_intrinsic | default_closure)
    result = session.execute(query)
    return bool(result.scalar())


def can_read_media_bulk(
    session: Session,
    viewer_user_id: UUID,
    media_ids: list[UUID],
) -> dict[UUID, bool]:
    """Check if viewer can read multiple media items under s4 provenance rules.

    Returns a dict containing ALL input ids as keys.
    For any media_id not readable (or non-existent), value is False.

    Implementation constraint: executes exactly ONE SELECT query.
    Empty list input: return {} without executing any query.
    """
    if not media_ids:
        return {}

    # Path 1: non-default library membership
    non_default_q = (
        select(LibraryMedia.media_id)
        .join(Membership, LibraryMedia.library_id == Membership.library_id)
        .join(Library, LibraryMedia.library_id == Library.id)
        .where(
            LibraryMedia.media_id.in_(media_ids),
            Membership.user_id == viewer_user_id,
            Library.is_default == False,  # noqa: E712
        )
    )

    # Path 2: default intrinsic
    intrinsic_q = (
        select(DefaultLibraryIntrinsic.media_id)
        .join(Library, DefaultLibraryIntrinsic.default_library_id == Library.id)
        .where(
            DefaultLibraryIntrinsic.media_id.in_(media_ids),
            Library.owner_user_id == viewer_user_id,
            Library.is_default == True,  # noqa: E712
        )
    )

    # Path 3: default closure edge with active source membership
    closure_q = (
        select(DefaultLibraryClosureEdge.media_id)
        .join(Library, DefaultLibraryClosureEdge.default_library_id == Library.id)
        .join(Membership, DefaultLibraryClosureEdge.source_library_id == Membership.library_id)
        .where(
            DefaultLibraryClosureEdge.media_id.in_(media_ids),
            Library.owner_user_id == viewer_user_id,
            Library.is_default == True,  # noqa: E712
            Membership.user_id == viewer_user_id,
        )
    )

    # Union all three paths and get distinct readable ids
    combined = union_all(non_default_q, intrinsic_q, closure_q).subquery()
    query = select(combined.c.media_id).distinct()

    result = session.execute(query)
    readable_ids = {row[0] for row in result.fetchall()}

    return {mid: mid in readable_ids for mid in media_ids}


def can_read_conversation(session: Session, viewer_user_id: UUID, conversation_id: UUID) -> bool:
    """Check if viewer can read a conversation under s4 visibility rules.

    True iff:
    - Viewer is the conversation owner, OR
    - Conversation sharing is 'public', OR
    - Conversation sharing is 'library' and exists a share-target library
      where both viewer and owner are current members.

    Returns False if conversation_id does not exist (no existence leak).
    """
    # Path 1: owner
    owner_path = exists().where(
        Conversation.id == conversation_id,
        Conversation.owner_user_id == viewer_user_id,
    )

    # Path 2: public
    public_path = exists().where(
        Conversation.id == conversation_id,
        Conversation.sharing == "public",
    )

    # Path 3: library-shared with active dual membership
    # Use aliased approach to check both viewer and owner membership in the same library
    viewer_membership = Membership.__table__.alias("viewer_m")
    owner_membership = Membership.__table__.alias("owner_m")

    library_path = (
        select(literal(1))
        .select_from(Conversation.__table__)
        .join(
            ConversationShare.__table__,
            ConversationShare.__table__.c.conversation_id == Conversation.__table__.c.id,
        )
        .join(
            viewer_membership,
            viewer_membership.c.library_id == ConversationShare.__table__.c.library_id,
        )
        .join(
            owner_membership,
            (owner_membership.c.library_id == ConversationShare.__table__.c.library_id)
            & (owner_membership.c.user_id == Conversation.__table__.c.owner_user_id),
        )
        .where(
            Conversation.__table__.c.id == conversation_id,
            Conversation.__table__.c.sharing == "library",
            viewer_membership.c.user_id == viewer_user_id,
        )
        .exists()
    )

    query = select(owner_path | public_path | library_path)
    result = session.execute(query)
    return bool(result.scalar())


def can_read_highlight(session: Session, viewer_user_id: UUID, highlight_id: UUID) -> bool:
    """Check if viewer can read a highlight under s4 visibility rules.

    True iff:
    - Viewer can read the anchor media (via can_read_media), AND
    - Exists a library containing that media where both viewer and highlight author are members.

    Returns False if highlight_id does not exist (no existence leak).
    """
    # Load highlight to get author and fragment->media chain
    highlight = session.get(Highlight, highlight_id)
    if highlight is None:
        return False

    author_id = highlight.user_id
    media_id = highlight.fragment.media_id

    # Check 1: viewer can read the anchor media
    if not can_read_media(session, viewer_user_id, media_id):
        return False

    # Check 2: exists a library containing media where both viewer and author are members
    viewer_m = Membership.__table__.alias("viewer_m")
    author_m = Membership.__table__.alias("author_m")

    intersection_q = (
        select(literal(1))
        .select_from(LibraryMedia.__table__)
        .join(viewer_m, viewer_m.c.library_id == LibraryMedia.__table__.c.library_id)
        .join(
            author_m,
            (author_m.c.library_id == LibraryMedia.__table__.c.library_id)
            & (author_m.c.user_id == author_id),
        )
        .where(
            LibraryMedia.__table__.c.media_id == media_id,
            viewer_m.c.user_id == viewer_user_id,
        )
        .exists()
    )

    result = session.execute(select(intersection_q))
    return bool(result.scalar())


def is_library_admin(session: Session, viewer_user_id: UUID, library_id: UUID) -> bool:
    """Check if viewer is an admin of a library.

    True iff viewer_user_id is a member of library_id with role == 'admin'.
    Returns False if library_id does not exist.
    """
    query = select(
        exists().where(
            Membership.library_id == library_id,
            Membership.user_id == viewer_user_id,
            Membership.role == "admin",
        )
    )
    result = session.execute(query)
    return bool(result.scalar())


def is_admin_of_any_containing_library(
    session: Session, viewer_user_id: UUID, media_id: UUID
) -> bool:
    """Check if viewer is admin of any library containing the media.

    True iff there exists a library L such that:
    - (L contains media_id via LibraryMedia) AND
    - viewer_user_id has Membership in L with role == 'admin'.

    Returns False if media_id does not exist.
    """
    query = select(
        exists().where(
            LibraryMedia.media_id == media_id,
            LibraryMedia.library_id == Membership.library_id,
            Membership.user_id == viewer_user_id,
            Membership.role == "admin",
        )
    )
    result = session.execute(query)
    return bool(result.scalar())


def is_library_member(session: Session, viewer_user_id: UUID, library_id: UUID) -> bool:
    """Check if viewer is a member of a library (any role)."""
    query = select(
        exists().where(
            Membership.library_id == library_id,
            Membership.user_id == viewer_user_id,
        )
    )
    result = session.execute(query)
    return bool(result.scalar())
