"""Pydantic schemas for podcast discovery, subscription, and plan policy."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.collection_page import CollectionRevision
from nexus.schemas.consumption import PauseShorteningMode, PlaybackRate
from nexus.schemas.contributors import (
    ContributorCreditIn,
    ContributorCreditOut,
)
from nexus.schemas.media import MediaProcessingStatus
from nexus.schemas.presence import Presence, absent
from nexus.services.podcasts.handles import PodcastRefreshRunHandle
from nexus.services.podcasts.types import PodcastRefreshRunStatus, PodcastSyncStatus
from nexus.services.sealed_handles import DiscoveryTargetHandle


class PodcastSourceFacts(BaseModel):
    """Trusted provider facts after Podcast discovery or OPML resolution."""

    provider_podcast_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    contributors: list[ContributorCreditIn] = Field(default_factory=list)
    feed_url: str = Field(min_length=1)
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None

    model_config = ConfigDict(extra="forbid")


class PodcastDiscoveryCommitTarget(BaseModel):
    kind: Literal["Discovery"] = "Discovery"
    target: DiscoveryTargetHandle

    model_config = ConfigDict(extra="forbid")


class PodcastCanonicalCommitTarget(BaseModel):
    kind: Literal["Canonical"] = "Canonical"
    podcast_id: UUID

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


PodcastCommitTarget = Annotated[
    PodcastDiscoveryCommitTarget | PodcastCanonicalCommitTarget,
    Field(discriminator="kind"),
]


class PodcastReplacementConfirmation(BaseModel):
    conflict_fingerprint: str = Field(min_length=64, max_length=64)

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastSubscribeRequest(BaseModel):
    target: PodcastCommitTarget
    named_library_ids: list[UUID] = Field(default_factory=list)
    replacement_confirmation: Presence[PodcastReplacementConfirmation]

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastEpisodeFromDiscoveryRequest(BaseModel):
    target: DiscoveryTargetHandle
    named_library_ids: list[UUID] = Field(default_factory=list)

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastOpmlImportRequest(BaseModel):
    opml: str = Field(min_length=1)
    default_library_ids: list[UUID] = Field(default_factory=list)
    per_feed_library_ids: dict[str, list[UUID]] = Field(default_factory=dict)

    model_config = ConfigDict(extra="forbid")


class PodcastBackfillOut(BaseModel):
    id: UUID
    state: Literal["Pending", "Running", "Complete", "SourceLimited", "Failed"]
    processed_count: int = Field(ge=0)
    added_count: int = Field(ge=0)

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastBackfillRetryOut(BaseModel):
    podcast_id: UUID
    outcome: Literal["Retried", "NotEligible"]
    backfill: PodcastBackfillOut

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastDestinationOutcomeOut(BaseModel):
    library_id: UUID
    outcome: Literal["Added", "AlreadyPresent", "IncludedThroughPodcast"]

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastSubscribeDestinationOutcomeOut(BaseModel):
    library_id: UUID
    outcome: Literal["Added", "AlreadyPresent"]

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastSubscribeOut(BaseModel):
    href: str
    podcast_id: UUID
    outcome: Literal["Subscribed", "AlreadySubscribed", "DestinationsAdded"]
    destinations: list[PodcastSubscribeDestinationOutcomeOut]
    backfill: PodcastBackfillOut
    collection_revision: CollectionRevision
    library_entries_collection_revision: CollectionRevision

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastEpisodeFromDiscoveryOut(BaseModel):
    href: str
    media_id: UUID
    destination_outcomes: list[PodcastDestinationOutcomeOut]
    collection_revision: CollectionRevision

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastSubscriptionSettingsPatchRequest(BaseModel):
    default_playback_speed: Presence[PlaybackRate] = Field(default_factory=absent)
    pause_shortening_mode: Presence[PauseShorteningMode] = Field(default_factory=absent)
    auto_queue: bool | None = None

    @model_validator(mode="after")
    def validate_patch_semantics(self) -> "PodcastSubscriptionSettingsPatchRequest":
        if (
            "default_playback_speed" not in self.model_fields_set
            and "pause_shortening_mode" not in self.model_fields_set
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
    default_playback_speed: Presence[PlaybackRate]
    pause_shortening_mode: Presence[PauseShorteningMode]
    auto_queue: bool = False
    sync_status: PodcastSyncStatus
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int
    sync_started_at: datetime | None = None
    sync_completed_at: datetime | None = None
    last_checked_at: datetime | None = None
    updated_at: datetime
    backfill: PodcastBackfillOut


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
    default_playback_speed: Presence[PlaybackRate]
    pause_shortening_mode: Presence[PauseShorteningMode]
    auto_queue: bool
    sync_status: PodcastSyncStatus

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
    offline_download_eligible: bool
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
    """Membership-defining episode state shared by list-wide commands."""

    state: Literal["all", "unplayed", "in_progress", "played"]

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


class PodcastUnsubscribedOut(BaseModel):
    outcome: Literal["Unsubscribed"] = "Unsubscribed"
    podcast_id: UUID
    removed_placement_count: int = Field(ge=0)
    retained_shared_count: int = Field(ge=0)
    collection_revision: CollectionRevision = Field(alias="collectionRevision")
    library_entries_collection_revision: CollectionRevision = Field(
        alias="libraryEntriesCollectionRevision"
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PodcastAlreadyUnsubscribedOut(BaseModel):
    outcome: Literal["AlreadyUnsubscribed"] = "AlreadyUnsubscribed"
    podcast_id: UUID
    collection_revision: CollectionRevision = Field(alias="collectionRevision")
    library_entries_collection_revision: CollectionRevision = Field(
        alias="libraryEntriesCollectionRevision"
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


PodcastUnsubscribeOut = Annotated[
    PodcastUnsubscribedOut | PodcastAlreadyUnsubscribedOut,
    Field(discriminator="outcome"),
]


class PodcastRefreshPodcastScope(BaseModel):
    kind: Literal["Podcast"] = "Podcast"
    podcast_id: UUID

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastRefreshPodcastsScope(BaseModel):
    kind: Literal["Podcasts"] = "Podcasts"

    model_config = ConfigDict(extra="forbid")


class PodcastRefreshLibraryScope(BaseModel):
    kind: Literal["Library"] = "Library"
    library_id: UUID

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


PodcastRefreshManualScope = Annotated[
    PodcastRefreshPodcastScope | PodcastRefreshPodcastsScope | PodcastRefreshLibraryScope,
    Field(discriminator="kind"),
]


class PodcastRefreshRunCreateOut(BaseModel):
    refresh_run_handle: PodcastRefreshRunHandle
    status: PodcastRefreshRunStatus
    requested_count: int = Field(ge=0)

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class PodcastRefreshRunSnapshotOut(BaseModel):
    refresh_run_handle: PodcastRefreshRunHandle
    status: PodcastRefreshRunStatus
    requested_count: int = Field(ge=0)
    finished_count: int = Field(ge=0)
    succeeded_count: int = Field(ge=0)
    source_limited_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    skipped_count: int = Field(ge=0)
    new_episode_count: int = Field(ge=0)
    started_at: datetime
    completed_at: Presence[datetime]

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )
