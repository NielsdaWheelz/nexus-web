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
- Media readability is via library membership (any role)
"""

from uuid import UUID

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from nexus.db.models import LibraryMedia, Membership


def can_read_media(session: Session, viewer_user_id: UUID, media_id: UUID) -> bool:
    """Check if viewer can read a media item.

    True iff media_id appears in at least one library where viewer_user_id is a member.
    Role does not matter ('member' or 'admin' both count).

    Returns False if media_id does not exist (no existence leak).

    Args:
        session: Database session.
        viewer_user_id: The ID of the viewer.
        media_id: The ID of the media.

    Returns:
        True if viewer can read the media, False otherwise.
    """
    # Check if there exists a library_media row joined with a membership
    # where the user is a member (any role)
    query = select(
        exists().where(
            LibraryMedia.media_id == media_id,
            LibraryMedia.library_id == Membership.library_id,
            Membership.user_id == viewer_user_id,
        )
    )
    result = session.execute(query)
    return bool(result.scalar())


def can_read_media_bulk(
    session: Session,
    viewer_user_id: UUID,
    media_ids: list[UUID],
) -> dict[UUID, bool]:
    """Check if viewer can read multiple media items.

    Returns a dict containing ALL input ids as keys.
    For any media_id not readable (or non-existent), value is False.

    Implementation constraint: executes exactly ONE SELECT query.
    Empty list input: return {} without executing any query.

    Args:
        session: Database session.
        viewer_user_id: The ID of the viewer.
        media_ids: List of media IDs to check.

    Returns:
        Dict mapping each media_id to True (readable) or False (not readable).
    """
    if not media_ids:
        return {}

    # Query for all readable media IDs in one query
    query = (
        select(LibraryMedia.media_id)
        .distinct()
        .join(Membership, LibraryMedia.library_id == Membership.library_id)
        .where(
            LibraryMedia.media_id.in_(media_ids),
            Membership.user_id == viewer_user_id,
        )
    )
    result = session.execute(query)
    readable_ids = {row[0] for row in result.fetchall()}

    # Return dict with all input IDs, marking readable ones as True
    return {media_id: media_id in readable_ids for media_id in media_ids}


def is_library_admin(session: Session, viewer_user_id: UUID, library_id: UUID) -> bool:
    """Check if viewer is an admin of a library.

    True iff viewer_user_id is a member of library_id with role == 'admin'.

    Returns False if library_id does not exist.

    Args:
        session: Database session.
        viewer_user_id: The ID of the viewer.
        library_id: The ID of the library.

    Returns:
        True if viewer is admin of the library, False otherwise.
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

    Args:
        session: Database session.
        viewer_user_id: The ID of the viewer.
        media_id: The ID of the media.

    Returns:
        True if viewer is admin of any library containing the media.
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
    """Check if viewer is a member of a library (any role).

    Args:
        session: Database session.
        viewer_user_id: The ID of the viewer.
        library_id: The ID of the library.

    Returns:
        True if viewer is a member of the library, False otherwise.
    """
    query = select(
        exists().where(
            Membership.library_id == library_id,
            Membership.user_id == viewer_user_id,
        )
    )
    result = session.execute(query)
    return bool(result.scalar())
