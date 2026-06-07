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


class LibraryIntelligenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LibraryIntelligenceBuildOut(LibraryIntelligenceModel):
    build_id: UUID
    status: BuildStatus
    phase: str
    error_code: str | None = None
    error: str | None = None
    started_at: datetime | None = None
    updated_at: datetime
    completed_at: datetime | None = None


class LibraryIntelligenceRefreshOut(LibraryIntelligenceModel):
    build_id: UUID
    status: BuildStatus
    idempotent: bool


class LibraryIntelligenceCoverageOut(LibraryIntelligenceModel):
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


class LibraryIntelligenceEvidenceOut(LibraryIntelligenceModel):
    id: UUID
    source_ref: dict[str, object]
    snippet: str
    locator: dict[str, object] | None = None
    support_role: Literal["supports", "contradicts", "context"]
    retrieval_status: str
    score: float | None = None


class LibraryIntelligenceClaimOut(LibraryIntelligenceModel):
    id: UUID
    claim_text: str
    support_state: SupportState
    confidence: float | None = None
    ordinal: int
    evidence: list[LibraryIntelligenceEvidenceOut]


class LibraryIntelligenceSectionOut(LibraryIntelligenceModel):
    id: UUID
    section_kind: SectionKind
    title: str
    body: str
    ordinal: int
    claims: list[LibraryIntelligenceClaimOut]
    metadata: dict[str, object]


class LibraryIntelligenceArtifactOut(LibraryIntelligenceModel):
    kind: Literal["overview"]
    status: ArtifactFreshnessStatus
    published_at: datetime | None = None


class LibraryIntelligenceOut(LibraryIntelligenceModel):
    library_id: UUID
    status: ArtifactFreshnessStatus
    source_count: int
    chunk_count: int
    updated_at: datetime | None = None
    artifact: LibraryIntelligenceArtifactOut
    sections: list[LibraryIntelligenceSectionOut]
    coverage: list[LibraryIntelligenceCoverageOut]
    build: LibraryIntelligenceBuildOut | None = None
