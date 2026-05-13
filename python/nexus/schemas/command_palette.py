"""Command palette usage-history schemas."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

CommandPaletteSource = Literal["static", "workspace", "recent", "oracle", "search", "ai"]
CommandPaletteTargetKind = Literal["href", "action", "prefill"]


class CommandPaletteSelectionRecordRequest(BaseModel):
    """POST body for one accepted command palette selection."""

    query: str | None = Field(default=None, max_length=500)
    target_key: str = Field(min_length=1, max_length=500)
    target_kind: CommandPaletteTargetKind
    target_href: str | None = Field(default=None, min_length=1, max_length=2000)
    title_snapshot: str = Field(min_length=1, max_length=500)
    source: CommandPaletteSource

    model_config = ConfigDict(extra="forbid")


class CommandPaletteUsageOut(BaseModel):
    """Response row for one normalized command palette usage record."""

    query_normalized: str
    target_key: str
    target_kind: str
    target_href: str | None
    title_snapshot: str
    source: str
    use_count: int
    last_used_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CommandPaletteHistoryRecentOut(BaseModel):
    """Recent destination row for command palette history."""

    target_key: str
    target_kind: str
    target_href: str
    title_snapshot: str
    source: str
    last_used_at: datetime


class CommandPaletteHistoryOut(BaseModel):
    """Command palette usage history response."""

    recent: list[CommandPaletteHistoryRecentOut]
    frecency_boosts: dict[str, float]
