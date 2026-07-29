"""Pydantic schemas for podcast discovery, subscription, and plan policy."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.contributors import (
    ContributorCreditIn,
    ContributorCreditOut,
)
from nexus.schemas.media import MediaProcessingStatus
from nexus.schemas.presence import Presence


class PodcastDiscoveryOut(BaseModel):
    podcast_id: UUID | None = None
    provider_podcast_id: str
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    feed_url: str
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None


class _PodcastWritePayload(BaseModel):
    """Podcast write boundary (subscribe/OPML).

    ``contributors`` rides the snake-strict :class:`ContributorCreditIn` v2 (D-4):
    ``{credited_name, role, raw_role}`` only, ``extra="forbid"`` — an unknown
    field (a stale ``source``/``ordinal``/output-shaped key) is a 400. The former
    ``contributor_credit_write_payload`` output-field scrub is gone; clients send
    the typed input shape.
    """

    provider_podcast_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    contributors: list[ContributorCreditIn] = Field(default_factory=list)
    feed_url: str = Field(min_length=1)
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None

    model_config = ConfigDict(extra="forbid")


class PodcastSubscribeRequest(_PodcastWritePayload):
    auto_queue: bool = False
    library_ids: list[UUID] = Field(default_factory=list)


class PodcastOpmlImportRequest(BaseModel):
    opml: str = Field(min_length=1)
    default_library_ids: list[UUID] = Field(default_factory=list)
    per_feed_library_ids: dict[str, list[UUID]] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")


class PodcastSubscribeOut(BaseModel):
    podcast_id: UUID
    subscription_created: bool
    auto_queue: bool
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_enqueued: bool
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    last_synced_at: datetime | None = None
    window_size: int


class PodcastSubscriptionSettingsPatchRequest(BaseModel):
    default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)
    auto_queue: bool | None = None

    @model_validator(mode="after")
    def validate_patch_semantics(self) -> "PodcastSubscriptionSettingsPatchRequest":
        if (
            "default_playback_speed" not in self.model_fields_set
            and "auto_queue" not in self.model_fields_set
        ):
            raise ValueError("At least one settings field is required")
        if "auto_queue" in self.model_fields_set and self.auto_queue is None:
            raise ValueError("auto_queue must be a boolean")
        return self

    model_config = ConfigDict(extra="forbid")


class PodcastOpmlImportErrorOut(BaseModel):
    feed_url: str | None = None
    error: str


class PodcastOpmlImportOut(BaseModel):
    total: int = Field(ge=0)
    imported: int = Field(ge=0)
    skipped_already_subscribed: int = Field(ge=0)
    skipped_invalid: int = Field(ge=0)
    errors: list[PodcastOpmlImportErrorOut] = Field(default_factory=list)


class PodcastSubscriptionStatusOut(BaseModel):
    user_id: UUID
    podcast_id: UUID
    status: Literal["active", "unsubscribed"]
    default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)
    auto_queue: bool = False
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    sync_started_at: datetime | None = None
    sync_completed_at: datetime | None = None
    last_synced_at: datetime | None = None
    updated_at: datetime


class PodcastSubscriptionSettingsOut(PodcastSubscriptionStatusOut):
    collection_revision: CollectionRevision = Field(alias="collectionRevision")
    library_entries_collection_revision: CollectionRevision = Field(
        alias="libraryEntriesCollectionRevision"
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PodcastSubscriptionVisibleLibraryOut(BaseModel):
    id: UUID
    name: str
    color: str | None = None


class PodcastListItemOut(BaseModel):
    id: UUID
    provider: str
    provider_podcast_id: str
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    feed_url: str
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None
    created_at: datetime
    updated_at: datetime


class PodcastSubscriptionListItemOut(BaseModel):
    """Compact row projection for the followed-Podcasts collection."""

    podcast_id: UUID
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    unplayed_count: int = Field(ge=0)
    latest_episode_published_at: Presence[datetime]
    default_playback_speed: Presence[float]
    auto_queue: bool
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]

    model_config = ConfigDict(extra="forbid")


class PodcastEpisodeListCapabilitiesOut(BaseModel):
    """Only the capability facts consumed by an episode collection row."""

    can_retry: bool
    can_refresh_source: bool
    can_retry_metadata: bool
    can_edit_authors: bool
    can_delete: bool

    model_config = ConfigDict(extra="forbid")


class PodcastEpisodeListeningStateOut(BaseModel):
    position_ms: int = Field(ge=0)
    duration_ms: Presence[int]
    playback_speed: float = Field(gt=0)

    model_config = ConfigDict(extra="forbid")


class PodcastEpisodeListPlayerDescriptorOut(BaseModel):
    """Chapter/image-free fact used only to gate list-row playback actions."""

    kind: Literal["FooterAudio"] = "FooterAudio"
    media_id: UUID

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastEpisodeListItemOut(BaseModel):
    """Compact row projection for one podcast episode."""

    id: UUID
    kind: Literal["podcast_episode"]
    title: str
    canonical_source_url: Presence[str]
    processing_status: MediaProcessingStatus
    transcript_state: str
    transcript_coverage: str
    listening_state: Presence[PodcastEpisodeListeningStateOut]
    episode_state: Literal["unplayed", "in_progress", "played"]
    progress_resettable: bool
    capabilities: PodcastEpisodeListCapabilitiesOut
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    author_mode: Literal["automatic", "manual"]
    published_date: Presence[str]
    duration_seconds: Presence[int]
    has_show_notes: bool
    player_descriptor: Presence[PodcastEpisodeListPlayerDescriptorOut] = Field(
        alias="playerDescriptor"
    )

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
    )


class PodcastEpisodeSelection(BaseModel):
    """Membership-defining episode query shared by list-wide commands."""

    state: Literal["all", "unplayed", "in_progress", "played"]
    query: Presence[str]

    model_config = ConfigDict(extra="forbid")


_QUERY_COMMAND_CONFIG = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
    extra="forbid",
)


class PodcastEpisodeMarkPlayedOut(BaseModel):
    matched_count: int = Field(ge=0)
    changed_count: int = Field(ge=0)
    collection_revision: CollectionRevision

    model_config = _QUERY_COMMAND_CONFIG


class PodcastEpisodeQueryTranscriptTarget(BaseModel):
    kind: Literal["PodcastEpisodeQuery"]
    podcast_id: UUID
    selection: PodcastEpisodeSelection
    reason: Literal["search", "highlight", "quote"]

    model_config = _QUERY_COMMAND_CONFIG


class PodcastEpisodeQueryTranscriptForecastOut(BaseModel):
    eligible_count: int = Field(ge=0)
    required_minutes: int = Field(ge=0)
    remaining_minutes: Presence[int]
    fits_budget: bool
    selection_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = _QUERY_COMMAND_CONFIG


class PodcastEpisodeQueryTranscriptRequest(BaseModel):
    target: PodcastEpisodeQueryTranscriptTarget
    selection_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = _QUERY_COMMAND_CONFIG


class PodcastEpisodeQueryTranscriptRequestOut(BaseModel):
    matched_count: int = Field(ge=0)
    queued_count: int = Field(ge=0)
    collection_revision: CollectionRevision

    model_config = _QUERY_COMMAND_CONFIG


class PodcastDetailOut(BaseModel):
    podcast: PodcastListItemOut
    subscription: PodcastSubscriptionStatusOut | None


class PodcastUnsubscribeOut(BaseModel):
    podcast_id: UUID
    status: Literal["unsubscribed"]
    removed_from_library_count: int = Field(ge=0)
    retained_shared_library_count: int = Field(ge=0)
    collection_revision: CollectionRevision = Field(alias="collectionRevision")
    library_entries_collection_revision: CollectionRevision = Field(
        alias="libraryEntriesCollectionRevision"
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PodcastSubscriptionSyncRefreshOut(BaseModel):
    podcast_id: UUID
    sync_status: Literal["pending", "running", "partial", "complete", "source_limited", "failed"]
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    sync_enqueued: bool
    collection_revision: CollectionRevision = Field(alias="collectionRevision")
    library_entries_collection_revision: CollectionRevision = Field(
        alias="libraryEntriesCollectionRevision"
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")
