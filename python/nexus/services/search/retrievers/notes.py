"""Note page and note-block retrievers over the unified content/evidence pipeline.

A page is title-only. Note-block results are hybrid over the same chunk
machinery that serves documents.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.resource_graph.highlight_notes import highlight_excerpts_for_note_blocks
from nexus.services.search.constants import (
    CONTENT_CHUNK_ANN_CANDIDATE_MULTIPLIER,
    CONTENT_CHUNK_MIN_ANN_CANDIDATES,
    CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY,
)
from nexus.services.search.projection import _truncate_snippet
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_score,
    _RankedNoteBlockResult,
    _RankedPageResult,
)
from nexus.services.search.scope import ScopeUnsupported, scope_filter_sql
from nexus.services.search.sql import (
    hybrid_content_chunk_tail_sql,
    query_embedding_cte_sql,
)
from nexus.services.semantic_chunks import (
    to_pgvector_literal,
    transcript_embedding_dimensions,
    transcript_embedding_provider_for_model,
)

# Page rows search only their own title. Linked content is indexed as note blocks.
_PAGE_TEXT = "p.title"


def _search_pages(
    db: Session,
    viewer_id: UUID,
    q: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Lexical page search over title only."""
    if not q.strip():
        return []
    scope_clause = scope_filter_sql(scope_type, scope_id, "page")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    params = {
        "viewer_id": viewer_id,
        "query": q,
        "contains_query": f"%{q}%",
        "limit": limit,
        **scope_params,
    }
    rows = (
        db.execute(
            text(
                f"""
            WITH owned_pages AS (
                SELECT
                    p.id,
                    p.title
                FROM pages p
                WHERE p.user_id = :viewer_id
            ),
            query_terms AS (SELECT websearch_to_tsquery('english', :query) AS tsq)
            SELECT
                p.id,
                p.title,
                ts_headline('english', {_PAGE_TEXT}, qt.tsq,
                    'MaxWords=50, MinWords=5, MaxFragments=1') AS snippet,
                (
                    CASE
                        WHEN lower(p.title) = lower(:query) THEN 4.0
                        WHEN p.title ILIKE :contains_query THEN 2.0
                        ELSE 0.0
                    END
                    + ts_rank_cd(to_tsvector('english', {_PAGE_TEXT}), qt.tsq) * 2.0
                ) AS score
            FROM owned_pages p
            CROSS JOIN query_terms qt
            WHERE (
                to_tsvector('english', {_PAGE_TEXT}) @@ qt.tsq
                OR p.title ILIKE :contains_query
            )
            {scope_filter}
            ORDER BY score DESC, p.id ASC
            LIMIT :limit
            """
            ),
            params,
        )
        .mappings()
        .all()
    )
    return [
        _RankedPageResult(
            id=row["id"],
            title=row["title"],
            snippet=_truncate_snippet(str(row["snippet"] or row["title"])),
            score=_build_search_score(row["score"]),
        )
        for row in rows
    ]


