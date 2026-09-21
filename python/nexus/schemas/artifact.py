"""Wire schemas for the universal dossier: head, builds, revisions, events.

The seven public Resource subjects and the internal user-owned Idea subject
share one read/build/event contract. Every key set here is decoded key-exact by
``apps/web/src/lib/dossiers``; owned absence is the repository ``Presence[T]``
encoding, never ``null``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.citation import CitationOut
from nexus.schemas.llm import CapacityPaused, SelectionPresentation
from nexus.schemas.presence import Presence
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.artifacts.dossier_types import (
    ArtifactBuildEventType,
    CancelledEventPayload,
    FailedEventPayload,
    ProgressEventPayload,
    StartedEventPayload,
    SucceededEventPayload,
)
from nexus.services.artifacts.manifests import InputManifestV1, MediaDisposition
from nexus.services.durable_step_journal import DurableExecutionPhase
from nexus.services.generation_spec import GenerationSelectionSpec


class ArtifactSchemaModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


# The head's freshness label: a presentation summary of the binding's manifest
# comparison, never a persisted or replayed value.
DossierFreshness = Literal["Current", "Stale"]

_InstructionText = Annotated[str, Field(max_length=4000)]


class DossierGenerateRequest(ArtifactSchemaModel):
    instruction: Presence[_InstructionText]


class DossierBuildCreatedOut(ArtifactSchemaModel):
    artifact_ref: str
    build_handle: str
    created: bool


class LearnDossierRequest(ArtifactSchemaModel):
    highlight_ref: str = Field(min_length=1)


class LearnDossierOpenedOut(ArtifactSchemaModel):
    kind: Literal["Opened"] = "Opened"
    artifact_ref: str


class LearnDossierBuildAcceptedOut(ArtifactSchemaModel):
    kind: Literal["BuildAccepted"] = "BuildAccepted"
    artifact_ref: str
    build_handle: str


LearnDossierOut = Annotated[
    LearnDossierOpenedOut | LearnDossierBuildAcceptedOut,
    Field(discriminator="kind"),
]


class DossierBuildExecution(ArtifactSchemaModel):
    """Advisory-only queue liveness; never a persisted event, never a failure."""

    phase: DurableExecutionPhase


class DossierBuildNoModelToolsOut(ArtifactSchemaModel):
    kind: Literal["NoModelTools"] = "NoModelTools"


class DossierBuildExactModelToolsOut(ArtifactSchemaModel):
    kind: Literal["ExactModelTools"] = "ExactModelTools"
    plan_id: str = Field(min_length=1)
    plan_revision: str = Field(min_length=1)
    effect_mode: Literal["ReadOnly", "AdditiveWrites"]


DossierBuildToolPlanOut = Annotated[
    DossierBuildNoModelToolsOut | DossierBuildExactModelToolsOut,
    Field(discriminator="kind"),
]


class DossierBuildAdmittedGenerationOut(ArtifactSchemaModel):
    """Read-only facts of the build's latest admitted generation.

    The frozen selection and its dispatch-time disclosure come from the ledger,
    never from mutable policy. No control, credential, price, or current
    catalog state crosses here.
    """

    selection: GenerationSelectionSpec
    display_at_dispatch: SelectionPresentation
    tool_plan: DossierBuildToolPlanOut
    tool_positions: int = Field(ge=0)


class DossierBuildSummary(ArtifactSchemaModel):
    """One attempt's identity and its execution or terminal facts.

    Serves both ``DossierHeadOut.active_build`` (only ``execution`` Present) and
    ``.latest_unsuccessful_build`` (exactly one of ``failure``/``cancellation``).
    ``requester_user_id`` is Absent once user teardown nulls the attribution.
    """

    handle: str
    requester_user_id: Presence[UUID]
    instruction: Presence[_InstructionText]
    created_at: datetime
    execution: Presence[DossierBuildExecution]
    failure: Presence[FailedEventPayload]
    cancellation: Presence[CancelledEventPayload]
    admitted_generation: Presence[DossierBuildAdmittedGenerationOut]
    capacity_pause: Presence[CapacityPaused]


class MediaDossierCoverageOut(ArtifactSchemaModel):
    kind: Literal["media"] = "media"
    offered_claim_count: int = Field(ge=0)
    omitted_evidence_refs: list[str]


class ConversationDossierCoverageOut(ArtifactSchemaModel):
    kind: Literal["conversation"] = "conversation"
    message_refs: list[str]
    context_refs: list[str]


class CollectionDossierCoverageOut(ArtifactSchemaModel):
    kind: Literal["library", "podcast", "contributor"]
    included: list[str]
    omitted: list[tuple[str, MediaDisposition]]


class PageDossierCoverageOut(ArtifactSchemaModel):
    kind: Literal["page"] = "page"
    block_refs: list[str]
    connection_refs: list[str]


class NoteDossierCoverageOut(ArtifactSchemaModel):
    kind: Literal["note"] = "note"
    body_present: bool
    connection_refs: list[str]


class IdeaDossierCoverageOut(ArtifactSchemaModel):
    kind: Literal["idea"] = "idea"
    seed_count: int = Field(ge=0)
    nexus_source_count: int = Field(ge=0)
    web_source_count: int = Field(ge=0)
    omitted_sources: list[tuple[str, str]]


DossierCoverageOut = Annotated[
    MediaDossierCoverageOut
    | ConversationDossierCoverageOut
    | CollectionDossierCoverageOut
    | PageDossierCoverageOut
    | NoteDossierCoverageOut
    | IdeaDossierCoverageOut,
    Field(discriminator="kind"),
]


class _DossierRevisionFacts(ArtifactSchemaModel):
    """The facts both revision reads carry.

    ``input_manifest`` is the typed, binding-owned coverage source: coverage is
    derived from it rather than duplicated as a separate count. ``instruction``
    is hoisted from the originating build for display.
    """

    revision_id: UUID
    revision_ref: str
    is_current: bool
    input_manifest: InputManifestV1
    coverage: DossierCoverageOut
    instruction: Presence[_InstructionText]
    creator_user_id: Presence[UUID]
    model_provider: Presence[str]
    model_name: Presence[str]
    total_tokens: Presence[int]
    created_at: datetime
    promoted_at: Presence[datetime]


class DossierRevisionOut(_DossierRevisionFacts):
    """One immutable, citation-bearing revision, standalone or as the head's current."""

    artifact_id: UUID
    artifact_ref: str
    content_html: str
    content_text: str
    citations: list[CitationOut]


