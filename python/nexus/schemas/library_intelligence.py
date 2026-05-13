"""Schemas for library intelligence artifacts."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

ArtifactFreshnessStatus = Literal["current", "stale", "building", "failed", "unavailable"]
BuildStatus = Literal["pending", "running", "succeeded", "failed"]
SectionKind = Literal[
    "overview",
    "key_topics",
    "key_sources",
    "tensions",
    "open_questions",
    "reading_path",
    "recent_changes",
]
SupportState = Literal[
    "supported",
    "partially_supported",
    "contradicted",
    "not_enough_evidence",
    "out_of_scope",
    "not_source_grounded",
]


class LibraryIntelligenceRefreshRequest(BaseModel):
    artifact_kind: Literal["overview"] = "overview"

    model_config = ConfigDict(extra="forbid")


class LibraryIntelligenceBuildOut(BaseModel):
    build_id: UUID
    status: BuildStatus
    phase: str
    error_code: str | None = None
    error: str | None = None
    started_at: datetime | None = None
    updated_at: datetime
    completed_at: datetime | None = None


class LibraryIntelligenceRefreshOut(BaseModel):
    build_id: UUID
    status: BuildStatus
    idempotent: bool


class LibraryIntelligenceCoverageOut(BaseModel):
    media_id: UUID | None = None
    podcast_id: UUID | None = None
    source_kind: Literal["media", "podcast"]
    title: str
    media_kind: str | None = None
    readiness_state: str
    chunk_count: int
    included: bool
    exclusion_reason: str | None = None
    source_updated_at: datetime | None = None


class LibraryIntelligenceEvidenceOut(BaseModel):
    id: UUID
    source_ref: dict[str, object]
    snippet: str
    locator: dict[str, object] | None = None
    support_role: Literal["supports", "contradicts", "context"]
    retrieval_status: str
    score: float | None = None


class LibraryIntelligenceClaimOut(BaseModel):
    id: UUID
    claim_text: str
    support_state: SupportState
    confidence: float | None = None
    ordinal: int
    evidence: list[LibraryIntelligenceEvidenceOut]


class LibraryIntelligenceSectionOut(BaseModel):
    id: UUID
    section_kind: SectionKind
    title: str
    body: str
    ordinal: int
    claims: list[LibraryIntelligenceClaimOut]
    metadata: dict[str, object]


class LibraryIntelligenceArtifactFreshnessOut(BaseModel):
    current_source_set_version_id: UUID | None = None
    active_source_set_version_id: UUID | None = None
    current_source_set_hash: str | None = None
    active_source_set_hash: str | None = None


class LibraryIntelligenceArtifactOut(BaseModel):
    kind: Literal["overview"]
    status: ArtifactFreshnessStatus
    active_version_id: UUID | None = None
    source_set_version_id: UUID | None = None
    prompt_version: str | None = None
    schema_version: str | None = None
    published_at: datetime | None = None
    freshness: LibraryIntelligenceArtifactFreshnessOut


class LibraryIntelligenceOut(BaseModel):
    library_id: UUID
    status: ArtifactFreshnessStatus
    source_count: int
    chunk_count: int
    updated_at: datetime | None = None
    artifact: LibraryIntelligenceArtifactOut
    sections: list[LibraryIntelligenceSectionOut]
    coverage: list[LibraryIntelligenceCoverageOut]
    build: LibraryIntelligenceBuildOut | None = None


class LibraryArtifactPromptContext(BaseModel):
    version_id: UUID
    library_id: UUID
    source_set_version_id: UUID
    source_set_hash: str
    prompt_version: str
    schema_version: str
    text: str
