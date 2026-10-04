"""Wire contracts for activity capture, exclusions and personal statistics.

The capture body is frozen: the web outbox and the Android app both post it. Raw device ids
arrive only through the BFF; only sealed handles go out.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, BeforeValidator, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.presence import Absent, Presence


def _civil_date(value: object) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
        raise ValueError("Expected YYYY-MM-DD")
    return value


ConsumptionDate = Annotated[date, BeforeValidator(_civil_date)]


ActivityModality = Literal["Reading", "Listening", "Viewing"]
ActivityDeviceClass = Literal["Desktop", "Mobile"]
_Position = Annotated[int, Field(ge=0, le=9_223_372_036_854_775_807)]
_Progress = Annotated[float, Field(ge=0, le=1)]
CompletionHandle = Annotated[str, Field(pattern=r"^ncc1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$")]
DeviceHandle = Annotated[str, Field(pattern=r"^ncd1\.[A-Za-z0-9_-]{22}$")]
ActivityExclusionHandle = Annotated[
    str, Field(pattern=r"^nce1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$")
]


class CamelIn(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=False, extra="forbid")


class CamelOut(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class CommandIn(CamelIn):
    """A write that replays by its ``clientMutationId``."""

    client_mutation_id: UUID


class _Row(CamelOut):
    """Validated from a query row whose columns carry its field names; other columns are ignored."""

    model_config = ConfigDict(extra="ignore")


class _SpanIn(CamelIn):
    capture_key: UUID
    occurred_at: AwareDatetime
    duration_ms: int = Field(gt=0, le=30_000)

    @model_validator(mode="after")
    def _paired(self) -> Self:
        """Each ``*_start`` measurement is present exactly when its ``*_end`` is."""
        for start in (name for name in type(self).model_fields if "_start" in name):
            end = start.replace("_start", "_end")
            if isinstance(getattr(self, start), Absent) != isinstance(getattr(self, end), Absent):
                raise ValueError(
                    f"{to_camel(start)} and {to_camel(end)} must have the same presence"
                )
        return self


class ViewingActivitySpanIn(_SpanIn):
    pass


class ReadingActivitySpanIn(_SpanIn):
    progress_start: Presence[_Progress]
    progress_end: Presence[_Progress]
    word_start: Presence[_Position]
    word_end: Presence[_Position]


class ListeningActivitySpanIn(_SpanIn):
    progress_start: Presence[_Progress]
    progress_end: Presence[_Progress]
    media_position_start_ms: Presence[_Position]
    media_position_end_ms: Presence[_Position]


class ReadingActivityBatchIn(CamelIn):
    modality: Literal["Reading"]
    spans: list[ReadingActivitySpanIn] = Field(min_length=1, max_length=120)


class ListeningActivityBatchIn(CamelIn):
    modality: Literal["Listening"]
    spans: list[ListeningActivitySpanIn] = Field(min_length=1, max_length=120)


class ViewingActivityBatchIn(CamelIn):
    modality: Literal["Viewing"]
    spans: list[ViewingActivitySpanIn] = Field(min_length=1, max_length=120)


ActivityBatchIn = Annotated[
    ReadingActivityBatchIn | ListeningActivityBatchIn | ViewingActivityBatchIn,
    Field(discriminator="modality"),
]


class ActivityRecordIn(CamelIn):
    """``clientMutationId`` is accepted and ignored: the shipped Android app still sends it."""

    client_mutation_id: UUID
    media_ref: str = Field(min_length=1, max_length=100)
    device_id: str = Field(min_length=1, max_length=200)
    device_class: ActivityDeviceClass
    batch: ActivityBatchIn

    @model_validator(mode="after")
    def _distinct_capture_keys(self) -> Self:
        keys = [span.capture_key for span in self.batch.spans]
        if len(keys) != len(set(keys)):
            raise ValueError("captureKey must be unique within one activity batch")
        return self


class ExcludeActivityIn(CommandIn):
    kind: Literal["Exclude"]
    media_ref: str = Field(min_length=1, max_length=100)
    modality: ActivityModality
    device_handle: DeviceHandle
    started_at: AwareDatetime
    ended_at: AwareDatetime


class RestoreActivityExclusionIn(CommandIn):
    kind: Literal["Restore"]
    exclusion_handle: ActivityExclusionHandle


ActivityExclusionIn = Annotated[
    ExcludeActivityIn | RestoreActivityExclusionIn, Field(discriminator="kind")
]


class ActivityExclusionResultOut(CamelOut):
    outcome: Literal["Excluded", "Restored"]
    exclusion_handle: ActivityExclusionHandle


class DeviceSummaryOut(_Row):
    device_handle: DeviceHandle
    label: str


class ActivitySessionOut(_Row):
    media_ref: str
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


class ActivitySessionPageOut(CamelOut):
    items: list[ActivitySessionOut]
    next_cursor: Presence[str]


class ActivityTotalsOut(CamelOut):
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


class LocalDayOut(CamelOut):
    date: date
    active_ms: int


class LocalHourOut(CamelOut):
    hour: int
    active_ms: int


class MediaActivityOut(_Row):
    media_ref: str
    title: str
    active_ms: int
    forward_word_position: int
    forward_media_position_ms: int


class MediaActivityBreakdownOut(CamelOut):
    rows: list[MediaActivityOut]
    other_active_ms: int


class ContributorActivityOut(CamelOut):
    contributor_handle: str
    display_name: str
    roles: list[str]
    active_ms: int


class ContributorActivityBreakdownOut(CamelOut):
    rows: list[ContributorActivityOut]


class DeviceActivityOut(_Row):
    device_handle: DeviceHandle
    label: str
    is_current: bool
    active_ms: int


class ActiveExclusionOut(_Row):
    exclusion_handle: ActivityExclusionHandle
    title: str
    modality: ActivityModality
    device: DeviceSummaryOut
    started_at: datetime
    excluded_active_ms: int


class _Scoped(CamelOut):
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
    sessions: ActivitySessionPageOut
    longest_session: Presence[ActivitySessionOut]
    active_exclusions: list[ActiveExclusionOut]


class MediaCompletionOut(_Row):
    media_ref: str
    title: str
    total: int


class ContributorCompletionOut(CamelOut):
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


class ConsumptionStatsOut(CamelOut):
    activity: ActivityStatsSectionOut
    completion: CompletionStatsSectionOut
    retained_artifacts: RetainedArtifactsOut
