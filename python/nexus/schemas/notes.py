"""Schemas for page titles and note bodies."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any
from uuid import UUID

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator

from nexus.schemas.resource_items import (
    ResourceSurfaceOut,
    validate_note_body_pm_json,
)


class NoteBlockOut(BaseModel):
    id: UUID
    parent_block_id: UUID | None = Field(
        None,
        validation_alias=AliasChoices("parent_block_id", "parentBlockId"),
        serialization_alias="parentBlockId",
    )
    order_key: str | None = Field(
        None,
        validation_alias=AliasChoices("order_key", "orderKey"),
        serialization_alias="orderKey",
    )
    body_pm_json: dict[str, Any] = Field(
        validation_alias=AliasChoices("body_pm_json", "bodyPmJson"),
        serialization_alias="bodyPmJson",
    )
    body_text: str = Field(
        validation_alias=AliasChoices("body_text", "bodyText"),
        serialization_alias="bodyText",
    )
    collapsed: bool = False
    children: list[NoteBlockOut] = Field(default_factory=list)
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


class DailyNotePageSummaryOut(BaseModel):
    local_date: date = Field(
        serialization_alias="localDate",
    )

    model_config = ConfigDict(populate_by_name=True)


class NotePageOut(NotePageSummaryOut):
    surface: ResourceSurfaceOut | None = None
    blocks: list[NoteBlockOut] = Field(default_factory=list)
    daily_note: DailyNotePageSummaryOut | None = Field(
        None,
        serialization_alias="dailyNote",
    )


class DailyNotePageOut(BaseModel):
    local_date: date = Field(
        validation_alias=AliasChoices("local_date", "localDate"),
        serialization_alias="localDate",
    )
    time_zone: str = Field(
        validation_alias=AliasChoices("time_zone", "timeZone"),
        serialization_alias="timeZone",
    )
    page: NotePageOut

    model_config = ConfigDict(populate_by_name=True)


class CreatePageRequest(BaseModel):
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


class QuickCaptureRequest(NoteBodyRequest):
    id: UUID
    client_mutation_id: str = Field(
        ...,
        min_length=1,
        max_length=120,
        validation_alias=AliasChoices("client_mutation_id", "clientMutationId"),
        serialization_alias="clientMutationId",
    )
    local_date: date | None = Field(
        None,
        validation_alias=AliasChoices("local_date", "localDate"),
        serialization_alias="localDate",
    )
