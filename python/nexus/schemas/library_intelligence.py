"""Schemas for the library-intelligence artifact (stable head + revisions)."""

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.citation import CitationOut

ArtifactStatus = Literal["unavailable", "building", "failed", "stale", "current"]
RevisionStatus = Literal["building", "ready", "failed"]


class LibraryIntelligenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LibraryIntelligenceBuildOut(LibraryIntelligenceModel):
    """The in-flight (or just-terminal) draft revision's run status."""

    revision_id: UUID
    status: RevisionStatus


class LibraryIntelligenceArtifactOut(LibraryIntelligenceModel):
    """The GET read-model: current-revision content + computed head status."""

    artifact_id: UUID | None = None
    artifact_ref: str | None = None
    revision_id: UUID | None = None
    revision_ref: str | None = None
    status: ArtifactStatus
    content_md: str = ""
    citations: list[CitationOut] = Field(default_factory=list)
    build: LibraryIntelligenceBuildOut | None = None
    # Set only when ``status == "stale"``: the number of sources that changed
    # (added, removed, or re-ingested) since the current revision was built.
    stale_source_count: int | None = None


class LibraryIntelligenceGenerateOut(LibraryIntelligenceModel):
    artifact_id: UUID
    artifact_ref: str
    revision_id: UUID
    revision_ref: str


class LibraryIntelligenceRevisionSummaryOut(LibraryIntelligenceModel):
    artifact_id: UUID
    artifact_ref: str
    revision_id: UUID
    revision_ref: str
    status: RevisionStatus
    created_at: datetime
    promoted_at: datetime | None = None
    is_current: bool
    citation_count: int


class LibraryIntelligenceRevisionsOut(LibraryIntelligenceModel):
    revisions: list[LibraryIntelligenceRevisionSummaryOut]


class LibraryIntelligenceRevisionOut(LibraryIntelligenceModel):
    artifact_id: UUID
    artifact_ref: str
    revision_id: UUID
    revision_ref: str
    status: RevisionStatus
    content_md: str
    citations: list[CitationOut] = Field(default_factory=list)
    created_at: datetime
    promoted_at: datetime | None = None
    is_current: bool


class LibraryIntelligenceRevisionEventOut(LibraryIntelligenceModel):
    seq: int
    event_type: str
    payload: dict[str, Any]


class LibraryIntelligenceDoneEventPayload(LibraryIntelligenceModel):
    """Strict ``done`` SSE payload for a terminal revision (chat-done precedent).

    The normalized terminal grammar: ``status`` + ``error_code`` (set on
    failure) + the revision the event belongs to. Writers construct this model
    and store ``model_dump(mode="json")``.
    """

    status: Literal["ready", "failed"]
    error_code: str | None = None
    revision_id: UUID
