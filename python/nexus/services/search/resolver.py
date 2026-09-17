"""Durable typed search-result reopening and public projection."""

from __future__ import annotations

from typing import assert_never, cast
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.search import SearchResultOut
from nexus.schemas.search_types import SEARCH_RESULT_TYPES, VALID_RESULT_TYPES
from nexus.services.search.projection import _result_to_out
from nexus.services.search.results import InternalSearchResult, _SearchScore
from nexus.services.search.retrievers.content_chunks import (
    resolve_content_chunk_search_result,
)
from nexus.services.search.retrievers.conversations import resolve_message_search_result
from nexus.services.search.retrievers.evidence_spans import (
    resolve_evidence_span_search_result,
)
from nexus.services.search.retrievers.fragments import resolve_fragment_search_result
from nexus.services.search.retrievers.highlights import resolve_highlight_search_result
from nexus.services.search.retrievers.media import (
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


def get_search_result(
    db: Session,
    viewer_id: UUID,
    result_type: str,
    result_id: str,
    evidence_span_ids: list[UUID] | None = None,
) -> SearchResultOut:
    """Reopen one visible search result from its durable object reference."""
    if result_type not in VALID_RESULT_TYPES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid search type: {result_type}"
        )

    internal_result = _resolve_search_result(
        db,
        viewer_id=viewer_id,
        result_type=cast(SEARCH_RESULT_TYPES, result_type),
        result_id=_uuid_from_search_id(result_id),
        evidence_span_ids=evidence_span_ids,
    )
    return _result_to_out(db, viewer_id, internal_result)


def _resolve_search_result(
    db: Session,
    *,
    viewer_id: UUID,
    result_type: SEARCH_RESULT_TYPES,
    result_id: UUID,
    evidence_span_ids: list[UUID] | None,
) -> InternalSearchResult:
    """Dispatch a validated discriminant to its semantic retriever owner."""
    score = _SearchScore(raw=1.0, weighted=1.0, normalized=1.0)

    match result_type:
        case "media" | "episode" | "video":
            return resolve_media_search_result(
                db,
                viewer_id=viewer_id,
                result_type=cast(MediaSearchResultType, result_type),
                result_id=result_id,
                score=score,
            )
        case "content_chunk":
            return resolve_content_chunk_search_result(
                db,
                viewer_id=viewer_id,
                result_id=result_id,
                score=score,
                evidence_span_ids=evidence_span_ids,
            )
        case "fragment":
            return resolve_fragment_search_result(
                db,
                viewer_id=viewer_id,
                result_id=result_id,
                score=score,
            )
        case "page" | "note_block":
            return resolve_notes_search_result(
                db,
                viewer_id=viewer_id,
                result_type=cast(NotesSearchResultType, result_type),
                result_id=result_id,
                score=score,
            )
        case "highlight":
            return resolve_highlight_search_result(
                db,
                viewer_id=viewer_id,
                result_id=result_id,
                score=score,
            )
        case "message":
            return resolve_message_search_result(
                db,
                viewer_id=viewer_id,
                result_id=result_id,
                score=score,
            )
        case "reader_apparatus_item":
            return resolve_reader_apparatus_search_result(
                db,
                viewer_id=viewer_id,
                result_id=result_id,
                score=score,
            )
        case "web_result":
            return resolve_web_search_result(
                db,
                viewer_id=viewer_id,
                result_id=result_id,
                score=score,
            )
        case "evidence_span":
            return resolve_evidence_span_search_result(
                db,
                viewer_id=viewer_id,
                result_id=result_id,
                score=score,
            )
        case "podcast" | "contributor" | "conversation" | "artifact":
            # Discovery emits these, but no citable resource ever reopens as one.
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Search result not found")
        case unreachable:
            assert_never(unreachable)


def _uuid_from_search_id(result_id: str) -> UUID:
    try:
        return UUID(result_id)
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid search result id"
        ) from exc
