"""Wire schema for the canonical resource-action snapshot endpoint
(``POST /resource-items/action-snapshots/resolve``).

This is the single source of per-resource action FACTS. It carries only facts:
which capabilities exist for a ref and whether the server blocks each one. It
never carries labels, icons, order, separators, confirmation copy, mutation
URLs, executors, busy state, or client-only blocked reasons — those are owned by
the frontend planner/runtime. See ``docs/modules/resource-actions.md``.

Serialization is camelCase via ``by_alias=True`` (repo convention, mirroring
``ResourceActivationOut``). Capabilities are closed unions on ``kind``; conditional membership and note
states discriminate on ``state``. Unknown or mis-shaped variants are boundary
defects, not silent coercion.
"""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from nexus.schemas.consumption import PlayerDescriptor
from nexus.schemas.imports import RepairSearchOffer, RepairSourceOffer, RetrySourceOffer
from nexus.schemas.metadata_enrichment import MetadataRetry
from nexus.schemas.resource_items import ResourceActivationOut

_MAX_REFS = 100
_OUT_CONFIG = ConfigDict(
    alias_generator=to_camel,
    populate_by_name=True,
    extra="forbid",
    json_schema_serialization_defaults_required=True,
)


class ResourceActionSnapshotResolveRequest(BaseModel):
    """A batch of 1..100 unique resource refs to resolve.

    ``Field`` bounds the count (1..100) and a single ``model_validator`` adds the
    uniqueness rule pydantic cannot express; both surface as ``E_INVALID_REQUEST``
    via the app's request-validation remap. Ref grammar is parsed exactly once, at
    the route boundary (``api/routes/resource_items.py`` ``_parse_ref``), so an
    unparseable ref is rejected there — this model never re-parses.
    """

    refs: list[str] = Field(min_length=1, max_length=_MAX_REFS)

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _validate_unique(self) -> ResourceActionSnapshotResolveRequest:
        if len(set(self.refs)) != len(self.refs):
            raise ValueError("refs must be unique.")
        return self


class ServerActionAvailabilityAvailableOut(BaseModel):
    kind: Literal["Available"] = "Available"

    model_config = _OUT_CONFIG


class ServerActionAvailabilityBlockedOut(BaseModel):
    kind: Literal["Blocked"] = "Blocked"
    reason: Literal["PermissionDenied", "Locked", "Processing", "TemporarilyUnavailable"]

    model_config = _OUT_CONFIG


ServerActionAvailabilityOut = Annotated[
    ServerActionAvailabilityAvailableOut | ServerActionAvailabilityBlockedOut,
    Field(discriminator="kind"),
]

# Capability kinds whose only fact is availability. Grouped into one model
# because they share an identical wire shape (``{kind, availability}``); the
# generated web contract preserves this union.
SimpleResourceActionCapabilityKind = Literal[
    "Open",
    "OpenInNewPane",
    "MediaMetadata",
    "Share",
    "Chat",
    "PlayNext",
    "DownloadOriginal",
    "RefreshSource",
    "EditAuthors",
    "ResetProgress",
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
    "LinkHighlight",
    "LearnHighlight",
    "EditHighlightBounds",
    "DeleteHighlight",
    "EditPageTitle",
    "DeletePage",
    "EditNoteBody",
    "RegenerateArtifact",
    "RemoveMedia",
    "LibraryPlacement",
    "OfflineAudio",
]


class SimpleResourceActionCapabilityOut(BaseModel):
    kind: SimpleResourceActionCapabilityKind
    availability: ServerActionAvailabilityOut

    model_config = _OUT_CONFIG


class RetryMetadataResourceActionCapabilityOut(BaseModel):
    kind: Literal["RetryMetadata"] = "RetryMetadata"
    availability: ServerActionAvailabilityOut
    retry: MetadataRetry

    model_config = _OUT_CONFIG


class RetrySourceOfferOut(RetrySourceOffer):
    model_config = _OUT_CONFIG


class RepairSourceOfferOut(RepairSourceOffer):
    model_config = _OUT_CONFIG


class RepairSearchOfferOut(RepairSearchOffer):
    model_config = _OUT_CONFIG


MediaRecoveryOfferOut = Annotated[
    RetrySourceOfferOut | RepairSourceOfferOut | RepairSearchOfferOut,
    Field(discriminator="kind"),
]
"""The Imports owner's media offers, camelCased like every other snapshot field."""


class RecoveryResourceActionCapabilityOut(BaseModel):
    """The one recovery a media menu may plan, carrying the identity the viewer
    inspected so a stale offer conflicts instead of acting on newer work."""

    kind: Literal["Recovery"] = "Recovery"
    availability: ServerActionAvailabilityOut
    offer: MediaRecoveryOfferOut

    model_config = _OUT_CONFIG


