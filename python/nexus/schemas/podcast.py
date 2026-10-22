"""Podcast wire: subscriptions, episodes, refresh, episode transcript batches and requests."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import TranscriptState as MediaTranscriptState
from nexus.schemas.consumption import PauseShorteningMode, PlaybackRate
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaProcessingStatus, MediaSummaryOut
from nexus.services.sealed_handles import DiscoveryTargetHandle

# The web reads exact key sets, so each model's casing is load-bearing.
_CLOSED = ConfigDict(extra="forbid")
_SNAKE = ConfigDict(extra="forbid")
_SNAKE_OUT = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)

# Sync and backfill share one lifecycle vocabulary.
type PodcastSyncStatus = Literal["Pending", "Running", "Complete", "Failed"]
EpisodeState = Literal["all", "unplayed", "in_progress", "played"]


class PodcastDiscoveryCommitTarget(BaseModel):
    kind: Literal["Discovery"] = "Discovery"
    target: DiscoveryTargetHandle

    model_config = _SNAKE


class PodcastCanonicalCommitTarget(BaseModel):
    kind: Literal["Canonical"] = "Canonical"
    podcast_id: UUID

    model_config = _CLOSED


class PodcastSubscribeRequest(BaseModel):
    target: Annotated[
        PodcastDiscoveryCommitTarget | PodcastCanonicalCommitTarget, Field(discriminator="kind")
    ]
    named_library_ids: list[UUID] = Field(default_factory=list)
    # confirms that a show replaces episodes some destination files directly.
    replace_episodes: bool

    model_config = _CLOSED


class PodcastEpisodeFromDiscoveryRequest(BaseModel):
    target: DiscoveryTargetHandle
    named_library_ids: list[UUID] = Field(default_factory=list)

    model_config = _CLOSED


class PodcastBackfillOut(BaseModel):
    id: UUID
    state: PodcastSyncStatus
    updated_at: datetime
    error_code: str | None
    error_detail: str | None

    model_config = _CLOSED


class PodcastBackfillRetryRequest(BaseModel):
    expected_backfill_id: UUID

    model_config = _CLOSED


class PodcastBackfillRetryOut(BaseModel):
    podcast_id: UUID
    outcome: Literal["Retried", "NotEligible"]
    backfill: PodcastBackfillOut

    model_config = _CLOSED


class PodcastDestinationOutcomeOut(BaseModel):
    library_id: UUID
    outcome: Literal["Added", "AlreadyPresent", "IncludedThroughPodcast"]

    model_config = _CLOSED


class PodcastSubscribeOut(BaseModel):
    href: str = Field(min_length=1)
    podcast_id: UUID
    outcome: Literal["Subscribed", "AlreadySubscribed", "DestinationsAdded"]
    destinations: list[PodcastDestinationOutcomeOut]
    backfill: PodcastBackfillOut

    model_config = _CLOSED


class PodcastEpisodeFromDiscoveryOut(BaseModel):
    href: str = Field(min_length=1)
    media_id: UUID
    destination_outcomes: list[PodcastDestinationOutcomeOut]

    model_config = _CLOSED


class PodcastSubscriptionSettingsPatchRequest(BaseModel):
    expected_subscription_id: UUID
    expected_settings_version: int = Field(strict=True, ge=1, le=2_147_483_647)
    default_playback_speed: PlaybackRate | None
    pause_shortening_mode: PauseShorteningMode | None

    model_config = _CLOSED


class PodcastSubscriptionStatusOut(BaseModel):
    subscription_id: UUID
    settings_version: int = Field(strict=True, ge=1, le=2_147_483_647)
    user_id: UUID
    podcast_id: UUID
    default_playback_speed: PlaybackRate | None
    pause_shortening_mode: PauseShorteningMode | None
    sync_had_rejected_items: bool | None
    sync_status: PodcastSyncStatus
    sync_error_code: str | None = None
    sync_error_message: str | None = None
    sync_attempts: int = Field(ge=0)
    sync_started_at: datetime | None = None
    sync_completed_at: datetime | None = None
    last_checked_at: datetime | None = None
    updated_at: datetime
    backfill: PodcastBackfillOut

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class PodcastSubscriptionLifecycleSnapshotOut(BaseModel):
    """One viewer-owned subscription's live sync and backfill state (an SSE frame)."""

    podcast_id: UUID
    subscription_id: UUID
    sync_status: PodcastSyncStatus
    sync_completed_at: datetime | None
    backfill: PodcastBackfillOut

    model_config = _CLOSED


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

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class PodcastEpisodeCountsOut(BaseModel):
    available_count: int = Field(ge=0)
    unfinished_count: int = Field(ge=0)

    @model_validator(mode="after")
    def require_subset(self) -> "PodcastEpisodeCountsOut":
        if self.unfinished_count > self.available_count:
            raise ValueError("Unfinished episodes exceed available episodes")
        return self

    model_config = _CLOSED


