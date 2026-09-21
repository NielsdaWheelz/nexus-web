"""The contributor-credit read owner: composable SQL builders and batch loaders.

Every builder that scopes visibility binds ``:viewer_id`` and composes the CTEs owned
by ``auth/permissions``; credit DML lives in ``contributor_writes``.
"""

from __future__ import annotations

from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_content_credit_rows_sql, visible_media_ids_cte_sql
from nexus.schemas.contributors import ContributorCreditOut
from nexus.services.contributor_taxonomy import ContributorRole


def current_media_contributor_rows_sql() -> str:
    """``(media_id, handle, display_name, role)``, direct plus parent-podcast credits.

    No visibility rule: the consumer must join an already viewer-visible media relation.
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


def distinct_visible_works_sql() -> str:
    """One row per ``(contributor_id, visible target)`` — the works relation.

    Columns: ``contributor_id``; the mutually exclusive ``media_id`` / ``podcast_id`` /
    ``project_gutenberg_catalog_ebook_id``; ``href`` (the route, also the unique
    tiebreaker); ``title``; ``content_kind``; ``date_key`` (partial ISO text, NULL for
    podcasts); ``role_facts`` (jsonb by credit ordinal).
    """
    return f"""
        SELECT
            vcc.contributor_id,
            vcc.media_id,
            vcc.podcast_id,
            vcc.project_gutenberg_catalog_ebook_id,
            CASE
                WHEN vcc.media_id IS NOT NULL THEN '/media/' || vcc.media_id::text
                WHEN vcc.podcast_id IS NOT NULL THEN '/podcasts/' || vcc.podcast_id::text
                ELSE 'https://www.gutenberg.org/ebooks/'
                    || vcc.project_gutenberg_catalog_ebook_id::text
            END AS href,
            COALESCE(m.title, p.title, pg.title, '') AS title,
            CASE
                WHEN vcc.media_id IS NOT NULL THEN m.kind
                WHEN vcc.podcast_id IS NOT NULL THEN 'podcast'
                ELSE 'project_gutenberg_ebook'
            END AS content_kind,
            CASE
                WHEN vcc.media_id IS NOT NULL THEN m.original_published_date
                WHEN vcc.podcast_id IS NOT NULL THEN NULL
                ELSE pg.issued::text
            END AS date_key,
            jsonb_agg(
                jsonb_build_object(
                    'credited_name', vcc.credited_name,
                    'role', vcc.role,
                    'raw_role', vcc.raw_role
                )
                ORDER BY vcc.ordinal ASC
            ) AS role_facts
        FROM ({visible_content_credit_rows_sql()}) vcc
        LEFT JOIN media m ON m.id = vcc.media_id
        LEFT JOIN podcasts p ON p.id = vcc.podcast_id
        LEFT JOIN project_gutenberg_catalog pg
            ON pg.ebook_id = vcc.project_gutenberg_catalog_ebook_id
        GROUP BY
            vcc.contributor_id, vcc.media_id, vcc.podcast_id,
            vcc.project_gutenberg_catalog_ebook_id,
            m.title, m.kind, m.original_published_date, p.title, pg.title, pg.issued
    """


def contributor_fts_text_sql() -> str:
    """``(contributor_id, search_text)``: display name, every alias, visible credited names.

    Exact keys deliberately never enter the search blob.
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


def contributor_credits_rollup_cte_sql(
    owner_column: Literal["media_id", "podcast_id"], *, owner_predicate: str = "TRUE"
) -> str:
    """Per-owner ``(owner_id, contributor_credits jsonb, contributor_search_text)``.

    ``owner_column``/``owner_predicate`` are fixed internal SQL literals, never user input.
    The search text composes credited name, display name and aliases, never external keys.
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
                concat_ws(
                    ' ',
                    cc.credited_name,
                    c.display_name,
                    COALESCE(alias_text.aliases, '')
                ),
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
          AND {owner_predicate}
        GROUP BY cc.{owner_column}
    """


