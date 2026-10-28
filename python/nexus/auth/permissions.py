"""The readable relations: what a viewer may read, each rule spelled once, in SQL.

Fragments bind ``:viewer_id``. Point checks take a session and answer a bool; "not found" and
"not visible" are the same False. Two ORM adapters wrap the highlight rules as ``text`` clauses
correlated to the unaliased ``highlights`` table.

Workspace enumeration: library membership and exact media/highlight grants are
roots; source→piece containment closes over them. piece→source storage dependency
never grants access. The viewer's tombstones and every teardown intent exclude each step, roots
included. ``library_entries.library_media_ids_cte_sql`` layers "My Library" on top.
Highlights: a consistent typed anchor on readable media whose author is the viewer, shares a
non-system library holding the media with the viewer, or granted it exactly. A system library
(the Oracle corpus) reaches media, never fellow members' highlights.
Requested media: workspace-readable media or any canonical podcast episode. The catalogue
arm ignores personal removal markers; teardown still excludes it. Point tools and source
hydration use this relation; search, library and suggestion roots remain workspace-scoped.
Podcast enumeration: an active member-library rule or a retained episode. Contributors:
a visible credit or a viewer-owned graph edge (pickers: credits only). Conversations:
the owner only.
"""

from uuid import UUID

from sqlalchemy import TextClause, text
from sqlalchemy.orm import Session

from nexus.services import resource_grants
from nexus.services.media_text_scope import highlight_in_reading_scope_sql
from nexus.services.resource_graph.liveness import edge_live_sql


def non_system_media_ref_exists_sql(media_expr: str, viewer_param: str = ":viewer_id") -> str:
    """EXISTS: a non-system membership reaches the media (aliases ``nsref_*`` never shadow)."""
    return f"""
        EXISTS (
            SELECT 1 FROM library_entries nsref_le
            JOIN libraries nsref_l ON nsref_l.id = nsref_le.library_id
            JOIN memberships nsref_m
              ON nsref_m.library_id = nsref_l.id AND nsref_m.user_id = {viewer_param}
            WHERE nsref_le.media_id = {media_expr} AND nsref_l.system_key IS NULL
        )
    """


def media_containment_edges_sql() -> str:
    """Only source-to-piece containment grants media authority."""
    return "SELECT source_media_id AS parent_media_id, media_id AS child_media_id FROM media_parts"


def contained_media_ids_cte_sql(
    roots_sql: str, *, viewer_param: str | None = None, include_tearing_down: bool = False
) -> str:
    """roots and their contained pieces, with viewer tombstones at every step."""
    eligible = "SELECT m.id FROM media m WHERE TRUE"
    if viewer_param is not None:
        eligible += f""" AND NOT EXISTS (
            SELECT 1 FROM user_media_deletions d
            WHERE d.media_id = m.id AND d.user_id = {viewer_param})"""
    if not include_tearing_down:
        eligible += """ AND NOT EXISTS (
            SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id = m.id)"""
    return f"""
        WITH RECURSIVE eligible AS ({eligible}),
        containment AS ({media_containment_edges_sql()}),
        reached(media_id) AS (
            SELECT roots.media_id FROM ({roots_sql}) roots
            JOIN eligible ON eligible.id = roots.media_id
            UNION
            SELECT edge.child_media_id
            FROM reached JOIN containment edge ON edge.parent_media_id = reached.media_id
            JOIN eligible ON eligible.id = edge.child_media_id
        )
        SELECT media_id FROM reached
    """


def visible_media_ids_cte_sql(*, include_tearing_down: bool = False) -> str:
    """The readable media ids."""
    roots = f"""
        SELECT le.media_id FROM library_entries le
        JOIN memberships membership ON membership.library_id = le.library_id
        WHERE membership.user_id = :viewer_id AND le.media_id IS NOT NULL
        UNION
        SELECT m.id FROM media m
        WHERE {resource_grants.media_grant_path_exists_sql("m.id")}
    """
    return contained_media_ids_cte_sql(
        roots, viewer_param=":viewer_id", include_tearing_down=include_tearing_down
    )


def requested_media_ids_cte_sql(*, include_tearing_down: bool = False) -> str:
    """Point-read authority; this relation never enrolls catalogue episodes in a collection."""
    teardown = (
        ""
        if include_tearing_down
        else """AND NOT EXISTS (
        SELECT 1 FROM media_teardown_intents ti WHERE ti.media_id = pe.media_id)"""
    )
    return f"""
        SELECT media_id FROM ({visible_media_ids_cte_sql(include_tearing_down=include_tearing_down)}) workspace
        UNION
        SELECT pe.media_id FROM podcast_episodes pe
        JOIN media m ON m.id = pe.media_id AND m.kind = 'podcast_episode'
        WHERE TRUE {teardown}
    """


