"""Media and Fragment Pydantic schemas.

Contains response models for media and fragments endpoints.
Schemas are the FastAPI response contracts for current media routes.
"""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, JsonValue

from nexus.schemas.contributors import ContributorCreditOut

MediaProcessingStatus = Literal["pending", "extracting", "ready_for_reading", "failed"]

MediaUnitStatus = Literal["building", "ready", "failed"]

MediaReadState = Literal["unread", "in_progress", "finished"]


class MediaSummarizeOut(BaseModel):
    """Response contract for POST /media/{id}/summarize (on-demand unit build)."""

    media_id: UUID
    summary_id: UUID
    status: MediaUnitStatus

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


DocumentEmbedAggregateStatus = Literal[
    "unsupported",
    "empty",
    "resolving",
    "ready",
    "partial",
    "failed",
]


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
    provider: Literal["youtube", "x", "substack", "vimeo", "spotify", "generic", "unknown"]
    kind: Literal["video", "post", "audio", "link_preview", "unknown"]
    source_shape: Literal["iframe", "blockquote", "anchor", "video_tag", "provider_json", "unknown"]
    resolution_status: Literal["pending", "resolving", "resolved", "unsupported", "failed"]
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
    playback_speed: float = Field(gt=0)
    is_completed: bool = False


class PodcastEpisodeChapterOut(BaseModel):
    """Podcast episode chapter marker payload."""

    chapter_idx: int = Field(ge=0)
    title: str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int | None = Field(default=None, ge=0)
    url: str | None = None
    image_url: str | None = None


class MediaOut(BaseModel):
    """Response schema for media."""

    id: UUID
    kind: str  # "web_article", "epub", "pdf", "podcast_episode", "video"
    title: str
    canonical_source_url: str | None
    processing_status: MediaProcessingStatus
    transcript_state: str | None = None
    transcript_coverage: str | None = None
    retrieval_status: str | None = None
    retrieval_status_reason: str | None = None
    failure_stage: str | None = None
    last_error_code: str | None = None
    playback_source: PlaybackSourceOut | None = None
    listening_state: ListeningStateOut | None = None
    subscription_default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)
    episode_state: Literal["unplayed", "in_progress", "played"] | None = None
    chapters: list[PodcastEpisodeChapterOut] = []
    capabilities: CapabilitiesOut
    document_embed_summary: DocumentEmbedSummaryOut | None = None
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    # Snake wire (D-1): embedded media DTOs stay snake_case. "manual" mirrors
    # media.authors_manually_managed; the five camel author endpoints expose the
    # camel `authorMode` separately.
    author_mode: Literal["automatic", "manual"] = "automatic"
    published_date: str | None = None
    publisher: str | None = None
    language: str | None = None
    description: str | None = None
    description_html: str | None = None
    description_text: str | None = None
    metadata_enriched_at: datetime | None = None
    # Derived per-viewer read-state. Populated post-hoc by the consumption
    # projection (`services.consumption.media_read_states`, applied in
    # `services.media`) for viewer-scoped listings; absent (None) only on contexts
    # that never derive it (e.g. SSE snapshots). For documents, "unread" means no
    # reading session yet.
    read_state: MediaReadState | None = None
    progress_fraction: float | None = Field(default=None, ge=0.0, le=1.0)
    last_engaged_at: datetime | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


DeleteDocumentStatus = Literal["deleted", "removed", "hidden"]


class DeleteDocumentResponse(BaseModel):
    """Response for document delete and scoped library removal."""

    status: DeleteDocumentStatus
    hard_deleted: bool
    removed_from_library_ids: list[UUID]
    hidden_for_viewer: bool
    remaining_reference_count: int


class FragmentOut(BaseModel):
    """Response schema for fragment.

    Contains the sanitized HTML and canonical text for a media fragment.
    """

    id: UUID
    media_id: UUID
    idx: int
    html_sanitized: str
    canonical_text: str
    t_start_ms: int | None = None
    t_end_ms: int | None = None
    speaker_label: str | None = None
    document_embeds: list[DocumentEmbedOut] = Field(default_factory=list)
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# =============================================================================
# Upload / Ingest Schemas
# =============================================================================


class UploadInitRequest(BaseModel):
    """Request schema for POST /media/upload/init."""

    kind: Literal["pdf", "epub"]
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size_bytes: int = Field(gt=0)
    library_ids: list[UUID] = Field(default_factory=list)