def primary_creator_rows_sql(owner_column: Literal["media_id", "podcast_id"]) -> str:
    """``(owner_id, primary_name)``: the lowest-ordinal credit's display name, any role.

    No viewer scope; the composing query must already scope owners to visible content.
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
    owner_column: Literal["media_id", "podcast_id"],
    owner_id_expr: str,
    *,
    filter_contributor_ids: bool,
    filter_roles: bool,
) -> str:
    """``AND EXISTS (…)``: the outer target row has a matching credit, or ``''``.

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
                SELECT 1
                FROM contributor_credits cc_filter
                WHERE {" AND ".join(clauses)}
            )
        """


def media_author_names_agg_sql() -> str:
    """Aggregate expression: comma-joined distinct author credited names ``AS authors``."""
    return (
        "COALESCE("
        "NULLIF(string_agg(DISTINCT cc.credited_name, ', ' ORDER BY cc.credited_name), ''),"
        " ''"
        ") AS authors"
    )


def media_author_credits_join_sql() -> str:
    """The ``LEFT JOIN`` for :func:`media_author_names_agg_sql`; the outer media row is ``m``."""
    return "LEFT JOIN contributor_credits cc ON cc.media_id = m.id AND cc.role = 'author'"


def load_visible_contributor_media_ids(
    db: Session,
    *,
    contributor_id: UUID,
    viewer_id: UUID,
) -> list[UUID]:
    """Visible Media works credited directly or through a Podcast, newest first.

    Gutenberg catalog-only credits have no Media identity and are absent.
    """
    rows = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()}),
            credited_media AS (
                SELECT cc.media_id
                FROM contributor_credits cc
                WHERE cc.contributor_id = :contributor_id
                  AND cc.media_id IS NOT NULL

                UNION

                SELECT pe.media_id
                FROM contributor_credits cc
                JOIN podcast_episodes pe ON pe.podcast_id = cc.podcast_id
                WHERE cc.contributor_id = :contributor_id
                  AND cc.podcast_id IS NOT NULL
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
    return [UUID(str(row[0])) for row in rows]


def load_current_source_author_bylines(db: Session, *, media_id: UUID) -> list[str]:
    """Ordered author bylines supported by the media's current successful source."""
    rows = db.execute(
        text(
            """
            WITH current_source AS (
                SELECT source_type
                FROM media_source_attempts
                WHERE media_id = :media_id
                  AND status = 'succeeded'
                ORDER BY attempt_no DESC, id DESC
                LIMIT 1
            )
            SELECT cc.credited_name
            FROM contributor_credits cc
            CROSS JOIN current_source source
            WHERE cc.media_id = :media_id
              AND cc.role = 'author'
              AND (
                (source.source_type = 'generic_web_url'
                 AND cc.source = 'web_article_byline')
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
                OR (source.source_type = 'podcast_episode_transcript'
                    AND cc.source = 'rss')
              )
            ORDER BY cc.ordinal ASC
            LIMIT 33
            """
        ),
        {"media_id": media_id},
    ).scalars()
    return [str(value).strip() for value in rows if str(value).strip()]


def load_contributor_credits_for_media(
    db: Session, media_ids: list[UUID]
) -> dict[UUID, list[ContributorCreditOut]]:
    """Ordered credits per media id, as embedded DTOs."""
    return _load_credits(db, "media_id", media_ids)


def load_contributor_credits_for_podcasts(
    db: Session, podcast_ids: list[UUID]
) -> dict[UUID, list[ContributorCreditOut]]:
    """Ordered credits per podcast id, as embedded DTOs."""
    return _load_credits(db, "podcast_id", podcast_ids)


def _load_credits(
    db: Session,
    owner_column: Literal["media_id", "podcast_id"],
    owner_ids: list[UUID],
) -> dict[UUID, list[ContributorCreditOut]]:
    credits_by_owner: dict[UUID, list[ContributorCreditOut]] = {
        owner_id: [] for owner_id in owner_ids
    }
    if not owner_ids:
        return credits_by_owner
    rows = db.execute(
        text(
            f"""
            SELECT cc.{owner_column}, c.handle, c.display_name,
                   cc.credited_name, cc.role, cc.raw_role, cc.ordinal
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.{owner_column} = ANY(:owner_ids)
            ORDER BY cc.{owner_column} ASC, cc.ordinal ASC
            """
        ),
        {"owner_ids": owner_ids},
    ).fetchall()
    for row in rows:
        credits_by_owner.setdefault(UUID(str(row[0])), []).append(_credit_out(row))
    return credits_by_owner


def _credit_out(row: Any) -> ContributorCreditOut:
    return ContributorCreditOut(
        contributor_handle=row[1],
        contributor_display_name=row[2],
        href=f"/authors/{row[1]}",
        credited_name=row[3],
        role=cast(ContributorRole, row[4]),
        raw_role=row[5],
        ordinal=int(row[6]),
    )


def current_gutenberg_author_names(db: Session, ebook_ids: list[int]) -> dict[int, tuple[str, ...]]:
    """Ordered current author credited names per Gutenberg ebook, for sync change detection."""
    if not ebook_ids:
        return {}
    names_by_ebook: dict[int, list[str]] = {}
    rows = db.execute(
        text(
            """
            SELECT project_gutenberg_catalog_ebook_id, credited_name
            FROM contributor_credits
            WHERE project_gutenberg_catalog_ebook_id = ANY(:ebook_ids)
              AND role = 'author'
            ORDER BY project_gutenberg_catalog_ebook_id ASC, ordinal ASC
            """
        ),
        {"ebook_ids": ebook_ids},
    ).fetchall()
    for ebook_id, credited_name in rows:
        names_by_ebook.setdefault(int(ebook_id), []).append(str(credited_name))
    return {ebook_id: tuple(names) for ebook_id, names in names_by_ebook.items()}
