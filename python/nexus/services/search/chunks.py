"""The indexed-passage retrievers: hybrid lexical ∪ ANN over ``content_chunks``.

One pipeline serves document chunks, note chunks, and Oracle's candidate
probe. Only chunks whose owner index is ``ready`` on the query's active
provider/model are eligible, so a partially rebuilt index is never visible.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import highlight_readability_sql, visible_media_ids_cte_sql
from nexus.db.models import NoteBlock
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.contributor_credits import (
    contributor_credits_rollup_cte_sql,
    credit_target_filter_exists_sql,
)
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.resource_graph.highlight_notes import highlight_excerpts_for_note_blocks
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.search.projection import _snippet_around_query, _truncate_snippet
from nexus.services.search.query import SearchScope
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _build_search_source,
    _RankedContentChunkResult,
    _RankedEvidenceSpanResult,
    _RankedNoteBlockResult,
    _SearchScore,
)
from nexus.services.search.scope import scope_filter_sql
from nexus.services.semantic_chunks import (
    to_pgvector_literal,
    transcript_embedding_dimensions,
    transcript_embedding_provider_for_model,
)

MIN_ANN_CANDIDATES = 200
ANN_CANDIDATE_MULTIPLIER = 20
# ANN nearest neighbours alone are not matches: cosine must clear this floor.
MIN_SEMANTIC_SIMILARITY = 0.50

_TSQUERY = "websearch_to_tsquery('english', :query)"
_HEADLINE = (
    f"ts_headline('english', cc.chunk_text, {_TSQUERY}, 'MaxWords=50, MinWords=10, MaxFragments=1')"
)
# Half-life recency bonus, on documents only: a note's age never reorders it.
_RECENCY = """
                + (0.05 * GREATEST(0.0,
                    1.0 - LEAST(EXTRACT(EPOCH FROM (now() - created_at)) / 604800.0, 1.0)))"""


def _hybrid_sql(
    *, leading: str, carry: str, projection: str, tie: str, recency: bool, dims: int
) -> str:
    """Lexical ∪ ANN over the caller's owner-gated ``eligible_chunks`` relation.

    The caller supplies the leading CTE block (through ``eligible_chunks`` and
    ``query_embedding``), the extra column it carries through scoring, the final
    projection from ``ranked_candidates``, and the deterministic tie column.
    """
    return f"""
        WITH {leading},
            semantic_candidates AS (
                SELECT ec.id FROM eligible_chunks ec
                JOIN content_embeddings ce ON ce.chunk_id = ec.id
                    AND ce.embedding_provider = ec.active_embedding_provider
                    AND ce.embedding_model = ec.active_embedding_model
                    AND ce.embedding_dimensions = {dims}
                JOIN query_embedding qe ON true
                WHERE ec.active_embedding_provider = :query_embedding_provider
                  AND ec.active_embedding_model = :query_embedding_model
                ORDER BY ce.embedding_vector <=> qe.embedding ASC, ec.id ASC
                LIMIT :ann_limit
            ),
            lexical_candidates AS (
                SELECT ec.id FROM eligible_chunks ec
                WHERE ec.chunk_text_tsv @@ {_TSQUERY}
                ORDER BY ts_rank_cd(ec.chunk_text_tsv, {_TSQUERY}) DESC, ec.id ASC
                LIMIT :ann_limit
            ),
            candidate_ids AS (
                SELECT id FROM semantic_candidates UNION SELECT id FROM lexical_candidates
            ),
            scored_candidates AS (
                SELECT ec.id, {carry}
                    CASE WHEN ce.chunk_id IS NULL THEN 0.0
                         ELSE (1 - (ce.embedding_vector <=> qe.embedding)) END AS semantic_similarity,
                    ts_rank_cd(ec.chunk_text_tsv, {_TSQUERY}) AS lexical_score
                FROM candidate_ids ci
                JOIN eligible_chunks ec ON ec.id = ci.id
                JOIN query_embedding qe ON true
                LEFT JOIN content_embeddings ce ON ce.chunk_id = ec.id
                    AND ce.embedding_provider = ec.active_embedding_provider
                    AND ce.embedding_model = ec.active_embedding_model
                    AND ce.embedding_dimensions = {dims}
                    AND ec.active_embedding_provider = :query_embedding_provider
                    AND ec.active_embedding_model = :query_embedding_model
            ),
            ranked_candidates AS MATERIALIZED (
                SELECT *, (
                    (0.45 * CASE WHEN lexical_score > 0.0 THEN 1.0 ELSE 0.0 END)
                    + (0.35 * GREATEST(semantic_similarity, 0.0))
                    + (0.15 * GREATEST(lexical_score, 0.0)){_RECENCY if recency else ""}
                ) AS raw_score
                FROM scored_candidates
                WHERE lexical_score > 0.0 OR semantic_similarity >= :min_semantic_similarity
                ORDER BY raw_score DESC, {tie} ASC
                LIMIT :limit
            )
        {projection}
    """


def _lexical_sql(
    *, leading: str, carry: str, projection: str, tie: str, recency: bool, gated: bool
) -> str:
    """The same pipeline with no query embedding available."""
    rank = f"ts_rank_cd(ec.chunk_text_tsv, {_TSQUERY})"
    return f"""
        WITH {leading},
            lexical_candidates AS (
                SELECT ec.id, {carry}
                    {f"CASE WHEN :has_query THEN {rank} ELSE 0.0 END" if gated else rank}
                        AS lexical_score
                FROM eligible_chunks ec
                WHERE {
        f"(:has_query IS FALSE OR ec.chunk_text_tsv @@ {_TSQUERY})"
        if gated
        else f"ec.chunk_text_tsv @@ {_TSQUERY}"
    }
                ORDER BY lexical_score DESC, ec.{tie} ASC
                LIMIT :ann_limit
            ),
            ranked_candidates AS MATERIALIZED (
                SELECT id, {carry.replace("ec.", "")}
                    ((0.20 * GREATEST(lexical_score, 0.0)){
        _RECENCY if recency else ""
    }) AS raw_score
                FROM lexical_candidates
                WHERE {
        ":has_query IS FALSE OR lexical_score > 0.0" if gated else "lexical_score > 0.0"
    }
                ORDER BY raw_score DESC, {tie} ASC
                LIMIT :limit
            )
        {projection}
    """


def _embedding_params(
    params: dict[str, Any], semantic_embedding: tuple[str, list[float]] | None
) -> None:
    if semantic_embedding is None:
        return
    model, vector = semantic_embedding
    params["query_embedding"] = to_pgvector_literal(vector)
    params["query_embedding_provider"] = transcript_embedding_provider_for_model(model)
    params["query_embedding_model"] = model


def _query_embedding_cte(dims: int) -> str:
    return f"query_embedding AS (SELECT CAST(:query_embedding AS vector({dims})) AS embedding)"


def _ann_limit(limit: int) -> int:
    return max(MIN_ANN_CANDIDATES, int(limit) * ANN_CANDIDATE_MULTIPLIER)


def _require_resolved_evidence(resolution: dict[str, Any]) -> None:
    resolver = resolution.get("resolver")
    if not isinstance(resolver, dict) or resolver.get("status") != "resolved":
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result is stale")


# =============================================================================
# Document passages
# =============================================================================


def search_content_chunks(
    db: Session,
    viewer_id: UUID,
    *,
    q: str,
    has_query: bool,
    semantic_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    contributor_ids: list[UUID] | None,
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Indexed document passages, hybrid when an embedding is available."""
    cell = scope_filter_sql(scope_type, scope_id, "content_chunk")
    if cell is None:
        return []
    scope_sql, params = cell
    dims = transcript_embedding_dimensions()
    params |= {
        "viewer_id": viewer_id,
        "query": q,
        "has_query": has_query,
        "limit": limit,
        "ann_limit": _ann_limit(limit),
        "min_semantic_similarity": MIN_SEMANTIC_SIMILARITY,
    }
    _embedding_params(params, semantic_embedding)
    kind_filter = ""
    if content_kinds:
        params["content_kinds"] = content_kinds
        kind_filter = "AND m.kind = ANY(:content_kinds)"
    credit_filter = ""
    if contributor_ids is not None or roles:
        if contributor_ids is not None:
            params["contributor_ids"] = contributor_ids
        if roles:
            params["roles"] = roles
        credit_filter = credit_target_filter_exists_sql(
            "media_id",
            "m.id",
            filter_contributor_ids=contributor_ids is not None,
            filter_roles=bool(roles),
        )

    # NOT MATERIALIZED so branch filters and index lookups reach the source
    # instead of materializing every visible chunk's text vector three times.
    eligible = f"""eligible_chunks AS NOT MATERIALIZED (
                SELECT cc.id, cc.created_at, cc.chunk_text_tsv,
                       mcis.active_embedding_provider, mcis.active_embedding_model
                FROM content_chunks cc
                JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                JOIN visible_media vm ON vm.media_id = cc.owner_id
                JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                    AND mcis.owner_id = cc.owner_id AND mcis.status = 'ready'
                WHERE TRUE {scope_sql} {kind_filter} {credit_filter}
            )"""
    # The materialized final limit is the evaluation boundary for snippets and
    # contributor metadata; neither belongs in the multiply-read eligible CTE.
    snippet = (
        _HEADLINE
        if semantic_embedding is not None
        else f"CASE WHEN :has_query THEN {_HEADLINE} ELSE left(cc.chunk_text, 300) END"
    )
    rollup = contributor_credits_rollup_cte_sql(
        "media_id", owner_predicate="cc.media_id IN (SELECT media_id FROM ranked_media)"
    )
    projection = f"""
            , ranked_media AS (
                SELECT DISTINCT cc.owner_id AS media_id
                FROM ranked_candidates ranked JOIN content_chunks cc ON cc.id = ranked.id
            ), media_contributor_credits AS ({rollup})
            SELECT cc.id, cc.owner_id AS media_id, m.kind, m.title, m.original_published_date,
                   mcc.contributor_credits, cc.chunk_text, {snippet} AS snippet,
                   cc.source_kind, cc.primary_evidence_span_id, ranked.raw_score
            FROM ranked_candidates ranked
            JOIN content_chunks cc ON cc.id = ranked.id
            JOIN media m ON m.id = cc.owner_id
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            ORDER BY ranked.raw_score DESC, ranked.id ASC
        """
    leading = f"visible_media AS ({visible_media_ids_cte_sql()}), {eligible}"
    if semantic_embedding is not None:
        statement = _hybrid_sql(
            leading=f"{leading}, {_query_embedding_cte(dims)}",
            carry="ec.created_at,",
            projection=projection,
            tie="id",
            recency=True,
            dims=dims,
        )
    else:
        statement = _lexical_sql(
            leading=leading,
            carry="ec.created_at,",
            projection=projection,
            tie="id",
            recency=True,
            gated=True,
        )

    results: list[InternalSearchResult] = []
    for row in db.execute(text(statement), params).mappings():
        span_id = row["primary_evidence_span_id"]
        if span_id is None:
            continue
        try:
            resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=span_id)
            _require_resolved_evidence(resolution)
        except NotFoundError:
            continue
        chunk_text = str(row["chunk_text"] or "")
        snippet_text = _truncate_snippet(str(row["snippet"] or chunk_text))
        plain = snippet_text.replace("<b>", "").replace("</b>", "")
        if has_query and q.lower() not in plain.lower():
            snippet_text = _snippet_around_query(chunk_text, q) or snippet_text
        results.append(
            _RankedContentChunkResult(
                id=row["id"],
                snippet=snippet_text,
                source_kind=str(row["source_kind"]),
                evidence_span_ids=[span_id],
                citation_label=str(resolution["citation_label"]),
                locator=locator_from_resolution(
                    resolution, media_id=row["media_id"], media_kind=str(row["kind"] or "")
                ),
                source=_build_search_source(
                    row["media_id"],
                    row["kind"],
                    row["title"],
                    row["contributor_credits"],
                    row["original_published_date"],
                ),
                score=_build_search_score(row["raw_score"]),
            )
        )
    return results


