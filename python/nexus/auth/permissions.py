"""Authorization predicates for visibility and access control.

These predicates are the single source of truth for all visibility logic.
They are used by routes and services to enforce access control consistently.

All functions:
- Accept an explicit SQLAlchemy Session
- Return booleans or mappings only (no HTTP exceptions)
- Must not leak existence: "not found" and "not visible" both return False

Query Semantics:
- Membership role values: 'admin', 'member' (lowercase strings, not enums)
- LibraryEntry rows with non-null media_id connect libraries and media

Media Readability Rule (can_read_media / visible_media_ids_cte_sql):
- A media item is readable iff the viewer has a membership path or an incoming
  or creator grant path to that media (including an exact child-highlight
  grant), AND the viewer has no user_media_deletions tombstone for it, AND no
  media_teardown_intents row is armed for it.
- This is the sole authorization/global-readable relation. It is broader
  than "My Library": services/library_entries.py:library_media_ids_cte_sql()
  layers the personal-Default/non-default-library distinction on top of it.

Conversation Visibility (can_read_conversation):
- Viewer is owner, OR
- Conversation is public, OR
- Conversation is library-shared and both viewer+owner are members of a share-target library

Highlight Visibility (can_read_highlight):
- Viewer can read anchor media (via can_read_media), AND
- Viewer is its author, shares a library containing the media with its author,
  or has an incoming or creator grant on that exact highlight
"""

from uuid import UUID

from sqlalchemy import exists, literal, or_, select
from sqlalchemy.orm import InstrumentedAttribute, Session

from nexus.db.models import (
    Conversation,
    ConversationShare,
    Fragment,
    Highlight,
    HighlightFragmentAnchor,
    HighlightPdfAnchor,
    LibraryEntry,
    Media,
    MediaTeardownIntent,
    Membership,
    UserMediaDeletion,
)
from nexus.services import resource_grants


def _media_membership_path_exists(
    viewer_user_id: UUID,
    media_id: UUID | InstrumentedAttribute[UUID],
):
    """Core exists() expression: a current membership reaches a physical
    library_entries row for this media in any library the viewer belongs to
    (default, non-default, or system — no is_default distinction). Shared by
    :func:`can_read_media` and :func:`can_restore_media` so the one
    reachability rule cannot drift between its readable and restorable forms.
    """
    return exists().where(
        LibraryEntry.media_id == media_id,
        LibraryEntry.media_id.is_not(None),
        LibraryEntry.library_id == Membership.library_id,
        Membership.user_id == viewer_user_id,
    )


def _media_readability_predicate(
    viewer_user_id: UUID,
    media_id: UUID | InstrumentedAttribute[UUID],
    *,
    include_tearing_down: bool,
):
    access_path = _media_membership_path_exists(
        viewer_user_id,
        media_id,
    ) | resource_grants.media_grant_path_exists_expr(viewer_user_id, media_id)
    predicate = (
        exists().where(Media.id == media_id)
        & access_path
        & ~exists().where(
            UserMediaDeletion.user_id == viewer_user_id,
            UserMediaDeletion.media_id == media_id,
        )
    )
    if not include_tearing_down:
        predicate &= ~exists().where(MediaTeardownIntent.media_id == media_id)
    return predicate


def can_read_media(
    session: Session,
    viewer_user_id: UUID,
    media_id: UUID,
    *,
    include_tearing_down: bool = False,
) -> bool:
    """Check if viewer can read a media item.

    True iff the media exists, the viewer has a membership or grant path, the
    viewer has no tombstone for it, and it is not tearing down.

    ``include_tearing_down=True`` drops only the teardown clause (keeping the
    tombstone exclusion), so a reachable, non-tombstoned target still mid-
    teardown passes. A write path uses this to reach the target and then raise
    the specific ``E_MEDIA_DELETING`` for it, instead of the generic 404 the
    teardown-excluding read surface returns — while an unreachable or tombstoned
    target still fails here, so the specific error never leaks to a non-member.

    Returns False if media_id does not exist (no existence leak: a
    non-existent media_id can never match a library_entries row).
    """
    result = session.execute(
        select(
            _media_readability_predicate(
                viewer_user_id,
                media_id,
                include_tearing_down=include_tearing_down,
            )
        )
    )
    return bool(result.scalar())


