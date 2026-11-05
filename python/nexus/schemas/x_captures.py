"""Exact captured-source retrieval, image availability and guarded retry receipts."""

from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.imports import ImportObligation


class XPostSaveStateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capture_ids: list[UUID] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def distinct_captures(self) -> Self:
        if len(set(self.capture_ids)) != len(self.capture_ids):
            raise ValueError("capture_ids must be distinct")
        return self


class _SaveOut(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_serialization_defaults_required=True)


class XPostAcquisition(_SaveOut):
    media_id: UUID
    source_attempt_id: UUID
    obligation: ImportObligation


class XPostSaveUnavailable(_SaveOut):
    kind: Literal["unavailable"] = "unavailable"
    capture_id: UUID


class XPostSaveConflict(_SaveOut):
    kind: Literal["conflict"] = "conflict"
    capture_id: UUID
    saved_media_id: UUID | None


class XPostSaveResolved(_SaveOut):
    kind: Literal["resolved"] = "resolved"
    capture_id: UUID
    saved_media_id: UUID | None
    acquisition: XPostAcquisition | None


type XPostSaveState = Annotated[
    XPostSaveUnavailable | XPostSaveConflict | XPostSaveResolved, Field(discriminator="kind")
]


class XPostSaveStateOut(_SaveOut):
    items: list[XPostSaveState]


class QuoteRetrieval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: UUID
    status: Literal["queued", "running", "recovering", "failed", "succeeded"]
    error_code: str | None
    message: str | None
    can_retry: bool


class XCaptureAssetOut(BaseModel):
    asset_key: str
    url: str | None


class XCaptureArchiveOut(BaseModel):
    capture_id: UUID
    retrieval: QuoteRetrieval | None
    assets: list[XCaptureAssetOut]


class RetryXCaptureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_job_id: UUID