def resolve_content_chunk(
    db: Session,
    *,
    viewer_id: UUID,
    result_id: UUID,
    score: _SearchScore,
    evidence_span_ids: list[UUID] | None,
) -> _RankedContentChunkResult:
    """Re-materialize one visible, indexed document passage."""
    row = (
        db.execute(
            text(
                f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()}),
                 media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
            SELECT cc.id, cc.owner_id AS media_id, m.kind, m.title, m.original_published_date,
                   mcc.contributor_credits, cc.chunk_text, cc.source_kind,
                   cc.primary_evidence_span_id
            FROM content_chunks cc
            JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
            JOIN visible_media vm ON vm.media_id = cc.owner_id
            JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                AND mcis.owner_id = cc.owner_id AND mcis.status = 'ready'
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE cc.id = :id AND cc.owner_kind = 'media' AND vm.media_id IS NOT NULL
            """
            ),
            {"viewer_id": viewer_id, "id": result_id},
        )
        .mappings()
        .first()
    )
    span_id = None if row is None else row["primary_evidence_span_id"]
    if row is None or span_id is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    if evidence_span_ids and span_id not in evidence_span_ids:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=span_id)
    _require_resolved_evidence(resolution)
    # The reopen row reports the media kind where discovery reports the chunk's.
    media_kind = str(row["kind"])
    return _RankedContentChunkResult(
        id=row["id"],
        snippet=_truncate_snippet(str(row["chunk_text"] or "")),
        source_kind=str(row["source_kind"]),
        evidence_span_ids=[span_id],
        citation_label=str(resolution["citation_label"]),
        locator=locator_from_resolution(
            resolution, media_id=row["media_id"], media_kind=media_kind
        ),
        source=_build_search_source(
            row["media_id"],
            media_kind,
            str(row["title"]),
            row["contributor_credits"],
            row["original_published_date"],
        ),
        score=score,
    )


def resolve_evidence_span_result(
    db: Session, *, viewer_id: UUID, result_id: UUID, score: _SearchScore
) -> _RankedEvidenceSpanResult:
    """Re-materialize one durable evidence span a chat citation points at."""
    row = (
        db.execute(
            text(
                f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()}),
                 media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
            SELECT es.id, es.owner_kind, es.owner_id, es.span_text, es.citation_label,
                   m.kind, m.title, m.original_published_date, mcc.contributor_credits
            FROM evidence_spans es
            LEFT JOIN media m ON m.id = es.owner_id AND es.owner_kind = 'media'
            LEFT JOIN visible_media vm ON vm.media_id = es.owner_id
            LEFT JOIN note_blocks nb ON nb.id = es.owner_id AND es.owner_kind = 'note_block'
            JOIN content_index_states cis ON cis.owner_kind = es.owner_kind
                AND cis.owner_id = es.owner_id AND cis.status = 'ready'
            LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
            WHERE es.id = :id AND (vm.media_id IS NOT NULL OR nb.user_id = :viewer_id)
            """
            ),
            {"viewer_id": viewer_id, "id": result_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    resolution = resolve_evidence_span(db, viewer_id=viewer_id, evidence_span_id=row["id"])
    _require_resolved_evidence(resolution)
    owned_by_media = str(row["owner_kind"]) == "media"
    source_kind = str(row["kind"] or "note") if owned_by_media else str(row["owner_kind"])
    return _RankedEvidenceSpanResult(
        id=row["id"],
        snippet=_truncate_snippet(str(row["span_text"] or "")),
        citation_label=str(row["citation_label"] or resolution.get("citation_label") or ""),
        locator=locator_from_resolution(
            resolution, media_id=row["owner_id"], media_kind=source_kind
        ),
        source=_build_search_source(
            row["owner_id"],
            source_kind,
            str(row["title"] if owned_by_media else "Note"),
            row["contributor_credits"] if owned_by_media else None,
            row["original_published_date"] if owned_by_media else None,
        ),
        score=score,
        owner_ref=ResourceRef(
            scheme="media" if owned_by_media else "note_block", id=row["owner_id"]
        ),
    )


# =============================================================================
# Note passages
# =============================================================================


def search_note_chunks(
    db: Session,
    viewer_id: UUID,
    *,
    q: str,
    semantic_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
    highlight_notes_only: bool = False,
) -> list[InternalSearchResult]:
    """Note-block hits over the same chunk machinery that serves documents."""
    cell = scope_filter_sql(scope_type, scope_id, "note_block")
    if cell is None:
        return []
    scope_sql, params = cell
    dims = transcript_embedding_dimensions()
    params |= {
        "viewer_id": viewer_id,
        "query": q,
        "limit": limit,
        "ann_limit": _ann_limit(limit),
        "min_semantic_similarity": MIN_SEMANTIC_SIMILARITY,
    }
    _embedding_params(params, semantic_embedding)
    origin_filter = (
        f"""
            AND EXISTS (
                SELECT 1 FROM resource_edges edge
                JOIN highlights h ON h.id = edge.source_id AND edge.source_scheme = 'highlight'
                WHERE edge.user_id = :viewer_id AND edge.origin = 'highlight_note'
                  AND edge.target_scheme = 'note_block' AND edge.target_id = note_block.id
                  AND {highlight_readability_sql("h")}
            )"""
        if highlight_notes_only
        else ""
    )
    leading = f"""owned_notes AS (
                SELECT note_block.id FROM note_blocks note_block
                WHERE note_block.user_id = :viewer_id {origin_filter}
            ),
            eligible_chunks AS (
                SELECT cc.id, cc.owner_id AS note_block_id, cc.chunk_text_tsv,
                       mcis.active_embedding_provider, mcis.active_embedding_model
                FROM content_chunks cc
                JOIN owned_notes note ON note.id = cc.owner_id AND cc.owner_kind = 'note_block'
                JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                    AND mcis.owner_id = cc.owner_id AND mcis.status = 'ready'
                WHERE TRUE {scope_sql}
            )"""
    projection = f"""
            SELECT ranked.note_block_id, cc.chunk_text, {_HEADLINE} AS snippet,
                   cc.summary_locator, ranked.raw_score
            FROM ranked_candidates ranked
            JOIN content_chunks cc ON cc.id = ranked.id
            ORDER BY ranked.raw_score DESC, ranked.note_block_id ASC
        """
    if semantic_embedding is not None:
        statement = _hybrid_sql(
            leading=f"{leading}, {_query_embedding_cte(dims)}",
            carry="ec.note_block_id,",
            projection=projection,
            tie="note_block_id",
            recency=False,
            dims=dims,
        )
    else:
        statement = _lexical_sql(
            leading=leading,
            carry="ec.note_block_id,",
            projection=projection,
            tie="note_block_id",
            recency=False,
            gated=False,
        )

    best: dict[UUID, dict[str, Any]] = {}
    for row in db.execute(text(statement), params).mappings():
        block_id = UUID(str(row["note_block_id"]))
        if block_id not in best:
            best[block_id] = dict(row)
    excerpts = {
        note_id: _truncate_snippet(exact)
        for note_id, exact in highlight_excerpts_for_note_blocks(
            db, viewer_id=viewer_id, note_ids=list(best)
        ).items()
    }
    results: list[InternalSearchResult] = []
    for block_id, row in best.items():
        locator = row["summary_locator"]
        results.append(
            _RankedNoteBlockResult(
                id=block_id,
                snippet=_truncate_snippet(str(row["snippet"] or "")),
                body_text=str(row["chunk_text"] or ""),
                score=_build_search_score(row["raw_score"]),
                highlight_excerpt=excerpts.get(block_id),
                note_origin="highlight_note" if block_id in excerpts else "note",
                locator=retrieval_locator_json(
                    {
                        "type": "note_block_offsets",
                        "block_id": str(locator["note_block_id"]),
                        "start_offset": int(locator["start_offset"]),
                        "end_offset": int(locator["end_offset"]),
                    }
                ),
            )
        )
    return results


def resolve_note_block(
    db: Session, *, viewer_id: UUID, result_id: UUID, score: _SearchScore
) -> _RankedNoteBlockResult:
    """Re-materialize one viewer-owned, indexed note block."""
    block = db.get(NoteBlock, result_id)
    if block is None or block.user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    ready = db.execute(
        text(
            """
            SELECT 1 FROM content_index_states
            WHERE owner_kind = 'note_block' AND owner_id = :block_id AND status = 'ready'
            """
        ),
        {"block_id": block.id},
    ).first()
    body_text = str(block.body_text or "")
    if ready is None or not body_text:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
    excerpt = highlight_excerpts_for_note_blocks(db, viewer_id=viewer_id, note_ids=[block.id]).get(
        block.id
    )
    return _RankedNoteBlockResult(
        id=block.id,
        snippet=_truncate_snippet(body_text),
        body_text=block.body_text,
        score=score,
        highlight_excerpt=_truncate_snippet(excerpt) if excerpt else None,
        note_origin="highlight_note" if excerpt else "note",
        locator=retrieval_locator_json(
            {
                "type": "note_block_offsets",
                "block_id": str(block.id),
                "start_offset": 0,
                "end_offset": len(body_text),
            }
        ),
    )


# =============================================================================
# Oracle's semantic candidate probe
# =============================================================================


@dataclass(frozen=True)
class ContentChunkCandidate:
    """One semantically-ranked chunk with its citation/source anchoring."""

    content_chunk_id: UUID
    owner_kind: str  # "media" | "note_block"
    owner_id: UUID
    chunk_text: str
    source_kind: str
    heading_path: list[str]
    primary_evidence_span_id: UUID | None
    title: str  # media title, or "Note" for note-owned chunks
    semantic_score: float


def retrieve_content_chunk_candidates(
    db: Session,
    *,
    viewer_id: UUID,
    query_embedding: tuple[str, list[float]],
    scope: SearchScope,
    limit: int = 200,
) -> list[ContentChunkCandidate]:
    """Semantic chunk candidates for ``viewer_id``, ordered by ANN distance.

    ``scope=all`` returns visible media + owned-note chunks; ``library:<id>``
    returns that library's media chunks (the content_chunk cell is media-only).
    """
    cell = scope_filter_sql(scope.kind, scope.id, "content_chunk")
    if cell is None:
        return []
    scope_sql, params = cell
    dims = transcript_embedding_dimensions()
    model, vector = query_embedding
    params |= {
        "viewer_id": viewer_id,
        "query_embedding": to_pgvector_literal(vector),
        "query_embedding_provider": transcript_embedding_provider_for_model(model),
        "query_embedding_model": model,
        "embedding_dims": dims,
        "limit": limit,
    }
    rows = (
        db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()}),
                     {_query_embedding_cte(dims)}
                SELECT cc.id AS content_chunk_id, cc.owner_kind, cc.owner_id, cc.chunk_text,
                       cc.source_kind, cc.heading_path, cc.primary_evidence_span_id,
                       COALESCE(m.title, 'Note') AS title,
                       (1 - (ce.embedding_vector <=> qe.embedding)) AS semantic_score
                FROM content_chunks cc
                LEFT JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                    AND mcis.owner_id = cc.owner_id AND mcis.status = 'ready'
                JOIN content_embeddings ce ON ce.chunk_id = cc.id
                    AND ce.embedding_provider = mcis.active_embedding_provider
                    AND ce.embedding_model = mcis.active_embedding_model
                    AND ce.embedding_dimensions = :embedding_dims
                    AND ce.embedding_vector IS NOT NULL
                JOIN query_embedding qe ON true
                WHERE btrim(cc.chunk_text) <> ''
                  AND mcis.active_embedding_provider = :query_embedding_provider
                  AND mcis.active_embedding_model = :query_embedding_model
                  AND (
                    (cc.owner_kind = 'media'
                        AND cc.owner_id IN (SELECT media_id FROM visible_media))
                    OR (cc.owner_kind = 'note_block' AND cc.owner_id IN (
                        SELECT id FROM note_blocks WHERE user_id = :viewer_id))
                  )
                  {scope_sql}
                ORDER BY ce.embedding_vector <=> qe.embedding ASC, cc.id ASC
                LIMIT :limit
                """
            ),
            params,
        )
        .mappings()
        .all()
    )
    return [
        ContentChunkCandidate(
            content_chunk_id=row["content_chunk_id"],
            owner_kind=str(row["owner_kind"]),
            owner_id=row["owner_id"],
            chunk_text=str(row["chunk_text"] or ""),
            source_kind=str(row["source_kind"]),
            heading_path=[str(part) for part in row["heading_path"] or [] if str(part).strip()],
            primary_evidence_span_id=row["primary_evidence_span_id"],
            title=str(row["title"] or "Untitled"),
            semantic_score=float(row["semantic_score"] or 0.0),
        )
        for row in rows
    ]


def has_searchable_content_chunks(
    db: Session,
    *,
    viewer_id: UUID,
    scope: SearchScope,
    exclude_media_ids: set[UUID] | None = None,
) -> bool:
    """Whether the viewer has any ready, non-empty chunks under ``scope``.

    The existence probe for callers deciding whether a semantic pass is
    meaningful before paying for an embedding.
    """
    cell = scope_filter_sql(scope.kind, scope.id, "content_chunk")
    if cell is None:
        return False
    scope_sql, params = cell
    note_cell = scope_filter_sql(scope.kind, scope.id, "note_block")
    note_exists = (
        f"""
            OR EXISTS (
                SELECT 1 FROM content_chunks cc
                JOIN note_blocks nb ON nb.id = cc.owner_id AND cc.owner_kind = 'note_block'
                    AND nb.user_id = :viewer_id
                JOIN content_index_states ncis ON ncis.owner_kind = cc.owner_kind
                    AND ncis.owner_id = cc.owner_id AND ncis.status = 'ready'
                WHERE btrim(cc.chunk_text) <> '' {note_cell[0]}
                LIMIT 1
            )
        """
        if note_cell is not None
        else ""
    )
    excluded = list(exclude_media_ids or ())
    exclude_clause = (
        "AND NOT (cc.owner_kind = 'media' AND cc.owner_id = ANY(:exclude_media_ids))"
        if excluded
        else ""
    )
    return bool(
        db.execute(
            text(
                f"""
                WITH visible_media AS ({visible_media_ids_cte_sql()})
                SELECT EXISTS (
                    SELECT 1 FROM content_chunks cc
                    JOIN visible_media vm ON vm.media_id = cc.owner_id
                        AND cc.owner_kind = 'media'
                    JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                        AND mcis.owner_id = cc.owner_id AND mcis.status = 'ready'
                    WHERE btrim(cc.chunk_text) <> '' {exclude_clause} {scope_sql}
                    LIMIT 1
                )
                {note_exists}
                """
            ),
            {"viewer_id": viewer_id, "exclude_media_ids": excluded, **params},
        ).scalar_one()
    )
