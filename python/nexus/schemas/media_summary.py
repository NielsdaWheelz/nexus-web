"""One stored-media identity, read state, duration and descriptor eligibility wire.

``can_play`` names an episode's application source, independent of its transcript and
processing readiness. It promises neither remote delivery nor audible playback.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from nexus.db.models import MediaKind
from nexus.schemas.contributor_credit import ContributorCreditOut
from nexus.schemas.publication_dates import PublicationDate
from nexus.schemas.reading_time import ReadingTimeEstimateOut
from nexus.schemas.x_source import XArticleContent

MediaProcessingStatus = Literal["pending", "extracting", "ready_for_reading", "failed", "suspended"]
ConsumptionState = Literal["Unread", "InProgress", "Finished"]


class ConsumptionOut(BaseModel):
    """The viewer's read state of the media: the override, else progress, else engagement."""

    model_config = ConfigDict(extra="forbid")

    state: ConsumptionState
    progress: Annotated[float, Field(ge=0, le=1)] | None


class MediaDurationOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    modality: Literal["Read", "Listen"]
    estimate: ReadingTimeEstimateOut


class MediaSummaryOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_id: UUID
    media_kind: MediaKind
    title: str
    contributors: list[ContributorCreditOut]
    original_published_date: PublicationDate | None
    processing_status: MediaProcessingStatus
    consumption: ConsumptionOut
    duration: MediaDurationOut | None
    x_article_content: XArticleContent | None
    can_play: bool


class ResolveMediaSummariesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_ids: list[UUID] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_unique_ids(self) -> "ResolveMediaSummariesIn":
        if len(set(self.media_ids)) != len(self.media_ids):
            raise ValueError("media_ids must not contain duplicates")
        return self


class MediaSummaryResolutionOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    media_id: UUID
    summary: MediaSummaryOut | None


class ResolvedMediaSummariesOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[MediaSummaryResolutionOut]