class OfflineReadingResourceActionCapabilityOut(BaseModel):
    kind: Literal["OfflineReading"] = "OfflineReading"
    availability: ServerActionAvailabilityOut
    media_kind: Literal["web_article", "epub", "pdf"]
    requested_title: str = Field(min_length=1, max_length=512)

    model_config = _OUT_CONFIG

    @field_validator("requested_title")
    @classmethod
    def validate_requested_title(cls, value: str) -> str:
        if value.isspace():
            raise ValueError("requestedTitle must contain visible text")
        return value


class OpenSourceResourceActionCapabilityOut(BaseModel):
    kind: Literal["OpenSource"] = "OpenSource"
    availability: ServerActionAvailabilityOut
    href: str

    model_config = _OUT_CONFIG


class PlaybackResourceActionCapabilityOut(BaseModel):
    kind: Literal["Playback"] = "Playback"
    availability: ServerActionAvailabilityOut
    player_descriptor: PlayerDescriptor

    model_config = _OUT_CONFIG


class ConsumptionResourceActionCapabilityOut(BaseModel):
    kind: Literal["Consumption"] = "Consumption"
    availability: ServerActionAvailabilityOut
    state: Literal["Unread", "InProgress", "Finished"]

    model_config = _OUT_CONFIG


class EpisodeConsumptionResourceActionCapabilityOut(BaseModel):
    kind: Literal["EpisodeConsumption"] = "EpisodeConsumption"
    availability: ServerActionAvailabilityOut
    state: Literal["Unplayed", "Played"]

    model_config = _OUT_CONFIG


class PodcastSubscriptionResourceActionCapabilityOut(BaseModel):
    kind: Literal["PodcastSubscription"] = "PodcastSubscription"
    availability: ServerActionAvailabilityOut
    state: Literal["Subscribed", "Unsubscribed"]

    model_config = _OUT_CONFIG


class TranscriptResourceActionCapabilityOut(BaseModel):
    kind: Literal["Transcript"] = "Transcript"
    availability: ServerActionAvailabilityOut
    state: Literal[
        "NotRequested",
        "Queued",
        "Running",
        "Ready",
        "Partial",
        "Unavailable",
        "FailedProvider",
    ]
    coverage: Literal["None", "Partial", "Full"]

    model_config = _OUT_CONFIG


class LecternMembershipAbsentOut(BaseModel):
    kind: Literal["LecternMembership"] = "LecternMembership"
    availability: ServerActionAvailabilityOut
    state: Literal["Absent"] = "Absent"

    model_config = _OUT_CONFIG


class LecternMembershipPresentOut(BaseModel):
    kind: Literal["LecternMembership"] = "LecternMembership"
    availability: ServerActionAvailabilityOut
    state: Literal["Present"] = "Present"
    lectern_item_id: UUID

    model_config = _OUT_CONFIG


type LecternMembershipResourceActionCapabilityOut = Annotated[
    LecternMembershipAbsentOut | LecternMembershipPresentOut, Field(discriminator="state")
]


class HighlightNoteAbsentOut(BaseModel):
    kind: Literal["HighlightNote"] = "HighlightNote"
    availability: ServerActionAvailabilityOut
    state: Literal["Absent"] = "Absent"

    model_config = _OUT_CONFIG


class HighlightNotePresentOut(BaseModel):
    kind: Literal["HighlightNote"] = "HighlightNote"
    availability: ServerActionAvailabilityOut
    state: Literal["Present"] = "Present"
    note_block_id: UUID

    model_config = _OUT_CONFIG


type HighlightNoteResourceActionCapabilityOut = Annotated[
    HighlightNoteAbsentOut | HighlightNotePresentOut, Field(discriminator="state")
]

ResourceActionCapabilityOut = Annotated[
    SimpleResourceActionCapabilityOut
    | RetryMetadataResourceActionCapabilityOut
    | RecoveryResourceActionCapabilityOut
    | OfflineReadingResourceActionCapabilityOut
    | OpenSourceResourceActionCapabilityOut
    | PlaybackResourceActionCapabilityOut
    | ConsumptionResourceActionCapabilityOut
    | EpisodeConsumptionResourceActionCapabilityOut
    | PodcastSubscriptionResourceActionCapabilityOut
    | TranscriptResourceActionCapabilityOut
    | LecternMembershipResourceActionCapabilityOut
    | HighlightNoteResourceActionCapabilityOut,
    Field(discriminator="kind"),
]


class ResourceActionSnapshotOut(BaseModel):
    ref: str
    activation: ResourceActivationOut
    missing: bool
    capabilities: list[ResourceActionCapabilityOut]

    model_config = _OUT_CONFIG

    @model_validator(mode="after")
    def _validate_snapshot(self) -> ResourceActionSnapshotOut:
        if self.ref != self.activation.resource_ref:
            raise ValueError("snapshot ref must equal activation resource ref")
        if self.missing and self.capabilities:
            raise ValueError("missing snapshot must have no capabilities")
        if self.missing and self.activation.kind != "none":
            raise ValueError("missing snapshot must have no activation")
        return self


class ResourceActionSnapshotResolveResponse(BaseModel):
    snapshots: list[ResourceActionSnapshotOut]

    model_config = _OUT_CONFIG
