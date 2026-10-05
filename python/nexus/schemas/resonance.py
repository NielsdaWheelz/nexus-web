"""Reading-slate wire shapes. A media target always carries consumption; a
podcast target never does (the builders guarantee it)."""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field

from nexus.schemas.consumption import CamelOut, ConsumptionOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Presence


class MediaSlateTargetOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Media"] = "Media"
    ref: str
    media_summary: MediaSummaryOut
    image_url: Presence[str]
    href: str


class PodcastSlateTargetOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Podcast"] = "Podcast"
    ref: str
    title: str
    subtitle: Presence[str]
    image_url: Presence[str]
    href: str


class SlateItemOut(CamelOut):
    target: Annotated[MediaSlateTargetOut | PodcastSlateTargetOut, Field(discriminator="kind")]
    consumption: Presence[ConsumptionOut]


class SlateOut(CamelOut):
    items: list[SlateItemOut] = Field(max_length=10)


class QuickReadsOut(CamelOut):
    items: list[SlateItemOut] = Field(max_length=5)
