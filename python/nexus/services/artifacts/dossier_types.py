"""Universal Dossier value types (CP2-TYPES).

The closed vocabulary the generic dossier engine, subject policies, and bindings
share: the server-derived :class:`AudienceScope`, the decoded
:class:`DossierSubjectLocator`, the closed failure/phase/event enums, the strict
persisted build-event payloads, the :class:`BuildTicket` create outcome, and the
typed API errors. No database, no engine orchestration — pure owned values
(``docs/rules/boundaries.md`` internal representation).

Identity keys per CONTRACTS.md A2/A5/A7/A8/A19: a dossier head is unique by
``(subject_scheme, subject_id, audience_scheme, audience_id)``; the audience is
always derived server-side and is one of exactly two schemes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.presence import Presence
from nexus.services.contributor_taxonomy import ContributorHandle
from nexus.services.resource_graph.refs import ResourceRef

# ---------------------------------------------------------------------------
# Audience scope (A2) — closed, server-derived, never client-supplied.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AudienceUser:
    """The requesting/owning user is the audience (Media, Podcast, Contributor,
    Page, Note, and owner-User Conversation dossiers)."""

    user_id: UUID

    @property
    def scheme(self) -> Literal["user"]:
        return "user"

    @property
    def audience_id(self) -> UUID:
        return self.user_id


@dataclass(frozen=True, slots=True)
class AudienceLibrary:
    """A whole library is the audience (Library dossiers)."""

    library_id: UUID

    @property
    def scheme(self) -> Literal["library"]:
        return "library"

    @property
    def audience_id(self) -> UUID:
        return self.library_id


# The closed audience union. `.scheme` / `.audience_id` are the two persisted
# head columns; keep the rich variant while it flows through owned logic.
AudienceScope = AudienceUser | AudienceLibrary


# ---------------------------------------------------------------------------
# Subject locator (A2) — decoded once from the route, never re-parsed downstream.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SubjectResource:
    """A resource-schemed subject (Media, Conversation, Library, Podcast, Page,
    NoteBlock). Cannot carry a contributor."""

    ref: ResourceRef


@dataclass(frozen=True, slots=True)
class SubjectContributor:
    """The Author subject, resolved from its outward handle server-side; the
    private contributor id is never exposed through the locator."""

    handle: ContributorHandle


DossierSubjectLocator = SubjectResource | SubjectContributor


# ---------------------------------------------------------------------------
# Closed code enums (A7/A8) — StrEnum so `str(member)` is the bare wire value
# stored in and compared against the text columns (naming.md: PascalCase).
# ---------------------------------------------------------------------------


class DossierBuildFailureCode(StrEnum):
    """The only codes that become an ``artifact_build_failures`` row. Everything
    else (unexpected exceptions, invariant violations, retry exhaustion,
    unreconciled Uncertain) is a defect — there is no generic Internal code."""

    NoSourceMaterial = "NoSourceMaterial"
    InputsChanged = "InputsChanged"
    DependencyProjectionFailed = "DependencyProjectionFailed"
    EntitlementDenied = "EntitlementDenied"
    BudgetExceeded = "BudgetExceeded"
    ContextTooLarge = "ContextTooLarge"
    ProviderRefused = "ProviderRefused"
    ProviderIncomplete = "ProviderIncomplete"
    SchemaRepairExhausted = "SchemaRepairExhausted"
    CitationValidationFailed = "CitationValidationFailed"
    MigratedFailure = "MigratedFailure"
    MigratedIncomplete = "MigratedIncomplete"


class MigratedIncompleteReason(StrEnum):
    """Support provenance for a ``MigratedIncomplete`` failure (A7/A16) — not a
    second failure-code namespace."""

    LegacyBuilding = "LegacyBuilding"
    LegacyZeroCitation = "LegacyZeroCitation"


class DossierBuildExecutionPhase(StrEnum):
    """Advisory-only liveness derived from queue/coordination state (A8). Emitted
    unsequenced as an ``ExecutionAdvisory``; NEVER a persisted build event, never
    advances the cursor, cannot legalize a second Generate."""

    Queued = "Queued"
    Running = "Running"
    Recovering = "Recovering"
    Suspended = "Suspended"


class ArtifactBuildEventType(StrEnum):
    """The persisted, sequenced build-event log types (A5). Stored in
    ``artifact_build_events.event_type`` (append-only, storage-enum CHECK)."""

    Started = "Started"
    Progress = "Progress"
    Delta = "Delta"
    Succeeded = "Succeeded"
    Failed = "Failed"
    Cancelled = "Cancelled"


# ---------------------------------------------------------------------------
# Persisted build-event payloads (A5 §678) — strict, extra='forbid'.
# One payload model per ArtifactBuildEventType; discriminated wire subject.
# ---------------------------------------------------------------------------


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ResourceSubjectWire(_StrictModel):
    kind: Literal["Resource"] = "Resource"
    ref: str  # ResourceRef.uri (`<scheme>:<uuid>`)


class ContributorSubjectWire(_StrictModel):
    kind: Literal["Contributor"] = "Contributor"
    handle: str


SubjectLocatorWire = Annotated[
    ResourceSubjectWire | ContributorSubjectWire, Field(discriminator="kind")
]


class StartedEventPayload(_StrictModel):
    """Started{build handle, artifact ref, subject locator}."""

    build_handle: str
    artifact_ref: str
    subject_locator: SubjectLocatorWire


class ProgressEventPayload(_StrictModel):
    """Progress{phase, user message}."""

    phase: str
    message: str


class DeltaEventPayload(_StrictModel):
    """Delta{appended text}."""

    appended_text: str


class SucceededEventPayload(_StrictModel):
    """Succeeded{artifact revision ref}. Identifies the revision it created."""

    artifact_revision_ref: str


class FailedEventPayload(_StrictModel):
    """Failed{DossierBuildFailureCode, detail/support Presence}.

    ``support`` mirrors the ``artifact_build_failures.support`` blob; its concrete
    shape is code-owned (migration supports live in ``manifests.py``), so it stays
    an opaque owned-absence JSON object here to avoid a layering cycle."""

    failure_code: DossierBuildFailureCode
    detail: Presence[str]
    support: Presence[dict[str, Any]]


class CancelledEventPayload(_StrictModel):
    """Cancelled{actor, time}."""

    actor: Presence[UUID]
    at: datetime


# ---------------------------------------------------------------------------
# Create outcome (A19) — the value `engine.create_build` returns.
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BuildTicket:
    """The outcome of ``create_build``: the head + the (existing or new) attempt.

    ``created`` is True only when this call inserted the build; a reused
    idempotency key returns the original build with ``created=False`` (A6 rule 1).
    ``handle`` is the sealed, non-authorizing outward :mod:`.handles` value."""

    artifact_id: UUID
    build_id: UUID
    handle: str
    created: bool


# ---------------------------------------------------------------------------
# Typed API errors (A9/A19). Subclasses of the repo's ApiError family so the
# route boundary maps them to the correct status; not-found/unauthorized reuse
# the existing masked NotFoundError. (Dedicated ApiErrorCode values are deferred
# to the engine/routes slice — errors.py is out of scope for CP2-TYPES.)
# ---------------------------------------------------------------------------


class DossierGenerationInProgress(ConflictError):
    """A different idempotency key arrived while a build is active (A6 rule 2)."""

    def __init__(self, message: str = "A dossier build is already in progress") -> None:
        super().__init__(ApiErrorCode.E_INVITE_NOT_PENDING, message)


class BuildNotActive(ConflictError):
    """Public cancel of an already-succeeded/failed/cancelled build (A9)."""

    def __init__(self, message: str = "This dossier build is no longer active") -> None:
        super().__init__(ApiErrorCode.E_INVITE_NOT_PENDING, message)


class RevisionNotFound(NotFoundError):
    """make-current / read targeted a revision that does not exist (masked)."""

    def __init__(self, message: str = "Dossier revision not found") -> None:
        super().__init__(ApiErrorCode.E_NOT_FOUND, message)


class RevisionNotOwnedByHead(NotFoundError):
    """The revision exists but is not under the caller's head — masked as 404."""

    def __init__(self, message: str = "Dossier revision not found") -> None:
        super().__init__(ApiErrorCode.E_NOT_FOUND, message)


class InvalidSubjectLocator(InvalidRequestError):
    """The route subject scheme/handle is not one of the seven eligible subjects."""

    def __init__(self, message: str = "Invalid dossier subject") -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, message)


class InvalidInstruction(InvalidRequestError):
    """The supplied build instruction is not acceptable."""

    def __init__(self, message: str = "Invalid dossier instruction") -> None:
        super().__init__(ApiErrorCode.E_INVALID_REQUEST, message)
