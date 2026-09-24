"""Media, fragment, upload, reader-navigation and evidence wire models."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, FiniteFloat
from pydantic.alias_generators import to_camel

from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import Presence
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.upload_failures import UploadTransportFailure, UploadVerificationFailureCode
from nexus.services.offline_download_source import (
    OFFLINE_DOWNLOAD_SOURCE_URL_MAX_LENGTH,
    OFFLINE_DOWNLOAD_TITLE_MAX_LENGTH,
)
from nexus.services.sealed_handles import UploadSessionHandle


class _Strict(BaseModel):
    """Base for every closed model on this wire: an unknown key is rejected."""

    model_config = ConfigDict(extra="forbid")


_CAMEL_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

MediaProcessingStatus = Literal["pending", "extracting", "ready_for_reading", "failed", "suspended"]
MediaSourceAttemptStatus = Literal["accepted", "queued", "running", "succeeded", "failed"]
MediaReadState = Literal["unread", "in_progress", "finished"]
MediaIntelligenceStatus = Literal[
    "building", "ready", "stale", "failed", "suspended", "not_available"
]


class MediaIntelligenceOut(_Strict):
    """The Media Abstract: a current-only, read-only intelligence projection."""

    media_id: UUID
    status: MediaIntelligenceStatus
    content_fingerprint: str
    summary_md: str | None = None
    model_name: str | None = None


class CapabilitiesOut(BaseModel):
    can_read: bool
    can_highlight: bool
    can_quote: bool
    can_search: bool
    can_play: bool
    can_download_file: bool
    can_delete: bool = False
    can_retry: bool = False
    can_refresh_source: bool = False
    can_retry_metadata: bool = False
    can_repair_source: bool = False
    can_repair_search: bool = False
    can_edit_authors: bool = False
    can_read_embeds: bool = False


class PlaybackSourceOut(BaseModel):
    kind: Literal["external_audio", "external_video"]
    stream_url: str
    source_url: str
    provider: str | None = None
    provider_video_id: str | None = None
    watch_url: str | None = None
    embed_url: str | None = None


class OfflineDownloadSpecOut(BaseModel):
    kind: Literal["ProgressiveAudio"] = "ProgressiveAudio"
    media_id: UUID
    title: str = Field(min_length=1, max_length=OFFLINE_DOWNLOAD_TITLE_MAX_LENGTH)
    source_url: str = Field(min_length=1, max_length=OFFLINE_DOWNLOAD_SOURCE_URL_MAX_LENGTH)

    model_config = _CAMEL_CONFIG


DocumentEmbedAggregateStatus = Literal[
    "unsupported", "empty", "resolving", "ready", "partial", "failed"
]
DocumentEmbedProvider = Literal[
    "youtube", "x", "substack", "vimeo", "spotify", "generic", "unknown"
]
DocumentEmbedKind = Literal["video", "post", "audio", "link_preview", "unknown"]
DocumentEmbedSourceShape = Literal[
    "iframe", "blockquote", "anchor", "video_tag", "provider_json", "unknown"
]
DocumentEmbedResolutionStatus = Literal["resolving", "resolved", "unsupported", "failed"]


class DocumentEmbedSummaryOut(BaseModel):
    status: DocumentEmbedAggregateStatus
    total_count: int = Field(ge=0)
    resolved_count: int = Field(ge=0)
    unsupported_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)


class DocumentEmbedTextOut(BaseModel):
    kind: Literal["present", "absent"]
    value: str | None = None
    reason: Literal["not_in_source", "redacted", "not_applicable"] | None = None


class DocumentEmbedUrlOut(BaseModel):
    status: Literal["present", "malformed", "absent"]
    value: str | None = None
    error_code: str | None = None
    reason: Literal["not_in_source", "not_applicable"] | None = None


class DocumentEmbedProviderRefOut(BaseModel):
    kind: Literal["present", "absent"]
    value: str | None = None
    reason: Literal["unsupported_provider", "unparseable", "not_applicable"] | None = None


class DocumentEmbedLocatorOut(BaseModel):
    kind: Literal["anchored", "unanchored"]
    fragment_id: UUID | None = None
    canonical_start_offset: int | None = Field(default=None, ge=0)
    canonical_end_offset: int | None = Field(default=None, ge=0)
    document_order_key: str
    placeholder_text: str


class DocumentEmbedTargetOut(BaseModel):
    status: Literal[
        "exact",
        "container",
        "missing",
        "forbidden",
        "unanchorable",
        "stale",
        "unsupported",
        "partial",
    ]
    media_id: UUID | None = None
    resource_ref: str | None = None
    href: str | None = None
    kind: str | None = None
    title: str | None = None
    thumbnail_url: str | None = None
    playback: PlaybackSourceOut | None = None


class DocumentEmbedDisplayActionOut(BaseModel):
    kind: Literal["open_child_media", "open_original", "retry_child", "refresh_parent"]
    label: str
    href: str | None = None
    disabled: bool = False


class DocumentEmbedDisplayOut(BaseModel):
    mode: Literal["resolved", "pending", "unsupported", "failed"]
    label: str
    description: str
    actions: list[DocumentEmbedDisplayActionOut] = Field(default_factory=list)


class DocumentEmbedOut(BaseModel):
    id: UUID
    media_id: UUID
    fragment_id: UUID | None = None
    occurrence_key: str
    ordinal: int
    provider: DocumentEmbedProvider
    kind: DocumentEmbedKind
    source_shape: DocumentEmbedSourceShape
    resolution_status: DocumentEmbedResolutionStatus
    source_url: DocumentEmbedUrlOut
    canonical_url: DocumentEmbedUrlOut
    provider_target_ref: DocumentEmbedProviderRefOut
    title: DocumentEmbedTextOut
    description: DocumentEmbedTextOut
    thumbnail_url: DocumentEmbedUrlOut
    authored_text: DocumentEmbedTextOut
    locator: DocumentEmbedLocatorOut
    target: DocumentEmbedTargetOut
    error_code: DocumentEmbedTextOut
    display: DocumentEmbedDisplayOut


class ListeningStateOut(BaseModel):
    position_ms: int = Field(ge=0)
    duration_ms: int | None = Field(default=None, ge=0)
    is_completed: bool = False


class PodcastEpisodeChapterOut(BaseModel):
    chapter_idx: int = Field(ge=0)
    title: str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int | None = Field(default=None, ge=0)
    url: str | None = None
    image_url: str | None = None


class SourceStageProgress(_Strict):
    kind: Literal["Stage"] = "Stage"
    stage: Literal["Validate", "Extract", "Finalize"]
    run_count: int = Field(ge=0)
    updated_at: datetime


class SourceCountedProgress(_Strict):
    kind: Literal["Counted"] = "Counted"
    stage: Literal["Extract"] = "Extract"
    completed: int = Field(ge=0)
    total: int = Field(gt=0)
    unit: Literal["Page", "Chapter"]
    run_count: int = Field(ge=0)
    updated_at: datetime


SourceProgress = Annotated[SourceStageProgress | SourceCountedProgress, Field(discriminator="kind")]


class MediaOut(BaseModel):
    """The media detail wire: snake_case throughout except ``playerDescriptor``.

    ``read_state`` / ``progress_fraction`` / ``progress_resettable`` and
    ``last_engaged_at`` are the viewer's derived consumption facts;
    ``player_descriptor`` is Present only for a podcast episode with playable
    audio. Routes serializing this model must dump ``by_alias=True``.
    """

    id: UUID
    kind: str  # "web_article", "epub", "pdf", "podcast_episode", "video"
    title: str
    canonical_source_url: str | None
    processing_status: MediaProcessingStatus
    source_progress: Presence[SourceProgress]
    transcript_state: str | None = None
    transcript_coverage: str | None = None
    transcript_origin: Presence[Literal["Publisher", "Imported", "Generated"]]
    retrieval_status: str | None = None
    retrieval_status_reason: str | None = None
    failure_stage: str | None = None
    last_error_code: str | None = None
    playback_source: PlaybackSourceOut | None = None
    listening_state: ListeningStateOut | None = None
    episode_state: Literal["unplayed", "in_progress", "played"] | None = None
    chapters: list[PodcastEpisodeChapterOut] = []
    capabilities: CapabilitiesOut
    document_embed_summary: DocumentEmbedSummaryOut | None = None
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    author_mode: Literal["automatic", "manual"] = "automatic"
    original_published_date: Presence[PublicationDate]
    edition_published_date: Presence[PublicationDate]
    publisher: str | None = None
    language: str | None = None
    description: str | None = None
    description_html: str | None = None
    description_text: str | None = None
    metadata_enriched_at: datetime | None = None
    read_state: MediaReadState | None = None
    progress_fraction: float | None = Field(default=None, ge=0.0, le=1.0)
    progress_resettable: bool
    last_engaged_at: datetime | None = None
    player_descriptor: Presence[PlayerDescriptor] = Field(alias="playerDescriptor")
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class MediaRemovedResult(BaseModel):
    model_config = _CAMEL_CONFIG

    kind: Literal["Removed"] = "Removed"
    removed_from_library_ids: list[UUID]
    remaining_reference_count: int = Field(ge=0)
    library_entries_collection_revision: CollectionRevision


class MediaHiddenResult(BaseModel):
    model_config = _CAMEL_CONFIG

    kind: Literal["Hidden"] = "Hidden"
    removed_from_library_ids: list[UUID]
    remaining_reference_count: int = Field(ge=0)
    library_entries_collection_revision: CollectionRevision


class MediaDeletingResult(BaseModel):
    model_config = _CAMEL_CONFIG

    kind: Literal["Deleting"] = "Deleting"


MediaDeleteResult = Annotated[
    MediaRemovedResult | MediaHiddenResult | MediaDeletingResult, Field(discriminator="kind")
]


class FragmentOut(BaseModel):
    id: UUID
    media_id: UUID
    idx: int
    html_sanitized: str
    canonical_text: str
    word_count: int
    document_word_start: int
    t_start_ms: int | None = None
    t_end_ms: int | None = None
    speaker_label: str | None = None
    document_embeds: list[DocumentEmbedOut] = Field(default_factory=list)
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


def _canonical_uuid_text(value: str) -> str:
    """Replay keys are text columns, so only the canonical spelling is a key."""
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValueError("client_mutation_id must be canonical lowercase UUID text") from exc
    if str(parsed) != value:
        raise ValueError("client_mutation_id must be canonical lowercase UUID text")
    return value


ClientMutationUuidText = Annotated[str, AfterValidator(_canonical_uuid_text)]


class CreateUploadSessionRequest(_Strict):
    kind: Literal["Pdf", "Epub"]
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)
    library_ids: list[UUID] = Field(default_factory=list)


class RetryUploadSessionRequest(_Strict):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)
    client_mutation_id: ClientMutationUuidText
    expected_generation: int = Field(ge=1)


class ConfirmUploadSessionRequest(_Strict):
    generation: int = Field(ge=1)


class _UploadTransportFailureBase(_Strict):
    generation: int = Field(ge=1)
    duration_ms: int = Field(ge=0)
    request_id: str = Field(min_length=1, max_length=255)


class UploadNetworkFailureRequest(_UploadTransportFailureBase):
    kind: Literal["Network"]


class UploadTimeoutFailureRequest(_UploadTransportFailureBase):
    kind: Literal["Timeout"]


class UploadHttpRejectedFailureRequest(_UploadTransportFailureBase):
    kind: Literal["HttpRejected"]
    status: int = Field(ge=100, le=599)


class UploadAbortedFailureRequest(_UploadTransportFailureBase):
    kind: Literal["Aborted"]


UploadTransportFailureRequest = Annotated[
    UploadNetworkFailureRequest
    | UploadTimeoutFailureRequest
    | UploadHttpRejectedFailureRequest
    | UploadAbortedFailureRequest,
    Field(discriminator="kind"),
]


class UploadRequiredHeaders(BaseModel):
    content_type: str = Field(alias="Content-Type")

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class UploadRequired(_Strict):
    kind: Literal["UploadRequired"] = "UploadRequired"
    session_handle: UploadSessionHandle
    generation: int = Field(ge=1)
    method: Literal["PUT"] = "PUT"
    upload_url: str
    required_headers: UploadRequiredHeaders
    expires_at: datetime
    idempotency_outcome: Literal["Created", "Reused"]


class Published(_Strict):
    kind: Literal["Published"] = "Published"
    session_handle: UploadSessionHandle
    media_id: UUID
    source_attempt_id: UUID
    idempotency_outcome: Literal["Created", "Reused"]


class VerificationFailed(_Strict):
    kind: Literal["VerificationFailed"] = "VerificationFailed"
    code: UploadVerificationFailureCode
    failed_at: datetime


class TransportFailed(_Strict):
    kind: Literal["TransportFailed"] = "TransportFailed"
    reason: UploadTransportFailure
    failed_at: datetime


class CapabilityExpired(_Strict):
    kind: Literal["CapabilityExpired"] = "CapabilityExpired"
    expired_at: datetime


UploadSessionFailure = Annotated[
    VerificationFailed | TransportFailed | CapabilityExpired, Field(discriminator="kind")
]


class UploadSessionCapabilities(_Strict):
    can_retry_upload: bool
    can_remove: bool


class NeedsAttention(_Strict):
    kind: Literal["NeedsAttention"] = "NeedsAttention"
    session_handle: UploadSessionHandle
    failure: UploadSessionFailure
    capabilities: UploadSessionCapabilities


UploadSessionResponse = Annotated[
    UploadRequired | Published | NeedsAttention, Field(discriminator="kind")
]


class RetrySourceRequest(_Strict):
    from_stage: Literal["source"]
    client_mutation_id: ClientMutationUuidText
    expected_attempt_id: UUID


class RetryMetadataRequest(_Strict):
    """Re-enrich metadata; no idempotency ledger."""

    from_stage: Literal["metadata"]


RetryRequest = Annotated[
    RetrySourceRequest | RetryMetadataRequest, Field(discriminator="from_stage")
]


class SourceRepairRequest(_Strict):
    """Requeue the exact dead job of one nonterminal source attempt."""

    kind: Literal["Source"]
    client_mutation_id: ClientMutationUuidText
    expected_attempt_id: UUID
    expected_job_id: UUID


class SearchRepairRequest(_Strict):
    """Requeue the exact dead reindex job of one content-index revision."""

    kind: Literal["Search"]
    client_mutation_id: ClientMutationUuidText
    expected_revision: int = Field(ge=0)
    expected_job_id: UUID


MediaRepairRequest = Annotated[
    SourceRepairRequest | SearchRepairRequest, Field(discriminator="kind")
]


class SourceRetryAdmission(_Strict):
    kind: Literal["SourceRetry"] = "SourceRetry"
    media_id: UUID
    source_attempt_id: UUID
    job_id: UUID


class SourceRepairAdmission(_Strict):
    kind: Literal["SourceRepair"] = "SourceRepair"
    media_id: UUID
    source_attempt_id: UUID
    job_id: UUID


class SearchRepairAdmission(_Strict):
    kind: Literal["SearchRepair"] = "SearchRepair"
    media_id: UUID
    revision: int = Field(ge=0)
    job_id: UUID


TranscriptRequestReason = Literal[
    "episode_open", "search", "highlight", "quote", "background_warming", "operator_requeue"
]


class TranscriptRequestRequest(_Strict):
    reason: TranscriptRequestReason = "episode_open"
    dry_run: bool = False


class TranscriptRequestResponse(BaseModel):
    media_id: str
    processing_status: MediaProcessingStatus
    transcript_state: str
    transcript_coverage: str
    request_reason: TranscriptRequestReason
    required_minutes: int
    remaining_minutes: int | None = None
    fits_budget: bool
    request_enqueued: bool


class FromUrlRequest(BaseModel):
    url: str = Field(
        min_length=1,
        description="The URL to ingest. Must be an absolute http/https URL, including PDF, EPUB, article, or video URLs.",
    )
    library_ids: list[UUID] = Field(default_factory=list)


class FromUrlResponse(BaseModel):
    media_id: UUID
    source_attempt_id: UUID
    source_type: str
    source_attempt_status: MediaSourceAttemptStatus
    idempotency_outcome: Literal["created", "reused", "retrying", "refreshed"]
    processing_status: MediaProcessingStatus
    ingest_enqueued: bool


class MediaLibrariesRequest(BaseModel):
    library_ids: list[UUID] = Field(default_factory=list)


class MediaEvidenceTextQuoteOut(_Strict):
    exact: str
    prefix: str
    suffix: str


class MediaEvidenceWebHighlightOut(_Strict):
    kind: Literal["web_text"]
    evidence_span_id: UUID
    fragment_id: UUID
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    text_quote: MediaEvidenceTextQuoteOut


class MediaEvidenceEpubHighlightOut(_Strict):
    kind: Literal["epub_text"]
    evidence_span_id: UUID
    fragment_id: UUID
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    text_quote: MediaEvidenceTextQuoteOut


class MediaEvidencePdfQuadOut(_Strict):
    x1: FiniteFloat
    y1: FiniteFloat
    x2: FiniteFloat
    y2: FiniteFloat
    x3: FiniteFloat
    y3: FiniteFloat
    x4: FiniteFloat
    y4: FiniteFloat


class MediaEvidencePdfGeometryOut(_Strict):
    coordinate_space: Literal["pdf_points"]
    page_width: FiniteFloat = Field(gt=0)
    page_height: FiniteFloat = Field(gt=0)
    page_rotation_degrees: int = Field(ge=0)
    page_box: str | None = None
    projection: str | None = None
    quads: list[MediaEvidencePdfQuadOut]


class MediaEvidencePdfHighlightOut(_Strict):
    kind: Literal["pdf_text"]
    evidence_span_id: UUID
    page_number: int = Field(ge=1)
    page_label: str | None = None
    text_quote: MediaEvidenceTextQuoteOut
    geometry: MediaEvidencePdfGeometryOut | None = None


class MediaEvidenceTranscriptHighlightOut(_Strict):
    kind: Literal["transcript_time_text"]
    evidence_span_id: UUID
    t_start_ms: int | None = Field(default=None, ge=0)
    t_end_ms: int | None = Field(default=None, ge=0)
    text_quote: MediaEvidenceTextQuoteOut


MediaEvidenceHighlightOut = Annotated[
    MediaEvidenceWebHighlightOut
    | MediaEvidenceEpubHighlightOut
    | MediaEvidencePdfHighlightOut
    | MediaEvidenceTranscriptHighlightOut,
    Field(discriminator="kind"),
]


class MediaEvidenceResolverOut(_Strict):
    kind: Literal["web", "epub", "pdf", "transcript"]
    params: dict[str, str]
    status: Literal["resolved", "unresolved", "no_geometry"]
    highlight: MediaEvidenceHighlightOut | None


class MediaEvidenceOut(_Strict):
    evidence_span_id: UUID
    media_id: UUID
    span_text: str
    resolver: MediaEvidenceResolverOut


class MediaEvidenceResponse(_Strict):
    data: MediaEvidenceOut


class ReaderNavigationFragmentOut(_Strict):
    """One unique canonical text unit in document order."""

    fragment_id: UUID
    fragment_idx: int = Field(ge=0, strict=True)
    char_count: int = Field(ge=0, strict=True)


class NavigationTextPointOut(_Strict):
    """An exact canonical codepoint boundary within one source fragment."""

    fragment_id: UUID
    offset: int = Field(ge=0, strict=True)


class NavigationTextRangeOut(_Strict):
    """A semantic extent, potentially spanning several canonical fragments."""

    start: NavigationTextPointOut
    end: NavigationTextPointOut


class ReaderNavigationSectionOut(_Strict):
    section_id: str
    label: str
    parent_section_id: Presence[str]
    target: NavigationTextPointOut
    anchor_id: Presence[str]
    extent: Presence[NavigationTextRangeOut]
    source: Literal["Publisher", "Heading", "Both", "InferredNumberedEntry"]


class ReaderNavigationTocNodeOut(_Strict):
    """A TOC node extended with its canonical section target linkage."""

    id: str
    label: str
    section_id: Presence[str]
    children: list["ReaderNavigationTocNodeOut"]


class ReaderNavigationLocationOut(_Strict):
    """A non-TOC reader navigation target."""

    id: str
    label: str
    target: Presence[NavigationTextPointOut]


class MediaNavigationOut(_Strict):
    media_id: UUID
    kind: Literal["epub", "web_article"]
    generation: int = Field(ge=1, strict=True)
    fragments: list[ReaderNavigationFragmentOut]
    sections: list[ReaderNavigationSectionOut]
    toc_nodes: list[ReaderNavigationTocNodeOut]
    landmarks: list[ReaderNavigationLocationOut]
    page_list: list[ReaderNavigationLocationOut]


class EpubFragmentOut(_Strict):
    """One EPUB render unit, independent of the publication's outline."""

    fragment_id: UUID
    fragment_idx: int = Field(ge=0, strict=True)
    href_path: str = Field(min_length=1)
    generation: int = Field(ge=1, strict=True)
    html_sanitized: str
    canonical_text: str
    char_count: int = Field(ge=0, strict=True)
    word_count: int = Field(ge=0, strict=True)
    document_word_start: int = Field(ge=0, strict=True)
    created_at: datetime
