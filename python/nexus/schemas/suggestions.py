"""Suggestion targets; viewer consumption belongs to the media summary."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import ConfigDict, Field, RootModel, field_validator

from nexus.jobs.queue import DurableExecutionPhase
from nexus.schemas.consumption import CamelIn, CamelOut
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.schemas.presence import Presence
from nexus.services.resource_graph.refs import ResourceRef, parse_resource_ref


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


class SuggestionPublicationMetaOut(CamelOut):
    id: UUID
    as_of: datetime
    input_revision: int


class SuggestionPublicationOut(SuggestionPublicationMetaOut):
    items: list[SuggestionItemOut] = Field(max_length=80)


class SuggestionRefreshNowOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Now"] = "Now"


class SuggestionRefreshAtOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["At"] = "At"
    at: datetime


class SuggestionRefreshStoppedOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Stopped"] = "Stopped"


class SuggestionStateOut(CamelOut):
    input_revision: int
    latest: Presence[SuggestionPublicationMetaOut]
    work: Presence[DurableExecutionPhase]
    capability: Literal["Available", "LecternFull", "NotApplicable"]
    automatic_refresh: Annotated[
        SuggestionRefreshNowOut | SuggestionRefreshAtOut | SuggestionRefreshStoppedOut,
        Field(discriminator="kind"),
    ]


class SuggestionsOut(CamelOut):
    observed_at: datetime
    state: SuggestionStateOut
    publication: Presence[SuggestionPublicationOut]


class SuggestionViewIn(CamelIn):
    refs: list[str] = Field(max_length=80)

    @field_validator("refs")
    @classmethod
    def canonical_distinct_targets(cls, refs: list[str]) -> list[str]:
        if len(set(refs)) != len(refs):
            raise ValueError("suggestion refs must be distinct")
        for raw in refs:
            ref = parse_resource_ref(raw)
            if not isinstance(ref, ResourceRef) or ref.scheme not in ("media", "podcast"):
                raise ValueError("suggestion refs must be canonical media or podcast refs")
        return refs


class SuggestionViewOut(CamelOut):
    observed_at: datetime
    state: SuggestionStateOut
    items: list[SuggestionItemOut] = Field(max_length=80)


class SuggestionEnsureFreshIn(CamelIn):
    kind: Literal["EnsureFresh"]


class SuggestionExplicitRefreshIn(CamelIn):
    kind: Literal["Explicit"]
    observed_publication_id: Presence[UUID]


type SuggestionRefreshIn = Annotated[
    SuggestionEnsureFreshIn | SuggestionExplicitRefreshIn, Field(discriminator="kind")
]


class SuggestionCurrentOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Current"] = "Current"
    state: SuggestionStateOut


class SuggestionWithdrawnOut(CamelOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    kind: Literal["Withdrawn"] = "Withdrawn"


class SuggestionObservationOut(
    RootModel[Annotated[SuggestionCurrentOut | SuggestionWithdrawnOut, Field(discriminator="kind")]]
):
    pass


class QuickReadsOut(CamelOut):
    items: list[SuggestionItemOut] = Field(max_length=5)
