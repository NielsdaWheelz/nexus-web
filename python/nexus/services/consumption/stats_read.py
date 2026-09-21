"""The Stats and Sessions reads: rows in, key-exact wire payloads out.

Raw device ids never leave the server. A device becomes a sealed handle plus a
label — "This device" for the caller's own, otherwise its classes and the date
it was first seen, with an ordinal when two devices would read alike.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, cast
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from nexus.schemas.consumption_activity import (
    ActiveExclusionOut,
    ActivityDeviceClass,
    ActivitySessionOut,
    ActivitySessionPageOut,
    ActivitySessionsOut,
    ActivityStatsSectionOut,
    ActivityTimelineRowOut,
    ActivityTotalsOut,
    CompletionDateOut,
    CompletionStatsSectionOut,
    CompletionTimelineRowOut,
    ConsumptionStatsOut,
    ContributorActivityBreakdownOut,
    ContributorActivityOut,
    ContributorCompletionOut,
    DeviceActivityOut,
    DeviceSummaryOut,
    LocalDayOut,
    LocalHourOut,
    MediaActivityBreakdownOut,
    MediaActivityOut,
    MediaCompletionOut,
    RetainedArtifactsOut,
)
from nexus.schemas.presence import absent, present
from nexus.services.consumption import activity_stats
from nexus.services.consumption.activity_stats import (
    QUALIFYING_DAY_MS,
    ActivityBucket,
    ActivityQuery,
)
from nexus.services.consumption.handles import EXCLUSION, seal, seal_device
from nexus.services.highlights import count_retained_highlights
from nexus.services.notes import count_retained_note_blocks
from nexus.services.resource_graph.user_relations import count_retained_neutral_links

_SESSION_PAGE = 50
_Modality = Literal["Reading", "Listening", "Viewing"]


def activity_sessions(
    db: Session,
    *,
    viewer_id: UUID,
    query: ActivityQuery,
    cursor: str | None,
    limit: int,
    current_device_id: str,
) -> ActivitySessionPageOut:
    """One repeatable-read page of derived sessions, continuing one snapshot."""
    as_of, after = (
        (activity_stats.as_of_created_at(db), None)
        if cursor is None
        else activity_stats.decode_session_cursor(cursor, query=query, db=db, viewer_id=viewer_id)
    )
    page, next_cursor = _session_page(
        db, viewer_id=viewer_id, query=query, as_of=as_of, limit=limit, after=after
    )
    _, devices = _device_projections(
        activity_stats.device_breakdown_rows(db, viewer_id=viewer_id, query=query, as_of=as_of),
        current_device_id=current_device_id,
        time_zone=query.time_zone,
    )
    return ActivitySessionPageOut(
        sessions=[_session_out(row, devices) for row in page],
        next_cursor=present(next_cursor) if next_cursor else absent(),
    )


def consumption_stats(
    db: Session,
    *,
    viewer_id: UUID,
    query: ActivityQuery,
    bucket: ActivityBucket,
    current_device_id: str,
) -> ConsumptionStatsOut:
    """One deterministic personal-history snapshot: every relation shares ``as_of``."""
    as_of = activity_stats.as_of_created_at(db)
    read = {"viewer_id": viewer_id, "query": query, "as_of": as_of}
    totals_rows = activity_stats.activity_totals_rows(db, **read)
    local_days = activity_stats.local_day_rows(db, **read)
    streak = activity_stats.streak_row(db, **read)
    media_activity = activity_stats.media_activity_rows(db, **read)
    media_rows, media_other = activity_stats.top_media_rows(media_activity)
    contributor_rows, contributor_other = activity_stats.top_contributor_rows(db, media_activity)
    completion = activity_stats.completion_stats_rows(db, bucket=bucket, **read)
    devices, device_summaries = _device_projections(
        activity_stats.device_breakdown_rows(db, **read),
        current_device_id=current_device_id,
        time_zone=query.time_zone,
    )
    page, next_cursor = _session_page(
        db, viewer_id=viewer_id, query=query, as_of=as_of, limit=_SESSION_PAGE, after=None
    )
    longest = activity_stats.longest_session_row(db, **read)
    filters = _applied_filters(query)
    return ConsumptionStatsOut(
        activity=ActivityStatsSectionOut(
            applied_filters=["time", *filters],
            inapplicable_filters=[],
            totals=ActivityTotalsOut(
                active_ms=_sum(totals_rows, "active_ms"),
                forward_word_position=_sum(totals_rows, "forward_word_position"),
                forward_media_position_ms=_sum(totals_rows, "forward_media_position_ms"),
                recorded_active_ms=_sum(totals_rows, "recorded_active_ms"),
                excluded_active_ms=_sum(totals_rows, "excluded_active_ms"),
                active_days=sum(int(row["active_ms"]) >= QUALIFYING_DAY_MS for row in local_days),
                streak=streak["streak"],
                longest_streak=streak["longest_streak"],
                session_count=activity_stats.session_count(db, **read),
            ),
            timeline=[
                ActivityTimelineRowOut(**row)
                for row in activity_stats.timeline_rows(db, bucket=bucket, **read)
            ],
            local_days=[
                LocalDayOut(date=row["local_date"], active_ms=int(row["active_ms"]))
                for row in local_days
            ],
            local_hours=[
                LocalHourOut(hour=int(row["hour"]), active_ms=int(row["active_ms"]))
                for row in activity_stats.local_hour_rows(db, **read)
            ],
            media=MediaActivityBreakdownOut(
                rows=[
                    MediaActivityOut(
                        media_ref=f"media:{row['media_id']}",
                        title=str(row["title"]),
                        **_metrics(row),
                    )
                    for row in media_rows
                ],
                other_active_ms=media_other,
            ),
            contributors=ContributorActivityBreakdownOut(
                rows=[
                    ContributorActivityOut(
                        contributor_handle=str(row["contributor_handle"]),
                        display_name=str(row["display_name"]),
                        roles=[str(role) for role in row["roles"]],
                        **_metrics(row),
                    )
                    for row in contributor_rows
                ],
                other_active_ms=contributor_other,
            ),
            devices=devices,
            sessions=ActivitySessionsOut(
                rows=[_session_out(row, device_summaries) for row in page],
                next_cursor=present(next_cursor) if next_cursor else absent(),
            ),
            longest_session=(
                present(_session_out(longest, device_summaries))
                if longest is not None
                else absent()
            ),
            active_exclusions=[
                ActiveExclusionOut(
                    exclusion_handle=seal(EXCLUSION, row["exclusion_id"]),
                    media_ref=f"media:{row['media_id']}",
                    title=str(row["title"]),
                    modality=cast(_Modality, row["modality"]),
                    device=device_summaries[str(row["device_id"])],
                    started_at=row["started_at"],
                    ended_at=row["ended_at"],
                    excluded_active_ms=int(row["excluded_active_ms"]),
                )
                for row in activity_stats.active_exclusion_rows(db, **read)
            ],
        ),
        completion=CompletionStatsSectionOut(
            applied_filters=["time", *(name for name in filters if name != "device")],
            inapplicable_filters=["device"] if query.device_id is not None else [],
            total=int(completion["total"]),
            dates=[
                CompletionDateOut(date=row["date"], total=int(row["total"]))
                for row in completion["dates"]
            ],
            timeline=[CompletionTimelineRowOut(**row) for row in completion["timeline"]],
            media=[
                MediaCompletionOut(
                    media_ref=f"media:{row['media_id']}",
                    title=str(row["title"]),
                    total=int(row["total"]),
                )
                for row in completion["media"]
            ],
            contributors=[
                ContributorCompletionOut(
                    contributor_handle=str(row["contributor_handle"]),
                    display_name=str(row["display_name"]),
                    roles=[str(role) for role in row["roles"]],
                    total=int(row["total"]),
                )
                for row in completion["contributors"]
            ],
            by_modality=completion["by_modality"],
        ),
        retained_artifacts=RetainedArtifactsOut(
            applied_filters=["time"],
            inapplicable_filters=filters,
            highlights=count_retained_highlights(
                db, viewer_id=viewer_id, start=query.start, end=query.end
            ),
            note_blocks=count_retained_note_blocks(
                db, viewer_id=viewer_id, start=query.start, end=query.end
            ),
            neutral_links=count_retained_neutral_links(
                db, viewer_id=viewer_id, start=query.start, end=query.end
            ),
        ),
    )


def _applied_filters(query: ActivityQuery) -> list[str]:
    return [
        name
        for name, value in (
            ("modality", query.modality),
            ("media", query.media_id),
            ("contributor", query.contributor_handle),
            ("device", query.device_id),
        )
        if value is not None
    ]


def _sum(rows: list[dict[str, Any]], key: str) -> int:
    return sum(int(row[key]) for row in rows)


def _metrics(row: dict[str, Any]) -> dict[str, Any]:
    """The three shared activity measures, as constructor keywords."""
    return {
        "active_ms": int(row["active_ms"]),
        "forward_word_position": int(row["forward_word_position"]),
        "forward_media_position_ms": int(row["forward_media_position_ms"]),
    }


def _session_page(
    db: Session,
    *,
    viewer_id: UUID,
    query: ActivityQuery,
    as_of: datetime,
    limit: int,
    after: tuple[datetime, UUID, str, str] | None,
) -> tuple[list[dict[str, Any]], str | None]:
    """One page plus the cursor that continues it, fetched as ``limit + 1`` rows."""
    rows = activity_stats.session_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of, limit=limit, after=after
    )
    page = rows[:limit]
    next_cursor = (
        activity_stats.encode_session_cursor(as_of=as_of, query=query, row=page[-1])
        if len(rows) > limit and page
        else None
    )
    return page, next_cursor


def _session_out(row: dict[str, Any], devices: dict[str, DeviceSummaryOut]) -> ActivitySessionOut:
    first_progress = row["first_progress"]
    last_progress = row["last_progress"]
    return ActivitySessionOut(
        media_ref=f"media:{row['media_id']}",
        title=str(row["title"]),
        modality=cast(_Modality, row["modality"]),
        device=devices[str(row["device_id"])],
        started_at=row["session_start"],
        ended_at=row["session_end"],
        active_ms=int(row["active_ms"]),
        forward_word_position=int(row["forward_word_position"]),
        forward_media_position_ms=int(row["forward_media_position_ms"]),
        first_progress=present(float(first_progress)) if first_progress is not None else absent(),
        last_progress=present(float(last_progress)) if last_progress is not None else absent(),
        continues_before_range=bool(row["continues_before_range"]),
        continues_after_range=bool(row["continues_after_range"]),
    )


def _device_projections(
    rows: list[dict[str, Any]], *, current_device_id: str, time_zone: str
) -> tuple[list[DeviceActivityOut], dict[str, DeviceSummaryOut]]:
    """Seal device identities and derive stable, non-identifying labels."""
    zone = ZoneInfo(time_zone)
    handles = [seal_device(str(row["device_id"])) for row in rows]
    classes = [
        cast(list[ActivityDeviceClass], sorted(str(value) for value in row["device_classes"]))
        for row in rows
    ]
    labels = [
        "This device"
        if str(row["device_id"]) == current_device_id
        else (
            f"{' + '.join(classes[index])} · first seen "
            f"{row['first_seen_at'].astimezone(zone).date().isoformat()}"
        )
        for index, row in enumerate(rows)
    ]
    collisions: dict[str, list[int]] = {}
    for index, label in enumerate(labels):
        if label != "This device":
            collisions.setdefault(label, []).append(index)
    for label, indices in collisions.items():
        if len(indices) < 2:
            continue
        ordered = sorted(indices, key=lambda index: (rows[index]["first_seen_at"], handles[index]))
        for ordinal, index in enumerate(ordered, start=1):
            labels[index] = f"{label} · {ordinal}"

    outputs: list[DeviceActivityOut] = []
    summaries: dict[str, DeviceSummaryOut] = {}
    for index, row in enumerate(rows):
        summaries[str(row["device_id"])] = DeviceSummaryOut(
            device_handle=handles[index], label=labels[index]
        )
        outputs.append(
            DeviceActivityOut(
                device_handle=handles[index],
                label=labels[index],
                first_observed_at=row["first_observed_at"],
                last_observed_at=row["last_observed_at"],
                device_classes=classes[index],
                is_current=str(row["device_id"]) == current_device_id,
                active_ms=int(row["active_ms"]),
            )
        )
    return outputs, summaries
