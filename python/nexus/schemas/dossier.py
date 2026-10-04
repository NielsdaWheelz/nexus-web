"""Dossier wire models and the closed failure-code set.

A head is read whole: its subject, its one revision, its active build and its last
failed or cancelled build. Absence is ``Presence``, never null.
"""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.citation import CitationOut
from nexus.schemas.presence import Presence
from nexus.schemas.resource_items import ResourceActivationOut
from nexus.services.durable_step_journal import DurableExecutionPhase


class DossierFailureCode(StrEnum):
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


# What a coverage count counts: media claims, aggregate members, or offered sources.
CoverageUnit = Literal["claim", "media", "episode", "work", "source"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DossierGenerateRequest(_Model):
    instruction: Presence[str]


class LearnDossierRequest(_Model):
    highlight_ref: str = Field(min_length=1)


class DossierBuildCreatedOut(_Model):
    artifact_ref: str
    build_handle: str
    created: bool


class LearnDossierOpenedOut(_Model):
    kind: Literal["Opened"] = "Opened"
    artifact_ref: str


class LearnDossierBuildAcceptedOut(_Model):
    kind: Literal["BuildAccepted"] = "BuildAccepted"
    artifact_ref: str
    build_handle: str


LearnDossierOut = Annotated[
    LearnDossierOpenedOut | LearnDossierBuildAcceptedOut, Field(discriminator="kind")
]


class DossierBuildOut(_Model):
    """One build; also the SSE snapshot. ``phase`` is Present only while Active."""

    handle: str
    status: Literal["Active", "Succeeded", "Failed", "Cancelled"]
    phase: Presence[DurableExecutionPhase]
    failure_code: Presence[DossierFailureCode]
    instruction: Presence[str]


class DossierCoverageOut(_Model):
    unit: CoverageUnit
    included: int
    omitted: int


class DossierRevisionOut(_Model):
    revision_ref: str
    content_html: str
    citations: list[CitationOut]
    coverage: DossierCoverageOut
    stale: bool
    instruction: Presence[str]
    by_viewer: bool
    model: Presence[str]
    total_tokens: Presence[int]
    generated_at: datetime


class MediaAbstractOut(_Model):
    status: Literal["Building", "Ready", "Stale", "Failed"]
    summary_md: Presence[str]


class DossierHeadOut(_Model):
    """``artifact_ref`` Absent: never generated (a head read never inserts a head)."""

    artifact_ref: Presence[str]
    title: str
    subject_activation: Presence[ResourceActivationOut]
    revision: Presence[DossierRevisionOut]
    active_build: Presence[DossierBuildOut]
    last_failure: Presence[DossierBuildOut]
    media_abstract: Presence[MediaAbstractOut]
