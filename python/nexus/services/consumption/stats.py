"""Personal history: one read-time projection over the viewer's spans.

Every query starts from ``flagged``: visible spans created by ``as_of``, overlapping the range
widened by the 30-minute session gap, each flagged ``in_range``, clipped to the range and
``excluded`` when it lies wholly inside an exclusion active at ``as_of``. Sessions are
gap-and-island projections over ``(media_id, modality, device_id)``, never stored rows. A
session cursor carries ``as_of`` and a hash of its scope, so every page continues page one.
"""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import InvalidRequestError
from nexus.schemas import consumption_activity as wire
from nexus.schemas.presence import Absent, Present, absent, present
from nexus.services.consumption.handles import EXCLUSION, seal, seal_device
from nexus.services.contributor_credits import current_media_contributor_rows_sql
from nexus.services.contributor_taxonomy import try_parse_contributor_handle
from nexus.services.highlights import count_retained_highlights
from nexus.services.notes import count_retained_note_blocks
from nexus.services.resource_graph.user_relations import count_retained_neutral_links

Bucket = Literal["Hour", "Day", "Week", "Month", "Year"]
_LABEL = {
    "Hour": "%Y-%m-%d %H:00",
    "Day": "%Y-%m-%d",
    "Week": "Week of %Y-%m-%d",
    "Month": "%Y-%m",
    "Year": "%Y",
}
_FLOOR = datetime(1970, 1, 1, tzinfo=UTC)
_MINIMUM = datetime.min.replace(tzinfo=UTC)
_MAXIMUM = datetime.max.replace(tzinfo=UTC)
_CONTEXT = timedelta(minutes=30)
_QUALIFYING_DAY_MS = 300_000
_TOP = 25
_PAGE = 50
_NEWEST = "started_at DESC, media_id DESC, modality DESC, device_id DESC"


@dataclass(frozen=True, slots=True)
class Scope:
    viewer_id: UUID
    start: datetime | None
    end: datetime
    time_zone: str
    current_device_id: str
    modality: wire.ActivityModality | None = None
    media_id: UUID | None = None
    contributor: str | None = None
    device_id: str | None = None


def _calendar_edge_sql(edge: str) -> str:
    """The existing three-hour rule for one local calendar edge."""
    early = f"(({edge} - interval '3 hours') AT TIME ZONE :time_zone + interval '3 hours')"
    return f"""CASE WHEN {early} AT TIME ZONE :time_zone = {edge} THEN {early}
                    ELSE {edge} AT TIME ZONE :time_zone END"""


def resolve_scope(
    db: Session,
    *,
    viewer_id: UUID,
    start: date | None,
    end: date,
    time_zone: str,
    current_device_id: str,
    modality: wire.ActivityModality | None,
    media_id: UUID | None,
    contributor_handle: str | None,
    device_handle: str | None,
) -> Scope:
    """Civil bounds resolved once to UTC; 400 for invalid ranges, zones or handles."""
    if start is not None and start > end:
        raise InvalidRequestError(message="Invalid Consumption range")
    try:
        ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise InvalidRequestError(message="Invalid timeZone") from exc
    edges = db.execute(
        text(f"""WITH dates AS (
            SELECT CAST(:start AS date)::timestamp AS local_start,
                   CAST(:end AS date)::timestamp AS local_end
        ), resolved AS (
            SELECT {_calendar_edge_sql("local_start")} AS start,
                   {_calendar_edge_sql("local_end")} AS "end"
            FROM dates
        )
        SELECT start AT TIME ZONE 'UTC' AS start, "end" AT TIME ZONE 'UTC' AS "end"
        FROM resolved
        WHERE (start IS NULL OR start BETWEEN :minimum AND :maximum)
          AND "end" BETWEEN :minimum AND :maximum"""),
        {
            "start": start,
            "end": end,
            "time_zone": time_zone,
            "minimum": _MINIMUM,
            "maximum": _MAXIMUM,
        },
    ).one_or_none()
    if edges is None:
        raise InvalidRequestError(message="Invalid Consumption range")
    resolved_start = edges.start.replace(tzinfo=UTC) if edges.start is not None else None
    resolved_end = edges.end.replace(tzinfo=UTC)
    if resolved_start is not None and resolved_start > resolved_end:
        raise InvalidRequestError(message="Invalid Consumption range")
    contributor = try_parse_contributor_handle(contributor_handle) if contributor_handle else None
    if contributor_handle and contributor is None:
        raise InvalidRequestError(message="Invalid contributorHandle")
    device_id = (
        resolve_device(db, viewer_id=viewer_id, handle=device_handle) if device_handle else None
    )
    return Scope(
        viewer_id=viewer_id,
        start=resolved_start,
        end=resolved_end,
        time_zone=time_zone,
        current_device_id=current_device_id,
        modality=modality,
        media_id=media_id,
        contributor=contributor,
        device_id=device_id,
    )


