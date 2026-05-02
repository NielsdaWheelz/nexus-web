"""Capabilities derivation for media items."""

from nexus.db.models import MediaKind, ProcessingStatus, TranscriptCoverage, TranscriptState
from nexus.schemas.media import CapabilitiesOut

_READY_PROCESSING_STATUSES = {
    ProcessingStatus.ready_for_reading.value,
    ProcessingStatus.embedding.value,
    ProcessingStatus.ready.value,
}
_VALID_PROCESSING_STATUSES = {status.value for status in ProcessingStatus}
_DOCUMENT_MEDIA_KINDS = {
    MediaKind.epub.value,
    MediaKind.web_article.value,
}
_TRANSCRIPT_MEDIA_KINDS = {
    MediaKind.video.value,
    MediaKind.podcast_episode.value,
}
_RETRYABLE_DOCUMENT_MEDIA_KINDS = {
    MediaKind.epub.value,
    MediaKind.pdf.value,
    MediaKind.web_article.value,
}
_VALID_TRANSCRIPT_STATES = {state.value for state in TranscriptState}
_VALID_TRANSCRIPT_COVERAGES = {coverage.value for coverage in TranscriptCoverage}
_READABLE_TRANSCRIPT_STATES = {
    TranscriptState.ready.value,
    TranscriptState.partial.value,
}
_READABLE_TRANSCRIPT_COVERAGES = {
    TranscriptCoverage.partial.value,
    TranscriptCoverage.full.value,
}


def _validate_processing_status(processing_status: str) -> None:
    if processing_status not in _VALID_PROCESSING_STATUSES:
        raise ValueError(f"Unsupported processing status: {processing_status}")


def _validate_transcript_state(transcript_state: str | None) -> None:
    if transcript_state is not None and transcript_state not in _VALID_TRANSCRIPT_STATES:
        raise ValueError(f"Unsupported transcript state: {transcript_state}")


def _validate_transcript_coverage(transcript_coverage: str | None) -> None:
    if transcript_coverage is not None and transcript_coverage not in _VALID_TRANSCRIPT_COVERAGES:
        raise ValueError(f"Unsupported transcript coverage: {transcript_coverage}")


def derive_capabilities(
    kind: str,
    processing_status: str,
    last_error_code: str | None,
    *,
    media_file_exists: bool,
    external_playback_url_exists: bool,
    pdf_quote_text_ready: bool = False,
    transcript_state: str | None = None,
    transcript_coverage: str | None = None,
    can_delete: bool = False,
    is_creator: bool = False,
    requested_url_exists: bool = False,
) -> CapabilitiesOut:
    """Derive capabilities from media state."""
    _validate_processing_status(processing_status)
    _validate_transcript_state(transcript_state)
    _validate_transcript_coverage(transcript_coverage)

    is_pdf = kind == MediaKind.pdf.value
    is_document = kind in _DOCUMENT_MEDIA_KINDS
    is_transcript_media = kind in _TRANSCRIPT_MEDIA_KINDS

    status_ready_for_reading = processing_status in _READY_PROCESSING_STATUSES
    is_transcript_unavailable = False
    transcript_ready = False

    if is_transcript_media and transcript_state is not None:
        is_transcript_unavailable = transcript_state == TranscriptState.unavailable.value
        transcript_ready = transcript_state in _READABLE_TRANSCRIPT_STATES and (
            transcript_coverage in _READABLE_TRANSCRIPT_COVERAGES
        )

    can_download_file = media_file_exists

    if external_playback_url_exists:
        can_play = is_transcript_media or status_ready_for_reading or is_transcript_unavailable
    else:
        can_play = False

    if is_pdf:
        can_read = media_file_exists
    elif is_document:
        can_read = status_ready_for_reading
    elif is_transcript_media:
        if is_transcript_unavailable:
            can_read = False
        else:
            can_read = transcript_ready
    else:
        raise ValueError(f"Unsupported media kind: {kind}")

    if is_transcript_unavailable:
        can_highlight = False
    else:
        can_highlight = can_read

    if is_pdf:
        can_quote = can_read and pdf_quote_text_ready
    elif is_transcript_unavailable:
        can_quote = False
    else:
        can_quote = can_read

    can_search = can_quote

    terminal_retry_error = (
        (kind == MediaKind.pdf.value and last_error_code == "E_PDF_PASSWORD_REQUIRED")
        or (kind == MediaKind.epub.value and last_error_code == "E_ARCHIVE_UNSAFE")
    )
    retry_source_available = (
        (kind in {MediaKind.pdf.value, MediaKind.epub.value} and media_file_exists)
        or (kind == MediaKind.web_article.value and requested_url_exists)
    )
    can_retry = (
        is_creator
        and kind in _RETRYABLE_DOCUMENT_MEDIA_KINDS
        and processing_status == ProcessingStatus.failed.value
        and retry_source_available
        and not terminal_retry_error
    )

    return CapabilitiesOut(
        can_read=can_read,
        can_highlight=can_highlight,
        can_quote=can_quote,
        can_search=can_search,
        can_play=can_play,
        can_download_file=can_download_file,
        can_delete=can_delete,
        can_retry=can_retry,
    )
