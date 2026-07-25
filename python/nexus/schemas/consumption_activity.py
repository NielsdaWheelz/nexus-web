"""Strict wire and service inputs for Consumption activity capture.

The browser owns observation; this module owns only the bounded factual batch
it may submit.  Private device identity is deliberately not part of this wire
contract: the BFF injects it at the trusted service boundary.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel
from pydantic_core import core_schema

from nexus.schemas.presence import Absent, Presence

_IN_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=False, extra="forbid")
_INT64_MAX = 9_223_372_036_854_775_807
_MAX_ACTIVITY_SPAN_MS = 30_000

ActivityModality = Literal["Reading", "Listening", "Viewing"]
ActivityDeviceClass = Literal["Desktop", "Mobile"]
_NonNegativeInt64 = Annotated[int, Field(ge=0, le=_INT64_MAX)]
_Progress = Annotated[float, Field(ge=0, le=1)]
_DurationMs = Annotated[int, Field(gt=0, le=_MAX_ACTIVITY_SPAN_MS)]
_COMPLETION_HANDLE_RE = re.compile(r"^ncc1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$")
_DEVICE_HANDLE_RE = re.compile(r"^ncd1\.[A-Za-z0-9_-]{22}$")


class CompletionHandle(str):
    """The sealed outward identity of one first-completion fact."""

    @classmethod
    def _validate(cls, value: str) -> CompletionHandle:
        if not _COMPLETION_HANDLE_RE.fullmatch(value):
            raise ValueError("invalid completion handle")
        return cls(value)

    @classmethod
    def __get_pydantic_core_schema__(
        cls, _source_type: object, _handler: object
    ) -> core_schema.CoreSchema:
        return core_schema.no_info_after_validator_function(cls._validate, core_schema.str_schema())


class DeviceHandle(str):
    """A deterministic one-way outward pseudonym for one private device ID."""

    @classmethod
    def _validate(cls, value: str) -> DeviceHandle:
        if not _DEVICE_HANDLE_RE.fullmatch(value):
            raise ValueError("invalid device handle")
        return cls(value)

    @classmethod
    def __get_pydantic_core_schema__(
        cls, _source_type: object, _handler: object
    ) -> core_schema.CoreSchema:
        return core_schema.no_info_after_validator_function(cls._validate, core_schema.str_schema())


class _ActivitySpanIn(BaseModel):
    model_config = _IN_CONFIG

    occurred_at: datetime
    duration_ms: _DurationMs
    progress_start: Presence[_Progress]
    progress_end: Presence[_Progress]

    @model_validator(mode="after")
    def _require_paired_progress(self) -> _ActivitySpanIn:
        if isinstance(self.progress_start, Absent) != isinstance(self.progress_end, Absent):
            raise ValueError("progressStart and progressEnd must have the same presence")
        return self


class ReadingActivitySpanIn(_ActivitySpanIn):
    word_start: Presence[_NonNegativeInt64]
    word_end: Presence[_NonNegativeInt64]

    @model_validator(mode="after")
    def _require_paired_words(self) -> ReadingActivitySpanIn:
        if isinstance(self.word_start, Absent) != isinstance(self.word_end, Absent):
            raise ValueError("wordStart and wordEnd must have the same presence")
        return self


class ListeningActivitySpanIn(_ActivitySpanIn):
    media_position_start_ms: Presence[_NonNegativeInt64]
    media_position_end_ms: Presence[_NonNegativeInt64]

    @model_validator(mode="after")
    def _require_paired_media_positions(self) -> ListeningActivitySpanIn:
        if isinstance(self.media_position_start_ms, Absent) != isinstance(
            self.media_position_end_ms, Absent
        ):
            raise ValueError(
                "mediaPositionStartMs and mediaPositionEndMs must have the same presence"
            )
        return self


class ViewingActivitySpanIn(BaseModel):
    model_config = _IN_CONFIG

    occurred_at: datetime
    duration_ms: _DurationMs


class ReadingActivityBatchIn(BaseModel):
    model_config = _IN_CONFIG

    modality: Literal["Reading"]
    spans: list[ReadingActivitySpanIn] = Field(min_length=1, max_length=120)


class ListeningActivityBatchIn(BaseModel):
    model_config = _IN_CONFIG

    modality: Literal["Listening"]
    spans: list[ListeningActivitySpanIn] = Field(min_length=1, max_length=120)


class ViewingActivityBatchIn(BaseModel):
    model_config = _IN_CONFIG

    modality: Literal["Viewing"]
    spans: list[ViewingActivitySpanIn] = Field(min_length=1, max_length=120)


ActivityBatchIn = Annotated[
    ReadingActivityBatchIn | ListeningActivityBatchIn | ViewingActivityBatchIn,
    Field(discriminator="modality"),
]


class ActivityRecordIn(BaseModel):
    """Trusted backend activity record; the BFF alone injects ``deviceId``."""

    model_config = _IN_CONFIG

    client_mutation_id: UUID
    media_id: UUID
    device_id: str = Field(min_length=1, max_length=200)
    device_class: ActivityDeviceClass
    batch: ActivityBatchIn


_OUT_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class DeviceSummaryOut(BaseModel):
    model_config = _OUT_CONFIG

    device_handle: DeviceHandle
    label: str


class ActivitySessionOut(BaseModel):
    model_config = _OUT_CONFIG

    media_ref: str
    title: str
    modality: ActivityModality
    device: DeviceSummaryOut
    started_at: datetime
    ended_at: datetime
    active_ms: int = Field(ge=0)
    forward_word_position: int = Field(ge=0)
    forward_media_position_ms: int = Field(ge=0)
    first_progress: Presence[float]
    last_progress: Presence[float]
    continues_before_range: bool
    continues_after_range: bool


class ActivitySessionPageOut(BaseModel):
    model_config = _OUT_CONFIG

    sessions: list[ActivitySessionOut]
    next_cursor: Presence[str]


class ActivityMetricsOut(BaseModel):
    model_config = _OUT_CONFIG

    active_ms: int = Field(ge=0)
    forward_word_position: int = Field(ge=0)
    forward_media_position_ms: int = Field(ge=0)


class ActivityTotalsOut(ActivityMetricsOut):
    active_days: int = Field(ge=0)
    streak: int = Field(ge=0)
    longest_streak: int = Field(ge=0)
    session_count: int = Field(ge=0)


class ActivityTimelineRowOut(ActivityMetricsOut):
    start: datetime
    end: datetime
    local_label: str
    utc_offset_minutes: int
    reading_active_ms: int = Field(ge=0)
    listening_active_ms: int = Field(ge=0)
    viewing_active_ms: int = Field(ge=0)


class LocalDayOut(BaseModel):
    model_config = _OUT_CONFIG

    date: date
    active_ms: int = Field(ge=0)


class LocalHourOut(BaseModel):
    model_config = _OUT_CONFIG

    hour: int = Field(ge=0, le=23)
    active_ms: int = Field(ge=0)


class MediaActivityOut(ActivityMetricsOut):
    media_ref: str
    title: str


class MediaActivityBreakdownOut(BaseModel):
    model_config = _OUT_CONFIG

    rows: list[MediaActivityOut]
    other_active_ms: int = Field(ge=0)


class ContributorActivityOut(ActivityMetricsOut):
    contributor_handle: str
    display_name: str
    roles: list[str]


class ContributorActivityBreakdownOut(BaseModel):
    model_config = _OUT_CONFIG

    rows: list[ContributorActivityOut]
    other_active_ms: int = Field(ge=0)
    non_additive: Literal[True] = True


class DeviceActivityOut(BaseModel):
    model_config = _OUT_CONFIG

    device_handle: DeviceHandle
    label: str
    first_observed_at: datetime
    last_observed_at: datetime
    device_classes: list[ActivityDeviceClass]
    is_current: bool
    active_ms: int = Field(ge=0)


class ActivitySessionsOut(BaseModel):
    model_config = _OUT_CONFIG

    rows: list[ActivitySessionOut]
    next_cursor: Presence[str]


class ScopedSectionOut(BaseModel):
    model_config = _OUT_CONFIG

    applied_filters: list[str]
    inapplicable_filters: list[str]


class ActivityStatsSectionOut(ScopedSectionOut):
    totals: ActivityTotalsOut
    timeline: list[ActivityTimelineRowOut]
    local_days: list[LocalDayOut]
    local_hours: list[LocalHourOut]
    media: MediaActivityBreakdownOut
    contributors: ContributorActivityBreakdownOut
    devices: list[DeviceActivityOut]
    sessions: ActivitySessionsOut
    longest_session: Presence[ActivitySessionOut]


class CompletionDateOut(BaseModel):
    model_config = _OUT_CONFIG

    date: date
    total: int = Field(ge=0)


class CompletionTimelineRowOut(BaseModel):
    model_config = _OUT_CONFIG

    start: datetime
    end: datetime
    local_label: str
    total: int = Field(ge=0)


class MediaCompletionOut(BaseModel):
    model_config = _OUT_CONFIG

    media_ref: str
    title: str
    total: int = Field(ge=0)


class ContributorCompletionOut(BaseModel):
    model_config = _OUT_CONFIG

    contributor_handle: str
    display_name: str
    roles: list[str]
    total: int = Field(ge=0)


class CompletionStatsSectionOut(ScopedSectionOut):
    total: int = Field(ge=0)
    dates: list[CompletionDateOut]
    timeline: list[CompletionTimelineRowOut]
    media: list[MediaCompletionOut]
    contributors: list[ContributorCompletionOut]
    by_modality: dict[ActivityModality, int]


class RetainedArtifactsOut(ScopedSectionOut):
    period_wide: Literal[True] = True
    highlights: int = Field(ge=0)
    note_blocks: int = Field(ge=0)
    neutral_links: int = Field(ge=0)


class ConsumptionStatsOut(BaseModel):
    model_config = _OUT_CONFIG

    activity: ActivityStatsSectionOut
    completion: CompletionStatsSectionOut
    retained_artifacts: RetainedArtifactsOut
