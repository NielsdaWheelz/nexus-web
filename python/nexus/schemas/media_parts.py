"""closed piece commands and receipts; selectors name detector sections, never offsets."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.imports import ImportObligation
from nexus.schemas.reader import NavigationTextRangeOut
from nexus.schemas.resource_items import ResourceItemOut
from nexus.services.contributor_taxonomy import ContributorRole

PartForm = Literal["essay", "poem", "letter", "short_story", "section"]
PartBlockReason = Literal[
    "not_creator",
    "unsupported_source",
    "not_ready",
    "preparing_structure",
    "unknown_end",
    "unproved_structure",
    "active",
]


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SectionSelection(_Closed):
    source_generation: int = Field(ge=1)
    navigation_key: str = Field(pattern=r"^[0-9a-f]{64}$")
    section_ids: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def distinct_sections(self) -> "SectionSelection":
        if len(set(self.section_ids)) != len(self.section_ids):
            raise ValueError("section_ids must be distinct")
        return self


class PartCreate(_Closed):
    id: UUID
    selection: SectionSelection
    title: str = Field(min_length=1, max_length=1000)
    form: PartForm | None

    @model_validator(mode="after")
    def nonblank_title(self) -> "PartCreate":
        if not self.title.strip():
            raise ValueError("title must not be blank")
        return self


class PartUpdate(_Closed):
    expected_version: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=1000)
    form: PartForm | None
    selection: SectionSelection | None

    @model_validator(mode="after")
    def nonblank_title(self) -> "PartUpdate":
        if not self.title.strip():
            raise ValueError("title must not be blank")
        return self


class PartPreview(_Closed):
    selection: SectionSelection


class PartPrepare(_Closed):
    id: UUID
    expected_source_generation: int = Field(ge=1)


class PartDiscovery(_Closed):
    id: UUID
    expected_source_generation: int = Field(ge=1)
    expected_latest_job_id: UUID | None


class PartCandidateDecision(_Closed):
    expected_version: int = Field(ge=1)
    decision: Literal["accepted", "rejected"]
    part_id: UUID | None

    @model_validator(mode="after")
    def decision_identity(self) -> "PartCandidateDecision":
        if (self.decision == "accepted") != (self.part_id is not None):
            raise ValueError("acceptance requires part_id; rejection requires null part_id")
        return self


class PartEvidence(_Closed):
    section_id: str
    quote: str = Field(min_length=1, max_length=2000, pattern=r"\S")


class PartContributor(_Closed):
    credited_name: str = Field(min_length=1, max_length=200, pattern=r"\S")
    contributor_handle: str | None = Field(
        min_length=3, max_length=80, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$"
    )
    raw_role: str | None = Field(max_length=80)


class PartContributorSlice(_Closed):
    role: ContributorRole
    credits: list[PartContributor] = Field(max_length=20)


class PartFinding(_Closed):
    section_ids: list[str] = Field(min_length=1)
    verdict: Literal["independent_work", "uncertain", "not_independent"]
    title: str | None = Field(min_length=1, max_length=1000, pattern=r"\S")
    form: PartForm | None
    contributors: list[PartContributorSlice] | None
    evidence: list[PartEvidence] = Field(max_length=32)
    uncertainty_reason: str | None = Field(max_length=2000)


class PartReceipt(_Closed):
    media_id: UUID
    version: int
    body_generation: int
    set_revision: int


class PartRow(_Closed):
    kind: Literal["part"] = "part"
    item: ResourceItemOut
    version: int


class CandidateRow(_Closed):
    kind: Literal["candidate"] = "candidate"
    id: UUID
    version: int
    finding: PartFinding | None
    user_decision: Literal["accepted", "rejected"] | None
    part_id: UUID | None
    bound_title: str | None


PartListRow = Annotated[PartRow | CandidateRow, Field(discriminator="kind")]


class CandidateReceipt(_Closed):
    candidate: CandidateRow
    part: PartReceipt | None
    set_revision: int


class PartOperation(_Closed):
    job_id: UUID
    status: Literal["pending", "running", "failed", "succeeded", "dead"]
    completed_sections: int
    total_sections: int
    error_code: str | None
    outcome: Literal["completed", "superseded"] | None


class PartAction(_Closed):
    allowed: bool
    reason: PartBlockReason | None


class PartCapabilities(_Closed):
    create: PartAction
    discover: PartAction
    edit_bounds: PartAction
    edit_metadata: PartAction


class PartSectionChoice(_Closed):
    section_id: str
    eligible: bool
    reason: PartBlockReason | None


class PartPage(_Closed):
    next_cursor: str | None
    source_generation: int | None
    navigation_key: str | None
    set_revision: int
    operation: PartOperation | None
    preparation: ImportObligation | None
    section_choices: list[PartSectionChoice] | None
    capabilities: PartCapabilities


class PartDefinition(_Closed):
    media_id: UUID
    source_media_id: UUID
    source_title: str
    source_format: Literal["epub", "web_article"]
    source_generation: int
    extent: NavigationTextRangeOut
    title: str
    form: PartForm | None
    version: int
    body_generation: int
    selection: SectionSelection | None
    capabilities: PartCapabilities
