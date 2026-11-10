"""Shared source, subscription, finite-addition and OPML wire contracts."""

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import TranscriptState as MediaTranscriptState
from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.podcast import PodcastPlaybackSettingsOut
from nexus.services.sealed_handles import DiscoveryTargetHandle

_CLOSED = ConfigDict(extra="forbid")
FeedKind = Literal["podcast", "article"]
EntryState = Literal["all", "unread", "in_progress", "finished"]
EntrySort = Literal["newest", "oldest", "duration_asc", "duration_desc"]


class FeedDiscoveryCommitTarget(BaseModel):
    kind: Literal["Discovery"]
    target: DiscoveryTargetHandle

    model_config = _CLOSED


class FeedCanonicalCommitTarget(BaseModel):
    kind: Literal["Canonical"]
    feed_id: UUID

    model_config = _CLOSED


class FeedListItemOut(BaseModel):
    id: UUID
    kind: FeedKind
    provider: str | None
    provider_podcast_id: str | None
    title: str
    contributors: list[ContributorCreditOut] = Field(default_factory=list)
    feed_url: str | None
    website_url: str | None = None
    image_url: str | None = None
    description: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class FeedIndexItemOut(BaseModel):
    id: UUID
    kind: FeedKind
    title: str
    contributors: list[ContributorCreditOut]
    image_url: str | None

    model_config = _CLOSED


class FeedEntryCountsOut(BaseModel):
    known_count: int = Field(ge=0)
    unfinished_count: int = Field(ge=0)

    @model_validator(mode="after")
    def require_subset(self) -> "FeedEntryCountsOut":
        if self.unfinished_count > self.known_count:
            raise ValueError("Unfinished entries exceed known entries")
        return self

    model_config = _CLOSED


type FeedImportState = Literal["pending", "running", "complete", "failed", "cancelled"]


type FeedCommitTarget = Annotated[
    FeedDiscoveryCommitTarget | FeedCanonicalCommitTarget, Field(discriminator="kind")
]


class FeedActionFactsResolveRequest(BaseModel):
    targets: list[FeedCommitTarget] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def require_unique_targets(self) -> "FeedActionFactsResolveRequest":
        keys = [
            (target.kind, target.feed_id)
            if isinstance(target, FeedCanonicalCommitTarget)
            else (target.kind, target.target)
            for target in self.targets
        ]
        if len(set(keys)) != len(keys):
            raise ValueError("Duplicate feed targets")
        return self

    model_config = _CLOSED


class FeedActionCanonicalResolutionOut(BaseModel):
    kind: Literal["Canonical"] = "Canonical"
    feed_id: UUID
    feed_kind: FeedKind
    subscribed: bool

    model_config = _CLOSED


class FeedActionDiscoveryResolutionOut(BaseModel):
    kind: Literal["Discovery"] = "Discovery"

    model_config = _CLOSED


class FeedActionUnavailableResolutionOut(BaseModel):
    kind: Literal["Unavailable"] = "Unavailable"
    reason: Literal["NotFound", "InvalidDiscoveryTarget"]

    model_config = _CLOSED


class FeedActionResultOut(BaseModel):
    target: FeedCommitTarget
    resolution: Annotated[
        FeedActionCanonicalResolutionOut
        | FeedActionDiscoveryResolutionOut
        | FeedActionUnavailableResolutionOut,
        Field(discriminator="kind"),
    ]

    model_config = _CLOSED


class FeedActionFactsOut(BaseModel):
    items: list[FeedActionResultOut]

    model_config = _CLOSED


class FeedImportOut(BaseModel):
    library_name: str
    library_is_default: bool
    feed_title: str
    feed_kind: FeedKind
    id: UUID
    library_id: UUID
    feed_id: UUID
    run_id: UUID
    subscription_id: UUID | None
    state: FeedImportState
    work_in_flight: bool
    attempt_version: int
    added_count: int = Field(ge=0)
    already_present_count: int = Field(ge=0)
    error_code: str | None
    error_detail: str | None
    created_at: datetime
    updated_at: datetime
    can_cancel: bool
    can_retry: bool

    model_config = _CLOSED


class FeedSubscriptionOut(BaseModel):
    id: UUID
    library_id: UUID
    feed_id: UUID
    initial_import_id: UUID
    created_at: datetime

    model_config = _CLOSED


