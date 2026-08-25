"""Search orchestrator and durable-ref resolver.

Retrieval, ranking, and per-type dispatch live behind the shared pre-projection
candidate seam (``search.candidates``); this module owns the public ``search``
contract (gates, pagination, ``SearchResultOut`` projection) and
``get_search_result`` durable-ref re-resolution.
"""

from __future__ import annotations

import time
from typing import cast
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.schemas.search import (
    SearchPageInfo,
    SearchResponse,
    SearchResultOut,
    SearchResultSourceOut,
)
from nexus.schemas.search_types import VALID_RESULT_TYPES
from nexus.services import media_intelligence
from nexus.services.search.candidates import discovery_candidates
from nexus.services.search.constants import (
    MAX_LIMIT,
    MIN_QUERY_LENGTH,
)
from nexus.services.search.cursor import decode_search_cursor, encode_search_cursor
from nexus.services.search.embedding import _query_has_full_text_terms
from nexus.services.search.kinds import KIND_TO_RESULT_TYPES
from nexus.services.search.projection import _result_to_out
from nexus.services.search.query import SearchQuery
from nexus.services.search.results import _SearchScore
from nexus.services.search.retrievers.content_chunks import (
    resolve_content_chunk_search_result,
)
from nexus.services.search.retrievers.contributors import resolve_contributor_search_result
from nexus.services.search.retrievers.conversations import (
    ConversationSearchResultType,
    resolve_conversation_search_result,
)
from nexus.services.search.retrievers.evidence_spans import (
    resolve_evidence_span_search_result,
)
from nexus.services.search.retrievers.fragments import resolve_fragment_search_result
from nexus.services.search.retrievers.highlights import resolve_highlight_search_result
from nexus.services.search.retrievers.media import (
    MEDIA_SEARCH_RESULT_TYPES,
    MediaSearchResultType,
    resolve_media_search_result,
)
from nexus.services.search.retrievers.notes import (
    NotesSearchResultType,
    resolve_notes_search_result,
)
from nexus.services.search.retrievers.reader_apparatus import (
    resolve_reader_apparatus_search_result,
)
from nexus.services.search.retrievers.web import resolve_web_search_result
from nexus.services.search.scope import authorize_scope
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

    projections = media_intelligence.read_batch(db, media_ids=list(sources_by_media.keys()))
    for media_id, projection in projections.items():
        for source in sources_by_media.get(media_id, []):
            source.summary_md = projection.summary_md


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
        highlight_notes_only=query.highlight_notes_only,
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

    if result_type in MEDIA_SEARCH_RESULT_TYPES:
        return _result_to_out(
            db,
            viewer_id,
            resolve_media_search_result(
                db,
                viewer_id=viewer_id,
                result_type=cast(MediaSearchResultType, result_type),
                result_id=_uuid_from_search_id(result_id),
                score=score,
            ),
        )

    if result_type == "contributor":
        return _result_to_out(
            db,
            viewer_id,
            resolve_contributor_search_result(
                db,
                viewer_id=viewer_id,
                result_id=_uuid_from_search_id(result_id),
                score=score,
            ),
        )

    if result_type == "content_chunk":
        return _result_to_out(
            db,
            viewer_id,
            resolve_content_chunk_search_result(
                db,
                viewer_id=viewer_id,
                result_id=_uuid_from_search_id(result_id),
                score=score,
                evidence_span_ids=evidence_span_ids,
            ),
        )

    if result_type == "fragment":
        return _result_to_out(
            db,
            viewer_id,
            resolve_fragment_search_result(
                db,
                viewer_id=viewer_id,
                result_id=_uuid_from_search_id(result_id),
                score=score,
            ),
        )

    if result_type in KIND_TO_RESULT_TYPES["notes"]:
        return _result_to_out(
            db,
            viewer_id,
            resolve_notes_search_result(
                db,
                viewer_id=viewer_id,
                result_type=cast(NotesSearchResultType, result_type),
                result_id=_uuid_from_search_id(result_id),
                score=score,
            ),
        )

    if result_type == "highlight":
        return _result_to_out(
            db,
            viewer_id,
            resolve_highlight_search_result(
                db,
                viewer_id=viewer_id,
                result_id=_uuid_from_search_id(result_id),
                score=score,
            ),
        )

    if result_type in KIND_TO_RESULT_TYPES["conversations"]:
        return _result_to_out(
            db,
            viewer_id,
            resolve_conversation_search_result(
                db,
                viewer_id=viewer_id,
                result_type=cast(ConversationSearchResultType, result_type),
                result_id=_uuid_from_search_id(result_id),
                score=score,
            ),
        )

    if result_type == "reader_apparatus_item":
        return _result_to_out(
            db,
            viewer_id,
            resolve_reader_apparatus_search_result(
                db,
                viewer_id=viewer_id,
                result_id=_uuid_from_search_id(result_id),
                score=score,
            ),
        )

    if result_type == "web_result":
        return _result_to_out(
            db,
            viewer_id,
            resolve_web_search_result(
                db,
                viewer_id=viewer_id,
                result_id=_uuid_from_search_id(result_id),
                score=score,
            ),
        )

    if result_type == "evidence_span":
        return _result_to_out(
            db,
            viewer_id,
            resolve_evidence_span_search_result(
                db,
                viewer_id=viewer_id,
                result_id=_uuid_from_search_id(result_id),
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
