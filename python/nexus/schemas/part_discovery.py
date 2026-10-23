"""frozen discovery job inputs and the closed model output; jobs own scan history."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.media_parts import PartFinding


class _Closed(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class DiscoverySection(_Closed):
    section_id: str
    label: str
    parent_section_id: str | None
    start_fragment_idx: int
    start_offset: int
    end_fragment_idx: int | None
    end_offset: int | None


class DiscoveryCapture(_Closed):
    source_generation: int
    navigation_key: str
    detector_version: int
    prompt_version: int
    fingerprint: str
    source_title: str
    source_credits: list[ContributorCreditOut]
    sections: list[DiscoverySection]


class PartDiscoveryJob(_Closed):
    source_media_id: UUID
    requester_user_id: UUID
    expected_source_generation: int
    expected_latest_job_id: UUID | None
    origin: Literal["user", "source_publication"]
    capture: DiscoveryCapture | None
    cursor: int = Field(ge=0)


class PartDiscoveryOutput(_Closed):
    findings: list[PartFinding] = Field(max_length=32)
