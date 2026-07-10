"""Pydantic schemas for the unified consumption queue API."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

ConsumptionQueueInsertPosition = Literal["next", "last"]
ConsumptionQueueSource = Literal["manual", "auto_subscription", "auto_playlist", "assistant"]
ConsumptionQueueKindFilter = Literal["audio", "readable"]


class ConsumptionQueueListeningStateOut(BaseModel):
    """Per-item listening-state snapshot for audio queue payloads."""

    position_ms: int = Field(ge=0)
    playback_speed: float = Field(gt=0)


class ConsumptionQueueItemOut(BaseModel):
    """One ordered queue row returned to clients (any media kind)."""

    item_id: UUID
    media_id: UUID
    position: int = Field(ge=0)
    kind: str
    title: str
    # Streaming URL for audio/video kinds; null for readable kinds.
    stream_url: str | None = None
    # Always /media/{media_id}; navigation href for all kinds.
    reader_href: str
    source: ConsumptionQueueSource
    added_at: datetime
    listening_state: ConsumptionQueueListeningStateOut | None = None
    # Read/listen progress; audio derives from listening_state client-side, text
    # rows carry the derived read-state fraction here.
    progress_fraction: float | None = Field(default=None, ge=0.0, le=1.0)
    # Audio-only display fields (null for readable kinds).
    podcast_title: str | None = None
    duration_seconds: int | None = Field(default=None, ge=1)
    subscription_default_playback_speed: float | None = Field(default=None, ge=0.5, le=3.0)


class ConsumptionQueueAddRequest(BaseModel):
    """Body for POST /queue/items."""

    media_ids: list[UUID] = Field(min_length=1, max_length=200)
    insert_position: ConsumptionQueueInsertPosition = "last"
    current_media_id: UUID | None = None

    model_config = ConfigDict(extra="forbid")


class ConsumptionQueueOrderRequest(BaseModel):
    """Body for PUT /queue/order."""

    item_ids: list[UUID]

    model_config = ConfigDict(extra="forbid")
