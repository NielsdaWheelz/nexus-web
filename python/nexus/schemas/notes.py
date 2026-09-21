"""Page and note-block wire shapes. The notes routes serialize ``by_alias=True``."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.presence import Presence
from nexus.schemas.resource_items import ResourceSurfaceOut, validate_note_body_pm_json

_CAMEL = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)
_CAMEL_CLOSED = ConfigDict(
    alias_generator=to_camel, populate_by_name=True, from_attributes=True, extra="forbid"
)


class NoteBlockOut(BaseModel):
    id: UUID
    body_pm_json: dict[str, Any]
    body_text: str
    created_at: datetime
    updated_at: datetime
    version_by_lane: dict[str, int] = Field(default_factory=dict)

    model_config = _CAMEL


class NotePageSummaryOut(BaseModel):
    id: UUID
    title: str = Field(min_length=1, max_length=200)
    updated_at: datetime

    model_config = _CAMEL_CLOSED


class NotePagesOut(BaseModel):
    pages: list[NotePageSummaryOut]

    model_config = ConfigDict(extra="forbid")


class DailyPageSummaryOut(BaseModel):
    local_date: date

    model_config = _CAMEL_CLOSED


class NotePageOut(NotePageSummaryOut):
    daily_page: Presence[DailyPageSummaryOut]


class LatentDailyPageDescriptor(BaseModel):
    kind: Literal["Latent"]
    local_date: date
    default_title: str

    model_config = _CAMEL_CLOSED


class MaterializedDailyPageDescriptor(BaseModel):
    kind: Literal["Materialized"]
    local_date: date
    page: NotePageOut
    surface: ResourceSurfaceOut

    model_config = _CAMEL_CLOSED


DailyPageDescriptor = Annotated[
    LatentDailyPageDescriptor | MaterializedDailyPageDescriptor, Field(discriminator="kind")
]


class CreatePageRequest(BaseModel):
    page_id: UUID
    title: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class UpdatePageRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class DailyCaptureRequest(BaseModel):
    client_mutation_id: str = Field(min_length=1, max_length=120)
    note_id: UUID
    body_pm_json: dict[str, Any]

    model_config = _CAMEL_CLOSED

    @field_validator("body_pm_json")
    @classmethod
    def check_body(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class DailyCaptureResult(BaseModel):
    client_mutation_id: str
    local_date: date
    page_id: UUID
    surface: ResourceSurfaceOut

    model_config = _CAMEL_CLOSED
