"""Media and Fragment Pydantic schemas.

Contains response models for media and fragments endpoints.
All schemas must match s0_spec.md exactly.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class PlaybackSourceOut(BaseModel):
    """Typed playback source contract for externally hosted media."""

    kind: Literal["external_audio", "external_video"]
    stream_url: str
    source_url: str
    provider: str | None = None
    provider_video_id: str | None = None
    watch_url: str | None = None
    embed_url: str | None = None


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


class MediaAuthorOut(BaseModel):
    """Response schema for a media author."""

    id: UUID
    name: str
    role: str | None = None

    model_config = ConfigDict(from_attributes=True)


class MediaOut(BaseModel):
    """Response schema for media."""

    id: UUID
    kind: str  # "web_article", "epub", "pdf", "podcast_episode", "video"
    title: str
    canonical_source_url: str | None
    processing_status: str  # "pending", "extracting", "ready_for_reading", etc.
    transcript_state: str | None = None
    transcript_coverage: str | None = None
    failure_stage: str | None = None
    last_error_code: str | None = None
    playback_source: PlaybackSourceOut | None = None
    listening_state: ListeningStateOut | None = None
    subscription_default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)
    episode_state: Literal["unplayed", "in_progress", "played"] | None = None
    chapters: list[PodcastEpisodeChapterOut] = []
    capabilities: CapabilitiesOut
    authors: list[MediaAuthorOut] = []
    published_date: str | None = None
    publisher: str | None = None
    language: str | None = None
    description: str | None = None
    description_html: str | None = None
    description_text: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


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


class UploadInitResponse(BaseModel):
    """Response schema for POST /media/upload/init."""

    media_id: str
    storage_path: str
    token: str
    expires_at: str


class IngestResponse(BaseModel):
    """Response schema for POST /media/{id}/ingest.

    Extended in S5 PR-03 with processing_status and ingest_enqueued.
    Defaults preserve backward compatibility: clients reading only
    media_id and duplicate remain valid.
    """

    media_id: str
    duplicate: bool
    processing_status: str = "pending"
    ingest_enqueued: bool = False


class RetryResponse(BaseModel):
    """Response schema for POST /media/{id}/retry."""

    media_id: str
    processing_status: str
    retry_enqueued: bool


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


class TranscriptRequestBatchRequest(BaseModel):
    """Request schema for POST /media/transcript/request/batch."""

    media_ids: list[UUID] = Field(min_length=1, max_length=20)
    reason: TranscriptRequestReason = "episode_open"

    model_config = ConfigDict(extra="forbid")


class ListeningStateUpsertRequest(BaseModel):
    """Body for PUT /media/{id}/listening-state."""

    position_ms: int | None = Field(default=None, ge=0)
    duration_ms: int | None = Field(default=None, ge=0)
    playback_speed: float | None = Field(default=None, gt=0)
    is_completed: bool | None = None

    @model_validator(mode="after")
    def validate_has_mutation_field(self) -> "ListeningStateUpsertRequest":
        if (
            self.position_ms is None
            and self.duration_ms is None
            and self.playback_speed is None
            and self.is_completed is None
        ):
            raise ValueError(
                "At least one of position_ms, duration_ms, playback_speed, or is_completed is required"
            )
        return self

    model_config = ConfigDict(extra="forbid")


class ListeningStateBatchUpsertRequest(BaseModel):
    """Body for POST /media/listening-state/batch."""

    media_ids: list[UUID] = Field(min_length=1, max_length=1000)
    is_completed: bool

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
    processing_status: str
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


class FileDownloadResponse(BaseModel):
    """Response schema for GET /media/{id}/file."""

    url: str
    expires_at: str


# =============================================================================
# URL-Based Ingestion Schemas (S2)
# =============================================================================


class FromUrlRequest(BaseModel):
    """Request schema for POST /media/from_url.

    Creates media from URL with service-layer classification:
    - supported YouTube variants -> canonical `video` identity (create-or-reuse)
    - PDF/EPUB URLs -> file-backed `pdf`/`epub` media
    - other URLs -> provisional `web_article`
    URL validation (length, scheme, host, etc.) happens in the service layer.
    """

    url: str = Field(
        min_length=1,
        description="The URL to ingest. Must be an absolute http/https URL, including PDF, EPUB, article, or video URLs.",
    )


class FromUrlResponse(BaseModel):
    """Response schema for POST /media/from_url.

    `idempotency_outcome` is the source-of-truth contract for create-vs-reuse.
    """

    media_id: UUID
    idempotency_outcome: Literal["created", "reused"]
    processing_status: str
    ingest_enqueued: bool


# =============================================================================
# S5 PR-04: EPUB Chapter + TOC Read API Schemas
# =============================================================================


class EpubChapterSummaryOut(BaseModel):
    """Metadata-only chapter summary for chapter manifest."""

    idx: int
    fragment_id: UUID
    title: str
    char_count: int
    word_count: int
    has_toc_entry: bool
    primary_toc_node_id: str | None


class EpubChapterOut(BaseModel):
    """Full chapter payload with content and navigation pointers."""

    idx: int
    fragment_id: UUID
    title: str
    html_sanitized: str
    canonical_text: str
    char_count: int
    word_count: int
    has_toc_entry: bool
    primary_toc_node_id: str | None
    prev_idx: int | None
    next_idx: int | None
    created_at: datetime


class EpubTocNodeOut(BaseModel):
    """Single TOC node with recursive children."""

    node_id: str
    parent_node_id: str | None
    label: str
    href: str | None
    fragment_idx: int | None
    depth: int
    order_key: str
    children: list["EpubTocNodeOut"]


class EpubChapterPageInfoOut(BaseModel):
    """Pagination envelope for chapter manifest."""

    next_cursor: int | None
    has_more: bool


class EpubChapterListOut(BaseModel):
    """Paginated chapter manifest response."""

    data: list[EpubChapterSummaryOut]
    page: EpubChapterPageInfoOut


class EpubTocOut(BaseModel):
    """TOC tree response."""

    nodes: list[EpubTocNodeOut]


class EpubNavigationSectionOut(BaseModel):
    """Canonical EPUB navigation section target."""

    section_id: str
    label: str
    fragment_idx: int
    anchor_id: str | None
    source_node_id: str | None
    source: Literal["toc", "fragment_fallback"]
    ordinal: int


class EpubNavigationTocNodeOut(BaseModel):
    """TOC node extended with canonical section target linkage."""

    node_id: str
    parent_node_id: str | None
    label: str
    href: str | None
    fragment_idx: int | None
    depth: int
    order_key: str
    section_id: str | None
    children: list["EpubNavigationTocNodeOut"]


class EpubNavigationOut(BaseModel):
    """Unified EPUB navigation payload for reader UI."""

    sections: list[EpubNavigationSectionOut]
    toc_nodes: list[EpubNavigationTocNodeOut]
