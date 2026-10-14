"""Page and note-block wire shapes."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from nexus.schemas.resource_items import ResourceSurfaceOut, validate_note_body_pm_json

_ROW = ConfigDict(from_attributes=True)
_CLOSED = ConfigDict(from_attributes=True, extra="forbid")


class NoteBlockOut(BaseModel):
    id: UUID
    body_pm_json: dict[str, Any]
    body_text: str
    created_at: datetime
    updated_at: datetime
    version_by_lane: dict[str, int]

    model_config = _ROW


class NotePageSummaryOut(BaseModel):
    id: UUID
    title: str = Field(min_length=1, max_length=200)
    updated_at: datetime

    model_config = _CLOSED


class DailyPageSummaryOut(BaseModel):
    local_date: date

    model_config = _CLOSED


class NotePageOut(NotePageSummaryOut):
    daily_page: DailyPageSummaryOut | None


class LatentDailyPageDescriptor(BaseModel):
    kind: Literal["Latent"]
    local_date: date
    default_title: str

    model_config = _CLOSED


class MaterializedDailyPageDescriptor(BaseModel):
    kind: Literal["Materialized"]
    local_date: date
    page: NotePageOut
    surface: ResourceSurfaceOut

    model_config = _CLOSED

    @model_validator(mode="after")
    def _validate_daily_page(self) -> MaterializedDailyPageDescriptor:
        if self.page.daily_page is None:
            raise ValueError("materialized daily page must have daily metadata")
        if self.page.daily_page.local_date != self.local_date:
            raise ValueError("materialized daily page metadata must match local_date")
        return self


DailyPageDescriptor = Annotated[
    LatentDailyPageDescriptor | MaterializedDailyPageDescriptor, Field(discriminator="kind")
]


class CreatePageRequest(BaseModel):
    id: UUID
    title: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class UpdatePageRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class DailyCaptureRequest(BaseModel):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    note_id: UUID
    body_pm_json: dict[str, Any]

    model_config = _CLOSED

    @field_validator("body_pm_json")
    @classmethod
    def check_body(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class DailyCaptureResult(BaseModel):
    client_mutation_id: str
    local_date: date
    page_id: UUID
    surface: ResourceSurfaceOut

    model_config = _CLOSED
