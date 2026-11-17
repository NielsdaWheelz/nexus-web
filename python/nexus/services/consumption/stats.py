"""The reading record, projected under one read snapshot and one account calendar.

Every figure starts from the same visible, as-of spans. Exclusions remove time;
passes retain time but add no coverage or pace. Sittings are all-time gap islands,
never stored rows. Their cursors retain page one's as-of and bind to the viewer.
"""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import requested_media_ids_cte_sql
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas import consumption_activity as wire
from nexus.schemas.media_summary import MediaSummaryOut
from nexus.services.consumption import projection, structure
from nexus.services.media import media_summaries
from nexus.services.media_document_metrics import media_word_count_rows_sql, pdf_pages_sql

_QUALIFYING_DAY_MS = 300_000
_NEWEST = "started_at DESC, ended_at DESC, media_id DESC, modality DESC, device_id DESC"


@dataclass(frozen=True, slots=True)
class _Work:
    kind: str
    words: int | None
    position: float | None
    duration_ms: int | None

    @property
    def thickness_mm(self) -> float:
        return (self.words or 0) / 350 * 0.05 + (2 if self.kind == "epub" else 0.4)


def _base_sql(*, exact: bool = False) -> str:
    match = (
        "AND s.media_id = :media_id AND s.modality = :modality AND s.device_id = :device_id"
        if exact
        else ""
    )
    return f"""WITH visible_media AS ({requested_media_ids_cte_sql()}),
        spans AS (
            SELECT s.*, m.title,
                   s.occurred_at + s.duration_ms * interval '1 millisecond' AS span_end,
                   (s.occurred_at AT TIME ZONE :zone)::date AS day,
                   EXISTS (
                       SELECT 1 FROM consumption_activity_exclusions x
                       WHERE x.user_id = :viewer_id AND x.media_id = s.media_id
                         AND x.modality = s.modality AND x.device_id = s.device_id
                         AND x.created_at <= :as_of
                         AND (x.restored_at IS NULL OR x.restored_at > :as_of)
                         AND s.occurred_at >= x.started_at
                         AND s.occurred_at + s.duration_ms * interval '1 millisecond' <= x.ended_at
                   ) AS excluded,
                   coalesce(s.word_end - s.word_start > 15.0 * s.duration_ms / 1000, false)
                     OR (m.kind = 'pdf' AND coalesce(
                         (s.progress_end - s.progress_start) * {pdf_pages_sql("m")}
                             > 0.25 * s.duration_ms / 1000, false))
                     OR coalesce(s.media_position_end_ms - s.media_position_start_ms
                                     > 4 * s.duration_ms, false) AS is_pass
            FROM consumption_activity_spans s
            JOIN visible_media vm ON vm.media_id = s.media_id
            JOIN media m ON m.id = s.media_id
            WHERE s.user_id = :viewer_id AND s.created_at <= :as_of {match}
        )"""


def _sessions_sql(*, exact: bool = False) -> str:
    """A span starts an island at a gap of at least thirty minutes from the prior maximum end."""
    return f"""{_base_sql(exact=exact)},
        marked AS (
            SELECT spans.*,
                   CASE WHEN max(span_end) OVER prior IS NULL
                          OR occurred_at >= max(span_end) OVER prior + interval '30 minutes'
                        THEN 1 ELSE 0 END AS starts_island
            FROM spans WHERE NOT excluded
            WINDOW prior AS (PARTITION BY media_id, modality, device_id ORDER BY occurred_at, id
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
        ), islands AS (
            SELECT marked.*,
                   sum(starts_island) OVER (PARTITION BY media_id, modality, device_id
                                            ORDER BY occurred_at, id ROWS UNBOUNDED PRECEDING)
                       AS island
            FROM marked
        ), sessions AS (
            SELECT media_id, modality, device_id, min(title) AS title,
                   min(occurred_at) AS started_at, max(span_end) AS ended_at,
                   sum(duration_ms)::bigint AS active_ms,
                   min(progress_start) FILTER (WHERE NOT is_pass) AS from_place,
                   max(progress_end) FILTER (WHERE NOT is_pass) AS to_place
            FROM islands GROUP BY media_id, modality, device_id, island
        )"""


