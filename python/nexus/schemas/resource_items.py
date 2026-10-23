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
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.metadata_enrichment import MetadataRetry
from nexus.schemas.note_bodies import Body
from nexus.schemas.retrieval import LocationPrecision, RetrievalLocator

BlockReason = Literal["PermissionDenied", "Locked", "Processing", "TemporarilyUnavailable"]


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class _Action(_Out):
    blocked: BlockReason | None


class ResourceSourceTargetKey(_Out):
    kind: Literal["resource"] = "resource"
    resource_ref: str


class ReaderQuoteSourceTargetKey(_Out):
    kind: Literal["reader_quote"] = "reader_quote"
    message_id: UUID


class CitationSourceTargetKey(_Out):
    kind: Literal["citation"] = "citation"
    edge_id: UUID


class RetrievalSourceTargetKey(_Out):
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


class ResourceActivationOut(_Out):
    """Where opening a ref goes; ``href`` is null exactly when ``kind`` is none."""

    resource_ref: str
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
    media_kind: str | None
    contributors: list[ContributorCreditOut] | None


class MediaResourceBodyOut(_Out):
    """A live stored identity; captured evidence retains its frozen named/passage body."""

    kind: Literal["media"] = "media"
    media_summary: MediaSummaryOut


class PassageResourceBodyOut(_Out):
    kind: Literal["passage"] = "passage"
    prefix: ExcerptOut | None
    exact: ExcerptOut
    suffix: ExcerptOut | None
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
    label: ExcerptOut | None


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
    media_kind: str | None
    contributors: list[ContributorCreditOut] | None
    location_label: str | None
    activation: ResourceActivationOut | None


class ResourceAnnotationOut(_Out):
    attachment_edge_id: UUID
    note_ref: str
    body_pm_json: Body
    body_text: str
    body_version: int
    activation: ResourceActivationOut


class ResourcePreviewOut(_Out):
    body: ResourceBodyOut
    source: SourceAttributionOut | None
    annotation: ResourceAnnotationOut | None


class ResourceItemOut(_Out):
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


class UnavailableSourceLocationOut(_Out):
    kind: Literal["unavailable"] = "unavailable"
    reason: LocationUnavailableReason


class SourceTargetOut(_Out):
    source_activation: ResourceActivationOut | None
    location: Annotated[
        WholeSourceLocationOut | LocatedSourceLocationOut | UnavailableSourceLocationOut,
        Field(discriminator="kind"),
    ]


class ResolveSourceTargetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    target: SourceTargetKey


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
    "AddPodcast",
    "RefreshPodcast",
    "DeleteConversation",
    "ForkMessage",
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


class SimpleAction(_Action):
    kind: SimpleActionKind


class RetryMetadataAction(_Action):
    kind: Literal["RetryMetadata"] = "RetryMetadata"
    retry: MetadataRetry


class RefreshSourceAction(_Action):
    """Refresh from the attempt the viewer saw; a refresh admission replays by it."""

    kind: Literal["RefreshSource"] = "RefreshSource"
    expected_attempt_id: UUID | None


class ReviewMetadataResultAction(_Action):
    """Acknowledge the exact no-findings metadata job the viewer has not reviewed."""

    kind: Literal["ReviewMetadataResult"] = "ReviewMetadataResult"
    job_id: UUID


class RecoveryAction(_Action):
    """One import obligation's offer (source, then search; at most one each), carrying
    the attempt/job/revision the viewer saw."""

    kind: Literal["Recovery"] = "Recovery"
    offer: Annotated[
        RetrySourceOffer | RepairSourceOffer | RepairSearchOffer, Field(discriminator="kind")
    ]


class DownloadAction(_Action):
    """What android needs to keep this media offline: an episode's audio or a reading copy."""

    kind: Literal["Download"] = "Download"
    media_kind: DownloadKind
    title: str
    audio_url: str | None


class OpenSourceAction(_Action):
    kind: Literal["OpenSource"] = "OpenSource"
    href: str


class PlaybackAction(_Action):
    kind: Literal["Playback"] = "Playback"
    player_descriptor: PlayerDescriptor


class ConsumptionAction(_Action):
    kind: Literal["Consumption"] = "Consumption"
    finished: bool
    episode: bool


class StopPodcastAction(_Action):
    kind: Literal["StopPodcast"] = "StopPodcast"
    episodes: Literal["keep", "remove"]


class TranscriptAction(_Action):
    kind: Literal["Transcript"] = "Transcript"
    state: TranscriptState


class LecternMembershipAction(_Action):
    kind: Literal["LecternMembership"] = "LecternMembership"
    lectern_item_id: UUID | None


class HighlightNoteAction(_Action):
    kind: Literal["HighlightNote"] = "HighlightNote"
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
    | StopPodcastAction
    | TranscriptAction
    | LecternMembershipAction
    | HighlightNoteAction,
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
