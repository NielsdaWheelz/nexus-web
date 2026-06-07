"""Search orchestrator, durable-ref resolver, and per-type dispatch."""

from __future__ import annotations

import time
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    can_read_media,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.logging import get_logger
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.schemas.search import (
    VALID_RESULT_TYPES,
    SearchPageInfo,
    SearchResponse,
    SearchResultOut,
    SearchResultSourceOut,
)
from nexus.services import media_intelligence
from nexus.services.contributors import resolve_canonical_contributor_ids
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.search.constants import (
    CANDIDATES_PER_TYPE,
    MAX_LIMIT,
    MIN_QUERY_LENGTH,
)
from nexus.services.search.cursor import decode_search_cursor, encode_search_cursor
from nexus.services.search.embedding import _query_has_full_text_terms, build_query_embedding
from nexus.services.search.projection import (
    _direct_fragment_locator,
    _require_resolved_evidence,
    _result_to_out,
    _truncate_snippet,
)
from nexus.services.search.query import SearchQuery
from nexus.services.search.ranking import TYPE_WEIGHTS, _normalize_scores_by_type
from nexus.services.search.results import (
    InternalSearchResult,
    _build_search_source,
    _parse_contributor_credits,
    _RankedContentChunkResult,
    _RankedContributorResult,
    _RankedConversationResult,
    _RankedEvidenceSpanResult,
    _RankedFragmentResult,
    _RankedHighlightResult,
    _RankedMediaResult,
    _RankedMessageResult,
    _RankedNoteBlockResult,
    _RankedPageResult,
    _RankedPodcastResult,
    _RankedWebResult,
    _SearchScore,
    _web_result_ref_json,
)
from nexus.services.search.retrievers.contributors import _search_contributors
from nexus.services.search.retrievers.conversations import _search_conversations, _search_messages
from nexus.services.search.retrievers.highlights import _search_highlights
from nexus.services.search.retrievers.library_content import (
    _search_content_chunks,
    _search_evidence_spans,
    _search_fragments,
)
from nexus.services.search.retrievers.media import _search_media, _search_podcasts
from nexus.services.search.retrievers.objects import _search_note_blocks, _search_pages
from nexus.services.search.retrievers.web import _search_web_results
from nexus.services.search.scope import authorize_scope
from nexus.services.search.sql import contributor_credits_rollup_cte_sql
from nexus.services.search.telemetry import _log_search

logger = get_logger(__name__)


# =============================================================================
# Search Implementation
# =============================================================================


def _enrich_results_with_media_summaries(db: Session, results: list[SearchResultOut]) -> None:
    """Attach ready per-media unit summaries to each media-bearing result source.

    One batch select over the distinct media ids in this page; the unit summary
    is a nested property of the result's source (no per-call-site threading).
    """
    sources_by_media: dict[UUID, list[SearchResultSourceOut]] = {}
    for result in results:
        source = getattr(result, "source", None)
        if isinstance(source, SearchResultSourceOut):
            sources_by_media.setdefault(source.media_id, []).append(source)
    if not sources_by_media:
        return

    summaries = media_intelligence.get_ready_summaries(db, media_ids=list(sources_by_media.keys()))
    for media_id, summary_md in summaries.items():
        for source in sources_by_media.get(media_id, []):
            source.summary_md = summary_md


