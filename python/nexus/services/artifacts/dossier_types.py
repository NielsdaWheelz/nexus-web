"""Closed owned values shared by the dossier engine, bindings, and routes."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.errors import ApiError, ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.schemas.presence import Presence


@dataclass(frozen=True, slots=True)
class AudienceUser:
    """The requesting user is the audience (every subject except Library)."""

    user_id: UUID

    @property
    def scheme(self) -> Literal["user"]:
        return "user"

    @property
    def audience_id(self) -> UUID:
        return self.user_id


@dataclass(frozen=True, slots=True)
class AudienceLibrary:
    """A whole library is the audience; every member reads the one head."""

    library_id: UUID

    @property
    def scheme(self) -> Literal["library"]:
        return "library"

    @property
    def audience_id(self) -> UUID:
        return self.library_id


AudienceScope = AudienceUser | AudienceLibrary


class DossierBuildFailureCode(StrEnum):
    """The only codes that become an ``artifact_build_failures`` row."""

    NoSourceMaterial = "NoSourceMaterial"
    InputsChanged = "InputsChanged"
    DependencyProjectionFailed = "DependencyProjectionFailed"
    ContextTooLarge = "ContextTooLarge"
    Auth = "Auth"
    Quota = "Quota"
    Timeout = "Timeout"
    OutputLimit = "OutputLimit"
    InvalidOutput = "InvalidOutput"
    PolicyViolation = "PolicyViolation"
    RuntimeUnavailable = "RuntimeUnavailable"
    CapacityUnavailable = "CapacityUnavailable"
    DocumentValidationFailed = "DocumentValidationFailed"
    CitationValidationFailed = "CitationValidationFailed"


class ArtifactBuildEventType(StrEnum):
    """``artifact_build_events.event_type``; closed by the storage CHECK."""

    Started = "Started"
    Progress = "Progress"
    Succeeded = "Succeeded"
    Failed = "Failed"
    Cancelled = "Cancelled"


class _StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class StartedEventPayload(_StrictModel):
    build_handle: str
    artifact_ref: str


class ProgressEventPayload(_StrictModel):
    phase: str
    message: str


class SucceededEventPayload(_StrictModel):
    artifact_revision_ref: str


class FailedEventPayload(_StrictModel):
    failure_code: DossierBuildFailureCode
    detail: Presence[str]


class CancelledEventPayload(_StrictModel):
    actor: Presence[UUID]
    at: datetime


@dataclass(frozen=True, slots=True)
class BuildTicket:
    """One build command's head + attempt. ``created`` is False on replay."""

    artifact_id: UUID
    build_id: UUID
    handle: str
    created: bool


class DossierGenerationInProgress(ConflictError):
    def __init__(self, message: str = "A dossier build is already in progress") -> None:
        super().__init__(ApiErrorCode.E_DOSSIER_GENERATION_IN_PROGRESS, message)


class DossierIdeaUnresolved(ApiError):
    def __init__(self, message: str = "The selected idea could not be resolved") -> None:
        super().__init__(ApiErrorCode.E_DOSSIER_IDEA_UNRESOLVED, message)


class WebResearchNotConfigured(ApiError):
    def __init__(self, message: str = "Dossier Web research is not configured") -> None:
        super().__init__(ApiErrorCode.E_DOSSIER_WEB_RESEARCH_NOT_CONFIGURED, message)


class BuildNotActive(ConflictError):
    def __init__(self, message: str = "This dossier build is no longer active") -> None:
        super().__init__(ApiErrorCode.E_DOSSIER_BUILD_NOT_ACTIVE, message)


class RevisionNotFound(NotFoundError):
    def __init__(self, message: str = "Dossier revision not found") -> None:
        super().__init__(ApiErrorCode.E_DOSSIER_REVISION_NOT_FOUND, message)


class InvalidSubjectLocator(InvalidRequestError):
    """The route subject scheme/handle is not a locator-addressable subject."""

    def __init__(self, message: str = "Invalid dossier subject") -> None:
        super().__init__(ApiErrorCode.E_DOSSIER_INVALID_SUBJECT, message)


class InvalidInstruction(InvalidRequestError):
    def __init__(self, message: str = "Invalid dossier instruction") -> None:
        super().__init__(ApiErrorCode.E_DOSSIER_INVALID_INSTRUCTION, message)
