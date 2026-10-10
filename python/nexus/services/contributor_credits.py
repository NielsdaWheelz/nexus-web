"""Contributor-credit reads that other modules compose: SQL fragments and batch loaders.

A fragment that scopes visibility binds ``:viewer_id`` and composes the CTEs owned by
``auth/permissions``; one without a visibility rule says so and needs a visible outer
relation. Credit DML lives in ``contributor_writes``.
"""

from __future__ import annotations

from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_content_credit_rows_sql, visible_media_ids_cte_sql
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.services.contributor_taxonomy import ContributorRole

_Owner = Literal["media_id", "podcast_id"]


def current_media_contributor_rows_sql() -> str:
    """``(media_id, handle, display_name, role)``, direct plus parent-podcast credits.

    No visibility rule: the consumer joins an already viewer-visible media relation.
    """
    return """
        SELECT DISTINCT targets.media_id, c.handle, c.display_name, targets.role
        FROM (
            SELECT cc.media_id, cc.contributor_id, cc.role
            FROM contributor_credits cc
            WHERE cc.media_id IS NOT NULL
            UNION ALL
            SELECT pe.media_id, cc.contributor_id, cc.role
            FROM contributor_credits cc
            JOIN podcast_episodes pe ON pe.podcast_id = cc.podcast_id
            WHERE cc.podcast_id IS NOT NULL
        ) targets
        JOIN contributors c ON c.id = targets.contributor_id
    """


def visible_author_credit_rows_sql() -> str:
    """``(contributor_id, display_name, media_id, podcast_id)`` for visible author credits."""
    return f"""
        SELECT vcc.contributor_id, c.display_name, vcc.media_id, vcc.podcast_id
        FROM ({visible_content_credit_rows_sql()}) vcc
        JOIN contributors c ON c.id = vcc.contributor_id
        WHERE vcc.role = 'author'
          AND (vcc.media_id IS NOT NULL OR vcc.podcast_id IS NOT NULL)
    """


def contributor_fts_text_sql() -> str:
    """``(contributor_id, search_text)``: display name, aliases, visible credited names.

    Exact keys never enter the search text.
    """
    return f"""
        SELECT
            c.id AS contributor_id,
            concat_ws(
                ' ',
                c.display_name,
                (
                    SELECT string_agg(ca.alias, ' ' ORDER BY ca.alias ASC)
                    FROM contributor_aliases ca
                    WHERE ca.contributor_id = c.id
                ),
                (
                    SELECT string_agg(DISTINCT vcc.credited_name, ' ')
                    FROM ({visible_content_credit_rows_sql()}) vcc
                    WHERE vcc.contributor_id = c.id
                )
            ) AS search_text
        FROM contributors c
    """


def contributor_credits_rollup_cte_sql(owner_column: _Owner) -> str:
    """Per owner ``(owner_id, contributor_credits jsonb, contributor_search_text)``.

    ``owner_column`` is a fixed internal literal. The search text joins credited name,
    display name and aliases, never external keys.
    """
    return f"""
        SELECT
            cc.{owner_column},
            jsonb_agg(
                jsonb_build_object(
                    'credited_name', cc.credited_name,
                    'role', cc.role,
                    'raw_role', cc.raw_role,
                    'ordinal', cc.ordinal,
                    'contributor_handle', c.handle,
                    'contributor_display_name', c.display_name,
                    'href', '/authors/' || c.handle
                )
                ORDER BY cc.ordinal ASC, cc.created_at ASC, cc.id ASC
            ) AS contributor_credits,
            string_agg(
                concat_ws(' ', cc.credited_name, c.display_name, COALESCE(alias_text.aliases, '')),
                ' '
            ) AS contributor_search_text
        FROM contributor_credits cc
        JOIN contributors c ON c.id = cc.contributor_id
        LEFT JOIN (
            SELECT contributor_id, string_agg(alias, ' ') AS aliases
            FROM contributor_aliases
            GROUP BY contributor_id
        ) alias_text ON alias_text.contributor_id = c.id
        WHERE cc.{owner_column} IS NOT NULL
        GROUP BY cc.{owner_column}
    """


def primary_creator_rows_sql(owner_column: _Owner) -> str:
    """``(owner_id, primary_name)``: the lowest-ordinal credit's display name, any role.

    No visibility rule: the composing query scopes owners to visible content.
    """
    return f"""
        SELECT DISTINCT ON (cc.{owner_column})
            cc.{owner_column} AS owner_id,
            c.display_name AS primary_name
        FROM contributor_credits cc
        JOIN contributors c ON c.id = cc.contributor_id
        WHERE cc.{owner_column} IS NOT NULL
        ORDER BY cc.{owner_column}, cc.ordinal ASC, cc.created_at ASC, cc.id ASC
    """


def credit_target_filter_exists_sql(
    owner_column: _Owner,
    owner_id_expr: str,
    *,
    filter_contributor_ids: bool,
    filter_roles: bool,
) -> str:
    """``AND EXISTS (…)`` when the outer target row has a matching credit, else ``''``.

    Binds ``:contributor_ids`` and/or ``:roles`` only when the matching flag is set.
    """
    if not (filter_contributor_ids or filter_roles):
        return ""
    clauses = [f"cc_filter.{owner_column} = {owner_id_expr}"]
    if filter_contributor_ids:
        clauses.append("cc_filter.contributor_id = ANY(:contributor_ids)")
    if filter_roles:
        clauses.append("cc_filter.role = ANY(:roles)")
    return f"""
            AND EXISTS (
                SELECT 1 FROM contributor_credits cc_filter WHERE {" AND ".join(clauses)}
            )
        """


