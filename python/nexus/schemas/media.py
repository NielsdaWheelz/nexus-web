"""Media and Fragment Pydantic schemas.

Contains response models for media and fragments endpoints.
Schemas are the FastAPI response contracts for current media routes.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, FiniteFloat, JsonValue
from pydantic.alias_generators import to_camel

from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import Presence
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.upload_failures import (
    UploadTransportFailure,
    UploadVerificationFailureCode,
)
from nexus.services.offline_download_source import (
    OFFLINE_DOWNLOAD_SOURCE_URL_MAX_LENGTH,
    OFFLINE_DOWNLOAD_TITLE_MAX_LENGTH,
)
from nexus.services.sealed_handles import UploadSessionHandle

MediaProcessingStatus = Literal[
    "pending",
    "extracting",
    "ready_for_reading",
    "failed",
    "suspended",
]

MediaSourceAttemptStatus = Literal[
    "accepted",
    "queued",
    "running",
    "succeeded",
    "failed",
    "superseded",
]

MediaUnitStatus = Literal["building", "ready", "failed"]

MediaReadState = Literal["unread", "in_progress", "finished"]


MediaIntelligenceStatus = Literal[
    "building",
    "ready",
    "stale",
    "failed",
    "suspended",
    "not_available",
]


class MediaIntelligenceOut(BaseModel):
    """Response for GET /media/{media_handle}/intelligence: the Media Abstract.

    The authorized, compact, current-only per-media intelligence projection
    (spec §252/§826): a read-only view with no Generate control and no history.
    ``summary_md`` / ``model_name`` are populated for current and stale summaries.
    """

    media_id: UUID
    status: MediaIntelligenceStatus
    content_fingerprint: str
    summary_md: str | None = None
    model_name: str | None = None

    model_config = ConfigDict(extra="forbid")


class CapabilitiesOut(BaseModel):
    """Derived capabilities for a media item.

    Determines what actions a viewer can perform on a media item.
    Derived from media.kind, processing_status, last_error_code, and related data.
    """

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
    """Typed playback source contract for externally hosted media."""

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
    source_url: str = Field(
        min_length=1,
        max_length=OFFLINE_DOWNLOAD_SOURCE_URL_MAX_LENGTH,
    )

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


DocumentEmbedAggregateStatus = Literal[
    "unsupported",
    "empty",
    "resolving",
    "ready",
    "partial",
    "failed",
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
    """Per-media listening state for the authenticated viewer."""

    position_ms: int = Field(ge=0)
    duration_ms: int | None = Field(default=None, ge=0)
    is_completed: bool = False


class PodcastEpisodeChapterOut(BaseModel):
    """Podcast episode chapter marker payload."""

    chapter_idx: int = Field(ge=0)
    title: str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int | None = Field(default=None, ge=0)
    url: str | None = None
    image_url: str | None = None


class SourceStageProgress(BaseModel):
    kind: Literal["Stage"] = "Stage"
    stage: Literal["Validate", "Extract", "Finalize"]
    run_count: int = Field(ge=0)
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")


class SourceCountedProgress(BaseModel):
    kind: Literal["Counted"] = "Counted"
    stage: Literal["Extract"] = "Extract"
    completed: int = Field(ge=0)
    total: int = Field(gt=0)
    unit: Literal["Page", "Chapter"]
    run_count: int = Field(ge=0)
    updated_at: datetime

    model_config = ConfigDict(extra="forbid")


SourceProgress = Annotated[
    SourceStageProgress | SourceCountedProgress,
    Field(discriminator="kind"),
]


class MediaOut(BaseModel):
    """Response schema for media."""

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
    # Snake wire (D-1): embedded media DTOs stay snake_case. "manual" mirrors
    # media.authors_manually_managed; the five camel author endpoints expose the
    # camel `authorMode` separately.
    author_mode: Literal["automatic", "manual"] = "automatic"
    original_published_date: Presence[PublicationDate]
    edition_published_date: Presence[PublicationDate]
    publisher: str | None = None
    language: str | None = None
    description: str | None = None
    description_html: str | None = None
    description_text: str | None = None
    metadata_enriched_at: datetime | None = None
    # Derived per-viewer read-state. The explicit consumption override wins;
    # otherwise documents derive from retained reader engagement and podcast
    # episodes from listening state. Populated post-hoc by the consumption
    # projection (`services.consumption._projection.media_read_states`, applied in
    # `services.media`) for viewer-scoped listings; absent (None) only on contexts
    # that never derive it (e.g. SSE snapshots).
    read_state: MediaReadState | None = None
    progress_fraction: float | None = Field(default=None, ge=0.0, le=1.0)
    progress_resettable: bool
    last_engaged_at: datetime | None = None
    # New field (spec `lectern-player-lifecycle-hard-cutover.md` §6: "Lectern,
    # podcast, and media DTOs reuse the same server-derived title/subtitle +
    # FooterAudio descriptor"). Populated by `services.media._apply_consumption_state`
    # via the one projection owner, `services.consumption._projection.player_descriptors`, which
    # derives it exactly like a Lectern item. Present only when this media is a
    # podcast episode whose derived activation is FooterAudio; Absent otherwise
    # (including podcast episodes without playable audio, and every other kind).
    # Unlike its snake-wire siblings (D-1 legacy), this field is new-cutover
    # camelCase on the wire (`playerDescriptor`): routes serializing it must dump
    # `by_alias=True`.
    player_descriptor: Presence[PlayerDescriptor] = Field(alias="playerDescriptor")
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


# DELETE /media/{id} response: the tagged wire union (spec §3.1). Strict
# camelCase, ``extra="forbid"``, PascalCase discriminator. ``populate_by_name``
# lets the service construct with snake field names; routes serialize
# ``by_alias=True``.
_MEDIA_DELETE_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class MediaRemovedResult(BaseModel):
    """A scoped/whole-workspace removal that left at least one lifetime reference."""

    model_config = _MEDIA_DELETE_CONFIG

    kind: Literal["Removed"] = "Removed"
    removed_from_library_ids: list[UUID]
    remaining_reference_count: int = Field(ge=0)
    library_entries_collection_revision: CollectionRevision


class MediaHiddenResult(BaseModel):
    """A whole-workspace removal that recorded the viewer's hide marker."""

    model_config = _MEDIA_DELETE_CONFIG

    kind: Literal["Hidden"] = "Hidden"
    removed_from_library_ids: list[UUID]
    remaining_reference_count: int = Field(ge=0)
    library_entries_collection_revision: CollectionRevision


