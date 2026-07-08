"""Schemas for the artifact engine (stable head + immutable revisions).

The library-dossier REST facade keeps its ``Dossier*`` response shapes; the
run-stream event schemas are ``Artifact*`` (scope-generic, shared by every kind).
"""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.citation import CitationOut

ArtifactStatus = Literal["unavailable", "building", "failed", "stale", "current"]
RevisionStatus = Literal["building", "ready", "failed"]


class ArtifactSchemaModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ArtifactBuildOut(ArtifactSchemaModel):
    """The in-flight (or just-terminal) draft revision's run status."""

    revision_id: UUID
    status: RevisionStatus


class DossierGenerateRequest(ArtifactSchemaModel):
    instruction: str | None = Field(default=None, max_length=4000)


class DossierArtifactOut(ArtifactSchemaModel):
    """The GET read-model: current-revision content + computed head status."""

    artifact_id: UUID | None = None
    artifact_ref: str | None = None
    revision_id: UUID | None = None
    revision_ref: str | None = None
    status: ArtifactStatus
    content_md: str = ""
    citations: list[CitationOut] = Field(default_factory=list)
    citation_count: int = 0
    source_count: int = 0
    covered_source_count: int = 0
    omitted_source_count: int = 0
    custom_instruction: str | None = None
    model_provider: str | None = None
    model_name: str | None = None
    total_tokens: int | None = None
    build: ArtifactBuildOut | None = None
    # Set only when ``status == "stale"``: the number of sources that changed
    # (added, removed, or re-ingested) since the current revision was built.
    stale_source_count: int | None = None


class DossierGenerateOut(ArtifactSchemaModel):
    artifact_id: UUID
    artifact_ref: str
    revision_id: UUID
    revision_ref: str


class DossierRevisionSummaryOut(ArtifactSchemaModel):
    artifact_id: UUID
    artifact_ref: str
    revision_id: UUID
    revision_ref: str
    status: RevisionStatus
    created_at: datetime
    promoted_at: datetime | None = None
    is_current: bool
    citation_count: int
    source_count: int
    covered_source_count: int
    omitted_source_count: int
    custom_instruction: str | None = None
    model_provider: str | None = None
    model_name: str | None = None
    total_tokens: int | None = None


class DossierRevisionsOut(ArtifactSchemaModel):
    revisions: list[DossierRevisionSummaryOut]


class DossierRevisionOut(ArtifactSchemaModel):
    artifact_id: UUID
    artifact_ref: str
    revision_id: UUID
    revision_ref: str
    status: RevisionStatus
    content_md: str
    citations: list[CitationOut] = Field(default_factory=list)
    source_count: int
    covered_source_count: int
    omitted_source_count: int
    citation_count: int
    custom_instruction: str | None = None
    model_provider: str | None = None
    model_name: str | None = None
    total_tokens: int | None = None
    created_at: datetime
    promoted_at: datetime | None = None
    is_current: bool


class ArtifactRevisionEventOut(ArtifactSchemaModel):
    seq: int
    event_type: str
    payload: dict[str, Any]


class ArtifactDoneEventPayload(ArtifactSchemaModel):
    """Strict ``done`` SSE payload for a terminal revision (chat-done precedent).

    The normalized terminal grammar: ``status`` + ``error_code`` (set on
    failure) + the revision the event belongs to. Writers construct this model
    and store ``model_dump(mode="json")``.
    """

    status: Literal["ready", "failed"]
    error_code: str | None = None
    revision_id: UUID


class ConversationDistillateOut(ArtifactSchemaModel):
    """Read-model for GET /api/conversations/{id}/distillate."""

    artifact_id: UUID | None = None
    revision_id: UUID | None = None
    revision_ref: str | None = None
    status: ArtifactStatus
    content_md: str = ""
    citations: list[CitationOut] = Field(default_factory=list)
    build: ArtifactBuildOut | None = None


class ConversationDistillOut(ArtifactSchemaModel):
    """The 202 distill outcome (the revision IS the run)."""

    artifact_id: UUID
    revision_id: UUID
    revision_ref: str
    status: RevisionStatus
