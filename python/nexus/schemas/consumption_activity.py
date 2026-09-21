"""Wire contracts for Consumption activity capture, exclusions, and statistics.

The browser and the Android shell own observation; this module owns the bounded
factual batch they may submit and the key-exact statistics payload the Stats
pane decodes. Private device identity never appears here: the BFF injects
``deviceId`` at the trusted service boundary and only sealed handles go out.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from nexus.schemas.presence import Absent, Presence

_INT64_MAX = 9_223_372_036_854_775_807
_MAX_ACTIVITY_SPAN_MS = 30_000


class _In(BaseModel):
    """Strict camelCase ingress: no snake aliases, no unknown keys."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=False, extra="forbid")


class _Out(BaseModel):
    """Strict camelCase egress: built with snake names, serialized by alias."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


ActivityModality = Literal["Reading", "Listening", "Viewing"]
ActivityDeviceClass = Literal["Desktop", "Mobile"]
_NonNegativeInt64 = Annotated[int, Field(ge=0, le=_INT64_MAX)]
_Progress = Annotated[float, Field(ge=0, le=1)]
_DurationMs = Annotated[int, Field(gt=0, le=_MAX_ACTIVITY_SPAN_MS)]

CompletionHandle = Annotated[str, Field(pattern=r"^ncc1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$")]
DeviceHandle = Annotated[str, Field(pattern=r"^ncd1\.[A-Za-z0-9_-]{22}$")]
ActivityExclusionHandle = Annotated[
    str, Field(pattern=r"^nce1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$")
]


def _require_paired(label: str, first: object, second: object) -> None:
    """Both halves of an optional measurement are present, or neither is."""
    if isinstance(first, Absent) != isinstance(second, Absent):
        raise ValueError(f"{label} must have the same presence")


class _ActivitySpanIn(_In):
    capture_key: UUID
    occurred_at: AwareDatetime
    duration_ms: _DurationMs
    progress_start: Presence[_Progress]
    progress_end: Presence[_Progress]

    @model_validator(mode="after")
    def _paired_progress(self) -> _ActivitySpanIn:
        _require_paired("progressStart and progressEnd", self.progress_start, self.progress_end)
        return self


class ReadingActivitySpanIn(_ActivitySpanIn):
    word_start: Presence[_NonNegativeInt64]
    word_end: Presence[_NonNegativeInt64]

    @model_validator(mode="after")
    def _paired_words(self) -> ReadingActivitySpanIn:
        _require_paired("wordStart and wordEnd", self.word_start, self.word_end)
        return self


class ListeningActivitySpanIn(_ActivitySpanIn):
    media_position_start_ms: Presence[_NonNegativeInt64]
    media_position_end_ms: Presence[_NonNegativeInt64]

    @model_validator(mode="after")
    def _paired_media_positions(self) -> ListeningActivitySpanIn:
        _require_paired(
            "mediaPositionStartMs and mediaPositionEndMs",
            self.media_position_start_ms,
            self.media_position_end_ms,
        )
        return self


class ViewingActivitySpanIn(_In):
    capture_key: UUID
    occurred_at: AwareDatetime
    duration_ms: _DurationMs


class ReadingActivityBatchIn(_In):
    modality: Literal["Reading"]
    spans: list[ReadingActivitySpanIn] = Field(min_length=1, max_length=120)


class ListeningActivityBatchIn(_In):
    modality: Literal["Listening"]
    spans: list[ListeningActivitySpanIn] = Field(min_length=1, max_length=120)


class ViewingActivityBatchIn(_In):
    modality: Literal["Viewing"]
    spans: list[ViewingActivitySpanIn] = Field(min_length=1, max_length=120)


ActivityBatchIn = Annotated[
    ReadingActivityBatchIn | ListeningActivityBatchIn | ViewingActivityBatchIn,
    Field(discriminator="modality"),
]
ActivitySpanIn = ReadingActivitySpanIn | ListeningActivitySpanIn | ViewingActivitySpanIn


class ActivityRecordIn(_In):
    """Trusted backend activity record; the BFF alone injects ``deviceId``.

    ``clientMutationId`` is a wire no-op the shipped Android app still sends
    (ticket oi-170); ``extra="forbid"`` means it must stay declared.
    """

    client_mutation_id: UUID
    media_ref: str = Field(min_length=1, max_length=100)
    device_id: str = Field(min_length=1, max_length=200)
    device_class: ActivityDeviceClass
    batch: ActivityBatchIn

    @model_validator(mode="after")
    def _distinct_capture_keys(self) -> ActivityRecordIn:
        capture_keys = [span.capture_key for span in self.batch.spans]
        if len(capture_keys) != len(set(capture_keys)):
            raise ValueError("captureKey must be unique within one activity batch")
        return self


class ExcludeActivityIn(_In):
    kind: Literal["Exclude"]
    client_mutation_id: UUID
    media_ref: str = Field(min_length=1, max_length=100)
    modality: ActivityModality
    device_handle: DeviceHandle
    started_at: AwareDatetime
    ended_at: AwareDatetime


class RestoreActivityExclusionIn(_In):
    kind: Literal["Restore"]
    client_mutation_id: UUID
    exclusion_handle: ActivityExclusionHandle


ActivityExclusionIn = Annotated[
    ExcludeActivityIn | RestoreActivityExclusionIn,
    Field(discriminator="kind"),
]


class ActivityExclusionResultOut(_Out):
    outcome: Literal["Excluded", "Restored"]
    exclusion_handle: ActivityExclusionHandle


class DeviceSummaryOut(_Out):
    device_handle: DeviceHandle
    label: str


class ActivitySessionOut(_Out):
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


class ActivitySessionPageOut(_Out):
    sessions: list[ActivitySessionOut]
    next_cursor: Presence[str]


class ActivitySessionsOut(_Out):
    """The same session rows inside the Stats payload, keyed ``rows``."""

    rows: list[ActivitySessionOut]
    next_cursor: Presence[str]


class ActivityMetricsOut(_Out):
    active_ms: int = Field(ge=0)
    forward_word_position: int = Field(ge=0)
    forward_media_position_ms: int = Field(ge=0)


class ActivityTotalsOut(ActivityMetricsOut):
    recorded_active_ms: int = Field(ge=0)
    excluded_active_ms: int = Field(ge=0)
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


class LocalDayOut(_Out):
    date: date
    active_ms: int = Field(ge=0)


class LocalHourOut(_Out):
    hour: int = Field(ge=0, le=23)
    active_ms: int = Field(ge=0)


class MediaActivityOut(ActivityMetricsOut):
    media_ref: str
    title: str


class MediaActivityBreakdownOut(_Out):
    rows: list[MediaActivityOut]
    other_active_ms: int = Field(ge=0)


class ContributorActivityOut(ActivityMetricsOut):
    contributor_handle: str
    display_name: str
    roles: list[str]


class ContributorActivityBreakdownOut(_Out):
    rows: list[ContributorActivityOut]
    other_active_ms: int = Field(ge=0)
    non_additive: Literal[True] = True


class DeviceActivityOut(_Out):
    device_handle: DeviceHandle
    label: str
    first_observed_at: datetime
    last_observed_at: datetime
    device_classes: list[ActivityDeviceClass]
    is_current: bool
    active_ms: int = Field(ge=0)


class ActiveExclusionOut(_Out):
    exclusion_handle: ActivityExclusionHandle
    media_ref: str
    title: str
    modality: ActivityModality
    device: DeviceSummaryOut
    started_at: datetime
    ended_at: datetime
    excluded_active_ms: int = Field(ge=0)


class ScopedSectionOut(_Out):
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
    active_exclusions: list[ActiveExclusionOut]


class CompletionDateOut(_Out):
    date: date
    total: int = Field(ge=0)


class CompletionTimelineRowOut(_Out):
    start: datetime
    end: datetime
    local_label: str
    total: int = Field(ge=0)


class MediaCompletionOut(_Out):
    media_ref: str
    title: str
    total: int = Field(ge=0)


class ContributorCompletionOut(_Out):
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


class ConsumptionStatsOut(_Out):
    activity: ActivityStatsSectionOut
    completion: CompletionStatsSectionOut
    retained_artifacts: RetainedArtifactsOut