def can_restore_media(session: Session, viewer_user_id: UUID, media_id: UUID) -> bool:
    """Authorize a filing target the way spec S4.3 rule 1 requires: readable OR
    restorable. Restorable means membership-reachable (including a system
    library, same reach as :func:`can_read_media`) while ignoring only the
    viewer's own ``user_media_deletions`` tombstone AND the teardown barrier —
    a strict superset of ``can_read_media``, so re-filing media the viewer
    previously deleted is authorized. The more specific media-teardown barrier
    (``raise_if_media_teardown_pending``) is a separate, later check in the
    filing command, so reachable-but-tearing-down media raises the more
    specific ``E_MEDIA_DELETING`` instead of a masked 404 here.

    Returns False if media_id does not exist (no existence leak).
    """
    query = select(_media_membership_path_exists(viewer_user_id, media_id))
    result = session.execute(query)
    return bool(result.scalar())


def non_system_media_ref_exists_sql(media_expr: str, viewer_param: str = ":viewer_id") -> str:
    """SQL ``EXISTS`` fragment: the viewer has a non-system membership path to
    a media id. Parameterizable by ``media_expr`` so both a correlated column
    form (e.g. ``"m.id"``) and a bound-param form (``":media_id"``) can reuse
    it; ``viewer_param`` defaults to the conventional ``:viewer_id`` bind name
    but may be overridden (e.g. a correlated column) by callers with a
    different viewer binding in scope.

    The fragment's own table aliases are namespaced (``nsref_*``) so a
    correlated ``media_expr``/``viewer_param`` using a common single-letter
    alias (e.g. an outer ``media m`` or ``libraries l``) is never shadowed by
    this EXISTS subquery's own FROM/JOIN aliases.
    """
    return f"""
        EXISTS (
            SELECT 1 FROM library_entries nsref_le
            JOIN libraries nsref_l ON nsref_l.id = nsref_le.library_id
            JOIN memberships nsref_m
              ON nsref_m.library_id = nsref_l.id AND nsref_m.user_id = {viewer_param}
            WHERE nsref_le.media_id = {media_expr} AND nsref_l.system_key IS NULL
        )
    """


def visible_media_ids_cte_sql() -> str:
    """Return SQL for the canonical visible-media CTE. Binds :viewer_id.

    Sole authorization/global-readable relation: a viewer's membership or
    incoming/creator grant path, minus tombstoned and armed-teardown media.
    """
    return f"""
        SELECT m.id AS media_id
        FROM media m
        WHERE (
            EXISTS (
                SELECT 1
                FROM library_entries le
                JOIN memberships membership
                  ON membership.library_id = le.library_id
                WHERE membership.user_id = :viewer_id
                  AND le.media_id = m.id
            )
            OR {resource_grants.media_grant_path_exists_sql("m.id")}
          )
          AND NOT EXISTS (
              SELECT 1
              FROM user_media_deletions umd
              WHERE umd.user_id = :viewer_id
                AND umd.media_id = m.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM media_teardown_intents mti
              WHERE mti.media_id = m.id
          )
    """


def visible_podcast_ids_cte_sql() -> str:
    """Podcasts visible to a viewer: active subscription OR library membership. Binds :viewer_id."""
    return """
        SELECT ps.podcast_id
        FROM podcast_subscriptions ps
        WHERE ps.user_id = :viewer_id
          AND ps.status = 'active'

        UNION

        SELECT le.podcast_id
        FROM library_entries le
        JOIN memberships m ON m.library_id = le.library_id
                          AND m.user_id = :viewer_id
        WHERE le.podcast_id IS NOT NULL
    """


