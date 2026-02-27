"""Shared non-pure policy/helper for PDF matcher anomaly logging and path-specific mapping.

Owns the canonical pdf_quote_match_anomaly event schema (D14), centralized
logging/mapping helpers, and the no-content redaction contract (D15).

Two-layer boundary (D13): pdf_quote_match.py provides typed recoverable anomaly
classifications; this module owns structured logging + path-specific mapping.
"""

from dataclasses import dataclass
from enum import Enum
from uuid import UUID

from nexus.logging import get_logger
from nexus.services.pdf_quote_match import (
    MatcherAnomaly,
    MatchResult,
)

logger = get_logger(__name__)

_EVENT_NAME = "pdf_quote_match_anomaly"
_COHERENCE_EVENT_NAME = "pdf_quote_context_coherence_anomaly"


class PdfQuoteMatchInternalError(Exception):
    """Unclassified matcher exception — E_INTERNAL semantics.

    Raised by policy helpers when an unclassified exception is encountered.
    Callers should propagate this to fail the mutation.
    """

    def __init__(self, message: str, diagnostics: dict | None = None):
        self.diagnostics = diagnostics or {}
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class PendingWriteOutcome:
    """Approved D12 degrade-to-pending write-path outcome.

    All fields suitable for direct persistence on highlight_pdf_anchors.
    """

    match_status: str  # always "pending"
    match_version: None  # always None
    start_offset: None  # always None
    end_offset: None  # always None
    prefix: str  # always ""
    suffix: str  # always ""


_PENDING_OUTCOME = PendingWriteOutcome(
    match_status="pending",
    match_version=None,
    start_offset=None,
    end_offset=None,
    prefix="",
    suffix="",
)


class CoherenceAnomalyKind(str, Enum):
    """Recoverable coherence anomaly taxonomy for quote-context rendering."""

    unsupported_match_version = "unsupported_match_version"
    status_offsets_inconsistent = "status_offsets_inconsistent"
    offsets_out_of_range = "offsets_out_of_range"
    offsets_outside_page_span = "offsets_outside_page_span"
    offset_substring_mismatch_exact = "offset_substring_mismatch_exact"
    exact_status_inconsistent = "exact_status_inconsistent"
    unknown_match_status = "unknown_match_status"


class CoherenceFallbackAction(str, Enum):
    """Deterministic recoverable fallback actions for coherence anomalies."""

    retry_as_pending = "retry_as_pending"
    omit_nearby_context = "omit_nearby_context"


_COHERENCE_RECOVERABLE_ACTIONS: dict[CoherenceAnomalyKind, CoherenceFallbackAction] = {
    CoherenceAnomalyKind.unsupported_match_version: CoherenceFallbackAction.retry_as_pending,
    CoherenceAnomalyKind.status_offsets_inconsistent: CoherenceFallbackAction.retry_as_pending,
    CoherenceAnomalyKind.offsets_out_of_range: CoherenceFallbackAction.retry_as_pending,
    CoherenceAnomalyKind.offsets_outside_page_span: CoherenceFallbackAction.retry_as_pending,
    CoherenceAnomalyKind.offset_substring_mismatch_exact: CoherenceFallbackAction.retry_as_pending,
    CoherenceAnomalyKind.exact_status_inconsistent: CoherenceFallbackAction.retry_as_pending,
    CoherenceAnomalyKind.unknown_match_status: CoherenceFallbackAction.omit_nearby_context,
}


def handle_recoverable_anomaly(
    anomaly: MatcherAnomaly,
    *,
    highlight_id: UUID | None,
    media_id: UUID | None,
    page_number: int | None,
    path: str,
) -> PendingWriteOutcome:
    """Handle a classified recoverable matcher anomaly.

    Emits one canonical pdf_quote_match_anomaly event and returns the
    approved D12 degrade-to-pending outcome. Caller must NOT re-log.
    """
    logger.warning(
        _EVENT_NAME,
        anomaly_kind=anomaly.kind.value,
        classification="recoverable",
        path=path,
        highlight_id=str(highlight_id) if highlight_id else None,
        media_id=str(media_id) if media_id else None,
        page_number=page_number,
        detail_length=len(anomaly.detail) if anomaly.detail else 0,
    )
    return _PENDING_OUTCOME


