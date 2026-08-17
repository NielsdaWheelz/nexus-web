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


class MediaActivityMediaItemOut(BaseModel):
    kind: Literal["Media"] = "Media"
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


class MediaUploadSessionCapabilitiesOut(BaseModel):
    can_retry_upload: bool
    can_remove: bool

    model_config = ConfigDict(extra="forbid")


class MediaUploadSessionTransportFailureOut(BaseModel):
    kind: Literal["TransportFailed"] = "TransportFailed"
    failure_kind: Literal["Network", "Timeout", "HttpRejected", "Aborted"]
    http_status: Presence[int]

    model_config = ConfigDict(extra="forbid")


class MediaUploadSessionCapabilityExpiredOut(BaseModel):
    kind: Literal["CapabilityExpired"] = "CapabilityExpired"

    model_config = ConfigDict(extra="forbid")


class MediaUploadSessionVerificationFailureOut(BaseModel):
    kind: Literal["VerificationFailed"] = "VerificationFailed"
    failure_code: NonemptyString

    model_config = ConfigDict(extra="forbid")


MediaUploadSessionAttention = Annotated[
    MediaUploadSessionTransportFailureOut
    | MediaUploadSessionCapabilityExpiredOut
    | MediaUploadSessionVerificationFailureOut,
    Field(discriminator="kind"),
]


class MediaActivityUploadSessionItemOut(BaseModel):
    kind: Literal["UploadSession"] = "UploadSession"
    session_handle: NonemptyString
    filename: NonemptyString
    document_kind: Literal["Pdf", "Epub"]
    expected_size_bytes: int = Field(gt=0)
    attention: MediaUploadSessionAttention
    created_at: datetime
    updated_at: datetime
    capabilities: MediaUploadSessionCapabilitiesOut

    model_config = ConfigDict(extra="forbid")


MediaActivityItemOut = Annotated[
    MediaActivityMediaItemOut | MediaActivityUploadSessionItemOut,
    Field(discriminator="kind"),
]


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