class MediaDeletingResult(BaseModel):
    """The last lifetime reference was removed; teardown intent + job installed."""

    model_config = _MEDIA_DELETE_CONFIG

    kind: Literal["Deleting"] = "Deleting"


MediaDeleteResult = Annotated[
    MediaRemovedResult | MediaHiddenResult | MediaDeletingResult,
    Field(discriminator="kind"),
]


class FragmentOut(BaseModel):
    """Response schema for fragment.

    Contains the sanitized HTML and canonical text for a media fragment.
    """

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


# =============================================================================
# Upload / Ingest Schemas
# =============================================================================


class CreateUploadSessionRequest(BaseModel):
    kind: Literal["Pdf", "Epub"]
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)
    library_ids: list[UUID] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


def _canonical_uuid_text(value: str) -> str:
    """Replay keys are text columns, so two spellings of one UUID would be two
    different memo rows for one intent. Only the canonical spelling is a key."""
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValueError("client_mutation_id must be canonical lowercase UUID text") from exc
    if str(parsed) != value:
        raise ValueError("client_mutation_id must be canonical lowercase UUID text")
    return value


ClientMutationUuidText = Annotated[str, AfterValidator(_canonical_uuid_text)]


class RetryUploadSessionRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)
    client_mutation_id: ClientMutationUuidText
    expected_generation: int = Field(ge=1)

    model_config = ConfigDict(extra="forbid")


class ConfirmUploadSessionRequest(BaseModel):
    generation: int = Field(ge=1)

    model_config = ConfigDict(extra="forbid")


class _UploadTransportFailureBase(BaseModel):
    generation: int = Field(ge=1)
    duration_ms: int = Field(ge=0)
    request_id: str = Field(min_length=1, max_length=255)

    model_config = ConfigDict(extra="forbid")


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


class UploadRequired(BaseModel):
    kind: Literal["UploadRequired"] = "UploadRequired"
    session_handle: UploadSessionHandle
    generation: int = Field(ge=1)
    method: Literal["PUT"] = "PUT"
    upload_url: str
    required_headers: UploadRequiredHeaders
    expires_at: datetime
    idempotency_outcome: Literal["Created", "Reused"]

    model_config = ConfigDict(extra="forbid")


