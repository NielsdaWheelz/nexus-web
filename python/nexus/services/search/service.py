"""Search orchestrator and durable-ref resolver.

Retrieval, ranking, and per-type dispatch live behind the shared pre-projection
candidate seam (``search.candidates``); this module owns the public ``search``
contract (gates, pagination, ``SearchResultOut`` projection) and
``get_search_result`` durable-ref re-resolution.
"""

from __future__ import annotations

import time
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import (
    highlight_shared_library_exists_sql,
    visible_conversation_ids_cte_sql,
    visible_media_ids_cte_sql,
    visible_podcast_ids_cte_sql,
)
from nexus.db.models import NoteBlock
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
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
from nexus.services.locator_resolver import locator_from_resolution, resolve_evidence_span
from nexus.services.search.candidates import discovery_candidates
from nexus.services.search.constants import (
    MAX_LIMIT,
    MIN_QUERY_LENGTH,
)
from nexus.services.search.cursor import decode_search_cursor, encode_search_cursor
from nexus.services.search.embedding import _query_has_full_text_terms
from nexus.services.search.projection import (
    _direct_fragment_locator,
    _require_resolved_evidence,
    _result_to_out,
    _truncate_snippet,
)
from nexus.services.search.query import SearchQuery
from nexus.services.search.results import (
    _build_search_source,
    _parse_contributor_credits,
    _RankedContentChunkResult,
    _RankedConversationResult,
    _RankedEvidenceSpanResult,
    _RankedFragmentResult,
    _RankedHighlightResult,
    _RankedMediaResult,
    _RankedMessageResult,
    _RankedNoteBlockResult,
    _RankedPageResult,
    _RankedPodcastResult,
    _RankedReaderApparatusItemResult,
    _RankedWebResult,
    _SearchScore,
    _web_result_ref_json,
)
from nexus.services.search.retrievers.contributors import _search_contributors
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

    # Retrieval + ranking live behind the shared pre-projection candidate seam.
    all_results = discovery_candidates(
        db,
        viewer_id,
        q=q,
        has_query=has_query,
        result_types=result_types,
        scope_type=scope_type,
        scope_id=scope_id,
        contributor_handles=contributor_handles,
        roles=roles,
        content_kinds=content_kinds,
        transaction_active_at_entry=transaction_active_at_entry,
    )

    # Apply offset pagination
    paginated = all_results[offset : offset + limit + 1]  # +1 to check has_more

    has_more = len(paginated) > limit
    if has_more:
        paginated = paginated[:limit]

    # Convert to response objects
    results = [_result_to_out(db, viewer_id, r) for r in paginated]
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
            db,
            viewer_id,
            _RankedMediaResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[1])),
                source=_build_search_source(row[0], row[2], row[1], row[4], row[3]),
                score=score,
                result_type=media_result_type,
            ),
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
            db,
            viewer_id,
            _RankedPodcastResult(
                id=row[0],
                title=row[1],
                contributors=_parse_contributor_credits(row[2]),
                snippet=_truncate_snippet(str(row[1])),
                score=score,
            ),
        )

    if result_type == "contributor":
        # Durable-ref re-resolution (chat citation chip refresh): use BROAD
        # visibility so a contributor reachable only via a viewer-owned graph edge
        # (zero visible credits) still re-materializes instead of dropping (M2).
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
            broad_visibility=True,
        )
        if not matches:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        matches[0].score = score
        return _result_to_out(db, viewer_id, matches[0])

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
                    cc.owner_kind,
                    cc.owner_id,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits,
                    cc.chunk_text,
                    cc.source_kind,
                    cc.primary_evidence_span_id
                FROM content_chunks cc
                JOIN media m ON m.id = cc.owner_id AND cc.owner_kind = 'media'
                JOIN visible_media vm ON vm.media_id = cc.owner_id
                JOIN content_index_states mcis ON mcis.owner_kind = cc.owner_kind
                    AND mcis.owner_id = cc.owner_id
                    AND mcis.status = 'ready'
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE cc.id = :id
                  AND cc.owner_kind = 'media'
                  AND vm.media_id IS NOT NULL
                """
            ),
            {"viewer_id": viewer_id, "id": chunk_id},
        ).first()
        if row is None or row[9] is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        if evidence_span_ids and row[9] not in evidence_span_ids:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        resolution = resolve_evidence_span(
            db,
            viewer_id=viewer_id,
            evidence_span_id=row[9],
        )
        _require_resolved_evidence(resolution)
        source_kind = str(row[3])
        source_title = str(row[4])
        return _result_to_out(
            db,
            viewer_id,
            _RankedContentChunkResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[7] or "")),
                source_kind=str(row[8]),
                evidence_span_ids=[row[9]],
                citation_label=str(resolution["citation_label"]),
                locator=locator_from_resolution(
                    resolution,
                    media_id=row[2],
                    media_kind=source_kind,
                ),
                resolver=dict(resolution["resolver"]),
                source=_build_search_source(
                    row[2],
                    source_kind,
                    source_title,
                    row[6],
                    row[5],
                ),
                score=score,
            ),
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
                JOIN content_index_states mcis ON mcis.owner_kind = 'media'
                    AND mcis.owner_id = f.media_id
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
            db,
            viewer_id,
            _RankedFragmentResult(
                id=row[0],
                idx=int(row[1]),
                snippet=_truncate_snippet(str(row[2] or "")),
                source=_build_search_source(row[6], row[7], row[8], row[10], row[9]),
                score=score,
                citation_label=f"fragment {int(row[1]) + 1}",
                locator=locator,
            ),
        )

    if result_type == "page":
        page_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                """
                SELECT id, title
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
            db,
            viewer_id,
            _RankedPageResult(
                id=row[0],
                title=row[1],
                snippet=_truncate_snippet(str(row[1])),
                score=score,
            ),
        )

    if result_type == "note_block":
        block_id = _uuid_from_search_id(result_id)
        block = db.get(NoteBlock, block_id)
        if block is None or block.user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        ready = db.execute(
            text(
                """
                SELECT 1
                FROM content_index_states
                WHERE owner_kind = 'note_block'
                  AND owner_id = :block_id
                  AND status = 'ready'
                """
            ),
            {"block_id": block_id},
        ).first()
        if ready is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        if not str(block.body_text or ""):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            db,
            viewer_id,
            _RankedNoteBlockResult(
                id=block.id,
                snippet=_truncate_snippet(str(block.body_text or "")),
                body_text=block.body_text,
                score=score,
                locator=retrieval_locator_json(
                    {
                        "type": "note_block_offsets",
                        "block_id": str(block.id),
                        "start_offset": 0,
                        "end_offset": len(str(block.body_text or "")),
                    }
                )
                if block.body_text
                else None,
            ),
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
                JOIN content_index_states mcis ON mcis.owner_kind = 'media'
                    AND mcis.owner_id = h.anchor_media_id
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
                  AND {highlight_shared_library_exists_sql("h")}
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
            db,
            viewer_id,
            _RankedHighlightResult(
                id=row[0],
                exact=str(row[1] or ""),
                snippet=_truncate_snippet(str(row[1] or "")),
                color=str(row[4] or "yellow"),
                source=_build_search_source(row[5], row[6], row[7], row[9], row[8]),
                score=score,
                citation_label=f"highlight {str(row[0])[:8]}",
                locator=locator,
            ),
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
            db,
            viewer_id,
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
            ),
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
            db,
            viewer_id,
            _RankedConversationResult(
                id=row[0],
                title=str(row[1] or "Conversation"),
                snippet=str(row[1] or "Conversation"),
                score=score,
            ),
        )

    if result_type == "reader_apparatus_item":
        item_id = _uuid_from_search_id(result_id)
        row = db.execute(
            text(
                f"""
                WITH
                    visible_media AS ({visible_media_ids_cte_sql()}),
                    media_contributor_credits AS ({contributor_credits_rollup_cte_sql("media_id")})
                SELECT
                    rai.id,
                    rai.kind,
                    rai.label,
                    rai.body_text,
                    rai.locator,
                    rai.media_id,
                    m.kind,
                    m.title,
                    m.published_date,
                    mcc.contributor_credits
                FROM reader_apparatus_items rai
                JOIN reader_apparatus_states ras ON ras.id = rai.state_id
                JOIN media m ON m.id = rai.media_id
                JOIN visible_media vm ON vm.media_id = rai.media_id
                LEFT JOIN media_contributor_credits mcc ON mcc.media_id = m.id
                WHERE rai.id = :id
                  AND ras.status IN ('ready', 'partial')
                  AND rai.locator IS NOT NULL
                  AND rai.locator_status != 'missing'
                """
            ),
            {"viewer_id": viewer_id, "id": item_id},
        ).first()
        if row is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        return _result_to_out(
            db,
            viewer_id,
            _RankedReaderApparatusItemResult(
                id=row[0],
                snippet=_truncate_snippet(str(row[3] or row[2] or row[1] or "")),
                apparatus_kind=str(row[1]),
                locator=dict(row[4]),
                source=_build_search_source(row[5], row[6], row[7], row[9], row[8]),
                score=score,
            ),
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
                JOIN resource_external_snapshots res
                  ON res.id = CASE
                      WHEN mr.source_id ~ '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$'
                      THEN CAST(mr.source_id AS uuid)
                      ELSE NULL
                  END
                 AND res.user_id = :viewer_id
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
            db,
            viewer_id,
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
            ),
        )

    if result_type == "evidence_span":
        evidence_span_id = _uuid_from_search_id(result_id)
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
                    m.published_date,
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
            {"viewer_id": viewer_id, "id": evidence_span_id},
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
        return _result_to_out(
            db,
            viewer_id,
            _RankedEvidenceSpanResult(
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
            ),
        )

    raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}")


def _uuid_from_search_id(result_id: str) -> UUID:
    try:
        return UUID(result_id)
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid search result id"
        ) from exc
