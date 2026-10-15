"""Suggestion targets; viewer consumption belongs to the media summary."""

from typing import Annotated, Literal

from pydantic import Field

from nexus.schemas.consumption import Closed
from nexus.schemas.media_summary import MediaSummaryOut


class MediaSuggestionTargetOut(Closed):
    kind: Literal["Media"]
    ref: str
    media_summary: MediaSummaryOut
    image_url: str | None
    href: str


class PodcastSuggestionTargetOut(Closed):
    kind: Literal["Podcast"]
    ref: str
    title: str
    subtitle: str | None
    image_url: str | None
    href: str


class SuggestionItemOut(Closed):
    target: Annotated[
        MediaSuggestionTargetOut | PodcastSuggestionTargetOut, Field(discriminator="kind")
    ]


class SuggestionsOut(Closed):
    items: list[SuggestionItemOut] = Field(max_length=10)


class QuickReadsOut(Closed):
    items: list[SuggestionItemOut] = Field(max_length=5)