class FeedSubscriptionCreateRequest(BaseModel):
    id: UUID
    import_id: UUID
    target: FeedCommitTarget
    expected_removal_revision: OrderRevision

    model_config = _CLOSED


class FeedImportCreateRequest(BaseModel):
    id: UUID
    target: FeedCommitTarget
    expected_removal_revision: OrderRevision

    model_config = _CLOSED


class FeedImportCancelRequest(BaseModel):
    expected_attempt_version: int = Field(strict=True, ge=1)

    model_config = _CLOSED


class FeedImportRetryRequest(FeedImportCancelRequest):
    """Retry compares only the frozen attempt: an addition depends on no library order."""


class FeedAdmissionOut(BaseModel):
    feed_id: UUID
    href: str
    subscription: FeedSubscriptionOut | None
    operation: FeedImportOut
    order_revision: OrderRevision
    removal_revision: OrderRevision

    model_config = _CLOSED


class FeedDestinationOut(BaseModel):
    library_id: UUID
    name: str
    is_default: bool
    subscription_id: UUID
    can_add_content: bool

    model_config = _CLOSED


class FeedHistoryOut(BaseModel):
    work_in_flight: bool
    last_checked_at: datetime | None
    had_coverage_gaps: bool | None
    error_code: str | None
    error_detail: str | None

    model_config = _CLOSED


class FeedRecurringOut(BaseModel):
    state: Literal["pending", "running", "idle"]
    work_in_flight: bool
    last_checked_at: datetime | None
    had_coverage_gaps: bool | None
    error_code: str | None
    error_detail: str | None
    next_sync_at: datetime | None
    history: FeedHistoryOut

    model_config = _CLOSED


class FeedLibrarySourceOut(BaseModel):
    feed: FeedListItemOut
    destinations: list[FeedDestinationOut]
    recurring: FeedRecurringOut
    imports: list[FeedImportOut]

    model_config = _CLOSED


class LibraryFeedsOut(BaseModel):
    order_revision: OrderRevision
    removal_revision: OrderRevision
    can_add_content: bool
    subscriptions: list[FeedLibrarySourceOut]
    imports: list[FeedImportOut]

    model_config = _CLOSED


class LibraryFeedIndexSourceOut(BaseModel):
    feed: FeedIndexItemOut
    destinations: list[FeedDestinationOut]
    recurring: FeedRecurringOut
    imports: list[FeedImportOut]

    model_config = _CLOSED


class LibraryFeedIndexOut(BaseModel):
    order_revision: OrderRevision
    removal_revision: OrderRevision
    can_add_content: bool
    subscriptions: list[LibraryFeedIndexSourceOut]
    imports: list[FeedImportOut]

    model_config = _CLOSED


class LibraryFeedOut(BaseModel):
    library_id: UUID
    feed_id: UUID
    subscription: FeedSubscriptionOut | None
    operation: FeedImportOut | None
    entry_count: int = Field(ge=0)
    removal_revision: OrderRevision
    can_add_content: bool

    model_config = _CLOSED


class FeedDetailOut(BaseModel):
    feed: FeedListItemOut
    destinations: list[FeedDestinationOut]
    recurring: FeedRecurringOut
    imports: list[FeedImportOut]
    playback_settings: PodcastPlaybackSettingsOut | None
    entry_counts: FeedEntryCountsOut

    model_config = _CLOSED


class FeedRemovalDestinationOut(BaseModel):
    library_id: UUID
    name: str
    is_default: bool
    is_shared: bool
    subscription_id: UUID | None
    import_id: UUID | None
    import_attempt_version: int | None
    order_revision: OrderRevision
    entry_count: int = Field(ge=0)
    can_add_content: bool

    model_config = _CLOSED


class FeedRemovalSourceOut(BaseModel):
    id: UUID
    title: str

    model_config = _CLOSED


class FeedRemovalBlockedOut(BaseModel):
    library_id: UUID
    name: str
    reason: Literal["requires_admin", "subscription_active"]
    feeds: list[FeedRemovalSourceOut]

    model_config = _CLOSED


class FeedRemovalPreviewOut(BaseModel):
    scope: Literal["all", "library"]
    items: Literal["keep", "remove"]
    feed_id: UUID
    removal_revision: OrderRevision
    entry_count: int = Field(ge=0)
    destinations: list[FeedRemovalDestinationOut]
    can_execute: bool
    blocked: list[FeedRemovalBlockedOut]

    model_config = _CLOSED