def search(db: Session, viewer_id: UUID, query: SearchQuery) -> SearchResponse:
    """Execute hybrid search across all visible content for one ``SearchQuery``.

    ``SearchQuery`` is the sole input (spec §5.2): the HTTP route and the chat tool
    both parse transport → ``SearchQuery`` at the edge. Hybrid retrieval is an
    invariant — the query embedding is built once for any semantic-capable kind,
    independent of structured filters (no ``semantic`` flag, no filter-bypass).

    Raises:
        NotFoundError: If scope object is not visible to viewer.
        InvalidRequestError: If cursor is invalid.
    """
    start_time = time.time()
    transaction_active_at_entry = db.in_transaction()

    limit = min(max(1, query.limit), MAX_LIMIT)
    q = query.text.strip()
    offset = decode_search_cursor(query.cursor) if query.cursor else 0

    result_types = query.effective_result_types
    content_kinds = query.content_kinds
    contributor_handles = list(query.authors)
    roles = list(query.roles)
    scope_type = query.scope.kind
    scope_id = query.scope.id
    scope_label = scope_type if scope_id is None else f"{scope_type}:{scope_id}"

    has_query = len(q) >= MIN_QUERY_LENGTH
    has_structured_filter = bool(contributor_handles or roles or content_kinds)
    if not has_query and not has_structured_filter:
        _log_search(viewer_id, q, scope_label, list(result_types), 0, start_time)
        return SearchResponse()

    # Authorize scope (already parsed/validated at the edge).
    authorize_scope(db, viewer_id, scope_type, scope_id)

    if len(result_types) == 0:
        _log_search(viewer_id, q, scope_label, list(result_types), 0, start_time)
        return SearchResponse()

    if has_query and not _query_has_full_text_terms(db, q):
        _log_search(viewer_id, q, scope_label, list(result_types), 0, start_time)
        return SearchResponse()

    # Hybrid invariant: build the query embedding once for any semantic-capable kind
    # (content_chunk via Documents, page/note_block via Notes), regardless of filters.
    semantic_query_embedding: tuple[str, list[float]] | None = None
    if has_query and any(
        result_type in ("content_chunk", "page", "note_block") for result_type in result_types
    ):
        semantic_query_embedding = build_query_embedding(
            db, q, list(result_types), transaction_active_at_entry=transaction_active_at_entry
        )

    # Filter by canonical contributor ids so a merged handle returns the survivor's content.
    # None = no contributor filter requested; an empty list = requested handles resolved to nothing.
    contributor_ids = (
        resolve_canonical_contributor_ids(db, contributor_handles) if contributor_handles else None
    )

    # Execute search queries per type and collect results
    all_results: list[InternalSearchResult] = []

    for result_type in result_types:
        type_results = _search_type(
            db,
            viewer_id,
            q,
            has_query,
            result_type,
            semantic_query_embedding,
            scope_type,
            scope_id,
            contributor_ids,
            roles,
            content_kinds,
            CANDIDATES_PER_TYPE,
        )
        all_results.extend(type_results)

    # Compute weighted scores
    for result in all_results:
        result.score.weighted = result.score.raw * TYPE_WEIGHTS[result.result_type]

    # Normalize scores within each type to [0, 1]
    _normalize_scores_by_type(all_results)

    # Sort by normalized_score DESC, then by id ASC for determinism
    all_results.sort(
        key=lambda result: (
            -result.score.normalized,
            result.handle if isinstance(result, _RankedContributorResult) else str(result.id),
        )
    )

    # Apply offset pagination
    paginated = all_results[offset : offset + limit + 1]  # +1 to check has_more

    has_more = len(paginated) > limit
    if has_more:
        paginated = paginated[:limit]

    # Convert to response objects
    results = [_result_to_out(r) for r in paginated]
    _enrich_results_with_media_summaries(db, results)

    # Build page info
    next_cursor = None
    if has_more:
        next_cursor = encode_search_cursor(offset + limit)

    _log_search(viewer_id, q, scope_label, list(result_types), len(results), start_time)

    return SearchResponse(
        results=results,
        page=SearchPageInfo(has_more=has_more, next_cursor=next_cursor),
    )


