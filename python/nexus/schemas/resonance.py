"""Strict camelCase wire contracts for the deterministic Resonance slates.

Every variant is key-exact against ``apps/web/src/lib/resonance/contract.ts``.
"""

from collections.abc import Callable
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.db.models import MediaKind
from nexus.schemas.consumption import ConsumptionOut
from nexus.schemas.presence import Presence, Present
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.reading_time import ReadingTimeEstimateOut
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
    kind: Literal["Media"] = "Media"
    ref: MediaResourceRefUri
    media_kind: MediaKind
    title: str
    subtitle: Presence[str]
    image_url: Presence[str]
    href: InternalHref


class PodcastSlateTargetOut(ResonanceModel):
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
    publication_date: Presence[PublicationDate]
    consumption: Presence[ConsumptionOut]
    reading_time_estimate: Presence[ReadingTimeEstimateOut]

    @model_validator(mode="after")
    def validate_target_facts(self) -> Self:
        if isinstance(self.target, PodcastSlateTargetOut):
            if any(
                isinstance(value, Present)
                for value in (
                    self.publication_date,
                    self.consumption,
                    self.reading_time_estimate,
                )
            ):
                raise ValueError("Podcast targets have no publication, consumption or reading time")
        elif not isinstance(self.consumption, Present):
            raise ValueError("Media targets require consumption")
        elif isinstance(self.reading_time_estimate, Present) and self.target.media_kind not in (
            MediaKind.web_article,
            MediaKind.epub,
            MediaKind.pdf,
        ):
            raise ValueError("Reading time requires a document target")
        return self


class SlateOut(ResonanceModel):
    items: list[SlateItemOut] = Field(max_length=10)


class QuickReadsOut(ResonanceModel):
    items: list[SlateItemOut] = Field(max_length=5)

    @model_validator(mode="after")
    def validate_quick_reads(self) -> Self:
        for item in self.items:
            estimate = item.reading_time_estimate
            if (
                not isinstance(item.target, MediaSlateTargetOut)
                or not isinstance(estimate, Present)
                or not isinstance(estimate.value.remaining_minutes, Present)
                or estimate.value.remaining_minutes.value <= 0
            ):
                raise ValueError("Quick reads require documents with positive known remaining time")
        return self
