"""Exact captured-source retrieval, image availability and guarded retry receipts."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


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
