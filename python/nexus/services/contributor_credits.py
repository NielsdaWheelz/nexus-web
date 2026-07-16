"""Canonical contributor-credit READ owner.

The single query primitive for every consumer of ``contributor_credits`` (spec
§3/§4): composable SQL builders plus the two batch loaders. It performs no
writes — credit DML lives in the private ``_contributor_credit_writes`` module,
composed only by the ``contributors`` facade.

Every builder returns SQL text that binds ``:viewer_id`` (visibility flows from
``auth/permissions``, the one visibility owner) so detail, works pages, picker
counts, app search, and browse rollups share one visibility and target-dedup
relation.
"""

from __future__ import annotations

from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_content_credit_rows_sql
from nexus.schemas.contributors import ContributorCreditOut, ContributorRole


def visible_credit_rows_sql() -> str:
    """All credit rows on targets visible to the viewer. Binds ``:viewer_id``.

    Thin composable wrapper over the permissions predicate so read consumers
    compose the canonical relation without importing visibility SQL themselves.
    Columns: every ``contributor_credits`` column (``cc.*``).
    """
    return visible_content_credit_rows_sql()


def distinct_visible_works_sql() -> str:
    """Distinct visible credited targets with nested role facts. Binds ``:viewer_id``.

    One row per ``(contributor_id, target)`` — the target-dedup relation behind
    author detail, works pages, picker work counts/examples, and app search
    (spec §4 "Contributor work/examples aggregate by distinct visible target").
    Columns:

    - ``contributor_id``
    - ``href``          — the target route (also the unique tiebreaker key)
    - ``title``         — target title ('' when absent)
    - ``content_kind``  — media kind | 'podcast' | 'project_gutenberg_ebook'
    - ``date_key``      — partial ISO date text (media published date /
      gutenberg issued; NULL for podcasts) — D-25 ordering key
    - ``role_facts``    — jsonb array of ``{credited_name, role, raw_role}``
      ordered by credit ordinal
    """
    return f"""
        SELECT
            vcc.contributor_id,
            CASE
                WHEN vcc.media_id IS NOT NULL
                    THEN '/media/' || vcc.media_id::text
                WHEN vcc.podcast_id IS NOT NULL
                    THEN '/podcasts/' || vcc.podcast_id::text
                ELSE '/browse/gutenberg/' || vcc.project_gutenberg_catalog_ebook_id::text
            END AS href,
            COALESCE(m.title, p.title, pg.title, '') AS title,
            CASE
                WHEN vcc.media_id IS NOT NULL THEN m.kind
                WHEN vcc.podcast_id IS NOT NULL THEN 'podcast'
                ELSE 'project_gutenberg_ebook'
            END AS content_kind,
            CASE
                WHEN vcc.media_id IS NOT NULL THEN m.published_date
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
            vcc.contributor_id,
            vcc.media_id,
            vcc.podcast_id,
            vcc.project_gutenberg_catalog_ebook_id,
            m.title,
            m.kind,
            m.published_date,
            p.title,
            pg.title,
            pg.issued
    """


