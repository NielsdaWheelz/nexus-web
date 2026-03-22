"""Pydantic schemas for playback queue APIs."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

PlaybackQueueInsertPosition = Literal["next", "last"]
PlaybackQueueSource = Literal["manual", "auto_subscription", "auto_playlist"]


class PlaybackQueueListeningStateOut(BaseModel):
    """Per-item listening-state snapshot for queue payloads."""

    position_ms: int = Field(ge=0)
    playback_speed: float = Field(gt=0)


class PlaybackQueueItemOut(BaseModel):
    """One ordered queue row returned to clients."""

    item_id: UUID
    media_id: UUID
    title: str
    podcast_title: str | None = None
    duration_seconds: int | None = Field(default=None, ge=1)
    stream_url: str
    source_url: str
    position: int = Field(ge=0)
    source: PlaybackQueueSource
    added_at: datetime
    listening_state: PlaybackQueueListeningStateOut | None = None


class PlaybackQueueAddRequest(BaseModel):
    """Body for POST /playback/queue/items."""

    media_ids: list[UUID] = Field(min_length=1, max_length=200)
    insert_position: PlaybackQueueInsertPosition = "last"
    current_media_id: UUID | None = None

    model_config = ConfigDict(extra="forbid")


class PlaybackQueueOrderRequest(BaseModel):
    """Body for PUT /playback/queue/order."""

    item_ids: list[UUID]

    model_config = ConfigDict(extra="forbid")