class Published(BaseModel):
    kind: Literal["Published"] = "Published"
    session_handle: UploadSessionHandle
    media_id: UUID
    source_attempt_id: UUID
    idempotency_outcome: Literal["Created", "Reused"]

    model_config = ConfigDict(extra="forbid")


class VerificationFailed(BaseModel):
    kind: Literal["VerificationFailed"] = "VerificationFailed"
    code: UploadVerificationFailureCode
    failed_at: datetime

    model_config = ConfigDict(extra="forbid")


class TransportFailed(BaseModel):
    kind: Literal["TransportFailed"] = "TransportFailed"
    reason: UploadTransportFailure
    failed_at: datetime

    model_config = ConfigDict(extra="forbid")


class CapabilityExpired(BaseModel):
    kind: Literal["CapabilityExpired"] = "CapabilityExpired"
    expired_at: datetime

    model_config = ConfigDict(extra="forbid")


UploadSessionFailure = Annotated[
    VerificationFailed | TransportFailed | CapabilityExpired,
    Field(discriminator="kind"),
]


class UploadSessionCapabilities(BaseModel):
    can_retry_upload: bool
    can_remove: bool

    model_config = ConfigDict(extra="forbid")


class NeedsAttention(BaseModel):
    kind: Literal["NeedsAttention"] = "NeedsAttention"
    session_handle: UploadSessionHandle
    failure: UploadSessionFailure
    capabilities: UploadSessionCapabilities

    model_config = ConfigDict(extra="forbid")


UploadSessionResponse = Annotated[
    UploadRequired | Published | NeedsAttention,
    Field(discriminator="kind"),
]


class ArticleCaptureRequest(BaseModel):
    """Request schema for browser-captured web articles."""

    url: str = Field(min_length=1, max_length=2048)
    content_html: str = Field(min_length=1)
    source_html: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=1024)
    byline: str | None = Field(default=None, max_length=1024)
    excerpt: str | None = Field(default=None, max_length=4000)
    site_name: str | None = Field(default=None, max_length=1024)
    published_time: str | None = Field(default=None, max_length=128)
    library_ids: list[UUID] = Field(default_factory=list)


class RetrySourceRequest(BaseModel):
    """Body for POST /media/{id}/retry that admits a new source attempt."""

    from_stage: Literal["source"]
    client_mutation_id: ClientMutationUuidText
    expected_attempt_id: UUID

    model_config = ConfigDict(extra="forbid")


class RetryMetadataRequest(BaseModel):
    """Body for POST /media/{id}/retry that re-enriches metadata; its owner and
    its (absent) idempotency contract are unchanged by the imports cutover."""

    from_stage: Literal["metadata"]

    model_config = ConfigDict(extra="forbid")


RetryRequest = Annotated[
    RetrySourceRequest | RetryMetadataRequest,
    Field(discriminator="from_stage"),
]


class SourceRepairRequest(BaseModel):
    """Requeue the exact dead job of one nonterminal source attempt."""

    kind: Literal["Source"]
    client_mutation_id: ClientMutationUuidText
    expected_attempt_id: UUID
    expected_job_id: UUID

    model_config = ConfigDict(extra="forbid")


class SearchRepairRequest(BaseModel):
    """Requeue the exact dead reindex job of one content-index revision."""

    kind: Literal["Search"]
    client_mutation_id: ClientMutationUuidText
    expected_revision: int = Field(ge=0)
    expected_job_id: UUID

    model_config = ConfigDict(extra="forbid")


MediaRepairRequest = Annotated[
    SourceRepairRequest | SearchRepairRequest,
    Field(discriminator="kind"),
]


class SourceRetryAdmission(BaseModel):
    """The immutable receipt of an admitted source retry: the new attempt and
    the one job that will run it."""

    kind: Literal["SourceRetry"] = "SourceRetry"
    media_id: UUID
    source_attempt_id: UUID
    job_id: UUID

    model_config = ConfigDict(extra="forbid")


class SourceRepairAdmission(BaseModel):
    kind: Literal["SourceRepair"] = "SourceRepair"
    media_id: UUID
    source_attempt_id: UUID
    job_id: UUID

    model_config = ConfigDict(extra="forbid")