def contributor_fts_text_sql() -> str:
    """Per-contributor full-text blob. Binds ``:viewer_id``.

    Composes display name, ALL human aliases, and visible credited names —
    deliberately no external keys (spec §4: exact keys never enter the search
    blob). Columns: ``contributor_id``, ``search_text``. Consumed by the
    search-package contributors retriever (S5).
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


def podcast_credit_text_match_sql(podcast_id_expr: str = "p.id") -> str:
    """EXISTS predicate: a podcast credit matches ``:q_pattern`` (D-40).

    Matches credited names, canonical display names, and EVERY alias (resolving
    and not — spec §4 "Search reads every alias"). ``podcast_id_expr`` is the
    outer query's podcast-id SQL expression. Consumed by the podcast
    subscriptions list query (S5).
    """
    return f"""EXISTS (
        SELECT 1
        FROM contributor_credits cc
        JOIN contributors c ON c.id = cc.contributor_id
        LEFT JOIN contributor_aliases ca ON ca.contributor_id = c.id
        WHERE cc.podcast_id = {podcast_id_expr}
          AND (
                cc.credited_name ILIKE :q_pattern
                OR c.display_name ILIKE :q_pattern
                OR ca.alias ILIKE :q_pattern
          )
    )"""


def contributor_credits_rollup_cte_sql(owner_column: Literal["media_id", "podcast_id"]) -> str:
    """Return SQL for a CTE that pre-aggregates contributor credits per owner row.

    owner_column selects the ``contributor_credits`` foreign key to group by. It is a
    fixed internal literal, never user input, so interpolating it into SQL is safe.

    The per-credit JSON is the narrowed embedded ``ContributorCreditOut`` (D-33):
    handle, display name, href, credited name, role, raw role, and order — no credit
    id, source, or nested full contributor. ``contributor_search_text`` composes
    credited name + display name + every human alias; external keys never enter it
    (AC 24), so the media/podcast FTS blobs that embed it also carry no keys (a
    deliberate, accepted ranking delta). Consumed by the search retrievers/service.
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
        GROUP BY cc.{owner_column}
    """


def credit_target_filter_exists_sql(
    owner_column: Literal["media_id", "podcast_id"],
    owner_id_expr: str,
    *,
    filter_contributor_ids: bool,
    filter_roles: bool,
) -> str:
    """``AND EXISTS (…)`` predicate: the outer target row has a matching credit.

    Backs the media/podcast/library search retrievers' author/role filters. Binds
    ``:contributor_ids`` and/or ``:roles`` only when the corresponding flag is set
    (the caller supplies those params). ``owner_id_expr`` is the outer query's
    target-id SQL expression (e.g. ``m.id``); ``owner_column`` is a fixed internal
    literal. Returns ``''`` when no credit predicate is requested.
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
    """Aggregate expression: comma-joined distinct author credited names ``AS authors``.

    Pairs with :func:`media_author_credits_join_sql`; the outer query GROUPs BY its
    own media columns. Backs the resource-graph media/quote resolvers' byline label.
    """
    return (
        "COALESCE("
        "NULLIF(string_agg(DISTINCT cc.credited_name, ', ' ORDER BY cc.credited_name), ''),"
        " ''"
        ") AS authors"
    )


def media_author_credits_join_sql(media_id_expr: str = "m.id") -> str:
    """``LEFT JOIN`` onto author-role credits for :func:`media_author_names_agg_sql`.

    ``media_id_expr`` is the outer query's media-id SQL expression.
    """
    return (
        f"LEFT JOIN contributor_credits cc ON cc.media_id = {media_id_expr} AND cc.role = 'author'"
    )


def load_contributor_credits_for_media(
    db: Session,
    media_ids: list[UUID],
) -> dict[UUID, list[ContributorCreditOut]]:
    """Batch-load ordered credits per media id, as narrowed embedded DTOs (D-33)."""
    credits_by_media: dict[UUID, list[ContributorCreditOut]] = {
        media_id: [] for media_id in media_ids
    }
    if not media_ids:
        return credits_by_media

    rows = db.execute(
        text(
            """
            SELECT
                cc.media_id,
                c.handle,
                c.display_name,
                cc.credited_name,
                cc.role,
                cc.raw_role,
                cc.ordinal
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.media_id = ANY(:media_ids)
            ORDER BY cc.media_id ASC, cc.ordinal ASC
            """
        ),
        {"media_ids": media_ids},
    ).fetchall()
    for row in rows:
        credits_by_media.setdefault(UUID(str(row[0])), []).append(_credit_out(row))
    return credits_by_media


def load_contributor_credits_for_podcasts(
    db: Session,
    podcast_ids: list[UUID],
) -> dict[UUID, list[ContributorCreditOut]]:
    """Batch-load ordered credits per podcast id, as narrowed embedded DTOs (D-33)."""
    credits_by_podcast: dict[UUID, list[ContributorCreditOut]] = {
        podcast_id: [] for podcast_id in podcast_ids
    }
    if not podcast_ids:
        return credits_by_podcast

    rows = db.execute(
        text(
            """
            SELECT
                cc.podcast_id,
                c.handle,
                c.display_name,
                cc.credited_name,
                cc.role,
                cc.raw_role,
                cc.ordinal
            FROM contributor_credits cc
            JOIN contributors c ON c.id = cc.contributor_id
            WHERE cc.podcast_id = ANY(:podcast_ids)
            ORDER BY cc.podcast_id ASC, cc.ordinal ASC
            """
        ),
        {"podcast_ids": podcast_ids},
    ).fetchall()
    for row in rows:
        credits_by_podcast.setdefault(UUID(str(row[0])), []).append(_credit_out(row))
    return credits_by_podcast


def current_gutenberg_author_names(
    db: Session,
    ebook_ids: list[int],
) -> dict[int, tuple[str, ...]]:
    """Ordered current author credited names per Gutenberg ebook (author role only).

    Backs the catalog sync's change detection (D-15): an ebook whose parsed author
    names differ from its stored slice is reprocessed; unchanged ebooks do zero
    credit DML. Read-only; the credit rows themselves mutate only via the facade.
    """
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
