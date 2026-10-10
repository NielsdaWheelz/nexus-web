"""One strict stored-media identity and duration wire."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.db.models import MediaKind
from nexus.schemas.consumption_state import ConsumptionOut
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.presence import Presence
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.reading_time import ReadingTimeEstimateOut

MediaProcessingStatus = Literal["pending", "extracting", "ready_for_reading", "failed", "suspended"]


class MediaDurationOut(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    modality: Literal["Read", "Listen"]
    estimate: ReadingTimeEstimateOut


class MediaSummaryOut(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    media_id: UUID
    media_kind: MediaKind
    title: str
    contributors: list[ContributorCreditOut]
    original_published_date: Presence[PublicationDate]
    processing_status: MediaProcessingStatus
    consumption: ConsumptionOut
    duration: Presence[MediaDurationOut]


class ResolveMediaSummariesIn(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=False, extra="forbid")

    media_ids: list[UUID] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_unique_ids(self) -> "ResolveMediaSummariesIn":
        if len(set(self.media_ids)) != len(self.media_ids):
            raise ValueError("mediaIds must not contain duplicates")
        return self


class MediaSummaryResolutionOut(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

    media_id: UUID
    summary: Presence[MediaSummaryOut]


class ResolvedMediaSummariesOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[MediaSummaryResolutionOut]
