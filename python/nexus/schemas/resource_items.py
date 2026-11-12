"""Wire schemas for resource items: identity and actions.

Every key is snake_case on the wire.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import MediaKind
from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.imports import (
    RepairSearchOffer,
    RepairSourceOffer,
    RetrySourceOffer,
)
from nexus.schemas.live_reference import LiveLocator, LiveReference
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.metadata_enrichment import MetadataRetry
from nexus.schemas.reader_excerpts import ExcerptView
from nexus.schemas.reader_point import ReaderPointOut
from nexus.schemas.resource_evidence import ResourceField, validate_resource_field
from nexus.schemas.retrieval import LocationPrecision, RetrievalLocator
from nexus.schemas.x_source import RevisionId

BlockReason = Literal[
    "PermissionDenied", "Locked", "Processing", "TemporarilyUnavailable", "FeedSubscription"
]


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class _Action(_Out):
    blocked: BlockReason | None


class ResourceSourceTargetKey(_Out):
    kind: Literal["resource"] = "resource"
    resource_ref: str
    field: ResourceField

    @model_validator(mode="after")
    def validate_field(self):
        validate_resource_field(self.resource_ref, self.field)
        return self


class CitationSourceTargetKey(_Out):
    kind: Literal["citation"] = "citation"
    edge_id: UUID
    side: Literal["source", "target"]


class LiveReferenceSourceTargetKey(_Out):
    """Raw structural coordinates in a live resource; nothing was captured with them."""

    kind: Literal["live_reference"] = "live_reference"
    reference: LiveReference


class XPostSourceTargetKey(_Out):
    kind: Literal["x_post"] = "x_post"
    revision_id: RevisionId


SourceTargetKey = Annotated[
    ResourceSourceTargetKey
    | CitationSourceTargetKey
    | LiveReferenceSourceTargetKey
    | XPostSourceTargetKey,
    Field(discriminator="kind"),
]
LocationUnavailableReason = Literal["source_unavailable", "location_unavailable"]


class ResourceActivationOut(_Out):
    """Where opening a ref goes; ``href`` is null exactly when ``kind`` is none."""

    resource_ref: str
    field: ResourceField

    @model_validator(mode="after")
    def validate_field(self):
        validate_resource_field(self.resource_ref, self.field)
        return self

    kind: Literal["route", "external", "none"]
    href: str | None
    unavailable_reason: LocationUnavailableReason | None = None


class ExcerptOut(_Out):
    text: str
    truncated_before: bool
    truncated_after: bool


class NamedResourceBodyOut(_Out):
    kind: Literal["named"] = "named"
    title: str
    image_url: str | None
    media_kind: MediaKind | None
    contributors: list[ContributorCreditOut] | None


class MediaResourceBodyOut(_Out):
    """A live stored identity; captured evidence retains its frozen named/passage body."""

    kind: Literal["media"] = "media"
    media_summary: MediaSummaryOut


class PassageResourceBodyOut(_Out):
    kind: Literal["passage"] = "passage"
    excerpt: ExcerptView
    capture_revision: str | None
    reading_ref: str | None
    color: HighlightColor | None


class ProseResourceBodyOut(_Out):
    kind: Literal["prose"] = "prose"
    excerpt: ExcerptOut
    role: str | None
    format: Literal["plain", "code"]
    image_count: int


class ImagesResourceBodyOut(_Out):
    kind: Literal["images"] = "images"
    count: int
    alts: list[ExcerptOut | None]


class ReferenceResourceBodyOut(_Out):
    kind: Literal["reference"] = "reference"
    target_ref: str
    field: ResourceField
    label: ExcerptOut | None

    @model_validator(mode="after")
    def validate_field(self):
        validate_resource_field(self.target_ref, self.field)
        return self


ResourceBodyOut = Annotated[
    NamedResourceBodyOut
    | MediaResourceBodyOut
    | PassageResourceBodyOut
    | ProseResourceBodyOut
    | ImagesResourceBodyOut
    | ReferenceResourceBodyOut,
    Field(discriminator="kind"),
]


class SourceAttributionOut(_Out):
    ref: str | None
    title: str | None
    media_kind: MediaKind | None
    contributors: list[ContributorCreditOut] | None
    attribution_text: str | None
    location_label: str | None
    activation: ResourceActivationOut | None


class ResourcePreviewOut(_Out):
    body: ResourceBodyOut
    source: SourceAttributionOut | None


class ResourceItemOut(_Out):
    authored_by_viewer: bool
    ref: str
    action_ref: str
    label: str
    preview: ResourcePreviewOut
    activation: ResourceActivationOut
    missing: bool


class WholeSourceLocationOut(_Out):
    kind: Literal["resource"] = "resource"


class LocatedSourceLocationOut(_Out):
    kind: Literal["located"] = "located"
    locator: RetrievalLocator
    precision: LocationPrecision
    source_identity: str | None
    apparatus_reference_id: UUID | None


class LiveSourceLocationOut(_Out):
    """A live reference's own coordinates, proven to lie inside the source as it is now.
    No words travel with them; ``source_identity`` names a media's current publication."""

    kind: Literal["live"] = "live"
    locator: LiveLocator
    source_identity: str | None