def handle_unclassified_exception(
    exc: Exception,
    *,
    highlight_id: UUID | None,
    media_id: UUID | None,
    page_number: int | None,
    path: str,
) -> None:
    """Handle an unclassified matcher exception.

    Emits one canonical pdf_quote_match_anomaly event with sanitized
    exception diagnostics and raises PdfQuoteMatchInternalError.
    Caller must NOT re-log the same anomaly.
    """
    exc_type = type(exc).__name__
    # D15: sanitize exception message — only type name, no content
    logger.error(
        _EVENT_NAME,
        anomaly_kind="unclassified",
        classification="unclassified",
        path=path,
        highlight_id=str(highlight_id) if highlight_id else None,
        media_id=str(media_id) if media_id else None,
        page_number=page_number,
        exception_type=exc_type,
    )
    raise PdfQuoteMatchInternalError(
        f"Unclassified PDF quote-match exception: {exc_type}",
        diagnostics={
            "exception_type": exc_type,
            "highlight_id": str(highlight_id) if highlight_id else None,
            "media_id": str(media_id) if media_id else None,
        },
    ) from exc


def handle_recoverable_coherence_anomaly(
    anomaly_kind: CoherenceAnomalyKind,
    *,
    highlight_id: UUID | None,
    media_id: UUID | None,
    page_number: int | None,
    match_status: str | None,
    match_version: int | None,
    path: str,
) -> CoherenceFallbackAction:
    """Handle a classified recoverable coherence anomaly.

    Emits one canonical pdf_quote_context_coherence_anomaly event and returns
    the deterministic fallback action for quote-context rendering.
    Caller must NOT re-log the same anomaly.
    """
    fallback_action = _COHERENCE_RECOVERABLE_ACTIONS[anomaly_kind]
    logger.warning(
        _COHERENCE_EVENT_NAME,
        anomaly_kind=anomaly_kind.value,
        classification="recoverable",
        fallback_action=fallback_action.value,
        path=path,
        highlight_id=str(highlight_id) if highlight_id else None,
        media_id=str(media_id) if media_id else None,
        page_number=page_number,
        match_status=match_status,
        match_version=match_version,
    )
    return fallback_action


def handle_coherence_unclassified_exception(
    exc: Exception,
    *,
    highlight_id: UUID | None,
    media_id: UUID | None,
    page_number: int | None,
    match_status: str | None,
    match_version: int | None,
    path: str,
) -> None:
    """Handle an unclassified coherence exception.

    Emits one canonical pdf_quote_context_coherence_anomaly event with
    sanitized diagnostics and raises PdfQuoteMatchInternalError.
    Caller must NOT re-log the same anomaly.
    """
    exc_type = type(exc).__name__
    logger.error(
        _COHERENCE_EVENT_NAME,
        anomaly_kind="unclassified",
        classification="unclassified",
        path=path,
        highlight_id=str(highlight_id) if highlight_id else None,
        media_id=str(media_id) if media_id else None,
        page_number=page_number,
        match_status=match_status,
        match_version=match_version,
        exception_type=exc_type,
    )
    raise PdfQuoteMatchInternalError(
        f"Unclassified PDF quote-context coherence exception: {exc_type}",
        diagnostics={
            "exception_type": exc_type,
            "highlight_id": str(highlight_id) if highlight_id else None,
            "media_id": str(media_id) if media_id else None,
            "match_status": match_status,
            "match_version": match_version,
        },
    ) from exc


def match_result_to_persistence_fields(result: MatchResult) -> dict:
    """Convert a MatchResult to dict of fields for highlight_pdf_anchors persistence."""
    return {
        "plain_text_match_status": result.status.value,
        "plain_text_match_version": result.match_version,
        "plain_text_start_offset": result.start_offset,
        "plain_text_end_offset": result.end_offset,
    }
