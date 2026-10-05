"""Wire contracts for activity exclusions and personal statistics; capture-in lives in
:mod:`nexus.schemas.consumption`. Only sealed handles go out.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, BeforeValidator, ConfigDict, Field

from nexus.schemas.consumption import ActivityModality, CamelOut, CommandIn
from nexus.schemas.presence import Presence


def _civil_date(value: object) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
        raise ValueError("Expected YYYY-MM-DD")
    return value


ConsumptionDate = Annotated[date, BeforeValidator(_civil_date)]


DeviceHandle = Annotated[str, Field(pattern=r"^ncd1\.[A-Za-z0-9_-]{22}$")]
ActivityExclusionHandle = Annotated[
    str, Field(pattern=r"^nce1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$")
]


class _Row(CamelOut):
    """Validated from a query row whose columns carry its field names; other columns are ignored."""

    model_config = ConfigDict(extra="ignore")


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