class FeedStopDestinationRequest(BaseModel):
    library_id: UUID
    expected_subscription_id: UUID | None
    expected_import_id: UUID | None
    expected_import_attempt_version: int | None = Field(strict=True, ge=1)
    expected_order_revision: OrderRevision | None

    model_config = _CLOSED


class FeedEntryImportGuardIn(BaseModel):
    import_id: UUID
    expected_attempt_version: int = Field(strict=True, ge=1)

    model_config = _CLOSED


class FeedEntryImportGuardOut(BaseModel):
    import_id: UUID
    attempt_version: int = Field(ge=1)

    model_config = _CLOSED


class FeedEntryRemovalDestinationRequest(BaseModel):
    library_id: UUID
    expected_order_revision: OrderRevision
    imports: list[FeedEntryImportGuardIn]

    @model_validator(mode="after")
    def unique_imports(self) -> "FeedEntryRemovalDestinationRequest":
        if len({item.import_id for item in self.imports}) != len(self.imports):
            raise ValueError("Duplicate imports")
        return self

    model_config = _CLOSED


class FeedEntryRemovalDestinationOut(BaseModel):
    library_id: UUID
    name: str
    is_default: bool
    is_shared: bool
    order_revision: OrderRevision
    item_count: int = Field(ge=0)
    can_add_content: bool
    subscriptions: list[UUID]
    imports: list[FeedEntryImportGuardOut]

    model_config = _CLOSED


class FeedEntryRemovalRequest(BaseModel):
    expected_removal_revision: OrderRevision
    destinations: list[FeedEntryRemovalDestinationRequest]

    @model_validator(mode="after")
    def unique_destinations(self) -> "FeedEntryRemovalRequest":
        if len({d.library_id for d in self.destinations}) != len(self.destinations):
            raise ValueError("Duplicate destinations")
        return self

    model_config = _CLOSED


class FeedEntryRemovalPreviewOut(BaseModel):
    media_id: UUID
    removal_revision: OrderRevision
    destinations: list[FeedEntryRemovalDestinationOut]
    can_execute: bool
    blocked: list[FeedRemovalBlockedOut]

    model_config = _CLOSED


class FeedEntryRemovalOut(BaseModel):
    media_id: UUID
    removal_revision: OrderRevision

    model_config = _CLOSED


class FeedStopRequest(BaseModel):
    scope: Literal["all", "library"]
    items: Literal["keep", "remove"]
    expected_removal_revision: OrderRevision
    destinations: list[FeedStopDestinationRequest]

    @model_validator(mode="after")
    def require_guards(self) -> "FeedStopRequest":
        if len({d.library_id for d in self.destinations}) != len(self.destinations):
            raise ValueError("Duplicate destinations")
        if self.scope == "library" and len(self.destinations) != 1:
            raise ValueError("Library scope requires exactly one destination")
        for destination in self.destinations:
            if (destination.expected_import_id is None) != (
                destination.expected_import_attempt_version is None
            ):
                raise ValueError("Import identity and attempt must be supplied together")
            if (destination.expected_order_revision is None) != (self.items == "keep"):
                raise ValueError("Keep requires null revisions; remove requires exact revisions")
        return self

    model_config = _CLOSED


class FeedStoppedDestinationOut(BaseModel):
    library_id: UUID
    order_revision: OrderRevision

    model_config = _CLOSED


class FeedStopOut(BaseModel):
    feed_id: UUID
    removal_revision: OrderRevision
    destinations: list[FeedStoppedDestinationOut]

    model_config = _CLOSED


class FeedEntryListItemOut(BaseModel):
    id: UUID
    media_summary: MediaSummaryOut
    entry_id: UUID
    published_at: datetime | None
    published_on: date | None
    entry_url: str | None
    transcript_state: MediaTranscriptState | None

    model_config = ConfigDict(extra="forbid")


class FeedEntryIndexOut(BaseModel):
    next_cursor: str | None
    feed: FeedDetailOut
    items: list[FeedEntryListItemOut]

    model_config = _CLOSED


class FeedRefreshFeedScope(BaseModel):
    kind: Literal["Feed"] = "Feed"
    feed_id: UUID

    model_config = _CLOSED


class FeedRefreshFeedsScope(BaseModel):
    kind: Literal["Feeds"] = "Feeds"

    model_config = _CLOSED


class FeedRefreshLibraryScope(BaseModel):
    kind: Literal["Library"] = "Library"
    library_id: UUID

    model_config = _CLOSED


