"""Capabilities derivation for media items.

Also the single owner of the two author-editing permission predicates (spec 6).
The same functions shape the returned capabilities on the media DTO and
re-authorize each author mutation inside its transaction — the facade calls them
directly so the wire capability and the enforced rule can never diverge.
"""

from nexus.db.models import MediaKind, ProcessingStatus, TranscriptCoverage, TranscriptState
from nexus.schemas.media import CapabilitiesOut

# Roles that may rename a canonical contributor (spec 6:
# canRename = isAdministrator OR canCurateContributors).
CONTRIBUTOR_CURATOR_ROLES = frozenset({"admin", "contributor_curator"})


def can_edit_media_authors(*, can_read: bool, is_creator: bool, is_admin: bool) -> bool:
    """Spec 6: canEditAuthors = canReadMedia AND (isMediaCreator OR isAdministrator).

    Null/system-creator media therefore remains editable only by an administrator.
    """
    return can_read and (is_creator or is_admin)


def can_rename_contributor(roles: frozenset[str]) -> bool:
    """Spec 6: canRename = isAdministrator OR canCurateContributors."""
    return not CONTRIBUTOR_CURATOR_ROLES.isdisjoint(roles)


READABLE_PROCESSING_STATUSES = frozenset(
    {
        ProcessingStatus.ready_for_reading.value,
    }
)
_REFRESHABLE_PROCESSING_STATUSES = {
    ProcessingStatus.ready_for_reading.value,
    ProcessingStatus.failed.value,
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
_SOURCE_REFRESH_MEDIA_KINDS = {
    MediaKind.web_article.value,
    MediaKind.video.value,
    MediaKind.podcast_episode.value,
    MediaKind.pdf.value,
    MediaKind.epub.value,
}
_RETRYABLE_SOURCE_MEDIA_KINDS = {
    MediaKind.epub.value,
    MediaKind.pdf.value,
    MediaKind.web_article.value,
    MediaKind.video.value,
    MediaKind.podcast_episode.value,
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


def _processing_status_value(processing_status: str | ProcessingStatus) -> str:
    if isinstance(processing_status, ProcessingStatus):
        return processing_status.value
    if isinstance(processing_status, str):
        return processing_status
    raise ValueError(f"Unsupported processing status: {processing_status}")


def _validate_processing_status(processing_status: str | ProcessingStatus) -> str:
    processing_status = _processing_status_value(processing_status)
    if processing_status not in _VALID_PROCESSING_STATUSES:
        raise ValueError(f"Unsupported processing status: {processing_status}")
    return processing_status


def _validate_transcript_state(transcript_state: str | None) -> None:
    if transcript_state is not None and transcript_state not in _VALID_TRANSCRIPT_STATES:
        raise ValueError(f"Unsupported transcript state: {transcript_state}")


def _validate_transcript_coverage(transcript_coverage: str | None) -> None:
    if transcript_coverage is not None and transcript_coverage not in _VALID_TRANSCRIPT_COVERAGES:
        raise ValueError(f"Unsupported transcript coverage: {transcript_coverage}")


def is_document_status_ready(processing_status: str | ProcessingStatus) -> bool:
    processing_status = _validate_processing_status(processing_status)
    return processing_status in READABLE_PROCESSING_STATUSES


def is_transcript_readable(transcript_state: str | None, transcript_coverage: str | None) -> bool:
    _validate_transcript_state(transcript_state)
    _validate_transcript_coverage(transcript_coverage)
    return transcript_state in _READABLE_TRANSCRIPT_STATES and (
        transcript_coverage in _READABLE_TRANSCRIPT_COVERAGES
    )


def is_text_document_ready(
    kind: str,
    processing_status: str | ProcessingStatus,
    transcript_state: str | None = None,
    transcript_coverage: str | None = None,
) -> bool:
    """Return whether text/document read APIs may expose current artifacts."""
    if kind in _DOCUMENT_MEDIA_KINDS or kind == MediaKind.pdf.value:
        return is_document_status_ready(processing_status)
    if kind in _TRANSCRIPT_MEDIA_KINDS:
        return is_transcript_readable(transcript_state, transcript_coverage)
    raise ValueError(f"Unsupported media kind: {kind}")


def derive_capabilities(
    kind: str,
    processing_status: str | ProcessingStatus,
    last_error_code: str | None,
    *,
    media_file_exists: bool,
    external_playback_url_exists: bool,
    pdf_quote_text_ready: bool = False,
    transcript_state: str | None = None,
    transcript_coverage: str | None = None,
    retrieval_status: str | None = None,
    retrieval_active_ready: bool | None = None,
    can_delete: bool = False,
    is_creator: bool = False,
    is_admin: bool = False,
    requested_url_exists: bool = False,
    source_retry_available: bool = False,
    source_refresh_available: bool = False,
) -> CapabilitiesOut:
    """Derive capabilities from media state."""
    processing_status = _validate_processing_status(processing_status)
    _validate_transcript_state(transcript_state)
    _validate_transcript_coverage(transcript_coverage)

    is_pdf = kind == MediaKind.pdf.value
    is_document = kind in _DOCUMENT_MEDIA_KINDS
    is_transcript_media = kind in _TRANSCRIPT_MEDIA_KINDS

    status_ready_for_reading = is_document_status_ready(processing_status)
    is_transcript_unavailable = False
    transcript_ready = False

    if is_transcript_media and transcript_state is not None:
        is_transcript_unavailable = transcript_state == TranscriptState.unavailable.value
        transcript_ready = is_transcript_readable(transcript_state, transcript_coverage)

    can_download_file = media_file_exists

    if external_playback_url_exists:
        can_play = is_transcript_media or status_ready_for_reading or is_transcript_unavailable
    else:
        can_play = False

    if is_pdf:
        can_read = media_file_exists and processing_status != ProcessingStatus.failed.value
    elif is_document:
        can_read = status_ready_for_reading
    elif is_transcript_media:
        if is_transcript_unavailable:
            can_read = False
        else:
            can_read = transcript_ready
    else:
        raise ValueError(f"Unsupported media kind: {kind}")

    if is_pdf:
        can_highlight = media_file_exists and status_ready_for_reading
    elif is_transcript_unavailable:
        can_highlight = False
    else:
        can_highlight = can_read

    if is_pdf:
        can_quote = can_highlight and pdf_quote_text_ready
    elif is_transcript_unavailable:
        can_quote = False
    else:
        can_quote = can_read

    retrieval_ready = (
        retrieval_status == "ready" if retrieval_active_ready is None else retrieval_active_ready
    )
    can_search = can_quote and retrieval_ready

    terminal_retry_error = (
        kind == MediaKind.pdf.value and last_error_code == "E_PDF_PASSWORD_REQUIRED"
    ) or (kind == MediaKind.epub.value and last_error_code == "E_ARCHIVE_UNSAFE")
    can_retry = (
        is_creator
        and kind in _RETRYABLE_SOURCE_MEDIA_KINDS
        and processing_status == ProcessingStatus.failed.value
        and source_retry_available
        and not terminal_retry_error
    )
    can_refresh_source = (
        is_creator
        and kind in _SOURCE_REFRESH_MEDIA_KINDS
        and source_refresh_available
        and processing_status in _REFRESHABLE_PROCESSING_STATUSES
    )
    can_retry_metadata = is_creator and processing_status in READABLE_PROCESSING_STATUSES
    # Spec §6 canReadMedia is the ACCESS predicate (auth/permissions.can_read_media
    # — library/provenance membership), not this file's content-readability
    # can_read. Media DTOs are assembled only for media the viewer can access, so
    # the access term is true by construction here — the same value the PUT
    # enforcement passes after re-checking can_read_media. Author editing must
    # not depend on processing state (a failed ingest still has editable authors).
    can_edit_authors = can_edit_media_authors(
        can_read=True, is_creator=is_creator, is_admin=is_admin
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
        can_refresh_source=can_refresh_source,
        can_retry_metadata=can_retry_metadata,
        can_edit_authors=can_edit_authors,
        can_read_embeds=is_document and kind == MediaKind.web_article.value,
    )