def can_read_media(
    session: Session, viewer_user_id: UUID, media_id: UUID, *, include_tearing_down: bool = False
) -> bool:
    """Requested-media authority; teardown-inclusive checks let writes report deleting state."""
    readable = requested_media_ids_cte_sql(include_tearing_down=include_tearing_down)
    params = {"viewer_id": viewer_user_id, "media_id": media_id}
    return bool(session.scalar(text(f"SELECT :media_id IN ({readable})"), params))


def can_restore_media(session: Session, viewer_user_id: UUID, media_id: UUID) -> bool:
    """Membership reach or a canonical episode, ignoring removal and teardown for re-filing."""
    sql = f"""SELECT EXISTS (
        SELECT 1 FROM library_entries le JOIN memberships m ON m.library_id = le.library_id
        WHERE le.media_id = :media_id AND m.user_id = :viewer_id)
        OR EXISTS (SELECT 1 FROM podcast_episodes pe JOIN media m ON m.id=pe.media_id
                   WHERE pe.media_id=:media_id AND m.kind='podcast_episode')
        OR EXISTS (SELECT 1 FROM media_parts p WHERE p.media_id=:media_id
                   AND p.source_media_id IN ({visible_media_ids_cte_sql()}))"""
    return bool(session.scalar(text(sql), {"viewer_id": viewer_user_id, "media_id": media_id}))


def personal_media_removal_allowed_sql(media_expr: str) -> str:
    """The shared personal-removal policy for commands and action availability."""
    return f"""({non_system_media_ref_exists_sql(media_expr)}
        OR {resource_grants.media_grant_path_exists_sql(media_expr)}
        OR EXISTS (SELECT 1 FROM media_parts removable_part
            WHERE removable_part.media_id={media_expr}
              AND removable_part.source_media_id IN ({visible_media_ids_cte_sql()})
              AND ({non_system_media_ref_exists_sql("removable_part.source_media_id")}
                   OR {resource_grants.media_grant_path_exists_sql("removable_part.source_media_id")})))"""


def visible_podcast_ids_cte_sql() -> str:
    """Active rules or readable retained episodes expose their canonical show."""
    return f"""
        SELECT ps.podcast_id FROM library_podcast_subscriptions ps
        JOIN libraries l ON l.id=ps.library_id AND l.system_key IS NULL
        JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id
        UNION
        SELECT pe.podcast_id FROM podcast_episodes pe
        WHERE pe.media_id IN ({visible_media_ids_cte_sql()})
    """


def active_podcast_subscription_exists_sql(podcast_id_expr: str = "p.id") -> str:
    return f"""EXISTS (
        SELECT 1 FROM library_podcast_subscriptions ps
        JOIN libraries l ON l.id=ps.library_id AND l.system_key IS NULL
        JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id
        WHERE ps.podcast_id={podcast_id_expr}
    )"""


def visible_content_credit_rows_sql(
    *, visible_media: str | None = None, visible_podcasts: str | None = None
) -> str:
    """Contributor-credit rows whose credited content is visible.

    A composing read may supply both owned, duplicate-free relations, with columns
    ``media_id`` and ``podcast_id``. Joins reuse their membership once instead of
    rescanning an inline recursive set per credit. Other consumers remain standalone.
    """
    assert (visible_media is None) == (visible_podcasts is None)
    joins = ""
    if visible_media is None:
        media = f"cc.media_id IN ({visible_media_ids_cte_sql()})"
        podcasts = f"cc.podcast_id IN ({visible_podcast_ids_cte_sql()})"
    else:
        joins = f"""
        LEFT JOIN {visible_media} credit_media ON credit_media.media_id = cc.media_id
        LEFT JOIN {visible_podcasts} credit_podcast ON credit_podcast.podcast_id = cc.podcast_id"""
        media = "credit_media.media_id IS NOT NULL"
        podcasts = "credit_podcast.podcast_id IS NOT NULL"
    return f"""
        SELECT cc.*
        FROM contributor_credits cc{joins}
        WHERE cc.project_gutenberg_catalog_ebook_id IS NOT NULL
           OR {media}
           OR {podcasts}
    """


def credited_visible_contributor_ids_cte_sql() -> str:
    """Pickers and search: contributors with a visible credit, never "0 works" identities."""
    return f"""
        SELECT DISTINCT vcc.contributor_id
        FROM ({visible_content_credit_rows_sql()}) vcc
    """


def visible_contributor_ids_cte_sql() -> str:
    """Detail, works and hydration: a visible credit or a viewer-owned edge at either end."""
    return f"""
        SELECT vcc.contributor_id
        FROM ({visible_content_credit_rows_sql()}) vcc

        UNION

        SELECT re.source_id AS contributor_id
        FROM resource_edges re
        WHERE re.user_id = :viewer_id AND re.source_scheme = 'contributor'
          AND {edge_live_sql("re")}

        UNION

        SELECT re.target_id AS contributor_id
        FROM resource_edges re
        WHERE re.user_id = :viewer_id AND re.target_scheme = 'contributor'
          AND {edge_live_sql("re")}
    """