class PodcastDetailOut(BaseModel):
    podcast: PodcastListItemOut
    subscription: PodcastSubscriptionStatusOut | None
    episode_counts: PodcastEpisodeCountsOut


class PodcastSubscriptionListItemOut(BaseModel):
    podcast_id: UUID
    title: str
    image_url: str | None
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    unplayed_count: int = Field(ge=0)
    latest_episode_published_at: datetime | None
    default_playback_speed: PlaybackRate | None
    pause_shortening_mode: PauseShorteningMode | None
    sync_status: PodcastSyncStatus

    model_config = _SNAKE_OUT


class PodcastEpisodeListItemOut(BaseModel):
    id: UUID
    media_summary: MediaSummaryOut
    transcript_state: MediaTranscriptState

    model_config = ConfigDict(extra="forbid")


class PodcastEpisodeSelection(BaseModel):
    state: EpisodeState

    model_config = _SNAKE


class PodcastEpisodeMarkPlayedOut(BaseModel):
    matched_count: int = Field(ge=0)
    changed_count: int = Field(ge=0)

    model_config = _CLOSED


class PodcastEpisodeQueryTranscriptTarget(BaseModel):
    kind: Literal["PodcastEpisodeQuery"]
    podcast_id: UUID
    selection: PodcastEpisodeSelection
    reason: Literal["search", "highlight", "quote"]

    model_config = _CLOSED


class PodcastEpisodeQueryTranscriptForecastOut(BaseModel):
    eligible_count: int = Field(ge=0)
    selection_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = _CLOSED


class PodcastEpisodeQueryTranscriptRequest(BaseModel):
    target: PodcastEpisodeQueryTranscriptTarget
    selection_fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")

    model_config = _CLOSED


class PodcastEpisodeQueryTranscriptRequestOut(BaseModel):
    matched_count: int = Field(ge=0)
    queued_count: int = Field(ge=0)

    model_config = _CLOSED


class PodcastUnsubscribeOut(BaseModel):
    outcome: Literal["Unsubscribed", "AlreadyUnsubscribed"]
    podcast_id: UUID
    removed_placement_count: int = Field(default=0, ge=0)
    retained_shared_count: int = Field(default=0, ge=0)

    model_config = _SNAKE_OUT


class PodcastRefreshPodcastScope(BaseModel):
    kind: Literal["Podcast"] = "Podcast"
    podcast_id: UUID

    model_config = _CLOSED


class PodcastRefreshPodcastsScope(BaseModel):
    kind: Literal["Podcasts"] = "Podcasts"

    model_config = _SNAKE


class PodcastRefreshLibraryScope(BaseModel):
    kind: Literal["Library"] = "Library"
    library_id: UUID

    model_config = _CLOSED


PodcastRefreshManualScope = Annotated[
    PodcastRefreshPodcastScope | PodcastRefreshPodcastsScope | PodcastRefreshLibraryScope,
    Field(discriminator="kind"),
]


class PodcastRefreshAcceptedOut(BaseModel):
    requested_count: int = Field(ge=0)

    model_config = _CLOSED


class _Strict(BaseModel):
    """Base for every closed model on this wire: an unknown key is rejected."""

    model_config = ConfigDict(extra="forbid")


TranscriptState = Literal[
    "not_requested", "queued", "running", "ready", "partial", "unavailable", "failed_provider"
]
TranscriptCoverage = Literal["none", "partial", "full"]


TranscriptRequestReason = Literal[
    "episode_open", "search", "highlight", "quote", "background_warming", "operator_requeue"
]


class TranscriptRequestRequest(_Strict):
    reason: TranscriptRequestReason = "episode_open"


class TranscriptRequestOut(BaseModel):
    media_id: str
    processing_status: MediaProcessingStatus
    transcript_state: TranscriptState
    transcript_coverage: TranscriptCoverage
    request_reason: TranscriptRequestReason
    request_enqueued: bool