class SearchRepairAdmission(BaseModel):
    kind: Literal["SearchRepair"] = "SearchRepair"
    media_id: UUID
    revision: int = Field(ge=0)
    job_id: UUID

    model_config = ConfigDict(extra="forbid")


TranscriptRequestReason = Literal[
    "episode_open",
    "search",
    "highlight",
    "quote",
    "background_warming",
    "operator_requeue",
]


class TranscriptRequestRequest(BaseModel):
    """Request schema for POST /media/{id}/transcript/request."""

    reason: TranscriptRequestReason = "episode_open"
    dry_run: bool = False

    model_config = ConfigDict(extra="forbid")


class TranscriptRequestResponse(BaseModel):
    """Response schema for transcript admission endpoint."""

    media_id: str
    processing_status: MediaProcessingStatus
    transcript_state: str
    transcript_coverage: str
    request_reason: TranscriptRequestReason
    required_minutes: int
    remaining_minutes: int | None = None
    fits_budget: bool
    request_enqueued: bool


# =============================================================================
# URL-Based Ingestion Schemas
# =============================================================================


class FromUrlRequest(BaseModel):
    """Request schema for POST /media/from_url.

    Creates media from URL with service-layer classification:
    - supported YouTube variants -> canonical `video` identity (create-or-reuse)
    - supported X/Twitter post URLs -> canonical same-author thread `web_article`
    - PDF/EPUB URLs -> file-backed `pdf`/`epub` media
    - other URLs -> provisional `web_article`
    URL validation (length, scheme, host, etc.) happens in the service layer.
    """

    url: str = Field(
        min_length=1,
        description="The URL to ingest. Must be an absolute http/https URL, including PDF, EPUB, article, or video URLs.",
    )
    library_ids: list[UUID] = Field(default_factory=list)


class FromUrlResponse(BaseModel):
    """Response schema for accepted source-ingest commands.

    `idempotency_outcome` is the source-of-truth contract for create-vs-reuse.
    """

    media_id: UUID
    source_attempt_id: UUID
    source_type: str
    source_attempt_status: MediaSourceAttemptStatus
    idempotency_outcome: Literal["created", "reused", "retrying", "refreshed"]
    processing_status: MediaProcessingStatus
    ingest_enqueued: bool


class MediaLibrariesRequest(BaseModel):
    """Request schema for POST /media/{id}/libraries."""

    library_ids: list[UUID] = Field(default_factory=list)


class MediaEvidenceTextQuoteOut(BaseModel):
    """Text quote payload used by resolved evidence highlights."""

    exact: str
    prefix: str
    suffix: str

    model_config = ConfigDict(extra="forbid")


class MediaEvidenceWebHighlightOut(BaseModel):
    """Resolved web article text highlight."""

    kind: Literal["web_text"]
    evidence_span_id: UUID
    fragment_id: UUID
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    text_quote: MediaEvidenceTextQuoteOut

    model_config = ConfigDict(extra="forbid")


class MediaEvidenceEpubHighlightOut(BaseModel):
    """Resolved EPUB text highlight."""

    kind: Literal["epub_text"]
    evidence_span_id: UUID
    fragment_id: UUID
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    text_quote: MediaEvidenceTextQuoteOut

    model_config = ConfigDict(extra="forbid")


class MediaEvidencePdfQuadOut(BaseModel):
    """PDF highlight quad in page coordinate space."""

    x1: FiniteFloat
    y1: FiniteFloat
    x2: FiniteFloat
    y2: FiniteFloat
    x3: FiniteFloat
    y3: FiniteFloat
    x4: FiniteFloat
    y4: FiniteFloat

    model_config = ConfigDict(extra="forbid")


class MediaEvidencePdfGeometryOut(BaseModel):
    """PDF geometry payload produced from stored evidence selector geometry."""

    coordinate_space: Literal["pdf_points"]
    page_width: FiniteFloat = Field(gt=0)
    page_height: FiniteFloat = Field(gt=0)
    page_rotation_degrees: int = Field(ge=0)
    page_box: str | None = None
    projection: str | None = None
    quads: list[MediaEvidencePdfQuadOut]

    model_config = ConfigDict(extra="forbid")


