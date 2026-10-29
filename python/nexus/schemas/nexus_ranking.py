"""Nexus selection learning and ranking wire models."""

from pydantic import BaseModel, ConfigDict, Field


class NexusSelectionRecordRequest(BaseModel):
    query: str | None = Field(max_length=500)
    target_href: str = Field(min_length=1, max_length=2000)

    model_config = ConfigDict(extra="forbid")


class NexusRankingOut(BaseModel):
    frecency_by_href: dict[str, float]