def resolve_device(db: Session, *, viewer_id: UUID, handle: str) -> str:
    """The viewer's own device behind a sealed handle; nobody else's devices are scanned."""
    for device_id in db.scalars(
        text("SELECT DISTINCT device_id FROM consumption_activity_spans WHERE user_id = :id"),
        {"id": viewer_id},
    ):
        if seal_device(device_id) == handle:
            return device_id
    raise InvalidRequestError(message="Invalid deviceHandle")


def _filters(scope: Scope, alias: str, *, device: bool = True) -> str:
    clauses = [
        f"AND {alias}.{column} = :{column}"
        for column, value in (
            ("modality", scope.modality),
            ("media_id", scope.media_id),
            ("device_id", scope.device_id if device else None),
        )
        if value is not None
    ]
    if scope.contributor is not None:
        clauses.append(f"""AND EXISTS (
            SELECT 1 FROM ({current_media_contributor_rows_sql()}) credit
            WHERE credit.media_id = {alias}.media_id AND credit.handle = :contributor)""")
    return "\n".join(clauses)


def _params(scope: Scope, as_of: datetime) -> dict[str, Any]:
    start = scope.start or _FLOOR
    return asdict(scope) | {
        "start": start,
        "as_of": as_of,
        "context_start": start - _CONTEXT if start >= _MINIMUM + _CONTEXT else _MINIMUM,
        "context_end": scope.end + _CONTEXT if scope.end <= _MAXIMUM - _CONTEXT else _MAXIMUM,
        "minimum": _MINIMUM,
        "maximum": _MAXIMUM,
    }