def _search_note_chunks(
    db: Session,
    viewer_id: UUID,
    q: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    limit: int,
) -> list[InternalSearchResult]:
    """Hybrid note-block search over note-owned content chunks."""
    if not q.strip():
        return []
    scope_clause = scope_filter_sql(scope_type, scope_id, "note_block")
    if isinstance(scope_clause, ScopeUnsupported):
        return []
    scope_filter, scope_params = scope_clause
    embedding_dims = transcript_embedding_dimensions()
    ann_limit = max(
        CONTENT_CHUNK_MIN_ANN_CANDIDATES,
        int(limit) * CONTENT_CHUNK_ANN_CANDIDATE_MULTIPLIER,
    )
    params = {
        "viewer_id": viewer_id,
        "query": q,
        "limit": limit,
        "ann_limit": ann_limit,
        "min_semantic_similarity": CONTENT_CHUNK_MIN_SEMANTIC_SIMILARITY,
        **scope_params,
    }
    eligible_chunks = f"""
        owned_notes AS (SELECT id FROM note_blocks WHERE user_id = :viewer_id),
        eligible_chunks AS (
            SELECT
                cc.id,
                cc.owner_id AS note_block_id,
                cc.chunk_text,
                ts_headline('english', cc.chunk_text,
                    websearch_to_tsquery('english', :query),
                    'MaxWords=50, MinWords=10, MaxFragments=1') AS snippet,
                cc.summary_locator,
                cc.created_at,
                cc.chunk_text_tsv,
                mcis.active_embedding_provider,
                mcis.active_embedding_model
            FROM content_chunks cc
            JOIN owned_notes note ON note.id = cc.owner_id AND cc.owner_kind = 'note_block'
            JOIN content_index_states mcis
              ON mcis.owner_kind = cc.owner_kind
             AND mcis.owner_id = cc.owner_id
             AND mcis.status = 'ready'
            WHERE TRUE
            {scope_filter}
        )
    """
    if semantic_query_embedding is not None:
        embedding_model, query_embedding = semantic_query_embedding
        params["query_embedding"] = to_pgvector_literal(query_embedding)
        params["query_embedding_provider"] = transcript_embedding_provider_for_model(
            embedding_model
        )
        params["query_embedding_model"] = embedding_model
        query = hybrid_content_chunk_tail_sql(
            leading_ctes=f"""{eligible_chunks},
                {query_embedding_cte_sql(embedding_dims)}""",
            embedding_dims=embedding_dims,
            scored_passthrough_columns="""ec.note_block_id,
                        ec.chunk_text,
                        ec.snippet,
                        ec.summary_locator,""",
            final_select_columns="""note_block_id,
                chunk_text,
                snippet,
                summary_locator,""",
            order_by_id="note_block_id",
            include_recency_decay=False,
        )
    else:
        query = f"""
            WITH
                {eligible_chunks},
                lexical_candidates AS (
                    SELECT
                        ec.note_block_id,
                        ec.chunk_text,
                        ec.snippet,
                        ec.summary_locator,
                        ts_rank_cd(ec.chunk_text_tsv, websearch_to_tsquery('english', :query))
                            AS lexical_score
                    FROM eligible_chunks ec
                    WHERE ec.chunk_text_tsv @@ websearch_to_tsquery('english', :query)
                    ORDER BY lexical_score DESC, ec.note_block_id ASC
                    LIMIT :ann_limit
                )
            SELECT
                note_block_id, chunk_text, snippet, summary_locator,
                (0.20 * GREATEST(lexical_score, 0.0)) AS raw_score
            FROM lexical_candidates
            WHERE lexical_score > 0.0
            ORDER BY raw_score DESC, note_block_id ASC
            LIMIT :limit
        """
    rows = db.execute(text(query), params).mappings().all()

    block_results: list[tuple[UUID, dict]] = []
    seen_blocks: set[UUID] = set()
    for row in rows:
        block_id = UUID(str(row["note_block_id"]))
        if block_id in seen_blocks:
            continue
        seen_blocks.add(block_id)
        block_results.append((block_id, dict(row)))

    excerpts = _highlight_excerpts(db, viewer_id, [bid for bid, _ in block_results])
    results: list[InternalSearchResult] = []
    for block_id, row in block_results:
        loc = row["summary_locator"]
        body_text = str(row["chunk_text"] or "")
        results.append(
            _RankedNoteBlockResult(
                id=block_id,
                snippet=_truncate_snippet(str(row["snippet"] or "")),
                body_text=body_text,
                score=_build_search_score(row["raw_score"]),
                highlight_excerpt=excerpts.get(block_id),
                locator=retrieval_locator_json(
                    {
                        "type": "note_block_offsets",
                        "block_id": str(loc["note_block_id"]),
                        "start_offset": int(loc["start_offset"]),
                        "end_offset": int(loc["end_offset"]),
                    }
                ),
            )
        )
    return results


def _highlight_excerpts(db: Session, viewer_id: UUID, note_ids: list[UUID]) -> dict[UUID, str]:
    """First attached-highlight excerpt per note_block (``origin=highlight_note`` edges)."""
    return {
        note_id: _truncate_snippet(exact)
        for note_id, exact in highlight_excerpts_for_note_blocks(
            db, viewer_id=viewer_id, note_ids=note_ids
        ).items()
    }