def visible_content_credit_rows_sql() -> str:
    """Contributor-credit rows whose credited content is visible to the viewer. Binds :viewer_id."""
    return f"""
        SELECT cc.*
        FROM contributor_credits cc
        WHERE cc.project_gutenberg_catalog_ebook_id IS NOT NULL
           OR cc.media_id IN ({visible_media_ids_cte_sql()})
           OR cc.podcast_id IN ({visible_podcast_ids_cte_sql()})
    """


def credited_visible_contributor_ids_cte_sql() -> str:
    """Contributors with at least one visible credited target. Binds :viewer_id.

    The narrow picker/search predicate (spec 2.8, D-8): used by ``GET
    /contributors`` search and the search-package contributors retriever, so
    retained key owners or graph-referenced identities with zero visible credits
    never surface as eternal "0 works" choices. Detail, works, hydration, and
    mutation handle-binding keep the broad :func:`visible_contributor_ids_cte_sql`
    below.
    """
    return f"""
        SELECT DISTINCT vcc.contributor_id
        FROM ({visible_content_credit_rows_sql()}) vcc
    """


def visible_contributor_ids_cte_sql() -> str:
    """Contributors visible to a viewer: a visible credit OR a viewer-owned graph edge.

    Binds :viewer_id. This is the single definition of contributor visibility; every
    consumer (directory, search, object refs, detail reads) shares it. The edge lane
    succeeds the old object-link lane: a contributor the viewer connected (at either
    endpoint of a ``resource_edges`` row) stays visible with zero visible credits.
    """
    return f"""
        SELECT vcc.contributor_id
        FROM ({visible_content_credit_rows_sql()}) vcc

        UNION

        SELECT re.source_id AS contributor_id
        FROM resource_edges re
        WHERE re.user_id = :viewer_id AND re.source_scheme = 'contributor'

        UNION

        SELECT re.target_id AS contributor_id
        FROM resource_edges re
        WHERE re.user_id = :viewer_id AND re.target_scheme = 'contributor'
    """


def visible_conversation_ids_cte_sql() -> str:
    """Conversation IDs visible to a viewer (binds :viewer_id, returns conversation_id).

    The SQL set-membership twin of :func:`can_read_conversation`; co-located here so the
    two forms of the same rule cannot drift. A conversation is visible iff:
    - owner_user_id = viewer_id, OR
    - sharing = 'public', OR
    - sharing = 'library' AND a conversation_share targets a library where both viewer
      AND owner are current members (dual-membership check).
    """
    return """
        SELECT c.id AS conversation_id
        FROM conversations c
        WHERE c.owner_user_id = :viewer_id

        UNION

        SELECT c.id AS conversation_id
        FROM conversations c
        WHERE c.sharing = 'public'

        UNION

        SELECT c.id AS conversation_id
        FROM conversations c
        JOIN conversation_shares cs ON cs.conversation_id = c.id
        JOIN memberships vm ON vm.library_id = cs.library_id
                            AND vm.user_id = :viewer_id
        JOIN memberships om ON om.library_id = cs.library_id
                            AND om.user_id = c.owner_user_id
        WHERE c.sharing = 'library'
    """