class PointSourceLocationOut(_Out):
    kind: Literal["point"] = "point"
    point: ReaderPointOut
    source_identity: str


class UnavailableSourceLocationOut(_Out):
    kind: Literal["unavailable"] = "unavailable"
    reason: LocationUnavailableReason


class XPostSourceLocationOut(_Out):
    kind: Literal["x_post"] = "x_post"
    capture_id: UUID


class SourceTargetOut(_Out):
    source_activation: ResourceActivationOut | None
    location: Annotated[
        WholeSourceLocationOut
        | LocatedSourceLocationOut
        | LiveSourceLocationOut
        | PointSourceLocationOut
        | UnavailableSourceLocationOut
        | XPostSourceLocationOut,
        Field(discriminator="kind"),
    ]


class ResolveSourceTargetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target: SourceTargetKey
    reading_media_id: UUID | None

    @model_validator(mode="after")
    def require_post_reading_media(self):
        if isinstance(self.target, XPostSourceTargetKey) and self.reading_media_id is None:
            raise ValueError("x_post targets require reading_media_id")
        return self


TranscriptState = Literal[
    "not_requested", "queued", "running", "ready", "partial", "unavailable", "failed_provider"
]
DownloadKind = Literal["podcast_episode", "pdf", "epub", "web_article"]

SimpleActionKind = Literal[
    "Open",
    "OpenInNewPane",
    "Metadata",
    "MarkCollectionFinished",
    "MarkCollectionUnread",
    "AddUnfinishedToLectern",
    "LeaveLibrary",
    "TranscribePodcastEpisodes",
    "Share",
    "Chat",
    "PlayNext",
    "AddToQueue",
    "DownloadOriginal",
    "ResetProgress",
    "RemoveMedia",
    "AddEpisodeToAll",
    "RemoveFeedEntry",
    "LibraryPlacement",
    "LibrarySettings",
    "DeleteLibrary",
    "PodcastSettings",
    "SubscribeFeed",
    "FeedLibraries",
    "UnsubscribeFeed",
    "RemoveFeedItems",
    "RefreshFeed",
    "EditHighlight",
    "EditHighlightAnnotation",
    "EditHighlightBounds",
    "DeleteHighlight",
    "EditPageTitle",
    "DeletePage",
    "EditNoteBody",
]


class SimpleAction(_Action):
    kind: SimpleActionKind


class TurnAction(_Action):
    """A librarian turn's verb, offered on either message of its pair."""

    kind: Literal["RetryTurn", "DeleteTurn"]
    run_id: UUID


class RetryMetadataAction(_Action):
    kind: Literal["RetryMetadata"] = "RetryMetadata"
    retry: MetadataRetry


class RefreshSourceAction(_Action):
    """Refresh from the attempt the viewer saw; a refresh admission replays by it."""

    kind: Literal["RefreshSource"] = "RefreshSource"
    expected_attempt_id: UUID | None


class RecoveryAction(_Action):
    """One import obligation's offer (source, then search; at most one each), carrying
    the attempt/job/revision the viewer saw."""

    kind: Literal["Recovery"] = "Recovery"
    offer: Annotated[
        RetrySourceOffer | RepairSourceOffer | RepairSearchOffer,
        Field(discriminator="kind"),
    ]


class DownloadAction(_Action):
    """An admitted acquisition subject; native resolves its source and playback authority."""

    kind: Literal["Download"] = "Download"
    media_kind: DownloadKind
    title: str


class OpenSourceAction(_Action):
    kind: Literal["OpenSource"] = "OpenSource"
    href: str


class OpenFeedAction(_Action):
    kind: Literal["OpenFeed"] = "OpenFeed"
    href: str


class PlaybackAction(_Action):
    kind: Literal["Playback"] = "Playback"
    player_descriptor: PlayerDescriptor


class ConsumptionAction(_Action):
    kind: Literal["Consumption"] = "Consumption"
    finished: bool
    episode: bool


class TranscriptAction(_Action):
    kind: Literal["Transcript"] = "Transcript"
    state: TranscriptState


class LecternMembershipAction(_Action):
    kind: Literal["LecternMembership"] = "LecternMembership"
    lectern_item_id: UUID | None


ResourceActionOut = Annotated[
    SimpleAction
    | TurnAction
    | RefreshSourceAction
    | RetryMetadataAction
    | RecoveryAction
    | DownloadAction
    | OpenSourceAction
    | OpenFeedAction
    | PlaybackAction
    | ConsumptionAction
    | TranscriptAction
    | LecternMembershipAction,
    Field(discriminator="kind"),
]


class ResourceActionsOut(_Out):
    """One ref's verbs now. Inapplicable verbs are omitted; forbidden ones carry ``blocked``.
    A missing ref has no verbs and a none activation. ``label`` is the name confirmations
    quote (a media's bare title)."""

    ref: str
    label: str
    activation: ResourceActivationOut
    missing: bool
    actions: list[ResourceActionOut]