def get_search_result(
    db: Session,
    viewer_id: UUID,
    result_type: str,
    result_id: str,
    evidence_span_ids: list[UUID] | None = None,
) -> SearchResultOut:
    """Resolve one typed search result by durable object ref."""
    if result_type not in VALID_RESULT_TYPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}"
        )

    score = _SearchScore(raw=1.0, weighted=1.0, normalized=1.0)

    if result_type in {"media", "episode", "video"}:
        media_id = _uuid_from_search_id(result_id)
        kind_filter = ""
        if result_type == "media":
            kind_filter = "AND m.kind NOT IN ('podcast_episode', 'video')"
        elif result_type == "episode":
            kind_filter = "AND m.kind = 'podcast_episode'"
        else:
            kind_filter = "AND m.kind = 'video'"
        row = db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
                SELECT m.id, m.title, m.kind, m.published_date, mcc.contributor_credits
                FROM media m
                JOIN visible_media vm ON vm.media_id = m.id
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE m.id = :id
                {kind_filter}
                """
            ),
            {"viewer_id": viewer_id, "id": media_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        media_result_type: Literal["media", "episode", "video"] = (
            "episode"
            if result_type == "episode"
            else "video"
            if result_type == "video"
            else "media"
        )
        return _result_to_out(
            _RankedMediaResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[1])),
                source=_build_search_source(row[0], row[2], row[1], row[4], row[3]),
                score=score,
                result_type=media_result_type,
            )
        )

    if result_type == "podcast":
        podcast_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH
                    visible_podcasts AS ({visible_podcast_ids_cte_sql()}),
                    podcast_contributor_credits AS ({contributor_credits_rollup_cte_sql("podcast_id")})
                SELECT p.id, p.title, pcc.contributor_credits
                FROM podcasts p
                JOIN visible_podcasts vp ON vp.podcast_id = p.id
                LEFT JOIN podcast_contributor_credits pcc ON pcc.podcast_id = p.id
                WHERE p.id = :id
                """
            ),
            {"viewer_id": viewer_id, "id": podcast_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedPodcastResult(
                id=row[0],
                title=row[1],
                contributors=_parse_contributor_credits(row[2]),
                snippet=_truncate_snippet(str(row[1])),
                score=score,
            )
        )

    if result_type == "contributor":
        matches = _search_contributors(
            db,
            viewer_id,
            "",
            False,
            "all",
            None,
            [_uuid_from_search_id(result_id)],
            [],
            [],
            1,
        )
        if not matches:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        matches[0].score = score
        return _result_to_out(matches[0])

    if result_type == "content_chunk":
        chunk_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
                SELECT
                    cc.id,
                    cc.media_id,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits,
                    cc.chunk_text,
                    cc.source_kind,
                    cc.primary_evidence_span_id
                FROM content_chunks cc
                JOIN media m ON m.id = cc.media_id
                JOIN visible_media vm ON vm.media_id = cc.media_id
                JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                    AND mcis.status = 'ready'
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE cc.id = :id
                """
            ),
            {"viewer_id": viewer_id, "id": chunk_id},
        ).first()
        if row is None or row[8] is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        if evidence_span_ids and row[8] not in evidence_span_ids:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        resolution = resolve_evidence_span(
            db,
            viewer_id=viewer_id,
            media_id=row[1],
            evidence_span_id=row[8],
        )
        _require_resolved_evidence(resolution)
        return _result_to_out(
            _RankedContentChunkResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[6] or "")),
                source_kind=str(row[7]),
                evidence_span_ids=[row[8]],
                citation_label=str(resolution["citation_label"]),
                locator=locator_from_resolution(
                    resolution,
                    media_id=row[1],
                    media_kind=str(row[2] or ""),
                ),
                resolver=dict(resolution["resolver"]),
                source=_build_search_source(row[1], row[2], row[3], row[5], row[4]),
                score=score,
            )
        )

    if result_type == "fragment":
        fragment_id = _uuid_from_search_id(result_id)
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
                    m.published_date,
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
                LEFT JOIN media_content_index_states mcis ON mcis.media_id = f.media_id
                    AND mcis.status = 'ready'
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE f.id = :id
                """
            ),
            {"viewer_id": viewer_id, "id": fragment_id},
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
        return _result_to_out(
            _RankedFragmentResult(
                id=row[0],
                idx=int(row[1]),
                snippet=_truncate_snippet(str(row[2] or "")),
                source=_build_search_source(row[6], row[7], row[8], row[10], row[9]),
                score=score,
                citation_label=f"fragment {int(row[1]) + 1}",
                locator=locator,
            )
        )

    if result_type == "page":
        page_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                """
                SELECT id, title, description
                FROM pages
                WHERE id = :id
                  AND user_id = :viewer_id
                """
            ),
            {"viewer_id": viewer_id, "id": page_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedPageResult(
                id=row[0],
                title=row[1],
                description=row[2],
                snippet=_truncate_snippet(str(row[2] or row[1])),
                score=score,
            )
        )

    if result_type == "note_block":
        block_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                """
                SELECT nb.id, nb.page_id, p.title, nb.body_text
                FROM note_blocks nb
                JOIN pages p ON p.id = nb.page_id
                WHERE nb.id = :id
                  AND nb.user_id = :viewer_id
                """
            ),
            {"viewer_id": viewer_id, "id": block_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        if not str(row[3] or ""):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedNoteBlockResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[3] or "")),
                page_id=row[1],
                page_title=row[2],
                body_text=row[3],
                score=score,
                locator=retrieval_locator_json(
                    {
                        "type": "note_block_offsets",
                        "page_id": str(row[1]),
                        "block_id": str(row[0]),
                        "start_offset": 0,
                        "end_offset": len(str(row[3] or "")),
                    }
                )
                if row[3]
                else None,
            )
        )

    if result_type == "highlight":
        highlight_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
                SELECT
                    h.id,
                    h.exact,
                    h.prefix,
                    h.suffix,
                    h.color,
                    m.id,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits,
                    h.anchor_kind,
                    hfa.fragment_id,
                    hfa.start_offset,
                    hfa.end_offset,
                    f.canonical_text,
                    f.t_start_ms,
                    f.t_end_ms,
                    hpa.page_number,
                    pdf_quads.quads
                FROM highlights h
                JOIN media m ON m.id = h.anchor_media_id
                JOIN visible_media vm ON vm.media_id = h.anchor_media_id
                LEFT JOIN highlight_fragment_anchors hfa ON hfa.highlight_id = h.id
                LEFT JOIN fragments f ON f.id = hfa.fragment_id
                LEFT JOIN highlight_pdf_anchors hpa ON hpa.highlight_id = h.id
                LEFT JOIN LATERAL (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'x1', CAST(hpq.x1 AS float), 'y1', CAST(hpq.y1 AS float),
                            'x2', CAST(hpq.x2 AS float), 'y2', CAST(hpq.y2 AS float),
                            'x3', CAST(hpq.x3 AS float), 'y3', CAST(hpq.y3 AS float),
                            'x4', CAST(hpq.x4 AS float), 'y4', CAST(hpq.y4 AS float)
                        )
                        ORDER BY hpq.quad_idx
                    ) AS quads
                    FROM highlight_pdf_quads hpq
                    WHERE hpq.highlight_id = h.id
                ) pdf_quads ON true
                JOIN media_content_index_states mcis ON mcis.media_id = h.anchor_media_id
                    AND mcis.status = 'ready'
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE h.id = :id
                  AND h.anchor_media_id IS NOT NULL
                  AND (
                        (
                            h.anchor_kind = 'fragment_offsets'
                            AND EXISTS (
                                SELECT 1
                                FROM highlight_fragment_anchors hfa
                                JOIN fragments f ON f.id = hfa.fragment_id
                                WHERE hfa.highlight_id = h.id
                                  AND f.media_id = h.anchor_media_id
                            )
                        )
                        OR (
                            h.anchor_kind = 'pdf_page_geometry'
                            AND EXISTS (
                                SELECT 1
                                FROM highlight_pdf_anchors hpa
                                WHERE hpa.highlight_id = h.id
                                  AND hpa.media_id = h.anchor_media_id
                            )
                        )
                  )
                  AND EXISTS (
                        SELECT 1
                        FROM library_entries le
                        JOIN memberships viewer_m ON viewer_m.library_id = le.library_id
                        JOIN memberships author_m ON author_m.library_id = le.library_id
                        WHERE le.media_id = h.anchor_media_id
                          AND viewer_m.user_id = :viewer_id
                          AND author_m.user_id = h.user_id
                  )
                """
            ),
            {"viewer_id": viewer_id, "id": highlight_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        locator = None
        if row[10] == "fragment_offsets" and row[11] is not None:
            locator = _direct_fragment_locator(
                media_id=row[5],
                media_kind=str(row[6] or ""),
                fragment_id=row[11],
                text_value=str(row[14] or ""),
                start_offset=int(row[12]),
                end_offset=int(row[13]),
                exact=str(row[1] or ""),
                prefix=str(row[2] or ""),
                suffix=str(row[3] or ""),
                t_start_ms=int(row[15]) if row[15] is not None else None,
                t_end_ms=int(row[16]) if row[16] is not None else None,
            )
        elif row[10] == "pdf_page_geometry" and row[17] is not None:
            try:
                locator = retrieval_locator_json(
                    {
                        "type": "pdf_page_geometry",
                        "media_id": str(row[5]),
                        "page_number": int(row[17]),
                        "quads": row[18] if isinstance(row[18], list) else [],
                        "exact": str(row[1] or ""),
                        "prefix": str(row[2] or ""),
                        "suffix": str(row[3] or ""),
                        "text_quote_selector": {
                            "exact": str(row[1] or ""),
                            "prefix": str(row[2] or ""),
                            "suffix": str(row[3] or ""),
                        },
                    }
                )
            except ValueError:
                locator = None
        if locator is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedHighlightResult(
                id=row[0],
                exact=str(row[1] or ""),
                snippet=_truncate_snippet(str(row[1] or "")),
                color=str(row[4] or "yellow"),
                source=_build_search_source(row[5], row[6], row[7], row[9], row[8]),
                score=score,
                citation_label=f"highlight {str(row[0])[:8]}",
                locator=locator,
            )
        )

    if result_type == "message":
        message_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                SELECT m.id, m.conversation_id, m.seq, m.content
                FROM messages m
                JOIN visible_conversations vc ON vc.conversation_id = m.conversation_id
                WHERE m.id = :id
                  AND m.status != 'pending'
                """
            ),
            {"viewer_id": viewer_id, "id": message_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        if not str(row[3] or ""):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedMessageResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[3] or "")),
                conversation_id=row[1],
                seq=row[2],
                score=score,
                locator=retrieval_locator_json(
                    {
                        "type": "message_offsets",
                        "conversation_id": str(row[1]),
                        "message_id": str(row[0]),
                        "message_seq": int(row[2]),
                        "start_offset": 0,
                        "end_offset": len(str(row[3] or "")),
                    }
                )
                if row[3]
                else None,
            )
        )

    if result_type == "conversation":
        conversation_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                SELECT c.id, c.title
                FROM conversations c
                JOIN visible_conversations vc ON vc.conversation_id = c.id
                WHERE c.id = :id
                """
            ),
            {"viewer_id": viewer_id, "id": conversation_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            _RankedConversationResult(
                id=row[0],
                title=str(row[1] or "Conversation"),
                snippet=str(row[1] or "Conversation"),
                score=score,
            )
        )

    if result_type == "web_result":
        retrieval_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH visible_conversations AS ({visible_conversation_ids_cte_sql()})
                SELECT
                    mr.id,
                    mr.source_id,
                    COALESCE(mr.result_ref->>'result_ref', mr.source_id),
                    COALESCE(NULLIF(mr.result_ref->>'title', ''), mr.source_title, mr.source_id),
                    COALESCE(NULLIF(mr.result_ref->>'url', ''), mr.deep_link),
                    NULLIF(mr.result_ref->>'display_url', ''),
                    mr.result_ref->'extra_snippets',
                    NULLIF(mr.result_ref->>'published_at', ''),
                    NULLIF(mr.result_ref->>'source_name', ''),
                    CASE
                        WHEN mr.result_ref->>'rank' ~ '^[0-9]+$'
                        THEN CAST(mr.result_ref->>'rank' AS integer)
                        ELSE NULL
                    END,
                    NULLIF(mr.result_ref->>'provider', ''),
                    NULLIF(mr.result_ref->>'provider_request_id', ''),
                    COALESCE(NULLIF(mr.exact_snippet, ''), mr.result_ref->>'snippet', ''),
                    mr.locator,
                    mr.result_ref,
                    mr.selected
                FROM message_retrievals mr
                JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
                JOIN visible_conversations vc ON vc.conversation_id = mtc.conversation_id
                WHERE mr.id = :id
                  AND mr.result_type = 'web_result'
                  AND mr.result_ref->>'type' = 'web_result'
                  AND mr.locator IS NOT NULL
                  AND mr.locator != 'null'::jsonb
                """
            ),
            {"viewer_id": viewer_id, "id": retrieval_id},
        ).first()
        if row is None or not row[4]:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        result_ref = _web_result_ref_json(row[14])
        return _result_to_out(
            _RankedWebResult(
                id=str(row[0]),
                source_id=str(result_ref["source_id"]),
                result_ref=str(result_ref["result_ref"]),
                title=str(result_ref["title"]),
                url=str(result_ref["url"]),
                display_url=result_ref.get("display_url"),
                extra_snippets=list(result_ref.get("extra_snippets", [])),
                published_at=result_ref.get("published_at"),
                source_name=result_ref.get("source_name"),
                rank=result_ref.get("rank"),
                provider=result_ref.get("provider"),
                provider_request_id=result_ref.get("provider_request_id"),
                snippet=_truncate_snippet(str(row[12] or "")),
                locator=result_ref["locator"],
                selected=bool(row[15]),
                score=score,
            )
        )

    if result_type == "evidence_span":
        evidence_span_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
                SELECT
                    es.id,
                    es.media_id,
                    es.span_text,
                    es.citation_label,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits
                FROM evidence_spans es
                JOIN media m ON m.id = es.media_id
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE es.id = :id
                """
            ),
            {"id": evidence_span_id},
        ).first()
        if row is None or not can_read_media(db, viewer_id, row[1]):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        resolution = resolve_evidence_span(
            db,
            viewer_id=viewer_id,
            media_id=row[1],
            evidence_span_id=row[0],
        )
        _require_resolved_evidence(resolution)
        return _result_to_out(
            _RankedEvidenceSpanResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[2] or "")),
                citation_label=str(row[3] or resolution.get("citation_label") or ""),
                locator=locator_from_resolution(
                    resolution,
                    media_id=row[1],
                    media_kind=str(row[4]),
                ),
                source=_build_search_source(row[1], row[4], row[5], row[7], row[6]),
                score=score,
            )
        )

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}")


def _uuid_from_search_id(result_id: str) -> UUID:
    try:
        return UUID(result_id)
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid search result id"
        ) from exc


def _search_type(
    db: Session,
    viewer_id: UUID,
    q: str,
    has_query: bool,
    result_type: str,
    semantic_query_embedding: tuple[str, list[float]] | None,
    scope_type: str,
    scope_id: UUID | None,
    contributor_ids: list[UUID] | None,
    roles: list[str],
    content_kinds: list[str],
    limit: int,
) -> list[InternalSearchResult]:
    """Search a specific content type with visibility filtering.

    Returns list of dicts with raw results (not yet normalized).
    """
    if result_type == "media":
        return _search_media(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_ids,
            roles,
            content_kinds,
            limit,
        )
    if result_type == "episode":
        if content_kinds and "podcast_episode" not in content_kinds:
            return []
        return _search_media(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_ids,
            roles,
            ["podcast_episode"],
            limit,
            result_type="episode",
        )
    if result_type == "video":
        if content_kinds and "video" not in content_kinds:
            return []
        return _search_media(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_ids,
            roles,
            ["video"],
            limit,
            result_type="video",
        )
    if result_type == "podcast":
        return _search_podcasts(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_ids,
            roles,
            content_kinds,
            limit,
        )
    if result_type == "content_chunk":
        return _search_content_chunks(
            db,
            viewer_id,
            q,
            semantic_query_embedding,
            has_query,
            scope_type,
            scope_id,
            contributor_ids,
            roles,
            content_kinds,
            limit,
        )
    if result_type == "contributor":
        return _search_contributors(
            db,
            viewer_id,
            q,
            has_query,
            scope_type,
            scope_id,
            contributor_ids,
            roles,
            content_kinds,
            limit,
        )

    # Remaining types do not filter by contributor ids, roles, or content_kinds;
    # any such filter rules out a match entirely.
    if contributor_ids is not None or roles or content_kinds:
        return []

    if result_type == "evidence_span":
        return _search_evidence_spans(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "fragment":
        return _search_fragments(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "page":
        return _search_pages(
            db, viewer_id, q, semantic_query_embedding, scope_type, scope_id, limit
        )
    if result_type == "note_block":
        return _search_note_blocks(
            db, viewer_id, q, semantic_query_embedding, scope_type, scope_id, limit
        )
    if result_type == "highlight":
        return _search_highlights(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "message":
        return _search_messages(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "conversation":
        return _search_conversations(db, viewer_id, q, scope_type, scope_id, limit)
    if result_type == "web_result":
        return _search_web_results(db, viewer_id, q, has_query, scope_type, scope_id, limit)
    # Unreachable: result_types are validated at the edge and derived from the kind
    # taxonomy, so an unknown type here is an internal dispatch-invariant violation, not
    # a client error.
    raise ApiError(ApiErrorCode.E_INTERNAL, f"Unhandled search result type: {result_type}")
