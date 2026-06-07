"""Document-evidence retrievers (content chunks, evidence spans, fragments)."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import NotFoundError
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.search.constants import (
    CONTENT_CHUNK_ANN_CANDIDATE_MULTIPLIER,
    CONTENT_CHUNK_MIN_ANN_CANDIDATES,
    CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY,
)
from nexus.services.search.projection import (
    _direct_fragment_locator,
    _require_resolved_evidence,
    _snippet_around_query,
    _truncate_snippet,
)
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedContentChunkResult,
    _RankedEvidenceSpanResult,
    _RankedFragmentResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql
from nexus.services.search.sql import contributor_credits_rollup_cte_sql
from nexus.services.semantic_chunks import (
    to_pgvector_literal,
    transcript_embedding_dimensions,
    transcript_embedding_provider_for_model,
)


def _search_content_chunks(
    db: Session,
    viewer_id: UUID,
    q: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    has_query: bool,
    scope_type: str,
    scope_id: UUID | None,
    contributor_ids: list[UUID] | None,
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search active content chunks with lexical or hybrid semantic ranking."""
    scope_filter = ""
    embedding_dims = transcript_embedding_dimensions()
    ann_limit = max(
        CONTENT_CHUNK_MIN_ANN_CANDIDATES,
        int(limit) * CONTENT_CHUNK_ANN_CANDIDATE_MULTIPLIER,
    )
    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "query": q,
        "has_query": has_query,
        "limit": limit,
        "ann_limit": ann_limit,
        "min_semantic_similarity": CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY,
    }
    content_kind_filter = ""
    contributor_credit_filter = ""
    if content_kinds:
        content_kind_filter = "AND m.kind = ANY(:content_kinds)"
        params["content_kinds"] = content_kinds
    if contributor_ids is not None or roles:
        credit_clauses = ["cc_filter.media_id = m.id"]
        if contributor_ids is not None:
            credit_clauses.append("cc_filter.contributor_id = ANY(:contributor_ids)")
            params["contributor_ids"] = contributor_ids
        if roles:
            credit_clauses.append("cc_filter.role = ANY(:roles)")
            params["roles"] = roles
        contributor_credit_filter = f"""
            AND EXISTS (
                SELECT 1
                FROM contributor_credits cc_filter
                WHERE {" AND ".join(credit_clauses)}
            )
        """
    if semantic_query_embedding is not None:
        embedding_model, query_embedding = semantic_query_embedding
        params["query_embedding"] = to_pgvector_literal(query_embedding)
        params["query_embedding_provider"] = transcript_embedding_provider_for_model(
            embedding_model
        )
        params["query_embedding_model"] = embedding_model

    scope_clause = scope_filter_sql(scope_type, scope_id, "content_chunk")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params.update(scope_params)

    if semantic_query_embedding is not None:
        query = f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")}),
                query_embedding AS (
                    SELECT CAST(:query_embedding AS vector({embedding_dims})) AS embedding
                ),
                eligible_chunks AS (
                    SELECT
                        cc.id,
                        cc.media_id,
                        m.kind,
                        m.title,
                        m.published_date,
                        mcc.contributor_credits,
                        cc.chunk_text,
                        ts_headline(
                            'english',
                            cc.chunk_text,
                            websearch_to_tsquery('english', :query),
                            'MaxWords=50, MinWords=10, MaxFragments=1'
                        ) AS snippet,
                        cc.source_kind,
                        cc.primary_evidence_span_id,
                        cc.summary_locator,
                        cc.created_at,
                        cc.chunk_text_tsv,
                        mcis.active_embedding_provider,
                        mcis.active_embedding_model
                    FROM content_chunks cc
                    JOIN media m ON m.id = cc.media_id
                    JOIN visible_media vm ON vm.media_id = cc.media_id
                    JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                        AND mcis.status = 'ready'
                    LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                    WHERE TRUE
                    {scope_filter}
                    {content_kind_filter}
                    {contributor_credit_filter}
                ),
                semantic_candidates AS (
                    SELECT ec.id
                    FROM eligible_chunks ec
                    JOIN content_embeddings ce ON ce.chunk_id = ec.id
                        AND ce.embedding_provider = ec.active_embedding_provider
                        AND ce.embedding_model = ec.active_embedding_model
                        AND ce.embedding_dimensions = {embedding_dims}
                    JOIN query_embedding qe ON true
                    WHERE ec.active_embedding_provider = :query_embedding_provider
                      AND ec.active_embedding_model = :query_embedding_model
                    ORDER BY ce.embedding_vector <=> qe.embedding ASC, ec.id ASC
                    LIMIT :ann_limit
                ),
                lexical_candidates AS (
                    SELECT ec.id
                    FROM eligible_chunks ec
                    WHERE ec.chunk_text_tsv @@ websearch_to_tsquery('english', :query)
                    ORDER BY
                        ts_rank_cd(ec.chunk_text_tsv, websearch_to_tsquery('english', :query)) DESC,
                        ec.id ASC
                    LIMIT :ann_limit
                ),
                candidate_ids AS (
                    SELECT id FROM semantic_candidates
                    UNION
                    SELECT id FROM lexical_candidates
                ),
                scored_candidates AS (
                    SELECT
                        ec.id,
                        ec.media_id,
                        ec.kind,
                        ec.title,
                        ec.published_date,
                        ec.contributor_credits,
                        ec.chunk_text,
                        ec.snippet,
                        ec.source_kind,
                        ec.primary_evidence_span_id,
                        ec.summary_locator,
                        ec.created_at,
                        CASE
                            WHEN ce.chunk_id IS NULL THEN 0.0
                            ELSE (1 - (ce.embedding_vector <=> qe.embedding))
                        END AS semantic_similarity,
                        ts_rank_cd(ec.chunk_text_tsv, websearch_to_tsquery('english', :query))
                            AS lexical_score
                    FROM candidate_ids ci
                    JOIN eligible_chunks ec ON ec.id = ci.id
                    JOIN query_embedding qe ON true
                    LEFT JOIN content_embeddings ce ON ce.chunk_id = ec.id
                        AND ce.embedding_provider = ec.active_embedding_provider
                        AND ce.embedding_model = ec.active_embedding_model
                        AND ce.embedding_dimensions = {embedding_dims}
                        AND ec.active_embedding_provider = :query_embedding_provider
                        AND ec.active_embedding_model = :query_embedding_model
                )
            SELECT
                id,
                media_id,
                kind,
                title,
                published_date,
                contributor_credits,
                chunk_text,
                snippet,
                source_kind,
                primary_evidence_span_id,
                summary_locator,
                (
                    (0.45 * CASE WHEN lexical_score > 0.0 THEN 1.0 ELSE 0.0 END)
                    + (0.35 * GREATEST(semantic_similarity, 0.0))
                    + (0.15 * GREATEST(lexical_score, 0.0))
                    + (
                        0.05 * GREATEST(
                            0.0,
                            1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)
                        )
                    )
                ) AS raw_score
            FROM scored_candidates
            WHERE
                lexical_score > 0.0
                OR semantic_similarity >= :min_semantic_similarity
            ORDER BY raw_score DESC, id ASC
            LIMIT :limit
        """
    else:
        query = f"""
            WITH
                visible_media AS ({visible_media_ids_cte_sql()}),
                media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")}),
                lexical_candidates AS (
                    SELECT
                        cc.id,
                        cc.media_id,
                        m.kind,
                        m.title,
                        m.published_date,
                        mcc.contributor_credits,
                        cc.chunk_text,
                        CASE WHEN :has_query THEN ts_headline(
                            'english',
                            cc.chunk_text,
                            websearch_to_tsquery('english', :query),
                            'MaxWords=50, MinWords=10, MaxFragments=1'
                        ) ELSE left(cc.chunk_text, 300) END AS snippet,
                        cc.source_kind,
                        cc.primary_evidence_span_id,
                        cc.summary_locator,
                        cc.created_at,
                        CASE WHEN :has_query THEN
                            ts_rank_cd(cc.chunk_text_tsv, websearch_to_tsquery('english', :query))
                        ELSE 0.0 END AS lexical_score
                    FROM content_chunks cc
                    JOIN media m ON m.id = cc.media_id
                    JOIN visible_media vm ON vm.media_id = cc.media_id
                    JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                        AND mcis.status = 'ready'
                    LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                    WHERE
                        (:has_query IS FALSE OR cc.chunk_text_tsv @@ websearch_to_tsquery('english', :query))
                    {scope_filter}
                    {content_kind_filter}
                    {contributor_credit_filter}
                    ORDER BY lexical_score DESC, cc.id ASC
                    LIMIT :ann_limit
                )
            SELECT
                id,
                media_id,
                kind,
                title,
                published_date,
                contributor_credits,
                chunk_text,
                snippet,
                source_kind,
                primary_evidence_span_id,
                summary_locator,
                (
                    (0.20 * GREATEST(lexical_score, 0.0))
                    + (
                        0.05 * GREATEST(
                            0.0,
                            1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)
                        )
                    )
                ) AS raw_score
            FROM lexical_candidates
            WHERE :has_query IS FALSE OR lexical_score > 0.0
            ORDER BY raw_score DESC, id ASC
            LIMIT :limit
        """
    rows = db.execute(text(query), params).fetchall()
    results: list[InternalSearchResult] = []
    for row in rows:
        if row[9] is None:
            continue
        try:
            resolution = resolve_evidence_span(
                db,
                viewer_id=viewer_id,
                media_id=row[1],
                evidence_span_id=row[9],
            )
        except NotFoundError:
            continue
        try:
            _require_resolved_evidence(resolution)
        except NotFoundError:
            continue
        evidence_span_ids = [row[9]] if row[9] is not None else []
        snippet = _truncate_snippet(str(row[7] or row[6] or ""))
        if has_query and q.lower() not in snippet.lower().replace("<b>", "").replace("</b>", ""):
            query_snippet = _snippet_around_query(str(row[6] or ""), q)
            if query_snippet is not None:
                snippet = query_snippet
        results.append(
            _RankedContentChunkResult(
                id=row[0],
                snippet=snippet,
                source_kind=str(row[8]),
                evidence_span_ids=evidence_span_ids,
                citation_label=str(resolution["citation_label"]),
                locator=locator_from_resolution(
                    resolution,
                    media_id=row[1],
                    media_kind=str(row[2] or ""),
                ),
                resolver=dict(resolution["resolver"]),
                source=_build_search_source(row[1], row[2], row[3], row[5], row[4]),
                score=_build_search_score(row[11]),
            )
        )
    return results


def _search_fragments(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    scope_filter = ""
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
                m.published_date,
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
            LEFT JOIN media_content_index_states mcis ON mcis.media_id = f.media_id
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


def _search_evidence_spans(
    db: Session,
    viewer_id: UUID,
    q: str,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    scope_filter = ""
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
                es.media_id,
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
            JOIN visible_media vm ON vm.media_id = es.media_id
            JOIN media m ON m.id = es.media_id
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
                media_id=row[1],
                evidence_span_id=row[0],
            )
            _require_resolved_evidence(resolution)
        except NotFoundError:
            continue
        locator = locator_from_resolution(
            resolution,
            media_id=row[1],
            media_kind=str(row[4]),
        )
        results.append(
            _RankedEvidenceSpanResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[9] or row[2] or "")),
                citation_label=str(row[3] or resolution.get("citation_label") or ""),
                locator=locator,
                source=_build_search_source(row[1], row[4], row[5], row[7], row[6]),
                score=_build_search_score(row[8]),
            )
        )
    return results
