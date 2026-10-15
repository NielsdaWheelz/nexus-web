"""Media detail, processing-stream and removal wire models."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.db.models import MediaKind
from nexus.db.models import TranscriptCoverage as MediaTranscriptCoverage
from nexus.db.models import TranscriptState as MediaTranscriptState
from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_sources import SourceProgress
from nexus.schemas.media_summary import MediaDurationOut, MediaProcessingStatus
from nexus.schemas.metadata_enrichment import MetadataEnrichmentView
from nexus.schemas.publication_dates import PublicationDate

_CLOSED = ConfigDict(extra="forbid")

MediaReadState = Literal["unread", "in_progress", "finished"]


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
    provider: str | None
    provider_video_id: str | None
    watch_url: str | None
    embed_url: str | None


DocumentEmbedAggregateStatus = Literal[
    "unsupported", "empty", "resolving", "ready", "partial", "failed"
]


class DocumentEmbedSummaryOut(BaseModel):
    status: DocumentEmbedAggregateStatus
    total_count: int = Field(ge=0)
    resolved_count: int = Field(ge=0)
    unsupported_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)


class ListeningStateOut(BaseModel):
    position_ms: int = Field(ge=0)
    duration_ms: int | None = Field(ge=0)


class PodcastEpisodeChapterOut(BaseModel):
    chapter_idx: int = Field(ge=0)
    title: str
    t_start_ms: int = Field(ge=0)
    t_end_ms: int | None = Field(ge=0)
    url: str | None
    image_url: str | None


class XSourceContext(BaseModel):
    source_attempt_id: UUID
    published_at: datetime
    enumeration: Literal["exhausted", "post_limit"]
    unavailable_context_count: int = Field(ge=0)
    uncaptured_context_count: int = Field(ge=0)

    model_config = _CLOSED


class MediaOut(BaseModel):
    """The media detail wire.

    ``read_state`` / ``progress_fraction`` / ``progress_resettable`` and
    ``last_engaged_at`` are the viewer's derived consumption facts;
    ``player_descriptor`` is set only for a podcast episode with playable
    audio.
    """

    id: UUID
    kind: MediaKind
    title: str
    canonical_source_url: str | None
    provider: str | None
    provider_id: str | None
    requested_url: str | None
    canonical_url: str | None
    processing_status: MediaProcessingStatus
    source_progress: SourceProgress | None
    transcript_state: MediaTranscriptState | None
    transcript_coverage: MediaTranscriptCoverage | None
    transcript_origin: Literal["Publisher", "Imported", "Generated"] | None
    retrieval_status: str | None
    retrieval_status_reason: str | None
    failure_stage: str | None
    last_error_code: str | None
    playback_source: PlaybackSourceOut | None
    listening_state: ListeningStateOut | None
    chapters: list[PodcastEpisodeChapterOut]
    capabilities: CapabilitiesOut
    document_embed_summary: DocumentEmbedSummaryOut | None
    contributors: list[ContributorCreditOut]
    author_mode: Literal["automatic", "manual"] = "automatic"
    original_published_date: PublicationDate | None
    edition_published_date: PublicationDate | None
    edition_isbn: str | None
    duration: MediaDurationOut | None
    publisher: str | None
    language: str | None
    description: str | None
    description_html: str | None
    description_text: str | None
    metadata_enriched_at: datetime | None
    metadata_enrichment: MetadataEnrichmentView
    x_source_context: XSourceContext | None
    read_state: MediaReadState | None
    progress_fraction: float | None = Field(ge=0.0, le=1.0)
    progress_resettable: bool
    last_engaged_at: datetime | None
    player_descriptor: PlayerDescriptor | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class MediaProcessingSnapshotOut(BaseModel):
    """The complete data frame for media processing state and done events."""

    processing_status: MediaProcessingStatus
    source_progress: SourceProgress | None
    last_error_code: str | None
    failure_stage: str | None
    retrieval_status: str | None
    retrieval_status_reason: str | None
    capabilities: CapabilitiesOut
    transcript_state: MediaTranscriptState | None
    transcript_coverage: MediaTranscriptCoverage | None
    updated_at: str


class MediaRemovedResult(BaseModel):
    model_config = _CLOSED

    kind: Literal["Removed"] = "Removed"
    removed_from_library_ids: list[UUID]
    remaining_reference_count: int = Field(ge=0)


class MediaHiddenResult(BaseModel):
    model_config = _CLOSED

    kind: Literal["Hidden"] = "Hidden"
    removed_from_library_ids: list[UUID]
    remaining_reference_count: int = Field(ge=0)


class MediaDeletingResult(BaseModel):
    model_config = _CLOSED

    kind: Literal["Deleting"] = "Deleting"


MediaDeleteResult = Annotated[
    MediaRemovedResult | MediaHiddenResult | MediaDeletingResult, Field(discriminator="kind")
]
