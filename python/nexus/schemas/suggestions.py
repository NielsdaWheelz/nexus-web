"""Suggestion targets; viewer consumption belongs to the media summary."""

from typing import Annotated, Literal

from pydantic import ConfigDict, Field

from nexus.schemas.consumption import CamelOut
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


class SuggestionsOut(CamelOut):
    items: list[SuggestionItemOut] = Field(max_length=10)


class QuickReadsOut(CamelOut):
    items: list[SuggestionItemOut] = Field(max_length=5)
