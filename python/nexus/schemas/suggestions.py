"""Suggestion wire shapes. A media target always carries consumption; a
podcast target never does (the builders guarantee it)."""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field

from nexus.schemas.consumption import CamelOut, ConsumptionOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Presence


class MediaSuggestionTargetOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Media"] = "Media"
    ref: str
    media_summary: MediaSummaryOut
    image_url: Presence[str]
    href: str


class PodcastSuggestionTargetOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Podcast"] = "Podcast"
    ref: str
    title: str
    subtitle: Presence[str]
    image_url: Presence[str]
    href: str


class SuggestionItemOut(CamelOut):
    target: Annotated[
        MediaSuggestionTargetOut | PodcastSuggestionTargetOut, Field(discriminator="kind")
    ]
    consumption: Presence[ConsumptionOut]


class SuggestionsOut(CamelOut):
    items: list[SuggestionItemOut] = Field(max_length=10)


class QuickReadsOut(CamelOut):
    items: list[SuggestionItemOut] = Field(max_length=5)
