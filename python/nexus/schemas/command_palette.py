"""Command palette recent destination schemas."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class CommandPaletteRecentRecordRequest(BaseModel):
    """POST body for one recent destination."""

    href: str = Field(min_length=1)
    title_snapshot: str | None = None

    model_config = ConfigDict(extra="forbid")


class CommandPaletteRecentOut(BaseModel):
    """Response row for one recent destination."""

    href: str
    title_snapshot: str | None
    last_used_at: datetime

    model_config = ConfigDict(from_attributes=True)