def _snapshot(db: Session, viewer_id: UUID) -> dict[str, Any]:
    row = db.execute(
        text("SELECT now() AS as_of, calendar_time_zone FROM users WHERE id = :viewer_id"),
        {"viewer_id": viewer_id},
    ).one()
    return {"viewer_id": viewer_id, "as_of": row.as_of, "zone": row.calendar_time_zone}


def _rows(db: Session, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(row) for row in db.execute(text(sql), params).mappings()]


def _days(db: Session, params: dict[str, Any], media_id: UUID | None) -> list[wire.DayOut]:
    target = "AND f.media_id = :media_id" if media_id is not None else ""
    rows = _rows(
        db,
        f"""{_base_sql()},
        days AS (
            SELECT f.day AS date, sum(f.duration_ms)::bigint AS active_ms, 0 AS finished
            FROM spans f WHERE NOT f.excluded {target} GROUP BY f.day
            UNION ALL
            SELECT (f.created_at AT TIME ZONE :zone)::date, 0, count(*)
            FROM consumption_completion_facts f
            JOIN visible_media vm ON vm.media_id = f.media_id
            WHERE f.user_id = :viewer_id AND f.created_at <= :as_of {target}
            GROUP BY (f.created_at AT TIME ZONE :zone)::date
        )
        SELECT date, sum(active_ms)::bigint AS active_ms, sum(finished)::int AS finished
        FROM days GROUP BY date ORDER BY date""",
        params | {"media_id": media_id},
    )
    return [
        wire.DayOut(
            **row,
            level=sum(
                row["active_ms"] >= threshold
                for threshold in (_QUALIFYING_DAY_MS, 1_200_000, 2_700_000, 5_400_000)
            ),
        )
        for row in rows
    ]


def _works(db: Session, params: dict[str, Any], media_ids: list[UUID]) -> dict[UUID, _Work]:
    if not media_ids:
        return {}
    rows = _rows(
        db,
        f"""SELECT m.id, m.kind, counts.word_count,
                   (SELECT sum(f.canonical_text_word_count) FROM fragments f
                    WHERE f.media_id = m.id) AS transcript_words,
                   nullif({projection.listening_duration_sql("pls", "pe")}, 0) AS duration_ms,
                   CASE WHEN m.kind = 'video' THEN NULL
                        WHEN m.kind = 'pdf' THEN CASE
                            WHEN cursor.cursor->>'tag' = 'Positioned'
                                 AND cursor.cursor->'locator'->>'kind' = 'pdf'
                                 AND {pdf_pages_sql("m")} > 0
                            THEN ((cursor.cursor->'locator'->>'page')::float8 - 1
                                  + coalesce((cursor.cursor->'locator'->>'page_progression')::float8, 0))
                                 / {pdf_pages_sql("m")}
                            ELSE NULL END
                        ELSE state.progress_fraction END AS position
            FROM media m
            JOIN ({media_word_count_rows_sql()}) counts ON counts.media_id = m.id
            LEFT JOIN ({projection.engagement_fact_rows_sql(media_ids_param="media_ids")}) state
              ON state.media_id = m.id
            LEFT JOIN reader_media_state cursor ON cursor.media_id = m.id AND cursor.user_id = :viewer_id
            LEFT JOIN podcast_episodes pe ON pe.media_id = m.id
            LEFT JOIN podcast_listening_states pls ON pls.media_id = m.id AND pls.user_id = :viewer_id
            WHERE m.id = ANY(:media_ids)""",
        params | {"media_ids": media_ids},
    )
    result: dict[UUID, _Work] = {}
    for row in rows:
        words = row["word_count"]
        if row["kind"] in ("podcast_episode", "video"):
            words = row["transcript_words"] or round((row["duration_ms"] or 0) / 60_000 * 150)
        result[row["id"]] = _Work(row["kind"], words, row["position"], row["duration_ms"])
    return result


