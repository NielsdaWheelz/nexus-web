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

from typing import Any, cast
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


# ---------------------------------------------------------------------------
# CUTOVER-SCAFFOLD (deleted in S5)
#
# Legacy write/preview entry points kept importable only so the S4 adapter
# files (pdf/epub/web/x/youtube/email/podcasts/gutenberg/enrichment) keep
# collecting until they migrate to typed observations and
# ``contributors.replace_observed_role_slices``. Their behavior is gone with
# the old schema; calling them is a defect.
# ---------------------------------------------------------------------------


def replace_media_contributor_credits(
    db: Session,
    *,
    media_id: UUID,
    credits: list[dict[str, Any]],
    source: str | None = None,
) -> None:
    raise NotImplementedError(
        "CUTOVER-SCAFFOLD: emit a typed observation and call "
        "contributors.replace_observed_role_slices instead"
    )


def replace_machine_derived_media_author_credits(
    db: Session,
    *,
    media_id: UUID,
    names: list[str],
    source: str,
    source_ref: dict[str, Any] | None = None,
) -> None:
    raise NotImplementedError(
        "CUTOVER-SCAFFOLD: emit a typed observation and call "
        "contributors.replace_observed_role_slices instead"
    )


def replace_podcast_contributor_credits(
    db: Session,
    *,
    podcast_id: UUID,
    credits: list[dict[str, Any]],
    source: str | None = None,
) -> None:
    raise NotImplementedError(
        "CUTOVER-SCAFFOLD: emit a typed observation and call "
        "contributors.replace_observed_role_slices instead"
    )


def replace_gutenberg_contributor_credits(
    db: Session,
    *,
    ebook_id: int,
    credits: list[dict[str, Any]],
    source: str | None = None,
) -> None:
    raise NotImplementedError(
        "CUTOVER-SCAFFOLD: emit a typed observation and call "
        "contributors.replace_observed_role_slices_batch instead"
    )


def upstream_contributor_credit_previews_for_names(
    db: Session,
    names: list[str],
    *,
    role: str = "author",
    source: str = "local",
) -> list[ContributorCreditOut]:
    raise NotImplementedError(
        "CUTOVER-SCAFFOLD: podcast previews become handle-less text facts (D-9); "
        "build narrowed ContributorCreditOut rows directly"
    )
