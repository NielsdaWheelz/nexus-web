"""Podcast wire: subscriptions, episodes, refresh, episode transcript batches and requests."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import TranscriptState as MediaTranscriptState
from nexus.schemas.acquisition import AcquisitionGuard
from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.consumption import PauseShorteningMode, PlaybackRate
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaProcessingStatus, MediaSummaryOut
from nexus.services.sealed_handles import DiscoveryTargetHandle

# The web reads exact key sets, so each model's casing is load-bearing.
_CLOSED = ConfigDict(extra="forbid")

EpisodeState = Literal["all", "unplayed", "in_progress", "played"]
EpisodeSort = Literal["newest", "oldest", "duration_asc", "duration_desc"]


class PodcastDiscoveryCommitTarget(BaseModel):
    kind: Literal["Discovery"] = "Discovery"
    target: DiscoveryTargetHandle

    model_config = _CLOSED


class PodcastCanonicalCommitTarget(BaseModel):
    kind: Literal["Canonical"] = "Canonical"
    podcast_id: UUID

    model_config = _CLOSED


class PodcastEpisodeFromDiscoveryRequest(AcquisitionGuard):
    target: DiscoveryTargetHandle

    model_config = _CLOSED


class PodcastDestinationOutcomeOut(BaseModel):
    library_id: UUID
    outcome: Literal["Added", "AlreadyPresent"]

    model_config = _CLOSED


class PodcastEpisodeFromDiscoveryOut(BaseModel):
    href: str = Field(min_length=1)
    media_id: UUID
    destination_outcomes: list[PodcastDestinationOutcomeOut]

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


type PodcastImportState = Literal["pending", "running", "complete", "failed", "cancelled"]
type PodcastCommitTarget = Annotated[
    PodcastDiscoveryCommitTarget | PodcastCanonicalCommitTarget, Field(discriminator="kind")
]


class PodcastActionFactsResolveRequest(BaseModel):
    targets: list[PodcastCommitTarget] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def require_unique_targets(self) -> "PodcastActionFactsResolveRequest":
        keys = [
            (target.kind, target.podcast_id)
            if isinstance(target, PodcastCanonicalCommitTarget)
            else (target.kind, target.target)
            for target in self.targets
        ]
        if len(set(keys)) != len(keys):
            raise ValueError("Duplicate podcast targets")
        return self

    model_config = _CLOSED


class PodcastActionCanonicalResolutionOut(BaseModel):
    kind: Literal["Canonical"] = "Canonical"
    podcast_id: UUID
    subscribed: bool

    model_config = _CLOSED


class PodcastActionDiscoveryResolutionOut(BaseModel):
    kind: Literal["Discovery"] = "Discovery"

    model_config = _CLOSED


class PodcastActionUnavailableResolutionOut(BaseModel):
    kind: Literal["Unavailable"] = "Unavailable"
    reason: Literal["NotFound", "InvalidDiscoveryTarget"]

    model_config = _CLOSED


class PodcastActionResultOut(BaseModel):
    target: PodcastCommitTarget
    resolution: Annotated[
        PodcastActionCanonicalResolutionOut
        | PodcastActionDiscoveryResolutionOut
        | PodcastActionUnavailableResolutionOut,
        Field(discriminator="kind"),
    ]

    model_config = _CLOSED


class PodcastActionFactsOut(BaseModel):
    items: list[PodcastActionResultOut]

    model_config = _CLOSED


class PodcastImportOut(BaseModel):
    library_name: str
    library_is_default: bool
    podcast_title: str
    id: UUID
    library_id: UUID
    podcast_id: UUID
    run_id: UUID
    state: PodcastImportState
    attempt_version: int
    added_count: int = Field(ge=0)
    already_present_count: int = Field(ge=0)
    error_code: str | None
    error_detail: str | None
    created_at: datetime
    updated_at: datetime
    can_cancel: bool
    can_retry: bool
    order_revision: OrderRevision

    model_config = _CLOSED


class PodcastSubscriptionOut(BaseModel):
    id: UUID
    library_id: UUID
    podcast_id: UUID
    initial_import_id: UUID
    created_at: datetime

    model_config = _CLOSED


class PodcastSubscriptionCreateRequest(BaseModel):
    id: UUID
    import_id: UUID
    target: PodcastCommitTarget
    expected_order_revision: OrderRevision
    expected_removal_revision: OrderRevision

    model_config = _CLOSED


class PodcastImportCreateRequest(BaseModel):
    id: UUID
    target: PodcastCommitTarget
    expected_order_revision: OrderRevision
    expected_removal_revision: OrderRevision

    model_config = _CLOSED


class PodcastImportCancelRequest(BaseModel):
    expected_attempt_version: int = Field(strict=True, ge=1)

    model_config = _CLOSED


class PodcastImportRetryRequest(PodcastImportCancelRequest):
    expected_order_revision: OrderRevision


class PodcastAdmissionOut(BaseModel):
    podcast_id: UUID
    href: str
    subscription: PodcastSubscriptionOut | None
    import_: PodcastImportOut = Field(alias="import")
    order_revision: OrderRevision
    removal_revision: OrderRevision

    model_config = _CLOSED


class PodcastDestinationOut(BaseModel):
    library_id: UUID
    name: str
    is_default: bool
    subscription_id: UUID
    can_add_content: bool

    model_config = _CLOSED


class PodcastRecurringOut(BaseModel):
    state: Literal["pending", "running", "idle"]
    last_checked_at: datetime | None
    had_coverage_gaps: bool | None
    error_code: str | None
    error_detail: str | None
    next_sync_at: datetime | None

    model_config = _CLOSED


class PodcastLibraryShowOut(BaseModel):
    podcast: PodcastListItemOut
    destinations: list[PodcastDestinationOut]
    recurring: PodcastRecurringOut
    imports: list[PodcastImportOut]

    model_config = _CLOSED


class LibraryPodcastsOut(BaseModel):
    order_revision: OrderRevision
    removal_revision: OrderRevision
    can_add_content: bool
    subscriptions: list[PodcastLibraryShowOut]
    imports: list[PodcastImportOut]

    model_config = _CLOSED


class LibraryPodcastOut(BaseModel):
    library_id: UUID
    podcast_id: UUID
    subscription: PodcastSubscriptionOut | None
    import_: PodcastImportOut | None = Field(alias="import")
    episode_count: int = Field(ge=0)
    order_revision: OrderRevision
    removal_revision: OrderRevision
    can_add_content: bool

    model_config = _CLOSED


type SettingsVersion = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,18})$", strict=True)]


class PodcastPlaybackSettingsOut(BaseModel):
    id: UUID | None
    podcast_id: UUID
    settings_version: SettingsVersion
    default_playback_speed: PlaybackRate | None
    pause_shortening_mode: PauseShorteningMode | None

    model_config = _CLOSED


class PodcastPlaybackSettingsRequest(BaseModel):
    id: UUID
    expected_settings_version: SettingsVersion
    default_playback_speed: PlaybackRate | None
    pause_shortening_mode: PauseShorteningMode | None

    model_config = _CLOSED


class PodcastDetailOut(BaseModel):
    podcast: PodcastListItemOut
    destinations: list[PodcastDestinationOut]
    recurring: PodcastRecurringOut
    imports: list[PodcastImportOut]
    playback_settings: PodcastPlaybackSettingsOut
    episode_counts: PodcastEpisodeCountsOut

    model_config = _CLOSED


class PodcastRemovalDestinationOut(BaseModel):
    library_id: UUID
    name: str
    is_default: bool
    is_shared: bool
    subscription_id: UUID | None
    import_id: UUID | None
    import_attempt_version: int | None
    order_revision: OrderRevision
    episode_count: int = Field(ge=0)
    can_add_content: bool

    model_config = _CLOSED


class PodcastRemovalBlockedOut(BaseModel):
    library_id: UUID
    name: str
    reason: Literal["requires_admin"]

    model_config = _CLOSED


class PodcastRemovalPreviewOut(BaseModel):
    scope: Literal["all", "library"]
    episodes: Literal["keep", "remove"]
    podcast_id: UUID
    removal_revision: OrderRevision
    episode_count: int = Field(ge=0)
    destinations: list[PodcastRemovalDestinationOut]
    can_execute: bool
    blocked: list[PodcastRemovalBlockedOut]

    model_config = _CLOSED


class PodcastStopDestinationRequest(BaseModel):
    library_id: UUID
    expected_subscription_id: UUID | None
    expected_import_id: UUID | None
    expected_import_attempt_version: int | None = Field(strict=True, ge=1)
    expected_order_revision: OrderRevision | None

    model_config = _CLOSED


class PodcastStopRequest(BaseModel):
    scope: Literal["all", "library"]
    episodes: Literal["keep", "remove"]
    expected_removal_revision: OrderRevision
    destinations: list[PodcastStopDestinationRequest]

    @model_validator(mode="after")
    def require_guards(self) -> "PodcastStopRequest":
        if len({d.library_id for d in self.destinations}) != len(self.destinations):
            raise ValueError("Duplicate destinations")
        if self.scope == "library" and len(self.destinations) != 1:
            raise ValueError("Library scope requires exactly one destination")
        for destination in self.destinations:
            if (destination.expected_import_id is None) != (
                destination.expected_import_attempt_version is None
            ):
                raise ValueError("Import identity and attempt must be supplied together")
            if (destination.expected_order_revision is None) != (self.episodes == "keep"):
                raise ValueError("Keep requires null revisions; remove requires exact revisions")
        return self

    model_config = _CLOSED


class PodcastStoppedDestinationOut(BaseModel):
    library_id: UUID
    order_revision: OrderRevision

    model_config = _CLOSED


class PodcastStopOut(BaseModel):
    podcast_id: UUID
    removal_revision: OrderRevision
    destinations: list[PodcastStoppedDestinationOut]

    model_config = _CLOSED


class PodcastEpisodeListItemOut(BaseModel):
    id: UUID
    media_summary: MediaSummaryOut
    transcript_state: MediaTranscriptState

    model_config = ConfigDict(extra="forbid")


class PodcastEpisodeSelection(BaseModel):
    state: EpisodeState

    model_config = _CLOSED


class PodcastEpisodeConsumptionItem(BaseModel):
    media_id: UUID
    expected_override_revision: int | None = Field(strict=True, ge=1)

    model_config = _CLOSED


class PodcastEpisodeConsumptionPreparedOut(BaseModel):
    items: list[PodcastEpisodeConsumptionItem]

    model_config = _CLOSED


class PodcastEpisodeConsumptionRequest(BaseModel):
    desired_state: Literal["played", "unplayed"]
    items: list[PodcastEpisodeConsumptionItem]

    @model_validator(mode="after")
    def require_unique_media(self) -> "PodcastEpisodeConsumptionRequest":
        if len({item.media_id for item in self.items}) != len(self.items):
            raise ValueError("Duplicate episode ids")
        return self

    model_config = _CLOSED


class PodcastEpisodeConsumptionOut(BaseModel):
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


class PodcastRefreshPodcastScope(BaseModel):
    kind: Literal["Podcast"] = "Podcast"
    podcast_id: UUID

    model_config = _CLOSED


class PodcastRefreshPodcastsScope(BaseModel):
    kind: Literal["Podcasts"] = "Podcasts"

    model_config = _CLOSED


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
