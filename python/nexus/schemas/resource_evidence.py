"""Captured evidence: immutable words, attribution and the extent they described."""

from __future__ import annotations

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.highlight_color import HighlightColor
from nexus.schemas.reader_excerpts import FrozenExcerpt
from nexus.schemas.retrieval import LocationPrecision, RetrievalLocator

ResourceField = Literal["annotation"] | None


def validate_resource_field(resource_ref: str | None, field: ResourceField) -> None:
    if field is None:
        return
    if resource_ref is None or not resource_ref.startswith("highlight:"):
        raise ValueError("annotation field requires a highlight")
    identity = resource_ref.removeprefix("highlight:")
    if str(UUID(identity)) != identity:
        raise ValueError("annotation field requires a canonical highlight ref")


class CapturedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class LocationQuote(CapturedModel):
    exact: str
    prefix: str | None
    suffix: str | None
    color: HighlightColor | None


class CapturedQuote(LocationQuote):
    excerpt: FrozenExcerpt


class CapturedSource(CapturedModel):
    ref: str | None
    title: str | None
    media_kind: str | None
    contributors: list[ContributorCreditOut] | None
    location_label: str | None


class CapturedFieldTarget(CapturedModel):
    owner_ref: str
    field: ResourceField

    @model_validator(mode="after")
    def validate_field(self) -> CapturedFieldTarget:
        validate_resource_field(self.owner_ref, self.field)
        return self


class CapturedResourceTarget(CapturedFieldTarget):
    kind: Literal["resource"] = "resource"


class CapturedPassageTarget(CapturedFieldTarget):
    kind: Literal["passage"] = "passage"
    locator: RetrievalLocator
    precision: LocationPrecision
    source_identity: str | None

    @model_validator(mode="after")
    def validate_locator_field(self) -> CapturedPassageTarget:
        annotation = self.locator.type == "highlight_annotation_offsets"
        if annotation != (self.field == "annotation"):
            raise ValueError("annotation field and locator must agree")
        if (
            self.locator.type == "highlight_annotation_offsets"
            and self.owner_ref != f"highlight:{self.locator.highlight_id}"
        ):
            raise ValueError("annotation locator must belong to its highlight")
        return self


class CapturedUnavailableTarget(CapturedModel):
    kind: Literal["unavailable"] = "unavailable"
    owner_ref: str | None
    field: ResourceField

    @model_validator(mode="after")
    def validate_field(self) -> CapturedUnavailableTarget:
        validate_resource_field(self.owner_ref, self.field)
        return self


CapturedTarget = Annotated[
    CapturedResourceTarget | CapturedPassageTarget | CapturedUnavailableTarget,
    Field(discriminator="kind"),
]


class CapturedEvidence(CapturedModel):
    quote: CapturedQuote | None
    source: CapturedSource
    target: CapturedTarget