def _covered(
    db: Session, params: dict[str, Any], media_ids: list[UUID]
) -> dict[UUID, list[tuple[float, float]]]:
    result: dict[UUID, list[tuple[float, float]]] = {}
    if not media_ids:
        return result
    rows = _rows(
        db,
        f"""{_base_sql()} SELECT media_id, progress_start, progress_end FROM spans
            WHERE NOT excluded AND NOT is_pass AND progress_end > progress_start
              AND media_id = ANY(:media_ids) ORDER BY media_id, progress_start, progress_end""",
        params | {"media_ids": media_ids},
    )
    for row in rows:
        intervals = result.setdefault(row["media_id"], [])
        start, end = row["progress_start"], row["progress_end"]
        if intervals and start <= intervals[-1][1] + 0.001:
            intervals[-1] = (intervals[-1][0], max(intervals[-1][1], end))
        else:
            intervals.append((start, end))
    return result


def read_record(db: Session, viewer_id: UUID) -> wire.RecordOut:
    """The whole record, with the first open work's detailed drawing in the same snapshot."""
    params = _snapshot(db, viewer_id)
    today = params["as_of"].astimezone(ZoneInfo(params["zone"])).date()
    days = _days(db, params, None)
    counted = [day.date for day in days if day.level > 0]
    weeks: dict[date, int] = {}
    for day in counted:
        monday = day - timedelta(days=day.weekday())
        weeks[monday] = weeks.get(monday, 0) + 1
    monday = today - timedelta(days=today.weekday())
    if monday not in weeks:
        monday -= timedelta(days=7)
    running = 0
    while monday in weeks:
        running += 1
        monday -= timedelta(days=7)
    open_rows = _rows(
        db,
        f"""{_base_sql()}
        SELECT s.media_id, max(s.occurred_at) AS latest, sum(s.duration_ms)::bigint AS active_ms
        FROM spans s
        LEFT JOIN ({projection.engagement_fact_rows_sql()}) state ON state.media_id = s.media_id
        WHERE NOT s.excluded AND coalesce(state.read_state, 'Unread') <> 'Finished'
        GROUP BY s.media_id HAVING max(s.occurred_at) >= :as_of - interval '30 days'
        ORDER BY latest DESC, s.media_id LIMIT 6""",
        params,
    )
    finished = _rows(
        db,
        f"""{_base_sql()}
        SELECT f.media_id, (f.created_at AT TIME ZONE :zone)::date AS finished_on,
               coalesce(sum(s.duration_ms), 0)::bigint AS active_ms
        FROM consumption_completion_facts f
        JOIN visible_media vm ON vm.media_id = f.media_id
        LEFT JOIN spans s ON s.media_id = f.media_id AND NOT s.excluded
        WHERE f.user_id = :viewer_id AND f.created_at <= :as_of
        GROUP BY f.media_id, f.created_at ORDER BY f.created_at, f.media_id""",
        params,
    )
    longest = _rows(
        db,
        f"""{_sessions_sql()} SELECT * FROM sessions
            ORDER BY active_ms DESC, started_at, media_id, modality, device_id LIMIT 1""",
        params,
    )
    ids = list(dict.fromkeys(row["media_id"] for row in [*open_rows, *finished, *longest]))
    summaries = media_summaries(db, viewer_id=viewer_id, media_ids=ids)
    works = _works(db, params, ids)
    covered = _covered(db, params, [row["media_id"] for row in open_rows])
    years: dict[int, list[wire.StackWorkOut]] = {}
    for row in finished:
        work = works[row["media_id"]]
        years.setdefault(row["finished_on"].year, []).append(
            wire.StackWorkOut(
                media=summaries[row["media_id"]],
                finished_on=row["finished_on"],
                active_ms=row["active_ms"],
                words=work.words,
                thickness_mm=work.thickness_mm,
            )
        )
    stack = [
        wire.StackYearOut(
            year=year, height_mm=sum(work.thickness_mm for work in items), works=items
        )
        for year, items in sorted(years.items(), reverse=True)
    ]
    fullest = max(
        (day for day in days if day.active_ms), key=lambda day: day.active_ms, default=None
    )
    lengths: list[wire.WorkLengthOut] = []
    for row in finished:
        work = works[row["media_id"]]
        if work.words is not None:
            lengths.append(wire.WorkLengthOut(media=summaries[row["media_id"]], words=work.words))
    longest_work = max(lengths, key=lambda work: work.words, default=None)
    return wire.RecordOut(
        time_zone=params["zone"],
        today=today,
        slip=wire.SlipOut(
            weeks_running=running,
            weeks_entire=sum(
                monday.year == today.year and count == 7 for monday, count in weeks.items()
            ),
            days_read=sum(day.year == today.year for day in counted),
            days=days,
        ),
        open=[
            wire.OpenWorkOut(
                media=summaries[row["media_id"]],
                position=works[row["media_id"]].position,
                covered=covered.get(row["media_id"], []),
                thickness_mm=works[row["media_id"]].thickness_mm,
                active_ms=row["active_ms"],
            )
            for row in open_rows
        ],
        in_hand=_read_work(
            db, params, summaries[open_rows[0]["media_id"]], works[open_rows[0]["media_id"]]
        )
        if open_rows
        else None,
        stack=stack,
        lifetime_mm=sum(year.height_mm for year in stack),
        records=wire.RecordsOut(
            longest_sitting=wire.SittingRecordOut(
                media=summaries[longest[0]["media_id"]],
                started_at=longest[0]["started_at"],
                active_ms=longest[0]["active_ms"],
            )
            if longest
            else None,
            fullest_day=wire.DayRecordOut(date=fullest.date, active_ms=fullest.active_ms)
            if fullest
            else None,
            longest_work=longest_work,
            observed_ms=sum(day.active_ms for day in days),
            first_day=days[0].date if days else None,
        ),
    )


