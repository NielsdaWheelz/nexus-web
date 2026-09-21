"""Capabilities derivation for media items.

Also the single owner of the two author-editing permission predicates (spec 6)
and of the identity a recovery command is admitted for. The same functions shape
the returned capabilities on the media DTO and re-authorize each author mutation
inside its transaction — the facade calls them directly so the wire capability
and the enforced rule can never diverge. Recovery capabilities are not derived
here: the source and search owners decide the offer, and this module only reads
which offer they made.
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
    """A viewer's recovery command: authorized as that viewer and replayed by
    their ``client_mutation_id``."""

    viewer_id: UUID
    client_mutation_id: str


@dataclass(frozen=True, slots=True)
class OperatorRecovery:
    """An internal operator route: operator authority, no viewer, no replay ledger."""


type RecoveryActor = ViewerRecovery | OperatorRecovery


def can_edit_media_authors(*, can_read: bool, is_creator: bool) -> bool:
    """Spec 6: canEditAuthors = canReadMedia AND isMediaCreator.

    Null/system-creator media therefore has no author editor.
    """
    return can_read and is_creator


_REFRESHABLE_PROCESSING_STATUSES = {
    ProcessingStatus.ready_for_reading.value,
    ProcessingStatus.failed.value,
}
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
_READABLE_TRANSCRIPT_STATES = {
    TranscriptState.ready.value,
    TranscriptState.partial.value,
}
_READABLE_TRANSCRIPT_COVERAGES = {
    TranscriptCoverage.partial.value,
    TranscriptCoverage.full.value,
}
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


def is_document_status_ready(processing_status: str | ProcessingStatus) -> bool:
    return processing_status == ProcessingStatus.ready_for_reading.value


def is_same_source_terminal_error(error_code: str | None) -> bool:
    """Return whether retrying or refreshing the exact source cannot change the result."""
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
    source_refresh_available: bool = False,
    source_recovery: SourceRecoveryAnswer,
    search_recovery: SearchRecoveryAnswer,
) -> CapabilitiesOut:
    """Derive capabilities from media state and the owners' recovery answers."""
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

    source_suspended = isinstance(source_recovery, RepairSourceOffer)
    can_refresh_source = (
        is_creator
        and kind in _SOURCE_REFRESH_MEDIA_KINDS
        and source_refresh_available
        and processing_status in _REFRESHABLE_PROCESSING_STATUSES
        and not is_same_source_terminal_error(last_error_code)
        and not source_suspended
    )
    can_retry_metadata = is_creator and is_metadata_enrichment_eligible(
        kind=kind, processing_status=processing_status
    )
    # Spec §6 canReadMedia is the ACCESS predicate (auth/permissions.can_read_media
    # — library/provenance membership), not this file's content-readability
    # can_read. Media DTOs are assembled only for media the viewer can access, so
    # the access term is true by construction here — the same value the PUT
    # enforcement passes after re-checking can_read_media. Author editing must
    # not depend on processing state (a failed ingest still has editable authors).
    can_edit_authors = can_edit_media_authors(can_read=True, is_creator=is_creator)

    return CapabilitiesOut(
        can_read=can_read,
        can_highlight=can_highlight,
        can_quote=can_quote,
        can_search=can_search,
        can_play=can_play,
        can_download_file=can_download_file,
        can_delete=can_delete,
        can_retry=isinstance(source_recovery, RetrySourceOffer),
        can_refresh_source=can_refresh_source,
        can_retry_metadata=can_retry_metadata,
        can_repair_source=source_suspended,
        can_repair_search=isinstance(search_recovery, RepairSearchOffer),
        can_edit_authors=can_edit_authors,
        can_read_embeds=is_document and kind == MediaKind.web_article.value,
    )
