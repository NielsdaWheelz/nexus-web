"""Source-fragment search retrieval."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.contributor_credits import contributor_credits_rollup_cte_sql
from nexus.services.search.projection import _direct_fragment_locator, _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedFragmentResult,
    _SearchScore,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql

_FRAGMENT_ROW_COLUMNS = """
    f.id,
    f.idx,
    char_length(f.canonical_text),
    f.t_start_ms,
    f.t_end_ms,
    m.id AS media_id,
    m.kind,
    m.title,
    m.original_published_date,
    mcc.contributor_credits
"""

_FRAGMENT_INDEXED_ROWS_SQL = """
    FROM fragments f
    JOIN media m ON m.id = f.media_id
    JOIN visible_media vm ON vm.media_id = f.media_id
    JOIN content_index_states mcis ON mcis.owner_kind = 'media'
        AND mcis.owner_id = f.media_id
        AND mcis.status = 'ready'
"""

_FRAGMENT_VISIBLE_ROWS_SQL = f"""{_FRAGMENT_INDEXED_ROWS_SQL}
    LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
"""


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
                {_FRAGMENT_ROW_COLUMNS},
                ts_rank_cd(
                    f.canonical_text_tsv,
                    websearch_to_tsquery('english', :query)
                ) AS score
            {_FRAGMENT_VISIBLE_ROWS_SQL}
            WHERE f.canonical_text_tsv @@ websearch_to_tsquery('english', :query)
            {scope_filter}
            ORDER BY score DESC, f.idx ASC, f.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    results: list[InternalSearchResult] = []
    for row in rows:
        # Match locator admission using metadata; bodies and excerpts belong
        # only to the selected response page, after cross-type ranking.
        if not row[2]:
            continue
        if row[3] is not None and row[4] is not None:
            if not 0 <= row[3] < row[4]:
                continue
        elif row[6] == "pdf":
            continue
        results.append(
            _RankedFragmentResult(
                id=row[0],
                idx=int(row[1]),
                query=q,
                source=_build_search_source(row[5], row[6], row[7], row[9], row[8]),
                score=_build_search_score(row[10]),
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
            SELECT {_FRAGMENT_ROW_COLUMNS}
            {_FRAGMENT_VISIBLE_ROWS_SQL}
            WHERE f.id = :id
            """
        ),
        {"viewer_id": viewer_id, "id": result_id},
    ).first()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    return _RankedFragmentResult(
        id=row[0],
        idx=int(row[1]),
        query=None,
        source=_build_search_source(row[5], row[6], row[7], row[9], row[8]),
        score=score,
    )


def read_fragment_search_content(
    db: Session, *, viewer_id: UUID, result: _RankedFragmentResult
) -> tuple[str, dict[str, Any]]:
    """Read a selected fragment's original excerpt and complete locator."""
    row = db.execute(
        text(
            f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT f.canonical_text, f.t_start_ms, f.t_end_ms, m.id, m.kind,
                CASE WHEN CAST(:query AS text) IS NULL THEN NULL
                ELSE ts_headline(
                    'english', f.canonical_text,
                    websearch_to_tsquery('english', :query),
                    'MaxWords=50, MinWords=10, MaxFragments=1'
                ) END AS snippet
            {_FRAGMENT_INDEXED_ROWS_SQL}
            WHERE f.id = :id
            """
        ),
        {"viewer_id": viewer_id, "id": result.id, "query": result.query},
    ).first()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    body = str(row[0] or "")
    locator = _direct_fragment_locator(
        media_id=row[3],
        media_kind=str(row[4] or ""),
        fragment_id=result.id,
        text_value=body,
        start_offset=0,
        end_offset=len(body),
        exact=body,
        t_start_ms=int(row[1]) if row[1] is not None else None,
        t_end_ms=int(row[2]) if row[2] is not None else None,
    )
    if locator is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    snippet = str(row[5] or body) if result.query is not None else body
    return _truncate_snippet(snippet), locator
