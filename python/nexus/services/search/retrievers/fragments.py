"""Source-fragment search retrieval."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.search.projection import _direct_fragment_locator, _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedFragmentResult,
    _SearchScore,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql
from nexus.services.search.sql import contributor_credits_rollup_cte_sql


def _search_fragments(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}
    scope_clause = scope_filter_sql(scope_type, scope_id, "fragment")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params.update(scope_params)

    rows = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
            SELECT
                f.id,
                f.idx,
                f.canonical_text,
                f.t_start_ms,
                f.t_end_ms,
                nav.location_id AS section_id,
                m.id AS media_id,
                m.kind,
                m.title,
                m.original_published_date,
                mcc.contributor_credits,
                ts_rank_cd(
                    to_tsvector('english', f.canonical_text),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    f.canonical_text,
                    websearch_to_tsquery('english', :query),
                    'MaxWords=50, MinWords=10, MaxFragments=1'
                ) AS snippet
            FROM fragments f
            JOIN media m ON m.id = f.media_id
            JOIN visible_media vm ON vm.media_id = f.media_id
            LEFT JOIN LATERAL (
                SELECT location_id
                FROM epub_nav_locations nav
                WHERE nav.media_id = f.media_id
                  AND nav.fragment_idx <= f.idx
                ORDER BY nav.fragment_idx DESC, nav.ordinal DESC
                LIMIT 1
            ) nav ON true
            JOIN content_index_states mcis ON mcis.owner_kind = 'media'
                AND mcis.owner_id = f.media_id
                AND mcis.status = 'ready'
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE to_tsvector('english', f.canonical_text) @@ websearch_to_tsquery('english', :query)
            {scope_filter}
            ORDER BY score DESC, f.idx ASC, f.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    results: list[InternalSearchResult] = []
    for row in rows:
        locator = _direct_fragment_locator(
            media_id=row[6],
            media_kind=str(row[7] or ""),
            fragment_id=row[0],
            text_value=str(row[2] or ""),
            start_offset=0,
            end_offset=len(str(row[2] or "")),
            exact=str(row[2] or ""),
            t_start_ms=int(row[3]) if row[3] is not None else None,
            t_end_ms=int(row[4]) if row[4] is not None else None,
            section_id=str(row[5]) if row[5] is not None else None,
        )
        if locator is None:
            continue
        results.append(
            _RankedFragmentResult(
                id=row[0],
                idx=int(row[1]),
                snippet=_truncate_snippet(str(row[12] or row[2] or "")),
                source=_build_search_source(row[6], row[7], row[8], row[10], row[9]),
                score=_build_search_score(row[11]),
                citation_label=f"fragment {int(row[1]) + 1}",
                locator=locator,
            )
        )
    return results


def resolve_fragment_search_result(
    db: Session,
    *,
    viewer_id: UUID,
    result_id: UUID,
    score: _SearchScore,
) -> _RankedFragmentResult:
    """Rematerialize one visible, indexed source-fragment search row."""
    row = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
            SELECT
                f.id,
                f.idx,
                f.canonical_text,
                f.t_start_ms,
                f.t_end_ms,
                nav.location_id AS section_id,
                m.id,
                m.kind,
                m.title,
                m.original_published_date,
                mcc.contributor_credits
            FROM fragments f
            JOIN media m ON m.id = f.media_id
            JOIN visible_media vm ON vm.media_id = f.media_id
            LEFT JOIN LATERAL (
                SELECT location_id
                FROM epub_nav_locations nav
                WHERE nav.media_id = f.media_id
                  AND nav.fragment_idx <= f.idx
                ORDER BY nav.fragment_idx DESC, nav.ordinal DESC
                LIMIT 1
            ) nav ON true
            JOIN content_index_states mcis ON mcis.owner_kind = 'media'
                AND mcis.owner_id = f.media_id
                AND mcis.status = 'ready'
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE f.id = :id
            """
        ),
        {"viewer_id": viewer_id, "id": result_id},
    ).first()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    locator = _direct_fragment_locator(
        media_id=row[6],
        media_kind=str(row[7] or ""),
        fragment_id=row[0],
        text_value=str(row[2] or ""),
        start_offset=0,
        end_offset=len(str(row[2] or "")),
        exact=str(row[2] or ""),
        t_start_ms=int(row[3]) if row[3] is not None else None,
        t_end_ms=int(row[4]) if row[4] is not None else None,
        section_id=str(row[5]) if row[5] is not None else None,
    )
    if locator is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    return _RankedFragmentResult(
        id=row[0],
        idx=int(row[1]),
        snippet=_truncate_snippet(str(row[2] or "")),
        source=_build_search_source(row[6], row[7], row[8], row[10], row[9]),
        score=score,
        citation_label=f"fragment {int(row[1]) + 1}",
        locator=locator,
    )
