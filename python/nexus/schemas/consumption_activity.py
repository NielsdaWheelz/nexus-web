"""Observed activity wire: capture in (web and android), session exclusions and personal
records out. Devices are the opaque stored ids the bff names; nothing is sealed."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, ConfigDict, Field, model_validator

from nexus.schemas.consumption import Closed
from nexus.schemas.media_summary import MediaSummaryOut

ActivityModality = Literal["Reading", "Listening", "Viewing"]
ActivityDeviceClass = Literal["Desktop", "Mobile"]
_Position = Annotated[int, Field(ge=0, le=9_223_372_036_854_775_807)]
_Progress = Annotated[float, Field(ge=0, le=1)]


class _Row(Closed):
    """Built from a query row whose columns carry its field names."""

    model_config = ConfigDict(extra="ignore")


class _SpanIn(Closed):
    capture_key: UUID
    occurred_at: AwareDatetime
    duration_ms: int = Field(gt=0, le=30_000)

    @model_validator(mode="after")
    def _paired(self) -> Self:
        """Each ``*_start`` measurement is present exactly when its ``*_end`` is."""
        for start in (name for name in type(self).model_fields if "_start" in name):
            end = start.replace("_start", "_end")
            if (getattr(self, start) is None) != (getattr(self, end) is None):
                raise ValueError(f"{start} and {end} must have the same presence")
        return self


class ViewingActivitySpanIn(_SpanIn):
    pass


class ReadingActivitySpanIn(_SpanIn):
    progress_start: _Progress | None
    progress_end: _Progress | None
    word_start: _Position | None
    word_end: _Position | None


class ListeningActivitySpanIn(_SpanIn):
    progress_start: _Progress | None
    progress_end: _Progress | None
    media_position_start_ms: _Position | None
    media_position_end_ms: _Position | None


class ReadingActivityBatchIn(Closed):
    modality: Literal["Reading"]
    spans: list[ReadingActivitySpanIn] = Field(min_length=1, max_length=120)


class ListeningActivityBatchIn(Closed):
    modality: Literal["Listening"]
    spans: list[ListeningActivitySpanIn] = Field(min_length=1, max_length=120)


class ViewingActivityBatchIn(Closed):
    modality: Literal["Viewing"]
    spans: list[ViewingActivitySpanIn] = Field(min_length=1, max_length=120)


ActivityBatchIn = Annotated[
    ReadingActivityBatchIn | ListeningActivityBatchIn | ViewingActivityBatchIn,
    Field(discriminator="modality"),
]


class ActivityRecordIn(Closed):
    """A batch of one media, modality and device class; the device is the header the bff
    stamps (I13)."""

    media_id: UUID
    device_class: ActivityDeviceClass
    batch: ActivityBatchIn

    @model_validator(mode="after")
    def _distinct_capture_keys(self) -> Self:
        keys = [span.capture_key for span in self.batch.spans]
        if len(keys) != len(set(keys)):
            raise ValueError("capture_key must be unique within one activity batch")
        return self


class ExcludeSessionIn(Closed):
    """One exact all-time session (``PUT /consumption/exclusions/{id}``)."""

    media_id: UUID
    modality: ActivityModality
    device_id: str = Field(min_length=1, max_length=200)
    started_at: AwareDatetime
    ended_at: AwareDatetime


class DayOut(Closed):
    date: date
    active_ms: int
    level: int
    finished: int


class SlipOut(Closed):
    weeks_running: int
    weeks_entire: int
    days_read: int
    days: list[DayOut]


class OpenWorkOut(Closed):
    media: MediaSummaryOut
    position: float | None
    covered: list[tuple[float, float]]
    thickness_mm: float
    active_ms: int


class StackWorkOut(Closed):
    media: MediaSummaryOut
    finished_on: date
    words: int | None
    thickness_mm: float
    active_ms: int


class StackYearOut(Closed):
    year: int
    height_mm: float
    works: list[StackWorkOut]


class SittingRecordOut(Closed):
    media: MediaSummaryOut
    started_at: AwareDatetime
    active_ms: int


class DayRecordOut(Closed):
    date: date
    active_ms: int


class WorkLengthOut(Closed):
    media: MediaSummaryOut
    words: int


class RecordsOut(Closed):
    longest_sitting: SittingRecordOut | None
    fullest_day: DayRecordOut | None
    longest_work: WorkLengthOut | None
    observed_ms: int
    first_day: date | None


class UnitOut(Closed):
    label: str | None
    start: float
    end: float
    weight: float
    part: int | None


class WorkRecordOut(Closed):
    media: MediaSummaryOut
    words: int | None
    thickness_mm: float
    unit: Literal["Chapter", "Section", "Page"] | None
    parts: list[str]
    units: list[UnitOut]
    position: float | None
    covered: list[tuple[float, float]]
    full_read_ms: int | None
    sittings: int
    active_ms: int
    first_read_on: date | None
    finished_on: date | None
    days: list[DayOut]


class RecordOut(Closed):
    time_zone: str
    today: date
    slip: SlipOut
    open: list[OpenWorkOut]
    in_hand: WorkRecordOut | None
    stack: list[StackYearOut]
    lifetime_mm: float
    records: RecordsOut


class SittingOut(_Row):
    media_id: UUID
    title: str
    modality: ActivityModality
    device_id: str
    started_at: datetime
    ended_at: datetime
    active_ms: int
    day: date
    from_place: float | None
    to_place: float | None
    exclusion_id: UUID | None
