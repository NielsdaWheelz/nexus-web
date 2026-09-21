"""Media capability derivation, plus the readiness and author-edit predicates.

The same predicates shape the wire capabilities and re-authorize each author
mutation, so the advertised action and the enforced rule cannot diverge. Recovery
capabilities are read, not decided: the source and search owners make the offer.
"""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from nexus.db.models import MediaKind, ProcessingStatus, TranscriptCoverage, TranscriptState
from nexus.schemas.imports import RepairSearchOffer, RepairSourceOffer, RetrySourceOffer
from nexus.schemas.media import CapabilitiesOut
from nexus.services.media_processing_state import is_metadata_enrichment_eligible

SourceRecoveryRestriction = Literal["NotOwner", "SameSourceTerminal", "SourceNotReacquirable"]
type SourceRecoveryAnswer = RetrySourceOffer | RepairSourceOffer | SourceRecoveryRestriction | None
type SearchRecoveryAnswer = RepairSearchOffer | Literal["NotOwner"] | None


@dataclass(frozen=True, slots=True)
class ViewerRecovery:
    """A viewer's recovery command, replayed by their ``client_mutation_id``."""

    viewer_id: UUID
    client_mutation_id: str


@dataclass(frozen=True, slots=True)
class OperatorRecovery:
    """An internal operator route: operator authority, no viewer, no replay ledger."""


type RecoveryActor = ViewerRecovery | OperatorRecovery

_REFRESHABLE_PROCESSING_STATUSES = {
    ProcessingStatus.ready_for_reading.value,
    ProcessingStatus.failed.value,
}
_DOCUMENT_MEDIA_KINDS = {MediaKind.epub.value, MediaKind.web_article.value}
_TRANSCRIPT_MEDIA_KINDS = {MediaKind.video.value, MediaKind.podcast_episode.value}
_SOURCE_REFRESH_MEDIA_KINDS = {
    MediaKind.web_article.value,
    MediaKind.video.value,
    MediaKind.podcast_episode.value,
    MediaKind.pdf.value,
    MediaKind.epub.value,
}
_READABLE_TRANSCRIPT_STATES = {TranscriptState.ready.value, TranscriptState.partial.value}
_READABLE_TRANSCRIPT_COVERAGES = {TranscriptCoverage.partial.value, TranscriptCoverage.full.value}
_SAME_SOURCE_TERMINAL_ERROR_CODES = frozenset(
    {
        "E_ARCHIVE_UNSAFE",
        "E_INVALID_FILE_TYPE",
        "E_PDF_PASSWORD_REQUIRED",
        "E_RESOURCE_LIMIT",
        "E_SOURCE_ACCESS_DENIED",
        "E_SOURCE_INTEGRITY",
        "E_SOURCE_NOT_READABLE",
        "E_SOURCE_TOO_LARGE",
    }
)


def can_edit_media_authors(*, can_read: bool, is_creator: bool) -> bool:
    """canEditAuthors = canReadMedia AND isMediaCreator; system media has no editor."""
    return can_read and is_creator


def is_document_status_ready(processing_status: str | ProcessingStatus) -> bool:
    return processing_status == ProcessingStatus.ready_for_reading.value


def is_same_source_terminal_error(error_code: str | None) -> bool:
    """Whether retrying or refreshing the exact source cannot change the result."""
    return error_code in _SAME_SOURCE_TERMINAL_ERROR_CODES


def is_transcript_readable(transcript_state: str | None, transcript_coverage: str | None) -> bool:
    return transcript_state in _READABLE_TRANSCRIPT_STATES and (
        transcript_coverage in _READABLE_TRANSCRIPT_COVERAGES
    )


def is_text_document_ready(
    kind: str,
    processing_status: str | ProcessingStatus,
    transcript_state: str | None = None,
    transcript_coverage: str | None = None,
) -> bool:
    """Whether text/document read APIs may expose current artifacts."""
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
    source_refresh_available: bool = False,
    source_recovery: SourceRecoveryAnswer,
    search_recovery: SearchRecoveryAnswer,
) -> CapabilitiesOut:
    """Derive capabilities from media state and the owners' recovery answers."""
    is_pdf = kind == MediaKind.pdf.value
    is_document = kind in _DOCUMENT_MEDIA_KINDS
    is_transcript_media = kind in _TRANSCRIPT_MEDIA_KINDS
    if not (is_pdf or is_document or is_transcript_media):
        raise ValueError(f"Unsupported media kind: {kind}")

    status_ready = is_document_status_ready(processing_status)
    transcript_unavailable = (
        is_transcript_media and transcript_state == TranscriptState.unavailable.value
    )
    transcript_ready = (
        is_transcript_media
        and transcript_state is not None
        and is_transcript_readable(transcript_state, transcript_coverage)
    )

    if is_pdf:
        can_read = media_file_exists and processing_status != ProcessingStatus.failed.value
        can_highlight = media_file_exists and status_ready
        can_quote = can_highlight and pdf_quote_text_ready
    elif is_document:
        can_read = can_highlight = can_quote = status_ready
    elif transcript_unavailable:
        can_read = can_highlight = can_quote = False
    else:
        can_read = can_highlight = can_quote = transcript_ready

    retrieval_ready = (
        retrieval_status == "ready" if retrieval_active_ready is None else retrieval_active_ready
    )
    source_suspended = isinstance(source_recovery, RepairSourceOffer)

    return CapabilitiesOut(
        can_read=can_read,
        can_highlight=can_highlight,
        can_quote=can_quote,
        can_search=can_quote and retrieval_ready,
        can_play=external_playback_url_exists
        and (is_transcript_media or status_ready or transcript_unavailable),
        can_download_file=media_file_exists,
        can_delete=can_delete,
        can_retry=isinstance(source_recovery, RetrySourceOffer),
        can_refresh_source=(
            is_creator
            and kind in _SOURCE_REFRESH_MEDIA_KINDS
            and source_refresh_available
            and processing_status in _REFRESHABLE_PROCESSING_STATUSES
            and not is_same_source_terminal_error(last_error_code)
            and not source_suspended
        ),
        # Author editing must not depend on processing state: a failed ingest
        # still has editable authors. The access half is true by construction —
        # a media DTO is only assembled for media the viewer can already read.
        can_retry_metadata=is_creator
        and is_metadata_enrichment_eligible(kind=kind, processing_status=processing_status),
        can_repair_source=source_suspended,
        can_repair_search=isinstance(search_recovery, RepairSearchOffer),
        can_edit_authors=can_edit_media_authors(can_read=True, is_creator=is_creator),
        can_read_embeds=kind == MediaKind.web_article.value,
    )