def media_author_names_agg_sql() -> str:
    """Aggregate: comma-joined distinct author credited names ``AS authors``."""
    return (
        "COALESCE(NULLIF(string_agg(DISTINCT cc.credited_name, ', ' ORDER BY cc.credited_name),"
        " ''), '') AS authors"
    )


def media_author_credits_join_sql() -> str:
    """The ``LEFT JOIN`` for :func:`media_author_names_agg_sql`; the outer media row is ``m``."""
    return "LEFT JOIN contributor_credits cc ON cc.media_id = m.id AND cc.role = 'author'"


def load_visible_contributor_media_ids(
    db: Session, *, contributor_id: UUID, viewer_id: UUID
) -> list[UUID]:
    """Visible media credited directly or through their podcast, newest first.

    Catalogue-only credits have no media identity and are absent.
    """
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()}),
            credited_media AS (
                SELECT cc.media_id FROM contributor_credits cc
                WHERE cc.contributor_id = :contributor_id AND cc.media_id IS NOT NULL
                UNION
                SELECT pe.media_id FROM contributor_credits cc
                JOIN podcast_episodes pe ON pe.podcast_id = cc.podcast_id
                WHERE cc.contributor_id = :contributor_id AND cc.podcast_id IS NOT NULL
            )
            SELECT DISTINCT cm.media_id, m.original_published_date, m.title
            FROM credited_media cm
            JOIN visible_media vm ON vm.media_id = cm.media_id
            JOIN media m ON m.id = cm.media_id
            ORDER BY m.original_published_date DESC NULLS LAST, m.title, cm.media_id
            """
        ),
        {"viewer_id": viewer_id, "contributor_id": contributor_id},
    )
    return [row[0] for row in rows]


def load_current_source_author_bylines(db: Session, *, media_id: UUID) -> list[str]:
    """Ordered author bylines supported by the media's current successful source."""
    rows = db.execute(
        text(
            """
            WITH current_source AS (
                SELECT source_type
                FROM media_source_attempts
                WHERE media_id = :media_id AND status = 'succeeded'
                ORDER BY attempt_no DESC, id DESC
                LIMIT 1
            )
            SELECT cc.credited_name
            FROM contributor_credits cc
            CROSS JOIN current_source source
            WHERE cc.media_id = :media_id
              AND cc.role = 'author'
              AND (
                (source.source_type = 'generic_web_url' AND cc.source = 'web_article_byline')
                OR (source.source_type = 'browser_article_capture'
                    AND cc.source = 'web_article_capture')
                OR (source.source_type IN ('x_author_thread', 'x_post')
                    AND cc.source IN ('x_api_author_thread', 'x_api_post', 'x_api_quoted_post'))
                OR (source.source_type IN ('youtube_video', 'video_transcript')
                    AND cc.source = 'youtube_metadata')
                OR (source.source_type IN ('remote_pdf_url', 'uploaded_pdf_file',
                    'browser_pdf_capture') AND cc.source = 'pdf_metadata')
                OR (source.source_type IN ('remote_epub_url', 'uploaded_epub_file',
                    'browser_epub_capture') AND cc.source = 'epub_opf')
                OR (source.source_type = 'podcast_episode_transcript' AND cc.source = 'rss')
              )
            ORDER BY cc.ordinal ASC
            LIMIT 33
            """
        ),
        {"media_id": media_id},
    ).scalars()
    return [name.strip() for name in rows if name.strip()]


def load_contributor_credits_for_media(
    db: Session, media_ids: list[UUID]
) -> dict[UUID, list[ContributorCreditOut]]:
    """Ordered credits per media id; every requested id has an entry."""
    return {media_id: [] for media_id in media_ids} | _credits(db, "media_id", media_ids)


def load_contributor_credits_for_podcasts(
    db: Session, podcast_ids: list[UUID]
) -> dict[UUID, list[ContributorCreditOut]]:
    """Ordered credits per podcast id; every requested id has an entry."""
    return {podcast_id: [] for podcast_id in podcast_ids} | _credits(db, "podcast_id", podcast_ids)


def load_contributor_credits_for_catalogue(
    db: Session, ebook_ids: list[int]
) -> dict[int, list[ContributorCreditOut]]:
    """Ordered credits per catalogue ebook that has any."""
    return _credits(db, "project_gutenberg_catalog_ebook_id", ebook_ids)


def current_gutenberg_author_names(db: Session, ebook_ids: list[int]) -> dict[int, tuple[str, ...]]:
    """Ordered author credited names per catalogue ebook, for sync change detection."""
    credits = _credits(db, "project_gutenberg_catalog_ebook_id", ebook_ids)
    return {
        ebook_id: tuple(c.credited_name for c in rows if c.role == "author")
        for ebook_id, rows in credits.items()
    }


def _credits[K: (UUID, int)](
    db: Session, owner_column: str, owner_ids: list[K]
) -> dict[K, list[ContributorCreditOut]]:
    """``owner_column`` is a fixed internal literal."""
    result: dict[K, list[ContributorCreditOut]] = {}
    if not owner_ids:
        return result
    rows = db.execute(
        text(
            f"""
            SELECT cc.{owner_column} AS owner, c.handle, c.display_name,
                   cc.credited_name, cc.role, cc.raw_role, cc.ordinal
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.{owner_column} = ANY(:owner_ids)
            ORDER BY cc.{owner_column} ASC, cc.ordinal ASC
            """
        ),
        {"owner_ids": owner_ids},
    ).mappings()
    for row in rows:
        result.setdefault(row["owner"], []).append(
            ContributorCreditOut(
                contributor_handle=row["handle"],
                contributor_display_name=row["display_name"],
                href=f"/authors/{row['handle']}",
                credited_name=row["credited_name"],
                role=cast(ContributorRole, row["role"]),
                raw_role=row["raw_role"],
                ordinal=row["ordinal"],
            )
        )
    return result
