"""Readability of a media's text, plus the readiness and author-edit predicates.

The same predicates shape the wire capabilities and re-authorize each reader, highlight
and author write, so the advertised action and the enforced rule cannot diverge. Recovery
is read, not decided here: the source and search owners make the offer.
"""

from typing import Literal

from nexus.schemas.imports import RepairSearchOffer, RepairSourceOffer, RetrySourceOffer
from nexus.services.pdf_readiness import pdf_quote_text_readiness_rows_sql
from nexus.services.reader_publication import ready_publication_rows_sql

SourceRecoveryRestriction = Literal["NotOwner", "SameSourceTerminal", "SourceNotReacquirable"]
type SourceRecoveryAnswer = RetrySourceOffer | RepairSourceOffer | SourceRecoveryRestriction | None
type SearchRecoveryAnswer = RepairSearchOffer | Literal["NotOwner"] | None

_TRANSCRIPT_KINDS = ("video", "podcast_episode")
_SAME_SOURCE_TERMINAL_ERROR_CODES = frozenset(
    {
        "E_ARCHIVE_UNSAFE",
        "E_INVALID_FILE_TYPE",
        "E_PDF_PASSWORD_REQUIRED",
        "E_RESOURCE_LIMIT",
        "E_SOURCE_ACCESS_DENIED",
        "E_SOURCE_GONE",
        "E_SOURCE_INTEGRITY",
        "E_SOURCE_NOT_READABLE",
        "E_SOURCE_TOO_LARGE",
    }
)


def can_edit_media_authors(*, can_read: bool, is_creator: bool) -> bool:
    """Readable and created by the viewer, whatever its processing (I4)."""
    return can_read and is_creator


def is_document_status_ready(processing_status: str) -> bool:
    return processing_status == "ready_for_reading"


def is_same_source_terminal_error(error_code: str | None) -> bool:
    """Whether retrying or refreshing the exact source cannot change the result."""
    return error_code in _SAME_SOURCE_TERMINAL_ERROR_CODES


def media_file_exists_sql(media_id_expr: str) -> str:
    return f"EXISTS (SELECT 1 FROM media_file mf WHERE mf.media_id = {media_id_expr})"


def quotable_document_rows_sql() -> str:
    """Documents whose current artifacts are quotable: the query half of ``can_quote``
    (a ready reader publication; a pdf's file and complete text too).

    Visibility belongs to the caller.
    """
    return f"""
        SELECT m.id AS media_id, m.kind AS media_kind
        FROM media m
        JOIN ({ready_publication_rows_sql()}) publication ON publication.media_id = m.id
        LEFT JOIN ({pdf_quote_text_readiness_rows_sql()}) pdf ON pdf.media_id = m.id
        WHERE (
            m.kind IN ('web_article', 'epub')
            OR (m.kind = 'pdf' AND {media_file_exists_sql("m.id")} AND pdf.quote_text_ready)
        )
    """


def _transcript_readable(state: str | None, coverage: str | None) -> bool:
    return state in ("ready", "partial") and coverage in ("partial", "full")


def is_text_document_ready(
    kind: str,
    processing_status: str,
    transcript_state: str | None = None,
    transcript_coverage: str | None = None,
) -> bool:
    """Whether the text and document read APIs may expose current artifacts."""
    if kind in _TRANSCRIPT_KINDS:
        return _transcript_readable(transcript_state, transcript_coverage)
    return is_document_status_ready(processing_status)


def publication_readable(kind: str, *, has_file: bool, publication_ready: bool) -> bool:
    """A document is readable from its ready reader publication (``ready_publication_rows_sql``:
    never inferred from an uploaded file); a pdf also needs its file."""
    return publication_ready and (kind != "pdf" or has_file)


def reading_capabilities(
    kind: str,
    *,
    has_file: bool,
    publication_ready: bool,
    pdf_quote_text_ready: bool,
    transcript_state: str | None,
    transcript_coverage: str | None,
) -> tuple[bool, bool, bool]:
    """``(can_read, can_highlight, can_quote)``.

    A document reads, highlights and quotes while its publication is readable
    (``publication_readable``); a pdf's quotes also need its complete text. A transcript is
    readable when ready or partial with some coverage.
    """
    if kind in _TRANSCRIPT_KINDS:
        ready = _transcript_readable(transcript_state, transcript_coverage)
        return ready, ready, ready
    can_read = publication_readable(kind, has_file=has_file, publication_ready=publication_ready)
    return can_read, can_read, can_read and (kind != "pdf" or pdf_quote_text_ready)