def read_work(db: Session, viewer_id: UUID, media_id: UUID) -> wire.WorkRecordOut:
    """One readable work's record; visibility failure is a 404, never an empty record."""
    params = _snapshot(db, viewer_id)
    summaries = media_summaries(db, viewer_id=viewer_id, media_ids=[media_id])
    if media_id not in summaries:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return _read_work(db, params, summaries[media_id], _works(db, params, [media_id])[media_id])


def _read_work(
    db: Session, params: dict[str, Any], media: MediaSummaryOut, work: _Work
) -> wire.WorkRecordOut:
    media_id = media.media_id
    drawing = structure.units(db, params["viewer_id"], media_id)
    days = _days(db, params, media_id)
    row = _rows(
        db,
        f"""{_sessions_sql()} SELECT
            (SELECT count(*) FROM sessions WHERE media_id = :media_id) AS sittings,
            sum(duration_ms) FILTER (WHERE NOT excluded AND NOT is_pass
                AND occurred_at >= :as_of - interval '60 days' AND progress_end > progress_start)
                ::bigint AS pace_ms,
            sum(progress_end - progress_start) FILTER (WHERE NOT excluded AND NOT is_pass
                AND occurred_at >= :as_of - interval '60 days' AND progress_end > progress_start)
                AS pace_progress,
            (SELECT (created_at AT TIME ZONE :zone)::date FROM consumption_completion_facts
             WHERE user_id = :viewer_id AND media_id = :media_id AND created_at <= :as_of) AS finished_on
            FROM spans WHERE media_id = :media_id""",
        params | {"media_id": media_id},
    )[0]
    estimate = round(work.words / 4 * 1000) if work.words else None
    full_read_ms = estimate
    if work.kind == "podcast_episode":
        full_read_ms = work.duration_ms
    elif (row["pace_ms"] or 0) >= 600_000 and (row["pace_progress"] or 0) >= 0.002:
        observed = round(row["pace_ms"] / row["pace_progress"])
        full_read_ms = min(observed, estimate * 3) if estimate is not None else observed
    read_days = [day for day in days if day.active_ms]
    return wire.WorkRecordOut(
        media=media,
        words=work.words,
        thickness_mm=work.thickness_mm,
        unit=drawing.unit,
        parts=drawing.parts,
        units=drawing.units,
        position=work.position,
        covered=_covered(db, params, [media_id]).get(media_id, []),
        full_read_ms=full_read_ms,
        sittings=row["sittings"],
        active_ms=sum(day.active_ms for day in days),
        first_read_on=read_days[0].date if read_days else None,
        finished_on=row["finished_on"],
        days=days,
    )