FeedRefreshManualScope = Annotated[
    FeedRefreshFeedScope | FeedRefreshFeedsScope | FeedRefreshLibraryScope,
    Field(discriminator="kind"),
]


class FeedRefreshAcceptedOut(BaseModel):
    requested_count: int = Field(ge=0)

    model_config = _CLOSED


class FeedUrlResolveRequest(BaseModel):
    kind: Literal["Url"]
    url: str = Field(min_length=1, max_length=8192)
    selected_kind: FeedKind | None

    model_config = _CLOSED


class FeedDiscoveryResolveRequest(BaseModel):
    kind: Literal["Discovery"]
    target: DiscoveryTargetHandle

    model_config = _CLOSED


type FeedResolveRequest = Annotated[
    FeedUrlResolveRequest | FeedDiscoveryResolveRequest, Field(discriminator="kind")
]


class FeedResolvedOut(BaseModel):
    state: Literal["resolved"] = "resolved"
    feed_id: UUID
    kind: FeedKind
    href: str

    model_config = _CLOSED


class FeedUrlChoiceOut(BaseModel):
    title: str
    url: str

    model_config = _CLOSED


class FeedChooseUrlOut(BaseModel):
    state: Literal["choose_url"] = "choose_url"
    choices: list[FeedUrlChoiceOut]

    model_config = _CLOSED


class FeedChooseKindOut(BaseModel):
    state: Literal["choose_kind"] = "choose_kind"
    url: str
    choices: list[FeedKind]

    model_config = _CLOSED


type FeedResolveOut = Annotated[
    FeedResolvedOut | FeedChooseUrlOut | FeedChooseKindOut, Field(discriminator="state")
]


class OpmlPreviewRequest(BaseModel):
    xml: str = Field(min_length=1, max_length=1024 * 1024)

    model_config = _CLOSED


class OpmlPreviewRow(BaseModel):
    ordinal: int = Field(ge=0)
    title: str
    url: str | None
    folder_path: list[str]
    duplicate_of: int | None
    error: str | None

    model_config = _CLOSED


class OpmlPreviewOut(BaseModel):
    rows: list[OpmlPreviewRow]

    model_config = _CLOSED


class OpmlImportItemRequest(BaseModel):
    id: UUID
    url: str = Field(min_length=1, max_length=8192)
    selected_kind: FeedKind | None
    library_id: UUID
    subscription_id: UUID
    initial_import_id: UUID

    model_config = _CLOSED


class OpmlImportCreateRequest(BaseModel):
    id: UUID
    expected_removal_revision: OrderRevision
    items: list[OpmlImportItemRequest] = Field(min_length=1, max_length=1000)

    @model_validator(mode="after")
    def require_distinct_ids(self) -> "OpmlImportCreateRequest":
        for name in ("id", "subscription_id", "initial_import_id"):
            ids = [getattr(item, name) for item in self.items]
            if len(ids) != len(set(ids)):
                raise ValueError(f"Duplicate OPML {name}")
        return self

    model_config = _CLOSED


class OpmlImportMutationRequest(BaseModel):
    expected_attempt_version: int = Field(strict=True, ge=1)

    model_config = _CLOSED


class OpmlImportItemOut(BaseModel):
    id: UUID
    ordinal: int
    url: str
    selected_kind: FeedKind | None
    library_id: UUID
    feed_id: UUID | None
    subscription_id: UUID | None
    import_id: UUID | None
    state: Literal["pending", "subscribed", "already_subscribed", "failed", "cancelled"]
    error_code: str | None
    error_detail: str | None
    can_retry: bool

    model_config = _CLOSED


class OpmlImportOut(BaseModel):
    id: UUID
    attempt_version: int
    state: Literal["pending", "running", "complete", "needs_attention", "cancelled"]
    items: list[OpmlImportItemOut]
    created_at: datetime
    updated_at: datetime
    can_cancel: bool
    can_retry: bool

    model_config = _CLOSED


class OpmlImportSummaryOut(BaseModel):
    id: UUID
    attempt_version: int = Field(ge=1)
    state: Literal["pending", "running", "complete", "needs_attention", "cancelled"]
    created_at: datetime
    updated_at: datetime
    admitted_count: int = Field(ge=0)
    remaining_count: int = Field(ge=0)
    failed_count: int = Field(ge=0)
    can_cancel: bool
    can_retry: bool

    model_config = _CLOSED
