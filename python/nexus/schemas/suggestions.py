"""Suggestion publications, current eligibility and refresh observation."""

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import ConfigDict, Field, field_validator

from nexus.jobs.queue import DurableExecutionPhase
from nexus.schemas.consumption import Closed
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref


class MediaSuggestionTargetOut(Closed):
    kind: Literal["Media"]
    ref: str
    media_summary: MediaSummaryOut
    href: str


class FeedSuggestionTargetOut(Closed):
    kind: Literal["Feed"]
    ref: str
    feed_id: UUID
    feed_kind: Literal["podcast", "article"]
    title: str
    subtitle: str | None
    image_url: str | None
    href: str


class SuggestionItemOut(Closed):
    target: Annotated[
        MediaSuggestionTargetOut | FeedSuggestionTargetOut, Field(discriminator="kind")
    ]


class SuggestionPublicationMetaOut(Closed):
    id: UUID


class DailyEditionOut(Closed):
    local_date: date
    time_zone: str
    window_start: datetime
    window_end: datetime
    checked_source_count: int
    source_count: int


class SuggestionPublicationOut(SuggestionPublicationMetaOut):
    edition: DailyEditionOut | None
    items: list[SuggestionItemOut] = Field(max_length=80)


class SuggestionRefreshNowOut(Closed):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Now"] = "Now"


class SuggestionRefreshAtOut(Closed):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["At"] = "At"
    at: datetime


class SuggestionRefreshStoppedOut(Closed):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Stopped"] = "Stopped"


class SuggestionStateOut(Closed):
    input_revision: int
    latest: SuggestionPublicationMetaOut | None
    work: DurableExecutionPhase | None
    capability: Literal["Available", "LecternFull", "NotApplicable"]
    automatic_refresh: Annotated[
        SuggestionRefreshNowOut | SuggestionRefreshAtOut | SuggestionRefreshStoppedOut,
        Field(discriminator="kind"),
    ]


class SuggestionsOut(Closed):
    observed_at: datetime
    state: SuggestionStateOut
    publication: SuggestionPublicationOut | None


class SuggestionViewIn(Closed):
    refs: list[str] = Field(max_length=80)

    @field_validator("refs")
    @classmethod
    def canonical_distinct_targets(cls, refs: list[str]) -> list[str]:
        if len(set(refs)) != len(refs):
            raise ValueError("suggestion refs must be distinct")
        for raw in refs:
            ref = parse_resource_ref(raw)
            if not isinstance(ref, ResourceRef) or ref.scheme not in ("media", "podcast", "feed"):
                raise ValueError("suggestion refs must be canonical media or feed refs")
        return refs


class SuggestionViewOut(Closed):
    observed_at: datetime
    state: SuggestionStateOut
    items: list[SuggestionItemOut] = Field(max_length=80)


class QuickReadsOut(Closed):
    items: list[SuggestionItemOut] = Field(max_length=5)
