"""Wire schemas for resource items: identity and actions.

Every key is snake_case on the wire.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.imports import RepairSearchOffer, RepairSourceOffer, RetrySourceOffer
from nexus.schemas.metadata_enrichment import MetadataRetry
from nexus.schemas.note_bodies import Body
from nexus.schemas.retrieval import LocationPrecision, RetrievalLocator

_OUT = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class ResourceSourceTargetKey(BaseModel):
    model_config = _OUT
    kind: Literal["resource"] = "resource"
    resource_ref: str


class ReaderQuoteSourceTargetKey(BaseModel):
    model_config = _OUT
    kind: Literal["reader_quote"] = "reader_quote"
    message_id: UUID


class CitationSourceTargetKey(BaseModel):
    model_config = _OUT
    kind: Literal["citation"] = "citation"
    edge_id: UUID


class RetrievalSourceTargetKey(BaseModel):
    model_config = _OUT
    kind: Literal["retrieval"] = "retrieval"
    retrieval_id: UUID


SourceTargetKey = Annotated[
    ResourceSourceTargetKey
    | ReaderQuoteSourceTargetKey
    | CitationSourceTargetKey
    | RetrievalSourceTargetKey,
    Field(discriminator="kind"),
]
LocationUnavailableReason = Literal["source_unavailable", "location_unavailable"]


class ResourceActivationOut(BaseModel):
    """Where opening a ref goes; ``href`` is null exactly when ``kind`` is none."""

    model_config = _OUT

    resource_ref: str
    kind: Literal["route", "external", "none"]
    href: str | None
    source_target: SourceTargetKey | None = None
    unavailable_reason: LocationUnavailableReason | None = None


class ExcerptOut(BaseModel):
    model_config = _OUT

    text: str
    truncated_before: bool
    truncated_after: bool


class NamedResourceBodyOut(BaseModel):
    model_config = _OUT

    kind: Literal["named"] = "named"
    title: str
    media_kind: str | None
    contributors: list[ContributorCreditOut] | None


class PassageResourceBodyOut(BaseModel):
    model_config = _OUT

    kind: Literal["passage"] = "passage"
    prefix: ExcerptOut | None
    exact: ExcerptOut
    suffix: ExcerptOut | None
    color: HighlightColor | None


class ProseResourceBodyOut(BaseModel):
    model_config = _OUT

    kind: Literal["prose"] = "prose"
    excerpt: ExcerptOut
    role: str | None
    format: Literal["plain", "code"]
    image_count: int


class ImagesResourceBodyOut(BaseModel):
    model_config = _OUT

    kind: Literal["images"] = "images"
    count: int
    alts: list[ExcerptOut | None]


class ReferenceResourceBodyOut(BaseModel):
    model_config = _OUT

    kind: Literal["reference"] = "reference"
    target_ref: str
    label: ExcerptOut | None


ResourceBodyOut = Annotated[
    NamedResourceBodyOut
    | PassageResourceBodyOut
    | ProseResourceBodyOut
    | ImagesResourceBodyOut
    | ReferenceResourceBodyOut,
    Field(discriminator="kind"),
]


class SourceAttributionOut(BaseModel):
    model_config = _OUT

    ref: str | None
    title: str | None
    media_kind: str | None
    contributors: list[ContributorCreditOut] | None
    location_label: str | None
    activation: ResourceActivationOut | None


class ResourceAnnotationOut(BaseModel):
    model_config = _OUT

    attachment_edge_id: UUID
    note_ref: str
    body_pm_json: Body
    body_text: str
    body_version: int
    activation: ResourceActivationOut


class ResourcePreviewOut(BaseModel):
    model_config = _OUT

    body: ResourceBodyOut
    source: SourceAttributionOut | None
    annotation: ResourceAnnotationOut | None


class ResourceItemOut(BaseModel):
    model_config = _OUT

    ref: str
    action_ref: str
    label: str
    preview: ResourcePreviewOut
    activation: ResourceActivationOut
    missing: bool


class WholeSourceLocationOut(BaseModel):
    model_config = _OUT

    kind: Literal["resource"] = "resource"


class LocatedSourceLocationOut(BaseModel):
    model_config = _OUT

    kind: Literal["located"] = "located"
    locator: RetrievalLocator
    precision: LocationPrecision
    source_identity: str | None


class UnavailableSourceLocationOut(BaseModel):
    model_config = _OUT

    kind: Literal["unavailable"] = "unavailable"
    reason: LocationUnavailableReason


class SourceTargetOut(BaseModel):
    model_config = _OUT

    source_activation: ResourceActivationOut | None
    location: Annotated[
        WholeSourceLocationOut | LocatedSourceLocationOut | UnavailableSourceLocationOut,
        Field(discriminator="kind"),
    ]


class ResolveSourceTargetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target: SourceTargetKey


BlockReason = Literal["PermissionDenied", "Locked", "Processing", "TemporarilyUnavailable"]
TranscriptState = Literal[
    "not_requested", "queued", "running", "ready", "partial", "unavailable", "failed_provider"
]
DownloadKind = Literal["podcast_episode", "pdf", "epub", "web_article"]

SimpleActionKind = Literal[
    "Open",
    "OpenInNewPane",
    "MediaMetadata",
    "Share",
    "Chat",
    "PlayNext",
    "DownloadOriginal",
    "EditAuthors",
    "ResetProgress",
    "RemoveMedia",
    "LibraryPlacement",
    "LibrarySettings",
    "DeleteLibrary",
    "PodcastSettings",
    "RefreshPodcast",
    "RetryPodcastBackfill",
    "DeleteConversation",
    "ForkMessage",
    "WalkMessageSources",
    "RerunMessage",
    "RegenerateMessage",
    "DeleteMessage",
    "EditHighlight",
    "LearnHighlight",
    "EditHighlightBounds",
    "DeleteHighlight",
    "EditPageTitle",
    "DeletePage",
    "EditNoteBody",
    "RegenerateArtifact",
]


class SimpleAction(BaseModel):
    model_config = _OUT

    kind: SimpleActionKind
    blocked: BlockReason | None


class RetryMetadataAction(BaseModel):
    model_config = _OUT

    kind: Literal["RetryMetadata"] = "RetryMetadata"
    blocked: BlockReason | None
    retry: MetadataRetry


class RefreshSourceAction(BaseModel):
    """Refresh from the attempt the viewer saw; a refresh admission replays by it."""

    model_config = _OUT

    kind: Literal["RefreshSource"] = "RefreshSource"
    blocked: BlockReason | None
    expected_attempt_id: UUID | None


class ReviewMetadataResultAction(BaseModel):
    """Acknowledge the exact no-findings metadata job the viewer has not reviewed."""

    model_config = _OUT

    kind: Literal["ReviewMetadataResult"] = "ReviewMetadataResult"
    blocked: BlockReason | None
    job_id: UUID


class RecoveryAction(BaseModel):
    """One import obligation's offer (source, then search; at most one each), carrying
    the attempt/job/revision the viewer saw."""

    model_config = _OUT

    kind: Literal["Recovery"] = "Recovery"
    blocked: BlockReason | None
    offer: Annotated[
        RetrySourceOffer | RepairSourceOffer | RepairSearchOffer, Field(discriminator="kind")
    ]


class DownloadAction(BaseModel):
    """What android needs to keep this media offline: an episode's audio or a reading copy."""

    model_config = _OUT

    kind: Literal["Download"] = "Download"
    blocked: BlockReason | None
    media_kind: DownloadKind
    title: str
    audio_url: str | None


