"""Observed activity wire: capture in (web and android), session exclusions and personal
statistics out. Devices are the opaque stored ids the bff names; nothing is sealed."""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BeforeValidator, ConfigDict, Field, model_validator

from nexus.schemas.consumption import Closed

ActivityModality = Literal["Reading", "Listening", "Viewing"]
ActivityDeviceClass = Literal["Desktop", "Mobile"]
_Position = Annotated[int, Field(ge=0, le=9_223_372_036_854_775_807)]
_Progress = Annotated[float, Field(ge=0, le=1)]


def _civil_date(value: object) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
        raise ValueError("Expected YYYY-MM-DD")
    return value


ConsumptionDate = Annotated[date, BeforeValidator(_civil_date)]


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


class DeviceSummaryOut(_Row):
    device_id: str
    label: str


class ActivitySessionOut(_Row):
    media_id: UUID
    title: str
    modality: ActivityModality
    device: DeviceSummaryOut
    started_at: datetime
    ended_at: datetime
    active_ms: int
    forward_word_position: int
    forward_media_position_ms: int
    continues_before_range: bool
    continues_after_range: bool


class ActivitySessionPageOut(Closed):
    items: list[ActivitySessionOut]
    next_cursor: str | None


class ActivityTotalsOut(Closed):
    active_ms: int
    recorded_active_ms: int
    forward_word_position: int
    forward_media_position_ms: int
    active_days: int
    streak: int
    longest_streak: int
    session_count: int


class ActivityTimelineRowOut(_Row):
    start: datetime
    end: datetime
    local_label: str
    utc_offset_minutes: int
    reading_active_ms: int
    listening_active_ms: int
    viewing_active_ms: int
    active_ms: int


class LocalDayOut(Closed):
    date: date
    active_ms: int


class LocalHourOut(Closed):
    hour: int
    active_ms: int


class MediaActivityOut(_Row):
    media_id: UUID
    title: str
    active_ms: int
    forward_word_position: int
    forward_media_position_ms: int


class MediaActivityBreakdownOut(Closed):
    rows: list[MediaActivityOut]
    other_active_ms: int


class ContributorActivityOut(Closed):
    contributor_handle: str
    display_name: str
    roles: list[str]
    active_ms: int


class ContributorActivityBreakdownOut(Closed):
    rows: list[ContributorActivityOut]


class DeviceActivityOut(_Row):
    device_id: str
    label: str
    is_current: bool
    active_ms: int


class ActiveExclusionOut(_Row):
    id: UUID
    title: str
    modality: ActivityModality
    device: DeviceSummaryOut
    started_at: datetime
    excluded_active_ms: int


class _Scoped(Closed):
    applied_filters: list[str]
    inapplicable_filters: list[str]


class ActivityStatsSectionOut(_Scoped):
    totals: ActivityTotalsOut
    timeline: list[ActivityTimelineRowOut]
    local_days: list[LocalDayOut]
    local_hours: list[LocalHourOut]
    media: MediaActivityBreakdownOut
    contributors: ContributorActivityBreakdownOut
    devices: list[DeviceActivityOut]
    longest_session: ActivitySessionOut | None
    active_exclusions: list[ActiveExclusionOut]


class MediaCompletionOut(_Row):
    media_id: UUID
    title: str
    total: int


class ContributorCompletionOut(Closed):
    contributor_handle: str
    display_name: str
    roles: list[str]
    total: int


class CompletionStatsSectionOut(_Scoped):
    total: int
    media: list[MediaCompletionOut]
    contributors: list[ContributorCompletionOut]


class RetainedArtifactsOut(_Scoped):
    highlights: int
    note_blocks: int
    neutral_links: int


class ConsumptionStatsOut(Closed):
    activity: ActivityStatsSectionOut
    completion: CompletionStatsSectionOut
    retained_artifacts: RetainedArtifactsOut
