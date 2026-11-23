"""Section preparation's independent admission and outcome."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

from nexus.schemas.imports import Classification, WaitingReason


class SectionPreparationAdmission(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_id: UUID
    job_id: UUID


class SectionPreparationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: UUID
    classification: Classification
    status: Literal["Queued", "Processing"] | None
    waiting_reason: WaitingReason | None
    next_retry_at: datetime | None
    failure_code: str | None
