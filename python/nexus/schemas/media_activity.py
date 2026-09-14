"""Bounded media Activity and exact-repair wire contracts."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from nexus.schemas.media import SourceProgress
from nexus.schemas.presence import Presence

NonemptyString = Annotated[str, Field(min_length=1)]


class MediaActivityCapabilitiesOut(BaseModel):
    can_open: bool
    can_repair_source: bool
    can_repair_search: bool
    can_remove: bool

    model_config = ConfigDict(extra="forbid")


class MediaActivityActiveStateOut(BaseModel):
    kind: Literal["Active"] = "Active"
    status: Literal["Queued", "Processing"]
    stage: Literal["Validate", "Extract", "Finalize", "Index"]
    waiting_reason: Presence[Literal["Queue", "Capacity", "RetryBackoff"]]
    progress: Presence[SourceProgress]
    status_code: Presence[NonemptyString]

    model_config = ConfigDict(extra="forbid")


class MediaActivityNeedsAttentionStateOut(BaseModel):
    kind: Literal["NeedsAttention"] = "NeedsAttention"
    scope: Literal["Source", "Search"]
    stage: Literal["Validate", "Extract", "Finalize", "Index"]
    failure_code: Presence[NonemptyString]

    model_config = ConfigDict(extra="forbid")


MediaActivityState = Annotated[
    MediaActivityActiveStateOut | MediaActivityNeedsAttentionStateOut,
    Field(discriminator="kind"),
]


class MediaActivityItemOut(BaseModel):
    media_id: UUID
    title: str
    media_kind: Literal["web_article", "epub", "pdf", "podcast_episode", "video"]
    source_attempt_id: UUID
    state: MediaActivityState
    request_id: Presence[NonemptyString]
    run_count: int = Field(ge=0)
    queue_attempts: int = Field(ge=0)
    queue_max_attempts: int = Field(ge=0)
    created_at: datetime
    updated_at: datetime
    capabilities: MediaActivityCapabilitiesOut

    model_config = ConfigDict(extra="forbid")


class MediaActivityOut(BaseModel):
    needs_attention_count: int = Field(ge=0)
    active_count: int = Field(ge=0)
    has_more: bool
    items: list[MediaActivityItemOut]

    model_config = ConfigDict(extra="forbid")


class MediaRepairRequest(BaseModel):
    scope: Literal["Source", "Search"]

    model_config = ConfigDict(extra="forbid")


class MediaRepairOut(BaseModel):
    media_id: UUID
    scope: Literal["Source", "Search"]
    job_id: UUID

    model_config = ConfigDict(extra="forbid")
