"""Nexus usage-history API schemas."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

NexusHistorySource = Literal["Static", "Workspace", "Recent", "Oracle", "Search", "Ai"]
# Complete pre-ranking union: openables 20 + owned 40 + panes 12 + destinations 18 + recents 5.
MAX_NEXUS_HISTORY_TARGETS = 95


class NexusHistoryQuery(BaseModel):
    """Score only the complete, bounded candidate set that Nexus is presenting."""

    model_config = ConfigDict(extra="forbid")
    query: str | None = Field(max_length=200)
    target_hrefs: list[Annotated[str, Field(min_length=1, max_length=2000)]] = Field(
        max_length=MAX_NEXUS_HISTORY_TARGETS
    )


class NexusSelectionRecordRequest(BaseModel):
    """POST body for one accepted internal Nexus selection."""

    client_mutation_id: str = Field(min_length=1, max_length=120)
    query: str | None = Field(default=None, max_length=200)
    target_href: str = Field(min_length=1, max_length=2000)
    label_snapshot: str = Field(min_length=1, max_length=120)
    source: NexusHistorySource

    model_config = ConfigDict(extra="forbid")


class NexusSelectionRecordOut(BaseModel):
    """Memoized response for one recorded Nexus selection."""

    use_count: int
    last_used_at: datetime

    model_config = ConfigDict(from_attributes=True)


class NexusHistoryRecentOut(BaseModel):
    """One canonical internal target in Nexus recency order."""

    target_href: str
    label_snapshot: str
    source: NexusHistorySource
    last_used_at: datetime


class NexusHistoryOut(BaseModel):
    """Recent internal targets and bounded query-aware frecency."""

    recent: list[NexusHistoryRecentOut]
    frecency_by_href: dict[str, float]
