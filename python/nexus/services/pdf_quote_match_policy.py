"""Shared non-pure policy/helper for PDF matcher anomaly logging and path-specific mapping.

Owns the canonical pdf_quote_match_anomaly event schema (D14), centralized
logging/mapping helpers, and the no-content redaction contract (D15).

Two-layer boundary (D13): pdf_quote_match.py provides typed recoverable anomaly
classifications; this module owns structured logging + path-specific mapping.
"""

from dataclasses import dataclass
from uuid import UUID

from nexus.logging import get_logger
from nexus.services.pdf_quote_match import (
    MatcherAnomaly,
    MatchResult,
)

logger = get_logger(__name__)

_EVENT_NAME = "pdf_quote_match_anomaly"


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


def match_result_to_persistence_fields(result: MatchResult) -> dict:
    """Convert a MatchResult to dict of fields for highlight_pdf_anchors persistence."""
    return {
        "plain_text_match_status": result.status.value,
        "plain_text_match_version": result.match_version,
        "plain_text_start_offset": result.start_offset,
        "plain_text_end_offset": result.end_offset,
    }
