"""Strict camelCase output contracts for the deterministic resonance slates."""

from collections.abc import Callable
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.consumption import ConsumptionOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Presence, Present
from nexus.services.resource_graph.refs import (
    ResourceRefParseFailure,
    ResourceScheme,
    parse_resource_ref,
)


def _ref_uri_validator(expected: ResourceScheme) -> Callable[[str], str]:
    def validate(value: str) -> str:
        parsed = parse_resource_ref(value)
        if isinstance(parsed, ResourceRefParseFailure):
            raise ValueError("ref must be a canonical ResourceRef")
        if parsed.scheme != expected:
            raise ValueError(f"ref must use the {expected} scheme")
        return value

    return validate


def _internal_href(value: str) -> str:
    if not value.startswith("/") or value.startswith("//"):
        raise ValueError("href must be a canonical internal route")
    return value


MediaResourceRefUri = Annotated[str, AfterValidator(_ref_uri_validator("media"))]
PodcastResourceRefUri = Annotated[str, AfterValidator(_ref_uri_validator("podcast"))]
InternalHref = Annotated[str, AfterValidator(_internal_href)]


class ResonanceModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class MediaSlateTargetOut(ResonanceModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Media"] = "Media"
    ref: MediaResourceRefUri
    media_summary: MediaSummaryOut
    image_url: Presence[str]
    href: InternalHref


class PodcastSlateTargetOut(ResonanceModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Podcast"] = "Podcast"
    ref: PodcastResourceRefUri
    title: str
    subtitle: Presence[str]
    image_url: Presence[str]
    href: InternalHref


SlateTargetOut = Annotated[
    MediaSlateTargetOut | PodcastSlateTargetOut,
    Field(discriminator="kind"),
]


class SlateItemOut(ResonanceModel):
    target: SlateTargetOut
    consumption: Presence[ConsumptionOut]

    @model_validator(mode="after")
    def validate_target_facts(self) -> Self:
        if isinstance(self.target, PodcastSlateTargetOut):
            if isinstance(self.consumption, Present):
                raise ValueError("Podcast targets have no consumption")
        elif not isinstance(self.consumption, Present):
            raise ValueError("Media targets require consumption")
        return self


class SlateOut(ResonanceModel):
    items: list[SlateItemOut] = Field(max_length=10)


class QuickReadsOut(ResonanceModel):
    items: list[SlateItemOut] = Field(max_length=5)

    @model_validator(mode="after")
    def validate_quick_reads(self) -> Self:
        for item in self.items:
            duration = (
                item.target.media_summary.duration
                if isinstance(item.target, MediaSlateTargetOut)
                else None
            )
            if (
                not isinstance(item.target, MediaSlateTargetOut)
                or not isinstance(duration, Present)
                or duration.value.modality != "Read"
                or not isinstance(duration.value.estimate.remaining_minutes, Present)
                or duration.value.estimate.remaining_minutes.value <= 0
            ):
                raise ValueError("Quick reads require documents with positive known remaining time")
        return self