def can_read_conversation(session: Session, viewer_user_id: UUID, conversation_id: UUID) -> bool:
    """Check if viewer can read a conversation under visibility rules.

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


def highlight_library_intersection_exists(
    viewer_user_id: UUID,
    author_user_id_expr: UUID | InstrumentedAttribute[UUID],
    media_id: UUID,
):
    """Core SQL exists expression for highlight library intersection check.

    Returns an exists() expression checking if viewer and highlight author share
    membership in at least one library containing the given media.

    Args:
        viewer_user_id: UUID of the viewer.
        author_user_id_expr: UUID for point reads, or a column expression
            like Highlight.user_id for correlated list-query filters.
        media_id: UUID of the anchor media.

    Returns:
        An exists() SQL expression usable in .where() or select().
    """
    viewer_m = Membership.__table__.alias("hl_viewer_m")
    author_m = Membership.__table__.alias("hl_author_m")

    return (
        select(literal(1))
        .select_from(LibraryEntry.__table__)
        .join(viewer_m, viewer_m.c.library_id == LibraryEntry.__table__.c.library_id)
        .join(
            author_m,
            (author_m.c.library_id == LibraryEntry.__table__.c.library_id)
            & (author_m.c.user_id == author_user_id_expr),
        )
        .where(
            LibraryEntry.__table__.c.media_id == media_id,
            viewer_m.c.user_id == viewer_user_id,
        )
        .exists()
    )


def highlight_visibility_sql(highlight_alias: str = "h") -> str:
    """Text-SQL twin of :func:`highlight_visibility_filter`. Binds :viewer_id."""
    return f"""(
        {highlight_alias}.user_id = :viewer_id
        OR EXISTS (
            SELECT 1
            FROM library_entries le
            JOIN memberships viewer_m ON viewer_m.library_id = le.library_id
            JOIN memberships author_m ON author_m.library_id = le.library_id
            WHERE le.media_id = {highlight_alias}.anchor_media_id
              AND viewer_m.user_id = :viewer_id
              AND author_m.user_id = {highlight_alias}.user_id
        )
        OR {resource_grants.highlight_grant_path_exists_sql(f"{highlight_alias}.id")}
    )"""


def highlight_visibility_filter(viewer_user_id: UUID, media_id: UUID):
    """SQL filter expression for visible highlights in list queries.

    Evaluates to True when the viewer is the author, shares a library containing
    the media with the author, or has an exact incoming/creator grant.

    For use in .where() clauses on queries selecting from Highlight.
    Correlates with Highlight.user_id from the outer query.

    Caller must separately verify viewer can read the anchor media
    (e.g. via get_fragment_for_viewer_or_404).
    """
    return or_(
        Highlight.user_id == viewer_user_id,
        highlight_library_intersection_exists(
            viewer_user_id=viewer_user_id,
            author_user_id_expr=Highlight.user_id,
            media_id=media_id,
        ),
        resource_grants.highlight_grant_path_exists_expr(
            viewer_user_id,
            Highlight.id,
        ),
    )


def can_read_highlight(session: Session, viewer_user_id: UUID, highlight_id: UUID) -> bool:
    """Check if viewer can read a highlight under visibility rules.

    True iff the typed anchor is valid, the viewer can read its parent media,
    and the viewer is its author, shares the existing library-intersection path
    with the author, or has an exact incoming/creator grant.

    Returns False if highlight_id does not exist (no existence leak).
    Returns False on irreconcilable typed-anchor state.

    Evaluates the complete rule in one statement.
    """
    fragment_anchor_exists = exists().where(
        HighlightFragmentAnchor.highlight_id == Highlight.id,
    )
    fragment_anchor_media_mismatch_exists = exists(
        select(literal(1))
        .select_from(HighlightFragmentAnchor)
        .join(Fragment, Fragment.id == HighlightFragmentAnchor.fragment_id)
        .where(
            HighlightFragmentAnchor.highlight_id == Highlight.id,
            Fragment.media_id != Highlight.anchor_media_id,
        )
    )
    pdf_anchor_exists = exists().where(
        HighlightPdfAnchor.highlight_id == Highlight.id,
        HighlightPdfAnchor.media_id == Highlight.anchor_media_id,
    )
    typed_anchor_exists = or_(
        (Highlight.anchor_kind == "fragment_offsets")
        & fragment_anchor_exists
        & ~fragment_anchor_media_mismatch_exists,
        (Highlight.anchor_kind == "pdf_page_geometry") & pdf_anchor_exists,
    )
    readable = session.scalar(
        select(
            exists().where(
                Highlight.id == highlight_id,
                typed_anchor_exists,
                _media_readability_predicate(
                    viewer_user_id,
                    Highlight.anchor_media_id,
                    include_tearing_down=False,
                ),
                highlight_visibility_filter(
                    viewer_user_id,
                    Highlight.anchor_media_id,
                ),
            )
        )
    )
    return bool(readable)


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