def sitting_page(
    db: Session, viewer_id: UUID, *, cursor: str | None, limit: int
) -> wire.SittingPageOut:
    """Newest effective islands and active exclusions; page one's snapshot continues."""
    params = _snapshot(db, viewer_id)
    after = ""
    if cursor is not None:
        as_of, keyset = _decode(viewer_id, cursor)
        params |= {"as_of": as_of} | keyset
        after = """WHERE (started_at, ended_at, media_id, modality, device_id)
                   < (:after_start, :after_end, :after_media, :after_modality, :after_device)"""
    rows = _rows(
        db,
        f"""{_sessions_sql()},
        active_exclusions AS (
            SELECT DISTINCT ON (x.media_id, x.modality, x.device_id, x.started_at, x.ended_at) x.*
            FROM consumption_activity_exclusions x
            JOIN visible_media vm ON vm.media_id = x.media_id
            WHERE x.user_id = :viewer_id AND x.created_at <= :as_of
              AND (x.restored_at IS NULL OR x.restored_at > :as_of)
            ORDER BY x.media_id, x.modality, x.device_id, x.started_at, x.ended_at, x.created_at, x.id
        ), sittings AS (
            SELECT sessions.*, NULL::uuid AS exclusion_id FROM sessions
            UNION ALL
            SELECT x.media_id, x.modality, x.device_id, min(m.title), x.started_at, x.ended_at,
                   coalesce(sum(s.duration_ms), 0)::bigint, NULL::float8, NULL::float8, x.id
            FROM active_exclusions x JOIN media m ON m.id = x.media_id
            LEFT JOIN spans s ON s.media_id = x.media_id AND s.modality = x.modality
                AND s.device_id = x.device_id AND s.occurred_at >= x.started_at AND s.span_end <= x.ended_at
            GROUP BY x.id, x.media_id, x.modality, x.device_id, x.started_at, x.ended_at
        )
        SELECT sittings.*, (started_at AT TIME ZONE :zone)::date AS day FROM sittings
        {after} ORDER BY {_NEWEST} LIMIT :limit""",
        params | {"limit": limit + 1},
    )
    return wire.SittingPageOut(
        items=[wire.SittingOut.model_validate(row) for row in rows[:limit]],
        next_cursor=_next_cursor(viewer_id, params["as_of"], rows, limit),
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
    """Whether this exact interval is one current all-time effective sitting."""
    return (
        db.scalar(
            text(f"""{_sessions_sql(exact=True)} SELECT 1 FROM sessions
                WHERE started_at = :started_at AND ended_at = :ended_at"""),
            {
                "viewer_id": viewer_id,
                "media_id": media_id,
                "modality": modality,
                "device_id": device_id,
                "started_at": started_at,
                "ended_at": ended_at,
                "as_of": db.scalar(text("SELECT now()")),
                "zone": "UTC",
            },
        )
        is not None
    )


def _next_cursor(
    viewer_id: UUID, as_of: datetime, rows: list[dict[str, Any]], limit: int
) -> str | None:
    if len(rows) <= limit:
        return None
    last = rows[limit - 1]
    payload = {
        "a": as_of.isoformat(),
        "q": _scope_hash(viewer_id),
        "s": last["started_at"].isoformat(),
        "e": last["ended_at"].isoformat(),
        "m": str(last["media_id"]),
        "o": last["modality"],
        "d": last["device_id"],
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _decode(viewer_id: UUID, cursor: str) -> tuple[datetime, dict[str, Any]]:
    try:
        value = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
        if set(value) != {"a", "q", "s", "e", "m", "o", "d"} or value["q"] != _scope_hash(
            viewer_id
        ):
            raise ValueError("cursor belongs to another viewer")
        if value["o"] not in ("Reading", "Listening", "Viewing") or not isinstance(value["d"], str):
            raise ValueError("cursor sitting identity is malformed")
        as_of = datetime.fromisoformat(value["a"])
        start, end = datetime.fromisoformat(value["s"]), datetime.fromisoformat(value["e"])
        if any(instant.tzinfo is None for instant in (as_of, start, end)):
            raise ValueError("cursor instants need time zones")
        return as_of, {
            "after_start": start,
            "after_end": end,
            "after_media": UUID(str(value["m"])),
            "after_modality": value["o"],
            "after_device": value["d"],
        }
    except (ValueError, TypeError, KeyError) as exc:
        raise InvalidRequestError(message="Invalid sittings cursor") from exc


def _scope_hash(viewer_id: UUID) -> str:
    return hashlib.sha256(str(viewer_id).encode()).hexdigest()