def visible_conversation_ids_cte_sql() -> str:
    return """
        SELECT c.id AS conversation_id
        FROM conversations c
        WHERE c.owner_user_id = :viewer_id
    """


def can_read_conversation(session: Session, viewer_user_id: UUID, conversation_id: UUID) -> bool:
    sql = f"SELECT :conversation_id IN ({visible_conversation_ids_cte_sql()})"
    params = {"viewer_id": viewer_user_id, "conversation_id": conversation_id}
    return bool(session.scalar(text(sql), params))


def highlight_visibility_sql(highlight_alias: str = "h") -> str:
    """A semantically live highlight on the author, library or grant path; the caller
    proves the anchor and its media. A deleted highlight's projection reads as absent."""
    return f"""({highlight_alias}.authored_visible AND (
        {highlight_alias}.user_id = :viewer_id
        OR EXISTS (
            SELECT 1
            FROM library_entries le
            JOIN libraries shared_l ON shared_l.id = le.library_id AND shared_l.system_key IS NULL
            JOIN memberships viewer_m ON viewer_m.library_id = le.library_id
            JOIN memberships author_m ON author_m.library_id = le.library_id
            WHERE (le.media_id = {highlight_alias}.anchor_media_id
                OR ({highlight_alias}.anchor_kind='fragment_offsets' AND {highlight_alias}.anchor_media_id IS NULL
                    AND {highlight_in_reading_scope_sql(f"{highlight_alias}.id", "le.media_id")})
                OR EXISTS (
                SELECT 1 FROM media_parts library_part
                WHERE library_part.media_id=le.media_id
                  AND library_part.source_media_id={highlight_alias}.anchor_media_id
                  AND {highlight_in_reading_scope_sql(f"{highlight_alias}.id", "library_part.media_id")}
            ))
              AND viewer_m.user_id = :viewer_id
              AND author_m.user_id = {highlight_alias}.user_id
        )
        OR {resource_grants.highlight_grant_path_exists_sql(f"{highlight_alias}.id")}
    ))"""


def highlight_readability_sql(highlight_alias: str = "h") -> str:
    """canonical identity remains source-local; a readable piece admits complete anchors."""
    from nexus.services.x_source import readable_x_capture_ids_sql

    readable = requested_media_ids_cte_sql()
    captures = readable_x_capture_ids_sql()
    return f"""(
        (
            ({highlight_alias}.anchor_kind='fragment_offsets' AND EXISTS (
                SELECT 1 FROM ({readable}) reading
                WHERE {highlight_in_reading_scope_sql(f"{highlight_alias}.id", "reading.media_id")}
                  AND EXISTS (SELECT 1 FROM fragments anchor_fragment
                      JOIN highlight_fragment_anchors anchor_range
                        ON anchor_range.fragment_id=anchor_fragment.id
                      WHERE anchor_range.highlight_id={highlight_alias}.id
                        AND anchor_fragment.media_id={highlight_alias}.anchor_media_id)
            ))
            OR ({highlight_alias}.anchor_kind='fragment_offsets'
                AND {highlight_alias}.anchor_media_id IS NULL
                AND EXISTS (SELECT 1 FROM highlight_fragment_anchors xa
                    JOIN fragments xf ON xf.id=xa.fragment_id
                    WHERE xa.highlight_id={highlight_alias}.id
                      AND xf.x_post_capture_id IN ({captures})
                      AND 0<=xa.start_offset AND xa.start_offset<xa.end_offset
                      AND xa.end_offset<=char_length(xf.canonical_text)))
            OR ({highlight_alias}.anchor_kind='pdf_page_geometry'
                AND {highlight_alias}.anchor_media_id IN ({readable})
                AND EXISTS (SELECT 1 FROM highlight_pdf_anchors hpa
                    WHERE hpa.highlight_id={highlight_alias}.id
                      AND hpa.media_id={highlight_alias}.anchor_media_id))
        ) AND {highlight_visibility_sql(highlight_alias)}
    )"""


def highlight_visibility_filter(viewer_user_id: UUID) -> TextClause:
    return text(highlight_visibility_sql("highlights")).bindparams(viewer_id=viewer_user_id)


def highlight_readability_filter(viewer_user_id: UUID) -> TextClause:
    return text(highlight_readability_sql("highlights")).bindparams(viewer_id=viewer_user_id)


def can_read_highlight(session: Session, viewer_user_id: UUID, highlight_id: UUID) -> bool:
    sql = f"""SELECT EXISTS (
        SELECT 1 FROM highlights h WHERE h.id = :id AND {highlight_readability_sql()})"""
    return bool(session.scalar(text(sql), {"viewer_id": viewer_user_id, "id": highlight_id}))


def is_library_member(session: Session, viewer_user_id: UUID, library_id: UUID) -> bool:
    sql = """SELECT EXISTS (
        SELECT 1 FROM memberships WHERE library_id = :id AND user_id = :viewer_id)"""
    return bool(session.scalar(text(sql), {"viewer_id": viewer_user_id, "id": library_id}))