class MediaIngestRequest(BaseModel):
    """Request schema for POST /media/{id}/ingest."""

    library_ids: list[UUID] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid")


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


class ArticleCaptureResponse(BaseModel):
    """Response schema for browser-captured web articles."""

    media_id: UUID
    source_attempt_id: UUID
    source_type: str
    source_attempt_status: str
    idempotency_outcome: Literal["created", "reused", "retrying", "refreshed"]
    processing_status: MediaProcessingStatus
    ingest_enqueued: bool


class RetryRequest(BaseModel):
    """Body for POST /media/{id}/retry."""

    from_stage: Literal["source", "metadata"]

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


class TranscriptRequestBatchRequest(BaseModel):
    """Request schema for POST /media/transcript/request/batch."""

    media_ids: list[UUID] = Field(min_length=1, max_length=20)
    reason: TranscriptRequestReason = "episode_open"

    model_config = ConfigDict(extra="forbid")

    model_config = ConfigDict(extra="forbid")


class TranscriptForecastBatchItemRequest(BaseModel):
    """One media forecast request for POST /media/transcript/forecasts."""

    media_id: UUID
    reason: TranscriptRequestReason = "episode_open"


class TranscriptForecastBatchRequest(BaseModel):
    """Batch forecast request for transcript admission without enqueueing work."""

    requests: list[TranscriptForecastBatchItemRequest] = Field(min_length=1, max_length=100)


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


class TranscriptRequestBatchItemResponse(BaseModel):
    """Per-media result for batch transcript admission."""

    media_id: str
    status: Literal[
        "queued",
        "already_ready",
        "already_queued",
        "rejected_quota",
        "rejected_invalid",
    ]
    required_minutes: int | None = None
    remaining_minutes: int | None = None
    error: str | None = None


class TranscriptRequestBatchResponse(BaseModel):
    """Response payload for POST /media/transcript/request/batch."""

    results: list[TranscriptRequestBatchItemResponse]


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
    source_attempt_status: str
    idempotency_outcome: Literal["created", "reused", "retrying", "refreshed"]
    processing_status: MediaProcessingStatus
    ingest_enqueued: bool


class MediaLibrariesRequest(BaseModel):
    """Request schema for POST /media/{id}/libraries."""

    library_ids: list[UUID] = Field(default_factory=list)


class MediaLibrariesResponse(BaseModel):
    """Response schema for POST /media/{id}/libraries."""

    media_id: UUID
    library_ids_added: list[UUID]


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
    section_id: str | None = None
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


class ReaderNavigationSectionOut(BaseModel):
    """Canonical reader navigation section target."""

    section_id: str
    label: str
    ordinal: int
    fragment_id: UUID | None = None
    fragment_idx: int | None = None
    level: int | None = None
    depth: int | None = None
    start_offset: int | None = None
    end_offset: int | None = None
    href_path: str | None = None
    href_fragment: str | None = None
    anchor_id: str | None = None
    char_count: int | None = None


class ReaderNavigationTocNodeOut(BaseModel):
    """TOC node extended with canonical section target linkage."""

    id: str
    label: str
    ordinal: int
    href: str | None = None
    fragment_idx: int | None = None
    level: int | None = None
    depth: int | None = None
    section_id: str | None = None
    children: list["ReaderNavigationTocNodeOut"]


class ReaderNavigationLocationOut(BaseModel):
    """Non-TOC reader navigation target."""

    id: str
    label: str
    ordinal: int
    href: str | None = None
    fragment_idx: int | None = None
    section_id: str | None = None


class MediaNavigationOut(BaseModel):
    """Unified media navigation payload for reader UI."""

    media_id: UUID
    kind: Literal["epub", "web_article"]
    sections: list[ReaderNavigationSectionOut]
    toc_nodes: list[ReaderNavigationTocNodeOut]
    landmarks: list[ReaderNavigationLocationOut]
    page_list: list[ReaderNavigationLocationOut]


class EpubSectionOut(BaseModel):
    """Canonical EPUB section payload backed by a persisted nav location."""

    section_id: str
    label: str
    fragment_id: UUID
    fragment_idx: int
    href_path: str | None
    anchor_id: str | None
    source_node_id: str | None
    source: Literal["toc", "spine"]
    ordinal: int
    prev_section_id: str | None
    next_section_id: str | None
    html_sanitized: str
    canonical_text: str
    char_count: int
    word_count: int
    created_at: datetime
