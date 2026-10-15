"""Dossier wire models and the closed failure-code set.

A head is read whole: its subject, its one revision, its active build and its last
failed or cancelled build. Absence is null.
"""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from nexus.jobs.queue import DurableExecutionPhase
from nexus.schemas.citation import CitationOut
from nexus.schemas.resource_items import ResourceActivationOut


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
    DocumentValidationFailed = "DocumentValidationFailed"
    CitationValidationFailed = "CitationValidationFailed"


# What a coverage count counts: media claims, aggregate members, or offered sources.
CoverageUnit = Literal["claim", "media", "episode", "work", "source"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DossierGenerateRequest(_Model):
    instruction: str | None


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
    """One build; also the SSE snapshot. ``phase`` is set only while Active."""

    handle: str
    status: Literal["Active", "Succeeded", "Failed", "Cancelled"]
    phase: DurableExecutionPhase | None
    failure_code: DossierFailureCode | None
    instruction: str | None


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
    instruction: str | None
    by_viewer: bool
    model: str | None
    total_tokens: int | None
    generated_at: datetime


class MediaAbstractOut(_Model):
    status: Literal["Building", "Ready", "Stale", "Failed"]
    summary_md: str | None


class DossierHeadOut(_Model):
    """``artifact_ref`` null: never generated (a head read never inserts a head)."""

    artifact_ref: str | None
    title: str
    subject_activation: ResourceActivationOut | None
    revision: DossierRevisionOut | None
    active_build: DossierBuildOut | None
    last_failure: DossierBuildOut | None
    media_abstract: MediaAbstractOut | None
