"""Nexus selection learning and usage map wire models."""

from pydantic import BaseModel, ConfigDict, Field


class NexusSelectionRecordRequest(BaseModel):
    query: str | None = Field(max_length=500)
    target_href: str = Field(min_length=1, max_length=2000)

    model_config = ConfigDict(extra="forbid")


class NexusUsageOut(BaseModel):
    use_count: int
    points: float
    last_used: str


class NexusUsageMapOut(BaseModel):
    """`usages[query_normalized][canonical_href]`; the untyped aggregate is query ``""``."""

    usages: dict[str, dict[str, NexusUsageOut]]
