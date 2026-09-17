"""Evidence-span search retrieval."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.contributor_credits import contributor_credits_rollup_cte_sql
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.projection import _require_resolved_evidence, _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedEvidenceSpanResult,
    _SearchScore,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql


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
                m.original_published_date,
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


def resolve_evidence_span_search_result(
    db: Session,
    *,
    viewer_id: UUID,
    result_id: UUID,
    score: _SearchScore,
) -> _RankedEvidenceSpanResult:
    """Rematerialize one visible, indexed evidence-span search row."""
    row = db.execute(
        text(
            f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
            SELECT
                es.id,
                es.owner_kind,
                es.owner_id,
                es.span_text,
                es.citation_label,
                m.kind,
                m.title,
                m.original_published_date,
                mcc.contributor_credits,
                nb.user_id AS note_user_id
            FROM evidence_spans es
            LEFT JOIN media m ON m.id = es.owner_id AND es.owner_kind = 'media'
            LEFT JOIN visible_media vm ON vm.media_id = es.owner_id
            LEFT JOIN note_blocks nb ON nb.id = es.owner_id AND es.owner_kind = 'note_block'
            JOIN content_index_states cis ON cis.owner_kind = es.owner_kind
                AND cis.owner_id = es.owner_id
                AND cis.status = 'ready'
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE es.id = :id
              AND (
                    vm.media_id IS NOT NULL
                    OR nb.user_id = :viewer_id
                  )
            """
        ),
        {"viewer_id": viewer_id, "id": result_id},
    ).first()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    resolution = resolve_evidence_span(
        db,
        viewer_id=viewer_id,
        evidence_span_id=row[0],
    )
    _require_resolved_evidence(resolution)
    owner_kind = str(row[1])
    source_kind = str(row[5] or "note") if owner_kind == "media" else owner_kind
    source_title = str(row[6] if owner_kind == "media" else "Note")
    return _RankedEvidenceSpanResult(
        id=row[0],
        snippet=_truncate_snippet(str(row[3] or "")),
        citation_label=str(row[4] or resolution.get("citation_label") or ""),
        locator=locator_from_resolution(
            resolution,
            media_id=row[2],
            media_kind=source_kind,
        ),
        source=_build_search_source(
            row[2],
            source_kind,
            source_title,
            row[8] if owner_kind == "media" else None,
            row[7] if owner_kind == "media" else None,
        ),
        score=score,
        owner_ref=ResourceRef(
            scheme="media" if owner_kind == "media" else "note_block",
            id=row[2],
        ),
    )