class DossierRevisionSummaryOut(_DossierRevisionFacts):
    """One history entry: no body — fetch the single revision for that."""

    citation_count: int = Field(ge=0)


class MediaAbstractBuildingOut(ArtifactSchemaModel):
    kind: Literal["Building"] = "Building"


class MediaAbstractReadyOut(ArtifactSchemaModel):
    kind: Literal["Ready"] = "Ready"
    summary_md: str


class MediaAbstractStaleOut(ArtifactSchemaModel):
    """A summary exists, but not for the media's current content fingerprint."""

    kind: Literal["Stale"] = "Stale"
    summary_md: str


class MediaAbstractFailedOut(ArtifactSchemaModel):
    kind: Literal["Failed"] = "Failed"


class MediaAbstractNotAvailableOut(ArtifactSchemaModel):
    kind: Literal["NotAvailable"] = "NotAvailable"


# The Media dossier's subordinate Media Intelligence display: compact, current
# only, no Generate control and no history of its own.
MediaAbstractOut = Annotated[
    MediaAbstractBuildingOut
    | MediaAbstractReadyOut
    | MediaAbstractStaleOut
    | MediaAbstractFailedOut
    | MediaAbstractNotAvailableOut,
    Field(discriminator="kind"),
]


class ResourceDossierIdentityOut(ArtifactSchemaModel):
    kind: Literal["Resource"] = "Resource"
    title: str
    activation: ResourceActivationOut


class IdeaDossierIdentityOut(ArtifactSchemaModel):
    kind: Literal["Idea"] = "Idea"
    title: str


DossierIdentityOut = Annotated[
    ResourceDossierIdentityOut | IdeaDossierIdentityOut,
    Field(discriminator="kind"),
]


class DossierHeadOut(ArtifactSchemaModel):
    """The dossier surface for one subject.

    Every field Absent with ``revision_count`` zero is the legitimate "never
    generated" state: the head read never inserts a head row. ``media_abstract``
    is Present only for the Media subject.
    """

    artifact_id: Presence[UUID]
    artifact_ref: Presence[str]
    identity: Presence[DossierIdentityOut]
    current_revision: Presence[DossierRevisionOut]
    freshness: Presence[DossierFreshness]
    active_build: Presence[DossierBuildSummary]
    latest_unsuccessful_build: Presence[DossierBuildSummary]
    revision_count: int = Field(ge=0)
    media_abstract: Presence[MediaAbstractOut]


BuildEventPayload = (
    StartedEventPayload
    | ProgressEventPayload
    | SucceededEventPayload
    | FailedEventPayload
    | CancelledEventPayload
)

_BUILD_EVENT_PAYLOAD_TYPES: dict[ArtifactBuildEventType, type[BaseModel]] = {
    ArtifactBuildEventType.Started: StartedEventPayload,
    ArtifactBuildEventType.Progress: ProgressEventPayload,
    ArtifactBuildEventType.Succeeded: SucceededEventPayload,
    ArtifactBuildEventType.Failed: FailedEventPayload,
    ArtifactBuildEventType.Cancelled: CancelledEventPayload,
}


class ArtifactBuildEventOut(ArtifactSchemaModel):
    """One replayable ``artifact_build_events`` row, strict end to end.

    A raw-dict ``payload`` read back from the jsonb column alongside its sibling
    ``event_type`` is coerced into the matching payload model before validation;
    an already-typed payload passes straight through.
    """

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