def _flagged_sql(scope: Scope) -> str:
    """The base relation every history query starts from, as a ``flagged`` CTE."""
    return f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()}),
        spans AS (
            SELECT s.id, s.media_id, s.modality, s.device_id, s.device_class, s.occurred_at,
                   s.occurred_at + s.duration_ms * interval '1 millisecond' AS span_end, m.title,
                   greatest(0, coalesce(s.word_end - s.word_start, 0)) AS word_delta,
                   greatest(0, coalesce(s.media_position_end_ms - s.media_position_start_ms, 0))
                       AS media_delta
            FROM consumption_activity_spans s
            JOIN visible_media vm ON vm.media_id = s.media_id
            JOIN media m ON m.id = s.media_id
            WHERE s.user_id = :viewer_id AND s.created_at <= :as_of
              AND s.occurred_at < :context_end
              AND s.occurred_at + s.duration_ms * interval '1 millisecond' > :context_start
              {_filters(scope, "s")}
        ), clipped AS (
            SELECT spans.*, :start < :end AND occurred_at < :end AND span_end > :start AS in_range,
                   GREATEST(occurred_at, :start) AS clipped_start,
                   LEAST(span_end, :end) AS clipped_end,
                   EXISTS (
                       SELECT 1 FROM consumption_activity_exclusions x
                       WHERE x.user_id = :viewer_id AND x.media_id = spans.media_id
                         AND x.modality = spans.modality AND x.device_id = spans.device_id
                         AND x.created_at <= :as_of
                         AND (x.restored_at IS NULL OR x.restored_at > :as_of)
                         AND spans.occurred_at >= x.started_at AND spans.span_end <= x.ended_at
                   ) AS excluded
            FROM spans
        ), flagged AS (
            SELECT clipped.*, in_range AND NOT excluded AS effective,
                   extract(epoch FROM clipped_end - clipped_start) * 1000 AS ms,
                   round(word_delta * extract(epoch FROM clipped_end - clipped_start)
                         / extract(epoch FROM span_end - occurred_at))::bigint AS word_forward,
                   round(media_delta * extract(epoch FROM clipped_end - clipped_start)
                         / extract(epoch FROM span_end - occurred_at))::bigint AS media_forward
            FROM clipped
        )"""


def _sessions_sql(scope: Scope) -> str:
    """``sessions``: one row per island with an in-range span, excluded spans removed.

    A new island starts when a span begins 30 minutes or more after the running maximum end
    before it; only in-range spans count, clipped to the range.
    """
    return f"""{_flagged_sql(scope)},
        marked AS (
            SELECT flagged.*,
                   CASE WHEN max(span_end) OVER prior IS NULL
                          OR occurred_at >= max(span_end) OVER prior + interval '30 minutes'
                        THEN 1 ELSE 0 END AS starts_island
            FROM flagged WHERE NOT excluded
            WINDOW prior AS (PARTITION BY media_id, modality, device_id ORDER BY occurred_at, id
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
        ), islands AS (
            SELECT marked.*,
                   sum(starts_island) OVER (PARTITION BY media_id, modality, device_id
                                            ORDER BY occurred_at, id ROWS UNBOUNDED PRECEDING)
                       AS island
            FROM marked
        ), sessions AS (
            SELECT 'media:' || media_id AS media_ref, media_id, modality, device_id,
                   min(title) AS title,
                   min(clipped_start) FILTER (WHERE in_range) AS started_at,
                   max(clipped_end) FILTER (WHERE in_range) AS ended_at,
                   (sum(ms) FILTER (WHERE in_range))::bigint AS active_ms,
                   (sum(word_forward) FILTER (WHERE in_range))::bigint AS forward_word_position,
                   (sum(media_forward) FILTER (WHERE in_range))::bigint
                       AS forward_media_position_ms,
                   min(occurred_at) < :start AS continues_before_range,
                   max(span_end) > :end AS continues_after_range
            FROM islands
            GROUP BY media_id, modality, device_id, island
            HAVING bool_or(in_range)
        )"""


def consumption_stats(db: Session, scope: Scope, bucket: Bucket) -> wire.ConsumptionStatsOut:
    """One snapshot: every relation shares ``as_of``."""
    params = _params(scope, db.scalar(text("SELECT now()")))
    zone = ZoneInfo(scope.time_zone)
    flagged = _flagged_sql(scope)

    media = _rows(
        db,
        f"""{flagged}
        SELECT media_id, 'media:' || media_id AS media_ref, min(title) AS title,
               sum(ms)::bigint AS recorded_ms,
               coalesce(sum(ms) FILTER (WHERE effective), 0)::bigint AS active_ms,
               coalesce(sum(word_forward) FILTER (WHERE effective), 0)::bigint
                   AS forward_word_position,
               coalesce(sum(media_forward) FILTER (WHERE effective), 0)::bigint
                   AS forward_media_position_ms
        FROM flagged WHERE in_range GROUP BY media_id
        ORDER BY active_ms DESC, media_id""",
        params,
    )
    active_media = [row for row in media if row["active_ms"] > 0]

    # Minute pieces assign time to local days and hours; each sum is rounded once.
    days: dict[date, float] = {}
    hours = [0.0] * 24
    for piece in _rows(
        db,
        f"""{flagged}, pieces AS (
            SELECT minute_start AT TIME ZONE :time_zone AS local_minute,
                   least(clipped_end, minute_start + interval '1 minute')
                       - greatest(clipped_start, minute_start) AS piece
            FROM flagged
            CROSS JOIN LATERAL generate_series(
                date_trunc('minute', clipped_start),
                date_trunc('minute', clipped_end - interval '1 microsecond'),
                interval '1 minute'
            ) minute_start
            WHERE effective
        )
        SELECT local_minute::date AS day, extract(hour FROM local_minute)::int AS hour,
               sum(extract(epoch FROM piece) * 1000) AS ms
        FROM pieces GROUP BY 1, 2""",
        params,
    ):
        days[piece["day"]] = days.get(piece["day"], 0) + float(piece["ms"])
        hours[piece["hour"]] += float(piece["ms"])
    local_days = [(day, round(ms)) for day, ms in sorted(days.items())]

    # Streaks: runs of consecutive qualifying days. The last run is the current one while the
    # range is live and it ends today or yesterday.
    runs: list[tuple[date, int]] = []
    for day in (day for day, ms in local_days if ms >= _QUALIFYING_DAY_MS):
        if runs and runs[-1][0] == day - timedelta(days=1):
            runs[-1] = (day, runs[-1][1] + 1)
        else:
            runs.append((day, 1))
    now = datetime.now(UTC)
    today = now.astimezone(zone).date()
    live = (scope.start is None or scope.start <= now) and now < scope.end
    ending = runs[-1] if runs else None
    streak = (
        ending[1] if ending and (not live or ending[0] in (today, today - timedelta(days=1))) else 0
    )

    timeline = _rows(
        db,
        f"""{flagged}, bounds AS (
            SELECT bucket_start,
                   lead(bucket_start, 1, :end) OVER (ORDER BY bucket_start) AS bucket_end
            FROM ({_series(bucket)} LIMIT 401) generated
        ), bucket_spans AS (
            SELECT b.bucket_start, b.bucket_end, f.modality,
                   extract(epoch FROM least(f.clipped_end, b.bucket_end)
                                      - greatest(f.clipped_start, b.bucket_start)) * 1000 AS ms
            FROM bounds b
            LEFT JOIN flagged f ON f.effective
                 AND f.clipped_start < b.bucket_end AND f.clipped_end > b.bucket_start
        )
        SELECT CASE WHEN bucket_start BETWEEN :minimum AND :maximum
                    THEN bucket_start AT TIME ZONE 'UTC' END AS start,
               CASE WHEN bucket_end BETWEEN :minimum AND :maximum
                    THEN bucket_end AT TIME ZONE 'UTC' END AS "end",
               coalesce(sum(ms) FILTER (WHERE modality = 'Reading'), 0)::bigint
                   AS reading_active_ms,
               coalesce(sum(ms) FILTER (WHERE modality = 'Listening'), 0)::bigint
                   AS listening_active_ms,
               coalesce(sum(ms) FILTER (WHERE modality = 'Viewing'), 0)::bigint
                   AS viewing_active_ms
        FROM bucket_spans
        GROUP BY bucket_start, bucket_end
        ORDER BY bucket_start""",
        params,
    )
    for row in timeline:
        if row["start"] is None or row["end"] is None:
            raise InvalidRequestError(message="Invalid Consumption range")
        row["start"] = row["start"].replace(tzinfo=UTC)
        row["end"] = row["end"].replace(tzinfo=UTC)
    if len(timeline) > 400:
        raise InvalidRequestError(message="Consumption timeline exceeds 400 buckets")

    devices, summaries = _devices(db, scope, params)
    ranked = _rows(
        db,
        f"""{_sessions_sql(scope)}
        SELECT * FROM (
            SELECT sessions.*, count(*) OVER () AS session_count,
                   row_number() OVER (ORDER BY {_NEWEST}) AS newest_rank,
                   row_number() OVER (ORDER BY active_ms DESC, started_at, media_id, modality,
                                               device_id) AS longest_rank
            FROM sessions
        ) ranked
        WHERE newest_rank <= :page OR longest_rank = 1
        ORDER BY newest_rank""",
        params | {"page": _PAGE + 1},
    )
    newest = [row for row in ranked if row["newest_rank"] <= _PAGE + 1]
    longest = next((row for row in ranked if row["longest_rank"] == 1), None)

    # An active exclusion counts the in-range spans it contains, under the same visibility and
    # filters as every other figure.
    exclusions = _rows(
        db,
        f"""{flagged}
        SELECT x.id, x.device_id, x.modality, x.started_at, min(f.title) AS title,
               sum(f.ms)::bigint AS excluded_active_ms
        FROM consumption_activity_exclusions x
        JOIN flagged f
          ON f.in_range AND f.media_id = x.media_id AND f.modality = x.modality
         AND f.device_id = x.device_id
         AND f.occurred_at >= x.started_at AND f.span_end <= x.ended_at
        WHERE x.user_id = :viewer_id AND x.created_at <= :as_of
          AND (x.restored_at IS NULL OR x.restored_at > :as_of)
        GROUP BY x.id
        ORDER BY x.started_at DESC, x.id DESC""",
        params,
    )
    completions = _rows(
        db,
        f"""WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT f.media_id, 'media:' || f.media_id AS media_ref, min(m.title) AS title,
               count(*) AS total
        FROM consumption_completion_facts f
        JOIN visible_media vm ON vm.media_id = f.media_id
        JOIN media m ON m.id = f.media_id
        WHERE f.user_id = :viewer_id AND f.created_at <= :as_of
          AND f.created_at >= :start AND f.created_at < :end
          {_filters(scope, "f", device=False)}
        GROUP BY f.media_id
        ORDER BY total DESC, f.media_id""",
        params,
    )
    credits = _rows(
        db,
        f"""SELECT * FROM ({current_media_contributor_rows_sql()}) credit
        WHERE credit.media_id = ANY(CAST(:media_ids AS uuid[]))
        ORDER BY credit.handle, credit.role""",
        {"media_ids": [row["media_id"] for row in active_media + completions]},
    )

    filters = [
        name
        for name, value in (
            ("modality", scope.modality),
            ("media", scope.media_id),
            ("contributor", scope.contributor),
            ("device", scope.device_id),
        )
        if value is not None
    ]
    period = {"viewer_id": scope.viewer_id, "start": scope.start, "end": scope.end}
    return wire.ConsumptionStatsOut(
        activity=wire.ActivityStatsSectionOut(
            applied_filters=["time", *filters],
            inapplicable_filters=[],
            totals=wire.ActivityTotalsOut(
                active_ms=sum(row["active_ms"] for row in active_media),
                recorded_active_ms=sum(row["recorded_ms"] for row in media),
                forward_word_position=sum(row["forward_word_position"] for row in active_media),
                forward_media_position_ms=sum(
                    row["forward_media_position_ms"] for row in active_media
                ),
                active_days=sum(ms >= _QUALIFYING_DAY_MS for _, ms in local_days),
                streak=streak,
                longest_streak=max((length for _, length in runs), default=0),
                session_count=ranked[0]["session_count"] if ranked else 0,
            ),
            timeline=[
                wire.ActivityTimelineRowOut(
                    **row,
                    local_label=local.strftime(_LABEL[bucket]),
                    utc_offset_minutes=(local.utcoffset() or timedelta()) // timedelta(minutes=1),
                    active_ms=row["reading_active_ms"]
                    + row["listening_active_ms"]
                    + row["viewing_active_ms"],
                )
                for row in timeline
                for local in [row["start"].astimezone(zone)]
            ],
            local_days=[wire.LocalDayOut(date=day, active_ms=ms) for day, ms in local_days],
            local_hours=[
                wire.LocalHourOut(hour=h, active_ms=round(ms)) for h, ms in enumerate(hours)
            ],
            media=wire.MediaActivityBreakdownOut(
                rows=[wire.MediaActivityOut.model_validate(row) for row in active_media[:_TOP]],
                other_active_ms=sum(row["active_ms"] for row in active_media[_TOP:]),
            ),
            contributors=wire.ContributorActivityBreakdownOut(
                rows=[
                    wire.ContributorActivityOut(**person, active_ms=total)
                    for person, total in _credited(
                        credits, {m["media_id"]: m["active_ms"] for m in active_media}
                    )[:_TOP]
                ]
            ),
            devices=devices,
            sessions=wire.ActivitySessionPageOut(
                items=[_session(row, summaries) for row in newest[:_PAGE]],
                next_cursor=_next_cursor(scope, params["as_of"], newest, _PAGE),
            ),
            longest_session=present(_session(longest, summaries)) if longest else absent(),
            active_exclusions=[
                wire.ActiveExclusionOut.model_validate(
                    row
                    | {"exclusion_handle": seal(EXCLUSION, row["id"])}
                    | {"device": summaries[row["device_id"]]}
                )
                for row in exclusions
            ],
        ),
        completion=wire.CompletionStatsSectionOut(
            applied_filters=["time", *(name for name in filters if name != "device")],
            inapplicable_filters=["device"] if scope.device_id is not None else [],
            total=sum(row["total"] for row in completions),
            media=[wire.MediaCompletionOut.model_validate(row) for row in completions],
            contributors=[
                wire.ContributorCompletionOut(**person, total=total)
                for person, total in _credited(
                    credits, {c["media_id"]: c["total"] for c in completions}
                )
            ],
        ),
        retained_artifacts=wire.RetainedArtifactsOut(
            applied_filters=["time"],
            inapplicable_filters=filters,
            highlights=count_retained_highlights(db, **period),
            note_blocks=count_retained_note_blocks(db, **period),
            neutral_links=count_retained_neutral_links(db, **period),
        ),
    )


def session_page(
    db: Session, scope: Scope, *, cursor: str | None, limit: int
) -> wire.ActivitySessionPageOut:
    """One newest-first page of sessions, continuing the snapshot its cursor names."""
    if cursor is None:
        as_of, keyset, after = db.scalar(text("SELECT now()")), {}, ""
    else:
        as_of, keyset = _decode(db, scope, cursor)
        after = """WHERE (started_at, media_id, modality, device_id)
                   < (:after_start, :after_media, :after_modality, :after_device)"""
    params = _params(scope, as_of)
    _, summaries = _devices(db, scope, params)
    rows = _rows(
        db,
        f"{_sessions_sql(scope)} SELECT * FROM sessions {after} ORDER BY {_NEWEST} LIMIT :limit",
        params | keyset | {"limit": limit + 1},
    )
    return wire.ActivitySessionPageOut(
        items=[_session(row, summaries) for row in rows[:limit]],
        next_cursor=_next_cursor(scope, as_of, rows, limit),
    )


def exact_session_exists(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    modality: wire.ActivityModality,
    device_id: str,
    started_at: datetime,
    ended_at: datetime,
) -> bool:
    """Whether ``[started_at, ended_at]`` is exactly one current all-time session."""
    scope = Scope(
        viewer_id=viewer_id,
        start=_FLOOR,
        end=datetime(9999, 12, 31, tzinfo=UTC),
        time_zone="UTC",
        current_device_id="",
        modality=modality,
        media_id=media_id,
        device_id=device_id,
    )
    sql = f"""{_sessions_sql(scope)}
        SELECT 1 FROM sessions WHERE started_at = :started_at AND ended_at = :ended_at"""
    params = _params(scope, db.scalar(text("SELECT now()")))
    return (
        db.scalar(text(sql), params | {"started_at": started_at, "ended_at": ended_at}) is not None
    )


def _devices(
    db: Session, scope: Scope, params: dict[str, Any]
) -> tuple[list[wire.DeviceActivityOut], dict[str, wire.DeviceSummaryOut]]:
    """Devices seen in range, sealed and labelled "This device", or by classes and first seen.

    Labels that would read alike take ordinals by first seen, then handle.
    """
    rows = _rows(
        db,
        f"""{_flagged_sql(scope)}
        SELECT device_id, array_agg(DISTINCT device_class ORDER BY device_class) AS classes,
               coalesce(sum(ms) FILTER (WHERE effective), 0)::bigint AS active_ms,
               (SELECT min(s.occurred_at) FROM consumption_activity_spans s
                JOIN visible_media vm ON vm.media_id = s.media_id
                WHERE s.user_id = :viewer_id AND s.device_id = flagged.device_id
                  AND s.created_at <= :as_of) AS first_seen_at
        FROM flagged WHERE in_range
        GROUP BY device_id
        ORDER BY min(clipped_start), device_id""",
        params,
    )
    zone = ZoneInfo(scope.time_zone)
    for row in rows:
        row["device_handle"] = seal_device(row["device_id"])
        row["is_current"] = row["device_id"] == scope.current_device_id
        first_seen = row["first_seen_at"].astimezone(zone).date()
        classes = " + ".join(row["classes"])
        row["label"] = (
            "This device" if row["is_current"] else f"{classes} · first seen {first_seen}"
        )
    for label in {row["label"] for row in rows} - {"This device"}:
        alike = sorted(
            (row for row in rows if row["label"] == label),
            key=lambda row: (row["first_seen_at"], row["device_handle"]),
        )
        for ordinal, row in enumerate(alike, start=1):
            row["label"] = f"{label} · {ordinal}" if len(alike) > 1 else label
    return [wire.DeviceActivityOut.model_validate(row) for row in rows], {
        row["device_id"]: wire.DeviceSummaryOut.model_validate(row) for row in rows
    }


def _credited(
    credits: list[dict[str, Any]], totals: dict[UUID, int]
) -> list[tuple[dict[str, Any], int]]:
    """Contributors credited on these media, each counting every credited media in full."""
    people: dict[str, dict[str, Any]] = {}
    media: dict[str, set[UUID]] = {}
    for credit in (credit for credit in credits if credit["media_id"] in totals):
        handle = credit["handle"]
        person = people.setdefault(handle, {"contributor_handle": handle, "roles": []})
        person["display_name"] = credit["display_name"]
        if credit["role"] not in person["roles"]:
            person["roles"].append(credit["role"])
        media.setdefault(handle, set()).add(credit["media_id"])
    ranked = [(person, sum(totals[m] for m in media[handle])) for handle, person in people.items()]
    return sorted(ranked, key=lambda item: (-item[1], item[0]["contributor_handle"]))


def _session(
    row: dict[str, Any], devices: dict[str, wire.DeviceSummaryOut]
) -> wire.ActivitySessionOut:
    return wire.ActivitySessionOut.model_validate(row | {"device": devices[row["device_id"]]})


def _next_cursor(
    scope: Scope, as_of: datetime, rows: list[dict[str, Any]], limit: int
) -> Absent | Present[str]:
    """A cursor after the page's last row, when ``rows`` holds one more than the page."""
    if len(rows) <= limit:
        return absent()
    last = rows[limit - 1]
    payload = {
        "a": as_of.isoformat(),
        "q": _scope_hash(scope),
        "s": last["started_at"].isoformat(),
        "m": str(last["media_id"]),
        "o": last["modality"],
        "d": seal_device(last["device_id"]),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return present(base64.urlsafe_b64encode(raw).rstrip(b"=").decode())


def _decode(db: Session, scope: Scope, cursor: str) -> tuple[datetime, dict[str, Any]]:
    """The snapshot and keyset a cursor names; 400 when malformed or minted for another query."""
    try:
        value = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if set(value) != {"a", "q", "s", "m", "o", "d"} or value["q"] != _scope_hash(scope):
            raise ValueError("cursor belongs to another query")
        return datetime.fromisoformat(value["a"]), {
            "after_start": datetime.fromisoformat(value["s"]),
            "after_media": UUID(value["m"]),
            "after_modality": value["o"],
            "after_device": resolve_device(db, viewer_id=scope.viewer_id, handle=value["d"]),
        }
    except (ValueError, TypeError, KeyError, InvalidRequestError) as exc:
        raise InvalidRequestError(message="Invalid sessions cursor") from exc


def _scope_hash(scope: Scope) -> str:
    return hashlib.sha256(
        json.dumps(asdict(scope), sort_keys=True, default=str).encode()
    ).hexdigest()


def _series(bucket: Bucket) -> str:
    """Hours step in UTC; larger grains share the civil range-edge rule, distinct when
    a skipped whole date shares its edge with the next date. Empty ranges have no buckets.
    """
    if bucket == "Hour":
        return """SELECT edge AS bucket_start
            FROM generate_series(:start, :end - interval '1 microsecond', interval '1 hour') edge
            WHERE :start < :end"""
    grain = bucket.lower()
    return f"""SELECT DISTINCT {_calendar_edge_sql("edge")} AS bucket_start
            FROM generate_series(date_trunc('{grain}', :start AT TIME ZONE :time_zone),
                                 date_trunc('{grain}', (:end - interval '1 microsecond')
                                                       AT TIME ZONE :time_zone),
                                 interval '1 {grain}') edge
            WHERE :start < :end"""


def _rows(db: Session, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(row) for row in db.execute(text(sql), params).mappings()]
