"""The media detail wire and the processing stream's frame."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.db.models import MediaKind
from nexus.db.models import TranscriptCoverage as MediaTranscriptCoverage
from nexus.db.models import TranscriptState as MediaTranscriptState
from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import ConsumptionOut, MediaDurationOut, MediaProcessingStatus
from nexus.schemas.metadata_enrichment import MetadataEnrichmentView
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.x_source import XArticleContent


class CapabilitiesOut(BaseModel):
    """What this viewer can do with the media's text now; ``can_retry``: the source owner
    offers a retry of the same source."""

    can_read: bool
    can_highlight: bool
    can_quote: bool
    can_retry: bool
    can_replace_x_article: bool


class PlaybackSourceOut(BaseModel):
    kind: Literal["external_audio", "external_video"]
    stream_url: str
    source_url: str
    provider: str | None
    provider_video_id: str | None
    watch_url: str | None
    embed_url: str | None


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
    scope: Literal["author_thread", "post"]
    primary_post_count: int = Field(ge=0)
    root_revision_id: str | None
    search_exhausted: bool | None
    limits: list[Literal["post_limit", "operation_limit"]]
    unresolved_parent_count: int = Field(ge=0)
    unchecked_post_count: int = Field(ge=0)
    unavailable_context_count: int = Field(ge=0)
    uncaptured_context_count: int = Field(ge=0)

    model_config = ConfigDict(extra="forbid")


class MediaOut(BaseModel):
    """One media as this viewer sees it: bibliography, processing, readability and the
    viewer's own consumption; ``player_descriptor`` only for a playable episode."""

    id: UUID
    kind: MediaKind
    title: str
    canonical_source_url: str | None
    provider: str | None
    provider_id: str | None
    requested_url: str | None
    canonical_url: str | None
    processing_status: MediaProcessingStatus
    transcript_state: MediaTranscriptState | None
    transcript_coverage: MediaTranscriptCoverage | None
    transcript_origin: Literal["Publisher", "Imported", "Generated"] | None
    retrieval_status: str | None
    retrieval_status_reason: str | None
    last_error_code: str | None
    playback_source: PlaybackSourceOut | None
    listening_state: ListeningStateOut | None
    chapters: list[PodcastEpisodeChapterOut]
    capabilities: CapabilitiesOut
    contributors: list[ContributorCreditOut]
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
    x_article_content: XArticleContent | None
    reader_generation: int | None
    consumption: ConsumptionOut
    last_engaged_at: datetime | None
    player_descriptor: PlayerDescriptor | None
    created_at: datetime
    updated_at: datetime


class MediaProcessingSnapshotOut(BaseModel):
    """One processing stream frame: the facts source work, transcripts and indexing change."""

    processing_status: MediaProcessingStatus
    last_error_code: str | None
    retrieval_status: str | None
    retrieval_status_reason: str | None
    capabilities: CapabilitiesOut
    transcript_state: MediaTranscriptState | None
    transcript_coverage: MediaTranscriptCoverage | None
    reader_generation: int | None
    transcript_reader_key: str | None
    work_in_flight: bool