class MediaEvidencePdfHighlightOut(BaseModel):
    """Resolved PDF text highlight."""

    kind: Literal["pdf_text"]
    evidence_span_id: UUID
    page_number: int = Field(ge=1)
    page_label: str | None = None
    text_quote: MediaEvidenceTextQuoteOut
    geometry: MediaEvidencePdfGeometryOut | None = None

    model_config = ConfigDict(extra="forbid")


class MediaEvidenceTranscriptHighlightOut(BaseModel):
    """Resolved transcript text/time highlight."""

    kind: Literal["transcript_time_text"]
    evidence_span_id: UUID
    t_start_ms: int | None = Field(default=None, ge=0)
    t_end_ms: int | None = Field(default=None, ge=0)
    text_quote: MediaEvidenceTextQuoteOut

    model_config = ConfigDict(extra="forbid")


MediaEvidenceHighlightOut = Annotated[
    MediaEvidenceWebHighlightOut
    | MediaEvidenceEpubHighlightOut
    | MediaEvidencePdfHighlightOut
    | MediaEvidenceTranscriptHighlightOut,
    Field(discriminator="kind"),
]


class MediaEvidenceResolverOut(BaseModel):
    """Backend-owned evidence resolver payload."""

    kind: Literal["web", "epub", "pdf", "transcript"]
    route: str
    params: dict[str, str]
    status: Literal["resolved", "unresolved", "no_geometry"]
    selector: dict[str, JsonValue]
    highlight: MediaEvidenceHighlightOut | None

    model_config = ConfigDict(extra="forbid")


class MediaEvidenceOut(BaseModel):
    """Resolved media evidence response payload."""

    evidence_span_id: UUID
    media_id: UUID
    citation_label: str
    span_text: str
    resolver: MediaEvidenceResolverOut

    model_config = ConfigDict(extra="forbid")


class MediaEvidenceResponse(BaseModel):
    """Success envelope for resolved media evidence."""

    data: MediaEvidenceOut

    model_config = ConfigDict(extra="forbid")


class ReaderNavigationFragmentOut(BaseModel):
    """One unique canonical text unit in document order."""

    fragment_id: UUID
    fragment_idx: int = Field(ge=0, strict=True)
    char_count: int = Field(ge=0, strict=True)

    model_config = ConfigDict(extra="forbid")


class NavigationTextPointOut(BaseModel):
    """An exact canonical codepoint boundary within one source fragment."""

    fragment_id: UUID
    offset: int = Field(ge=0, strict=True)

    model_config = ConfigDict(extra="forbid")


class NavigationTextRangeOut(BaseModel):
    """A semantic extent, potentially spanning several canonical fragments."""

    start: NavigationTextPointOut
    end: NavigationTextPointOut

    model_config = ConfigDict(extra="forbid")


class ReaderNavigationSectionOut(BaseModel):
    """Canonical reader navigation section target."""

    section_id: str
    label: str
    parent_section_id: Presence[str]
    target: NavigationTextPointOut
    anchor_id: Presence[str]
    extent: Presence[NavigationTextRangeOut]
    source: Literal["Publisher", "Heading", "Both", "InferredNumberedEntry"]

    model_config = ConfigDict(extra="forbid")


class ReaderNavigationTocNodeOut(BaseModel):
    """TOC node extended with canonical section target linkage."""

    id: str
    label: str
    section_id: Presence[str]
    children: list["ReaderNavigationTocNodeOut"]

    model_config = ConfigDict(extra="forbid")


class ReaderNavigationLocationOut(BaseModel):
    """Non-TOC reader navigation target."""

    id: str
    label: str
    target: Presence[NavigationTextPointOut]

    model_config = ConfigDict(extra="forbid")


class MediaNavigationOut(BaseModel):
    """Unified media navigation payload for reader UI."""

    media_id: UUID
    kind: Literal["epub", "web_article"]
    generation: int = Field(ge=1, strict=True)
    fragments: list[ReaderNavigationFragmentOut]
    sections: list[ReaderNavigationSectionOut]
    toc_nodes: list[ReaderNavigationTocNodeOut]
    landmarks: list[ReaderNavigationLocationOut]
    page_list: list[ReaderNavigationLocationOut]

    model_config = ConfigDict(extra="forbid")


class EpubFragmentOut(BaseModel):
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

    model_config = ConfigDict(extra="forbid")
