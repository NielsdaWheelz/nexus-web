"""Schemas for page titles and note bodies."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from nexus.schemas.resource_items import ResourceSurfaceOut, validate_note_body_pm_json


class NoteBlockOut(BaseModel):
    id: UUID
    body_pm_json: dict[str, Any] = Field(
        validation_alias=AliasChoices("body_pm_json", "bodyPmJson"),
        serialization_alias="bodyPmJson",
    )
    body_text: str = Field(
        validation_alias=AliasChoices("body_text", "bodyText"),
        serialization_alias="bodyText",
    )
    created_at: datetime = Field(
        validation_alias=AliasChoices("created_at", "createdAt"),
        serialization_alias="createdAt",
    )
    updated_at: datetime = Field(
        validation_alias=AliasChoices("updated_at", "updatedAt"),
        serialization_alias="updatedAt",
    )
    version_by_lane: dict[str, int] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("version_by_lane", "versionByLane"),
        serialization_alias="versionByLane",
    )

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class NotePageSummaryOut(BaseModel):
    id: UUID
    title: str
    updated_at: datetime = Field(
        validation_alias=AliasChoices("updated_at", "updatedAt"),
        serialization_alias="updatedAt",
    )

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class DailyPageSummaryOut(BaseModel):
    local_date: date = Field(
        serialization_alias="localDate",
    )

    model_config = ConfigDict(populate_by_name=True)


class NotePageOut(NotePageSummaryOut):
    daily_page: DailyPageSummaryOut | None = Field(
        None,
        serialization_alias="dailyPage",
    )


class LatentDailyPageDescriptor(BaseModel):
    kind: Literal["Latent"]
    local_date: date = Field(
        validation_alias=AliasChoices("local_date", "localDate"),
        serialization_alias="localDate",
    )
    default_title: str = Field(
        validation_alias=AliasChoices("default_title", "defaultTitle"),
        serialization_alias="defaultTitle",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class MaterializedDailyPageDescriptor(BaseModel):
    kind: Literal["Materialized"]
    local_date: date = Field(
        validation_alias=AliasChoices("local_date", "localDate"),
        serialization_alias="localDate",
    )
    page: NotePageOut
    surface: ResourceSurfaceOut

    model_config = ConfigDict(populate_by_name=True, extra="forbid")


DailyPageDescriptor = Annotated[
    LatentDailyPageDescriptor | MaterializedDailyPageDescriptor,
    Field(discriminator="kind"),
]


class CreatePageRequest(BaseModel):
    page_id: UUID
    title: str = Field(..., min_length=1, max_length=200)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class UpdatePageRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class NoteBodyRequest(BaseModel):
    body_pm_json: dict[str, Any] = Field(
        validation_alias=AliasChoices("body_pm_json", "bodyPmJson"),
        serialization_alias="bodyPmJson",
    )

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("body_pm_json")
    @classmethod
    def validate_body_pm_json(cls, value: dict[str, Any]) -> dict[str, Any]:
        return validate_note_body_pm_json(value) or value


class DailyCaptureRequest(NoteBodyRequest):
    client_mutation_id: str = Field(
        ...,
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    note_id: UUID = Field(
        validation_alias=AliasChoices("note_id", "noteId"),
        serialization_alias="noteId",
    )


class DailyCaptureResult(BaseModel):
    client_mutation_id: str = Field(
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    local_date: date = Field(
        validation_alias=AliasChoices("local_date", "localDate"),
        serialization_alias="localDate",
    )
    page_id: UUID = Field(
        validation_alias=AliasChoices("page_id", "pageId"),
        serialization_alias="pageId",
    )
    surface: ResourceSurfaceOut

    model_config = ConfigDict(populate_by_name=True, extra="forbid")
