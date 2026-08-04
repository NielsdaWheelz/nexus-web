"""Wire schema for the canonical resource-action snapshot endpoint
(``POST /resource-items/action-snapshots/resolve``).

This is the single source of per-resource action FACTS. It carries only facts:
which capabilities exist for a ref and whether the server blocks each one. It
never carries labels, icons, order, separators, confirmation copy, mutation
URLs, executors, busy state, or client-only blocked reasons — those are owned by
the frontend planner/runtime. See the design contract's "Backend wire contract".

Serialization is camelCase via ``by_alias=True`` (repo convention, mirroring
``ResourceActivationOut``). Every model is a closed discriminated union on
``kind`` so an unknown or mis-shaped variant is a boundary defect, not silent
coercion.
"""

from __future__ import annotations

import hashlib
from typing import Annotated, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref
from nexus.services.resource_mutation_replay import canonical_json_bytes

_MAX_REFS = 100


class ResourceActionSnapshotResolveRequest(BaseModel):
    """A batch of 1..100 unique, parseable resource refs to resolve.

    Uniqueness and per-ref parseability need a ``model_validator`` regardless, so
    the count bounds live there too, giving one boundary that raises specific
    ``E_INVALID_REQUEST`` messages (matching the ``_parse_ref`` boundary in
    ``api/routes/resource_items.py``).
    """

    refs: list[str]

    model_config = ConfigDict(extra="forbid")

    @model_validator(mode="after")
    def _validate_refs(self) -> ResourceActionSnapshotResolveRequest:
        if not self.refs:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "refs must contain between 1 and 100 entries.",
            )
        if len(self.refs) > _MAX_REFS:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                f"refs must contain at most {_MAX_REFS} entries.",
            )
        if len(set(self.refs)) != len(self.refs):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "refs must be unique.",
            )
        for raw in self.refs:
            if isinstance(parse_resource_ref(raw), ResourceRefParseFailure):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
                )
        return self


class ServerActionAvailabilityAvailableOut(BaseModel):
    kind: Literal["Available"] = "Available"

    model_config = ConfigDict(populate_by_name=True)


class ServerActionAvailabilityBlockedOut(BaseModel):
    kind: Literal["Blocked"] = "Blocked"
    reason: Literal["Locked", "Processing", "TemporarilyUnavailable"]

    model_config = ConfigDict(populate_by_name=True)


ServerActionAvailabilityOut = Annotated[
    ServerActionAvailabilityAvailableOut | ServerActionAvailabilityBlockedOut,
    Field(discriminator="kind"),
]

# Capability kinds whose only fact is availability. Grouped into one model
# because they share an identical wire shape (``{kind, availability}``); the
# frontend union mirrors this.
_SimpleCapabilityKind = Literal[
    "Open",
    "Share",
    "Chat",
    "RetryProcessing",
    "RefreshSource",
    "RetryMetadata",
    "EditAuthors",
    "ResetProgress",
    "LibrarySettings",
    "DeleteLibrary",
    "PodcastSettings",
    "RefreshPodcast",
    "DeleteConversation",
    "RemoveMedia",
    "LibraryPlacement",
    "OfflineAudio",
]


class SimpleResourceActionCapabilityOut(BaseModel):
    kind: _SimpleCapabilityKind
    availability: ServerActionAvailabilityOut

    model_config = ConfigDict(populate_by_name=True)


class OpenSourceResourceActionCapabilityOut(BaseModel):
    kind: Literal["OpenSource"] = "OpenSource"
    availability: ServerActionAvailabilityOut
    href: str

    model_config = ConfigDict(populate_by_name=True)


class ConsumptionResourceActionCapabilityOut(BaseModel):
    kind: Literal["Consumption"] = "Consumption"
    availability: ServerActionAvailabilityOut
    state: Literal["Unread", "InProgress", "Finished"]

    model_config = ConfigDict(populate_by_name=True)


class EpisodeConsumptionResourceActionCapabilityOut(BaseModel):
    kind: Literal["EpisodeConsumption"] = "EpisodeConsumption"
    availability: ServerActionAvailabilityOut
    state: Literal["Unplayed", "Played"]

    model_config = ConfigDict(populate_by_name=True)


class PodcastSubscriptionResourceActionCapabilityOut(BaseModel):
    kind: Literal["PodcastSubscription"] = "PodcastSubscription"
    availability: ServerActionAvailabilityOut
    state: Literal["Subscribed", "Unsubscribed"]

    model_config = ConfigDict(populate_by_name=True)


class LecternMembershipResourceActionCapabilityOut(BaseModel):
    kind: Literal["LecternMembership"] = "LecternMembership"
    availability: ServerActionAvailabilityOut
    state: Literal["Absent", "Present"]
    lectern_item_id: str | None = Field(
        default=None,
        validation_alias=AliasChoices("lectern_item_id", "lecternItemId"),
        serialization_alias="lecternItemId",
    )

    model_config = ConfigDict(populate_by_name=True)


ResourceActionCapabilityOut = Annotated[
    SimpleResourceActionCapabilityOut
    | OpenSourceResourceActionCapabilityOut
    | ConsumptionResourceActionCapabilityOut
    | EpisodeConsumptionResourceActionCapabilityOut
    | PodcastSubscriptionResourceActionCapabilityOut
    | LecternMembershipResourceActionCapabilityOut,
    Field(discriminator="kind"),
]


class ResourceActionSnapshotOut(BaseModel):
    ref: str
    activation: ResourceActivationOut
    missing: bool
    facts_revision: str = Field(
        default="",
        validation_alias=AliasChoices("facts_revision", "factsRevision"),
        serialization_alias="factsRevision",
    )
    capabilities: list[ResourceActionCapabilityOut] = Field(default_factory=list)

    model_config = ConfigDict(populate_by_name=True)


class ResourceActionSnapshotResolveResponse(BaseModel):
    snapshots: list[ResourceActionSnapshotOut]

    model_config = ConfigDict(populate_by_name=True)


def compute_facts_revision(snapshot_out: ResourceActionSnapshotOut) -> str:
    """Deterministic sha256hex of a snapshot's facts.

    Hashes the by-alias canonical JSON of ``{ref, activation, missing,
    capabilities}`` — ``factsRevision`` itself is excluded so the value is a
    faithful content hash, not self-referential. Not persisted; recomputed on
    every resolve so a stale client revision is a simple string mismatch.
    """
    payload = snapshot_out.model_dump(mode="json", by_alias=True, exclude={"facts_revision"})
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()