class OpenSourceAction(BaseModel):
    model_config = _OUT

    kind: Literal["OpenSource"] = "OpenSource"
    blocked: BlockReason | None
    href: str


class PlaybackAction(BaseModel):
    model_config = _OUT

    kind: Literal["Playback"] = "Playback"
    blocked: BlockReason | None
    player_descriptor: PlayerDescriptor


class ConsumptionAction(BaseModel):
    model_config = _OUT

    kind: Literal["Consumption"] = "Consumption"
    blocked: BlockReason | None
    finished: bool
    episode: bool


class PodcastSubscriptionAction(BaseModel):
    model_config = _OUT

    kind: Literal["PodcastSubscription"] = "PodcastSubscription"
    blocked: BlockReason | None
    subscribed: bool


class TranscriptAction(BaseModel):
    model_config = _OUT

    kind: Literal["Transcript"] = "Transcript"
    blocked: BlockReason | None
    state: TranscriptState


class LecternMembershipAction(BaseModel):
    model_config = _OUT

    kind: Literal["LecternMembership"] = "LecternMembership"
    blocked: BlockReason | None
    lectern_item_id: UUID | None


class HighlightNoteAction(BaseModel):
    model_config = _OUT

    kind: Literal["HighlightNote"] = "HighlightNote"
    blocked: BlockReason | None
    note_block_id: UUID | None


ResourceActionOut = Annotated[
    SimpleAction
    | RefreshSourceAction
    | RetryMetadataAction
    | ReviewMetadataResultAction
    | RecoveryAction
    | DownloadAction
    | OpenSourceAction
    | PlaybackAction
    | ConsumptionAction
    | PodcastSubscriptionAction
    | TranscriptAction
    | LecternMembershipAction
    | HighlightNoteAction,
    Field(discriminator="kind"),
]


class ResourceActionsOut(BaseModel):
    """One ref's verbs now. Inapplicable verbs are omitted; forbidden ones carry ``blocked``.
    A missing ref has no verbs and a none activation. ``label`` is the name confirmations
    quote (a media's bare title)."""

    model_config = _OUT

    ref: str
    label: str
    activation: ResourceActivationOut
    missing: bool
    actions: list[ResourceActionOut]
