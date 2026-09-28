"""One strict stored-media identity and duration wire."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from nexus.db.models import MediaKind
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
    duration: Presence[MediaDurationOut]
