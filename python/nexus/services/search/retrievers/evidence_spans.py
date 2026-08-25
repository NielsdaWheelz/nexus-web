"""Evidence-span search retrieval."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import NotFoundError
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.projection import _require_resolved_evidence, _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedEvidenceSpanResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql
from nexus.services.search.sql import contributor_credits_rollup_cte_sql


def _search_evidence_spans(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    params: dict[str, Any] = {"viewer_id": viewer_id, "query": q, "limit": limit}
    scope_clause = scope_filter_sql(scope_type, scope_id, "evidence_span")
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
                es.id,
                es.owner_id AS media_id,
                es.span_text,
                es.citation_label,
                m.kind,
                m.title,
                m.published_date,
                mcc.contributor_credits,
                ts_rank_cd(
                    to_tsvector('english', es.span_text),
                    websearch_to_tsquery('english', :query)
                ) AS score,
                ts_headline(
                    'english',
                    es.span_text,
                    websearch_to_tsquery('english', :query),
                    'MaxWords=50, MinWords=10, MaxFragments=1'
                ) AS snippet
            FROM evidence_spans es
            JOIN visible_media vm ON vm.media_id = es.owner_id AND es.owner_kind = 'media'
            JOIN media m ON m.id = es.owner_id
            JOIN content_index_states mcis ON mcis.owner_kind = es.owner_kind
                AND mcis.owner_id = es.owner_id
                AND mcis.status = 'ready'
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE to_tsvector('english', es.span_text)
                  @@ websearch_to_tsquery('english', :query)
              {scope_filter}
            ORDER BY score DESC, es.id ASC
            LIMIT :limit
            """
        ),
        params,
    ).fetchall()
    results: list[InternalSearchResult] = []
    for row in rows:
        try:
            resolution = resolve_evidence_span(
                db,
                viewer_id=viewer_id,
                evidence_span_id=row[0],
            )
            _require_resolved_evidence(resolution)
        except NotFoundError:
            continue
        results.append(
            _RankedEvidenceSpanResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[9] or row[2] or "")),
                citation_label=str(row[3] or resolution.get("citation_label") or ""),
                locator=locator_from_resolution(
                    resolution,
                    media_id=row[1],
                    media_kind=str(row[4]),
                ),
                source=_build_search_source(row[1], row[4], row[5], row[7], row[6]),
                score=_build_search_score(row[8]),
                owner_ref=ResourceRef(scheme="media", id=row[1]),
            )
        )
    return results
