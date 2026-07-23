"""Schemas for the universal Dossier engine (stable head + immutable revisions).

Recomposed for CONTRACTS.md A19 (resource-inspector-and-universal-dossiers hard
cutover): the legacy ``ArtifactBuildOut`` revision-status wrapper and the
library-dossier / conversation-distillate REST facades are gone. Every eligible
subject (Media, Conversation, Library, Podcast, Contributor, Page, Note) now
shares this one generic read/build/event contract; per-kind behavior lives in
the binding layer (``services/artifacts/bindings/``), never in these shapes.

Owned absence uses the repository-wide ``Presence[T]`` encoding
(``nexus.schemas.presence`` / ``docs/rules/boundaries.md``). Closed codes and
the persisted build-event payloads are reused directly from
``services.artifacts.dossier_types`` rather than re-declared here.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.citation import CitationOut
from nexus.schemas.presence import Presence
from nexus.services.artifacts.dossier_types import (
    ArtifactBuildEventType,
    CancelledEventPayload,
    DeltaEventPayload,
    DossierBuildExecutionPhase,
    FailedEventPayload,
    ProgressEventPayload,
    StartedEventPayload,
    SucceededEventPayload,
)
from nexus.services.artifacts.manifests import InputManifestV1


class ArtifactSchemaModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# Head-read-only freshness label (A9/A15). Not a `dossier_types` enum: this is
# a presentation summary of the binding's `manifests_equal(stored, live)`
# comparison (A18), not a persisted or replayed value.
DossierFreshness = Literal["Current", "Stale"]

# Shared bound for user-supplied build instructions (A9's `POST .../builds`
# body and, hoisted for display, the build/revision read models below).
_InstructionText = Annotated[str, Field(max_length=4000)]


class DossierGenerateRequest(ArtifactSchemaModel):
    """``POST /artifacts/dossiers/{subject_scheme}/{subject_handle}/builds`` body
    (A9/A19). Absent = no custom instruction supplied for this build."""

    instruction: Presence[_InstructionText]


class DossierBuildExecution(ArtifactSchemaModel):
    """The advisory-only queue/coordination liveness for an active build
    (A8/A9). Wraps `DossierBuildExecutionPhase` so the wire shape matches A15's
    nested ``DossierBuild{execution: Queued|Running|Recovering|Suspended}`` —
    never a persisted event, never a failure, cannot legalize a second Generate.
    """

    phase: DossierBuildExecutionPhase


class DossierBuildSummary(ArtifactSchemaModel):
    """One build attempt's identity — the replacement for the legacy
    ``ArtifactBuildOut`` revision-status wrapper (A5 §633).

    Serves both `DossierHeadOut.active_build` (only `execution` Present) and
    `.latest_unsuccessful_build` (exactly one of `failure`/`cancellation`
    Present, `execution` Absent). The terminal facets reuse the exact
    `dossier_types` build-event payloads, so the head snapshot and the live SSE
    stream agree on one shape for the same fact (A15: `Failed|Cancelled`).
    ``requester_user_id`` is the nullable attribution FK (User teardown nulls
    it — UI "Deleted user", A5)."""

    handle: str
    requester_user_id: Presence[UUID]
    instruction: Presence[_InstructionText]
    created_at: datetime
    execution: Presence[DossierBuildExecution]
    failure: Presence[FailedEventPayload]
    cancellation: Presence[CancelledEventPayload]


class DossierRevisionOut(ArtifactSchemaModel):
    """One immutable, citation-bearing revision (A5/A9/A10).

    Reused both standalone (``GET /artifact-revisions/{artifact_revision_ref}``)
    and nested as `DossierHeadOut.current_revision` — the current revision's
    body is the one historical body the head read is allowed to carry (A9: "NO
    historical revision body"). ``input_manifest`` is the typed, binding-owned
    coverage source (A18/A21): coverage is derived from it, not duplicated as a
    separate generic count. ``instruction`` is hoisted from the originating
    build for display."""

    artifact_id: UUID
    artifact_ref: str
    revision_id: UUID
    revision_ref: str
    is_current: bool
    content_md: str
    citations: list[CitationOut]
    input_manifest: InputManifestV1
    instruction: Presence[_InstructionText]
    created_at: datetime
    promoted_at: Presence[datetime]


class DossierRevisionSummaryOut(ArtifactSchemaModel):
    """One ``GET /artifacts/{artifact_ref}/revisions`` list item.

    No ``content_md`` (the "no historical body" boundary — fetch the single
    revision for body text) and no ``artifact_id``/``artifact_ref`` (the route
    is already scoped to one artifact). ``input_manifest`` still rides along so
    the history list can render binding-specific coverage per revision without
    a second round trip; ``citation_count`` stands in for the omitted full
    `citations` list."""

    revision_id: UUID
    revision_ref: str
    is_current: bool
    citation_count: int = Field(ge=0)
    input_manifest: InputManifestV1
    instruction: Presence[_InstructionText]
    created_at: datetime
    promoted_at: Presence[datetime]


class MediaAbstractBuildingOut(ArtifactSchemaModel):
    kind: Literal["Building"] = "Building"


class MediaAbstractReadyOut(ArtifactSchemaModel):
    kind: Literal["Ready"] = "Ready"
    summary_md: str


class MediaAbstractStaleOut(ArtifactSchemaModel):
    """MediaIntelligence has a summary, but not for the media's current content
    fingerprint (reingestion happened since it was generated); still shown,
    marked stale (A11/A18)."""

    kind: Literal["Stale"] = "Stale"
    summary_md: str


class MediaAbstractFailedOut(ArtifactSchemaModel):
    kind: Literal["Failed"] = "Failed"


class MediaAbstractNotAvailableOut(ArtifactSchemaModel):
    """No MediaIntelligence attempt exists yet for this media (e.g. not yet
    ready for reading, or no audience-resolvable citation candidate)."""

    kind: Literal["NotAvailable"] = "NotAvailable"


# Media Abstract (A11 §252): compact, read-only, current-only, no Generate
# control, no history — the Media Dossier's subordinate MediaIntelligence
# display, never the Dossier's own build state.
MediaAbstractOut = Annotated[
    MediaAbstractBuildingOut
    | MediaAbstractReadyOut
    | MediaAbstractStaleOut
    | MediaAbstractFailedOut
    | MediaAbstractNotAvailableOut,
    Field(discriminator="kind"),
]


class DossierHeadOut(ArtifactSchemaModel):
    """``GET /artifacts/dossiers/{subject_scheme}/{subject_handle}`` read model
    (A9) — every field the FE controller union's `Ready` case needs (A15)
    except ``history``, which comes from the separate revisions-list endpoint.

    Absent ``artifact_id``/``artifact_ref`` (and every other field) is the
    legitimate "never generated" state: `read_head` never inserts a head row —
    only `create_build` does (A6, "First-head create" is scoped to build
    creation, not read). ``media_abstract`` is Present only for the Media
    binding (A9/A11); every other subject always carries it Absent."""

    artifact_id: Presence[UUID]
    artifact_ref: Presence[str]
    current_revision: Presence[DossierRevisionOut]
    freshness: Presence[DossierFreshness]
    active_build: Presence[DossierBuildSummary]
    latest_unsuccessful_build: Presence[DossierBuildSummary]
    revision_count: int = Field(ge=0)
    media_abstract: Presence[MediaAbstractOut]


_BUILD_EVENT_PAYLOAD_TYPES: dict[ArtifactBuildEventType, type[BaseModel]] = {
    ArtifactBuildEventType.Started: StartedEventPayload,
    ArtifactBuildEventType.Progress: ProgressEventPayload,
    ArtifactBuildEventType.Delta: DeltaEventPayload,
    ArtifactBuildEventType.Succeeded: SucceededEventPayload,
    ArtifactBuildEventType.Failed: FailedEventPayload,
    ArtifactBuildEventType.Cancelled: CancelledEventPayload,
}

# The closed set of persisted build-event payloads (A5 §678), reused verbatim
# from `dossier_types` rather than re-declared.
BuildEventPayload = (
    StartedEventPayload
    | ProgressEventPayload
    | DeltaEventPayload
    | SucceededEventPayload
    | FailedEventPayload
    | CancelledEventPayload
)


class ArtifactBuildEventOut(ArtifactSchemaModel):
    """One replayable ``artifact_build_events`` row (A5 §678), strict end to
    end: ``payload`` is always the exact `dossier_types` payload model for
    ``event_type``, never a loose ``dict`` — replaces `ArtifactRevisionEventOut`
    and folds the old `ArtifactDoneEventPayload` into the typed
    `SucceededEventPayload`/`FailedEventPayload`.

    A raw-dict ``payload`` (e.g. read back from the JSONB column alongside its
    sibling ``event_type`` column) is coerced into the matching payload model
    before validation; an already-typed payload instance (the construction path
    when the engine appends a live event) passes straight through."""

    seq: int
    event_type: ArtifactBuildEventType
    payload: BuildEventPayload

    @model_validator(mode="before")
    @classmethod
    def _coerce_payload(cls, data: Any) -> Any:
        if (
            isinstance(data, dict)
            and "event_type" in data
            and isinstance(data.get("payload"), dict)
        ):
            payload_cls = _BUILD_EVENT_PAYLOAD_TYPES[ArtifactBuildEventType(data["event_type"])]
            data = {**data, "payload": payload_cls.model_validate(data["payload"])}
        return data
