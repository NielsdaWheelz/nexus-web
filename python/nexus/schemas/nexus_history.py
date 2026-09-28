"""Nexus usage-history wire models."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

NexusHistorySource = Literal["Static", "Workspace", "Recent", "Oracle", "Search", "Ai"]


class NexusSelectionRecordRequest(BaseModel):
    """One accepted internal Nexus selection. The stored label is cut to 120 characters."""

    client_mutation_id: str = Field(min_length=1, max_length=120)
    query: str | None = Field(default=None, max_length=500)
    target_href: str = Field(min_length=1, max_length=2000)
    label_snapshot: str = Field(min_length=1, max_length=2000)
    source: NexusHistorySource

    model_config = ConfigDict(extra="forbid")


class NexusSelectionRecordOut(BaseModel):
    use_count: int
    last_used_at: datetime


class NexusHistoryRecentOut(BaseModel):
    target_href: str
    label_snapshot: str
    source: NexusHistorySource
    last_used_at: datetime


class NexusHistoryOut(BaseModel):
    recent: list[NexusHistoryRecentOut]
    frecency_by_href: dict[str, float]
