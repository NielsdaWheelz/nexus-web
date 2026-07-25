"""SQL fact relations for Consumption personal-history reads.

This module deliberately exposes relations, not an in-memory ledger. Every
consumer begins with current media visibility and clips right-open intervals in
Postgres before aggregating.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.config import get_settings
from nexus.errors import InvalidRequestError
from nexus.services.consumption.handles import DeviceHandle, seal_device
from nexus.services.contributor_credits import (
    current_contributor_rows_for_media_sql,
    current_media_contributor_rows_sql,
)

ACTIVITY_SESSION_GAP_MS = 1_800_000


def timeline_rows_sql(bucket: str) -> str:
    """DST-aware local buckets plus exact overlap and largest-remainder deltas.

    ``bucket`` is a closed internal literal. Callers reject a generated series
    above 400 rows before materializing this relation.
    """
    if bucket not in {"Hour", "Day", "Week", "Month", "Year"}:
        raise ValueError(f"unknown activity bucket: {bucket}")
    if bucket == "Hour":
        series = "generate_series(:start, :end - interval '1 microsecond', interval '1 hour')"
        step = "interval '1 hour'"
    else:
        trunc = {"Day": "day", "Week": "week", "Month": "month", "Year": "year"}[bucket]
        step = {
            "Day": "interval '1 day'",
            "Week": "interval '1 week'",
            "Month": "interval '1 month'",
            "Year": "interval '1 year'",
        }[bucket]
        series = f"generate_series(date_trunc('{trunc}', :start AT TIME ZONE :time_zone), date_trunc('{trunc}', (:end - interval '1 microsecond') AT TIME ZONE :time_zone), {step}) AT TIME ZONE :time_zone"
    return f"""
        WITH buckets AS (
            SELECT bucket_start, lead(bucket_start, 1, :end) OVER (ORDER BY bucket_start) AS bucket_end
            FROM (SELECT {series} AS bucket_start) generated
        ), clipped AS ({visible_clipped_spans_sql()}), intersections AS (
            SELECT b.bucket_start, b.bucket_end, c.id, c.modality,
                   greatest(c.clipped_start, b.bucket_start) AS overlap_start,
                   least(c.clipped_end, b.bucket_end) AS overlap_end,
                   extract(epoch FROM c.ended_at - c.occurred_at) * 1000 AS span_ms,
                   extract(epoch FROM c.clipped_end - c.clipped_start) * 1000 AS range_ms,
                   greatest(0, coalesce(c.word_end - c.word_start, 0)) AS word_delta,
                   greatest(0, coalesce(c.media_position_end_ms - c.media_position_start_ms, 0)) AS media_delta
            FROM buckets b JOIN clipped c ON c.clipped_start < b.bucket_end AND c.clipped_end > b.bucket_start
        ), weighted AS (
            SELECT *, (extract(epoch FROM overlap_end - overlap_start) * 1000)::bigint AS active_ms,
                   word_delta * extract(epoch FROM overlap_end - overlap_start) * 1000 / span_ms AS word_exact,
                   media_delta * extract(epoch FROM overlap_end - overlap_start) * 1000 / span_ms AS media_exact,
                   round(word_delta * range_ms / span_ms)::bigint AS word_range_total,
                   round(media_delta * range_ms / span_ms)::bigint AS media_range_total
            FROM intersections
        ), allocated AS (
            SELECT *, floor(word_exact)::bigint AS word_floor, floor(media_exact)::bigint AS media_floor,
                   sum(floor(word_exact)::bigint) OVER (PARTITION BY id) AS word_floor_sum,
                   sum(floor(media_exact)::bigint) OVER (PARTITION BY id) AS media_floor_sum,
                   row_number() OVER (PARTITION BY id ORDER BY (word_exact - floor(word_exact)) DESC, bucket_start, id) AS word_rank,
                   row_number() OVER (PARTITION BY id ORDER BY (media_exact - floor(media_exact)) DESC, bucket_start, id) AS media_rank
            FROM weighted
        ), apportioned AS (
            SELECT *, word_range_total - word_floor_sum AS word_remainder_count,
                   media_range_total - media_floor_sum AS media_remainder_count
            FROM allocated
        )
        SELECT bucket_start, bucket_end, modality, sum(active_ms)::bigint AS active_ms,
               sum(word_floor + CASE WHEN word_rank <= word_remainder_count THEN 1 ELSE 0 END)::bigint AS forward_word_position,
               sum(media_floor + CASE WHEN media_rank <= media_remainder_count THEN 1 ELSE 0 END)::bigint AS forward_media_position_ms
        FROM apportioned
        GROUP BY bucket_start, bucket_end, modality
        ORDER BY bucket_start, modality
    """


def require_bucket_ceiling(
    db: Session, *, bucket: str, start: datetime, end: datetime, time_zone: str
) -> None:
    """Reject, never truncate, a timeline whose requested grain exceeds 400 rows."""
    if bucket == "Hour":
        count_sql = "SELECT count(*) FROM generate_series(:start, :end - interval '1 microsecond', interval '1 hour')"
    else:
        trunc = {"Day": "day", "Week": "week", "Month": "month", "Year": "year"}[bucket]
        step = {
            "Day": "interval '1 day'",
            "Week": "interval '1 week'",
            "Month": "interval '1 month'",
            "Year": "interval '1 year'",
        }[bucket]
        count_sql = f"SELECT count(*) FROM generate_series(date_trunc('{trunc}', :start AT TIME ZONE :time_zone), date_trunc('{trunc}', (:end - interval '1 microsecond') AT TIME ZONE :time_zone), {step})"
    count = db.scalar(text(count_sql), {"start": start, "end": end, "time_zone": time_zone})
    if count > 400:
        raise InvalidRequestError(message="Consumption timeline exceeds 400 buckets")


def activity_totals_sql() -> str:
    """One clipped factual total relation used by cards and day/hour rollups."""
    return f"""
        WITH clipped AS ({visible_clipped_spans_sql()})
        SELECT modality,
               sum(extract(epoch FROM clipped_end - clipped_start) * 1000)::bigint AS active_ms,
               sum(round(greatest(0, coalesce(word_end - word_start, 0))
                   * extract(epoch FROM clipped_end - clipped_start)
                   / extract(epoch FROM ended_at - occurred_at)))::bigint AS forward_word_position,
               sum(round(greatest(0, coalesce(media_position_end_ms - media_position_start_ms, 0))
                   * extract(epoch FROM clipped_end - clipped_start)
                   / extract(epoch FROM ended_at - occurred_at)))::bigint AS forward_media_position_ms
        FROM clipped GROUP BY modality
    """


def local_hours_sql() -> str:
    """Exactly 24 wall-clock rows; repeated fall-back hours intentionally fold."""
    return f"""
        WITH clipped AS ({visible_clipped_spans_sql()}), pieces AS (
            SELECT clipped.id,
                   minute_start,
                   least(clipped.clipped_end, minute_start + interval '1 minute') AS piece_end,
                   greatest(clipped.clipped_start, minute_start) AS piece_start
            FROM clipped
            CROSS JOIN LATERAL generate_series(
                date_trunc('minute', clipped.clipped_start),
                date_trunc('minute', clipped.clipped_end - interval '1 microsecond'),
                interval '1 minute'
            ) minute_start
        ), hourly AS (
            SELECT extract(hour FROM minute_start AT TIME ZONE :time_zone)::int AS hour,
                   sum(extract(epoch FROM piece_end - piece_start) * 1000)::bigint AS active_ms
            FROM pieces
            GROUP BY hour
        ), hours AS (SELECT generate_series(0, 23) AS hour)
        SELECT hours.hour, coalesce(hourly.active_ms, 0)::bigint AS active_ms
        FROM hours LEFT JOIN hourly USING (hour)
        ORDER BY hours.hour
    """


def local_days_sql() -> str:
    """Local calendar-day activity rows from the same clipped bucket facts."""
    return f"""
        WITH clipped AS ({visible_clipped_spans_sql()}), pieces AS (
            SELECT (minute_start AT TIME ZONE :time_zone)::date AS local_date,
                   greatest(clipped.clipped_start, minute_start) AS piece_start,
                   least(
                       clipped.clipped_end,
                       minute_start + interval '1 minute'
                   ) AS piece_end
            FROM clipped
            CROSS JOIN LATERAL generate_series(
                date_trunc('minute', clipped.clipped_start),
                date_trunc('minute', clipped.clipped_end - interval '1 microsecond'),
                interval '1 minute'
            ) minute_start
        )
        SELECT local_date,
               sum(extract(epoch FROM piece_end - piece_start) * 1000)::bigint AS active_ms
        FROM pieces
        GROUP BY local_date
        ORDER BY local_date
    """


def streaks_sql() -> str:
    """Qualifying-day streaks; binds ``:is_live`` and ``:today_local``."""
    return f"""
        WITH days AS ({local_days_sql()}), qualifying AS (
            SELECT local_date, local_date - row_number() OVER (ORDER BY local_date)::int AS island
            FROM days WHERE active_ms >= 300000
        ), runs AS (
            SELECT min(local_date) AS start_date, max(local_date) AS end_date, count(*)::int AS length
            FROM qualifying GROUP BY island
        ), ranked AS (
            SELECT *, row_number() OVER (ORDER BY length DESC, start_date ASC) AS longest_rank,
                   row_number() OVER (ORDER BY end_date DESC, start_date ASC) AS ending_rank
            FROM runs
        )
        SELECT coalesce(max(length) FILTER (WHERE longest_rank = 1), 0)::int AS longest_streak,
               coalesce(max(length) FILTER (WHERE ending_rank = 1 AND (NOT :is_live OR end_date IN (:today_local, :today_local - 1))), 0)::int AS ending_streak
        FROM ranked
    """


@dataclass(frozen=True, slots=True)
class ActivityQuery:
    start: datetime | None
    end: datetime
    time_zone: str
    modality: str | None = None
    media_id: UUID | None = None
    contributor_handle: str | None = None
    device_id: str | None = None


def resolve_device_handle(db: Session, *, viewer_id: UUID, raw: str | None) -> str | None:
    """Resolve an outward pseudonym against only the viewer's devices."""
    if raw is None:
        return None
    wanted = DeviceHandle(raw)
    for device_id in db.scalars(
        text(
            "SELECT DISTINCT device_id FROM consumption_activity_spans WHERE user_id = :viewer_id"
        ),
        {"viewer_id": viewer_id},
    ):
        if seal_device(device_id) == wanted:
            return device_id
    raise InvalidRequestError(message="Invalid deviceHandle")


def as_of_created_at(db: Session) -> datetime:
    """Database-clock session-page cutoff captured once per snapshot."""
    return db.scalar(text("SELECT now()"))


def encode_session_cursor(*, as_of: datetime, query: ActivityQuery, row: dict[str, Any]) -> str:
    """Authenticate outward-only pagination state; no UUID/device id is serialized."""
    session_start = row["session_start"]
    if not isinstance(session_start, datetime):
        raise TypeError("session_start must be a datetime")
    payload = {
        "v": 1,
        "a": as_of.isoformat(),
        "q": _query_hash(query),
        "s": session_start.isoformat(),
        "m": f"media:{row['media_id']}",
        "o": row["modality"],
        "d": str(seal_device(str(row["device_id"]))),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    tag = hmac.new(_cursor_key(), raw, hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(raw + tag).rstrip(b"=").decode()


def decode_session_cursor(
    raw: str, *, query: ActivityQuery, db: Session, viewer_id: UUID
) -> tuple[datetime, tuple[datetime, UUID, str, str]]:
    try:
        packed = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
        if base64.urlsafe_b64encode(packed).rstrip(b"=").decode() != raw:
            raise ValueError
        if len(packed) <= 16:
            raise ValueError
        body, tag = packed[:-16], packed[-16:]
        if not hmac.compare_digest(
            tag, hmac.new(_cursor_key(), body, hashlib.sha256).digest()[:16]
        ):
            raise ValueError
        value = json.loads(body)
        if (
            not isinstance(value, dict)
            or set(value) != {"v", "a", "q", "s", "m", "o", "d"}
            or value["v"] != 1
            or value["q"] != _query_hash(query)
            or value["o"] not in {"Reading", "Listening", "Viewing"}
            or not isinstance(value["m"], str)
            or not value["m"].startswith("media:")
        ):
            raise ValueError
        as_of = datetime.fromisoformat(value["a"])
        session_start = datetime.fromisoformat(value["s"])
        if as_of.tzinfo is None or session_start.tzinfo is None:
            raise ValueError
        device_id = resolve_device_handle(db, viewer_id=viewer_id, raw=value["d"])
        if device_id is None:
            raise ValueError
        return as_of, (
            session_start,
            UUID(value["m"][len("media:") :]),
            value["o"],
            device_id,
        )
    except (
        ValueError,
        TypeError,
        KeyError,
        UnicodeDecodeError,
        binascii.Error,
        json.JSONDecodeError,
    ) as exc:
        raise InvalidRequestError(message="Invalid sessions cursor") from exc


def _query_hash(query: ActivityQuery) -> str:
    return hashlib.sha256(
        json.dumps(
            {
                "start": query.start.isoformat() if query.start else None,
                "end": query.end.isoformat(),
                "zone": query.time_zone,
                "modality": query.modality,
                "media": str(query.media_id) if query.media_id else None,
                "contributor": query.contributor_handle,
                "device": query.device_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def _cursor_key() -> bytes:
    return hashlib.sha256(
        base64.b64decode(get_settings().effective_stream_token_signing_key, validate=True)
        + b"consumption-session-cursor-v1"
    ).digest()


def _filters(query: ActivityQuery) -> tuple[str, dict[str, Any]]:
    clauses: list[str] = []
    params: dict[str, Any] = {}
    if query.modality is not None:
        clauses.append("s.modality = :modality")
        params["modality"] = query.modality
    if query.media_id is not None:
        clauses.append("s.media_id = :media_id")
        params["media_id"] = query.media_id
    if query.device_id is not None:
        clauses.append("s.device_id = :device_id")
        params["device_id"] = query.device_id
    if query.contributor_handle is not None:
        clauses.append(
            f"""EXISTS (
                SELECT 1
                FROM ({current_media_contributor_rows_sql()}) current_credit
                WHERE current_credit.media_id = s.media_id
                  AND current_credit.handle = :contributor_handle
            )"""
        )
        params["contributor_handle"] = query.contributor_handle
    return (" AND " + " AND ".join(clauses)) if clauses else "", params


def visible_clipped_spans_sql() -> str:
    """One visible, snapshot-bounded, range-clipped span relation.

    Binds ``:viewer_id``, ``:start``, ``:end``, ``:as_of_created_at`` and any
    optional filter predicates supplied by the owning query. Columns retain the
    original row id so deterministic largest-remainder allocation can break
    ties by ``(bucket_start, id)``.
    """
    return f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()}),
        source AS (
            SELECT s.*, m.title,
                   s.occurred_at + s.duration_ms * interval '1 millisecond' AS ended_at
            FROM consumption_activity_spans s
            JOIN visible_media vm ON vm.media_id = s.media_id
            JOIN media m ON m.id = s.media_id
            WHERE s.user_id = :viewer_id
              AND s.created_at <= :as_of_created_at
              AND s.occurred_at < :end
              AND s.occurred_at + s.duration_ms * interval '1 millisecond' > :start
        )
        SELECT source.*,
               GREATEST(occurred_at, :start) AS clipped_start,
               LEAST(ended_at, :end) AS clipped_end
        FROM source
    """


def sessionized_spans_sql() -> str:
    """Gap-and-island spans with ±30 minute context and clipped output facts.

    The session identity uses the running prior maximum end, not merely LAG, so
    overlapping intervals cannot manufacture a false gap. Binds the same
    values as :func:`visible_clipped_spans_sql`; callers add fixed filter
    predicates inside ``filtered`` before grouping.
    """
    return f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()}),
        context_spans AS (
            SELECT s.*, m.title,
                   s.occurred_at + s.duration_ms * interval '1 millisecond' AS ended_at
            FROM consumption_activity_spans s
            JOIN visible_media vm ON vm.media_id = s.media_id
            JOIN media m ON m.id = s.media_id
            WHERE s.user_id = :viewer_id
              AND s.created_at <= :as_of_created_at
              AND s.occurred_at < :context_end
              AND s.occurred_at + s.duration_ms * interval '1 millisecond' > :context_start
        ), running AS (
            SELECT context_spans.*,
                   max(ended_at) OVER (
                       PARTITION BY media_id, modality, device_id
                       ORDER BY occurred_at, id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                   ) AS prior_max_end
            FROM context_spans
        ), marked AS (
            SELECT running.*,
                   CASE WHEN prior_max_end IS NULL
                          OR occurred_at >= prior_max_end + interval '1800000 milliseconds'
                        THEN 1 ELSE 0 END AS starts_island
            FROM running
        ), islands AS (
            SELECT marked.*,
                   sum(starts_island) OVER (
                       PARTITION BY media_id, modality, device_id
                       ORDER BY occurred_at, id
                       ROWS UNBOUNDED PRECEDING
                   ) AS island
            FROM marked
        ), island_bounds AS (
            SELECT media_id, modality, device_id, island,
                   min(occurred_at) AS island_start,
                   max(ended_at) AS island_end
            FROM islands
            GROUP BY media_id, modality, device_id, island
        ), clipped AS (
            SELECT islands.*,
                   GREATEST(occurred_at, :start) AS clipped_start,
                   LEAST(ended_at, :end) AS clipped_end,
                   CASE WHEN progress_start IS NOT NULL THEN
                       progress_start + (progress_end - progress_start)
                         * extract(epoch FROM GREATEST(occurred_at, :start) - occurred_at)
                         / extract(epoch FROM ended_at - occurred_at)
                   END AS clipped_progress_start,
                   CASE WHEN progress_end IS NOT NULL THEN
                       progress_start + (progress_end - progress_start)
                         * extract(epoch FROM LEAST(ended_at, :end) - occurred_at)
                         / extract(epoch FROM ended_at - occurred_at)
                   END AS clipped_progress_end,
                   round(
                       greatest(0, coalesce(word_end - word_start, 0))
                       * extract(epoch FROM LEAST(ended_at, :end) - GREATEST(occurred_at, :start))
                       / extract(epoch FROM ended_at - occurred_at)
                   )::bigint AS clipped_word_delta,
                   round(
                       greatest(0, coalesce(media_position_end_ms - media_position_start_ms, 0))
                       * extract(epoch FROM LEAST(ended_at, :end) - GREATEST(occurred_at, :start))
                       / extract(epoch FROM ended_at - occurred_at)
                   )::bigint AS clipped_media_delta,
                   island_bounds.island_start < :start AS continues_before_range,
                   island_bounds.island_end > :end AS continues_after_range
            FROM islands
            JOIN island_bounds USING (media_id, modality, device_id, island)
            WHERE occurred_at < :end AND ended_at > :start
        )
        SELECT * FROM clipped
    """


def session_rows(
    db: Session,
    *,
    viewer_id: UUID,
    query: ActivityQuery,
    as_of: datetime,
    limit: int,
    after: tuple[datetime, UUID, str, str] | None = None,
    longest_first: bool = False,
) -> list[dict[str, Any]]:
    """Return one page of SQL-derived sessions, newest first.

    ``after`` is already resolved at the boundary: the private media/device keys
    never enter an outward cursor. The query fetches ``limit + 1`` so callers
    can build a stable keyset continuation without an offset.
    """
    start = query.start or datetime(1970, 1, 1, tzinfo=UTC)
    filters, filter_params = _filters(query)
    keyset = ""
    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "start": start,
        "end": query.end,
        "context_start": start - timedelta(milliseconds=ACTIVITY_SESSION_GAP_MS),
        "context_end": query.end + timedelta(milliseconds=ACTIVITY_SESSION_GAP_MS),
        "as_of_created_at": as_of,
        "limit_plus_one": limit + 1,
    } | filter_params
    if after is not None:
        keyset = """WHERE (session_start, media_id, modality, device_id) <
            (:after_start, :after_media_id, :after_modality, :after_device_id)"""
        params.update(
            {
                "after_start": after[0],
                "after_media_id": after[1],
                "after_modality": after[2],
                "after_device_id": after[3],
            }
        )
    # Filters are injected only from fixed clauses built above, never request SQL.
    sql = sessionized_spans_sql().replace(
        "AND s.created_at <= :as_of_created_at", "AND s.created_at <= :as_of_created_at" + filters
    )
    order = (
        "active_ms DESC, session_start ASC, media_id ASC, modality ASC, device_id ASC"
        if longest_first
        else "session_start DESC, media_id DESC, modality DESC, device_id DESC"
    )
    return [
        dict(row)
        for row in db.execute(
            text(f"""
        WITH session_spans AS ({sql}), sessions AS (
            SELECT media_id, modality, device_id, min(title) AS title,
                   min(clipped_start) AS session_start, max(clipped_end) AS session_end,
                   sum(extract(epoch FROM clipped_end - clipped_start) * 1000)::bigint AS active_ms,
                   sum(clipped_word_delta)::bigint AS forward_word_position,
                   sum(clipped_media_delta)::bigint AS forward_media_position_ms,
                   (array_agg(clipped_progress_start ORDER BY clipped_start, id)
                       FILTER (WHERE clipped_progress_start IS NOT NULL))[1] AS first_progress,
                   (array_agg(clipped_progress_end ORDER BY clipped_end DESC, id DESC)
                       FILTER (WHERE clipped_progress_end IS NOT NULL))[1] AS last_progress,
                   bool_or(continues_before_range) AS continues_before_range,
                   bool_or(continues_after_range) AS continues_after_range
            FROM session_spans
            GROUP BY media_id, modality, device_id, island
        )
        SELECT * FROM sessions
        {keyset}
        ORDER BY {order}
        LIMIT :limit_plus_one
    """),
            params,
        ).mappings()
    ]


def longest_session_row(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> dict[str, Any] | None:
    """Greatest clipped active duration, then the complete deterministic key."""
    rows = session_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of, limit=1, longest_first=True
    )
    return rows[0] if rows else None


def _media_activity_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    """All currently visible media activity, deterministically ranked."""
    start = query.start or datetime(1970, 1, 1, tzinfo=UTC)
    filters, filter_params = _filters(query)
    relation = visible_clipped_spans_sql().replace(
        "AND s.created_at <= :as_of_created_at", "AND s.created_at <= :as_of_created_at" + filters
    )
    return [
        dict(row)
        for row in db.execute(
            text(f"""
        WITH clipped AS ({relation}), ranked AS (
            SELECT media_id, min(title) AS title,
                   sum(extract(epoch FROM clipped_end - clipped_start) * 1000)::bigint AS active_ms,
                   sum(round(greatest(0, coalesce(word_end - word_start, 0))
                       * extract(epoch FROM clipped_end - clipped_start)
                       / extract(epoch FROM ended_at - occurred_at)))::bigint
                       AS forward_word_position,
                   sum(round(greatest(0, coalesce(media_position_end_ms - media_position_start_ms, 0))
                       * extract(epoch FROM clipped_end - clipped_start)
                       / extract(epoch FROM ended_at - occurred_at)))::bigint
                       AS forward_media_position_ms,
                   row_number() OVER (ORDER BY sum(extract(epoch FROM clipped_end - clipped_start) * 1000) DESC, media_id ASC) AS rank
            FROM clipped GROUP BY media_id
        ) SELECT * FROM ranked ORDER BY rank
    """),
            {"viewer_id": viewer_id, "start": start, "end": query.end, "as_of_created_at": as_of}
            | filter_params,
        ).mappings()
    ]


def top_media_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> tuple[list[dict[str, Any]], int]:
    """Top 25 visible media plus only the remaining media's activity."""
    rows = _media_activity_rows(db, viewer_id=viewer_id, query=query, as_of=as_of)
    return rows[:25], sum(int(row["active_ms"]) for row in rows[25:])


def device_breakdown_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    """Private device facts for a later sealed-handle projection."""
    start = query.start or datetime(1970, 1, 1, tzinfo=UTC)
    filters, filter_params = _filters(query)
    clipped = visible_clipped_spans_sql().replace(
        "AND s.created_at <= :as_of_created_at", "AND s.created_at <= :as_of_created_at" + filters
    )
    return [
        dict(row)
        for row in db.execute(
            text(f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()}), clipped AS ({clipped}), range_rows AS (
            SELECT device_id, min(clipped_start) AS first_observed_at, max(clipped_end) AS last_observed_at,
                   sum(extract(epoch FROM clipped_end - clipped_start) * 1000)::bigint AS active_ms,
                   array_agg(DISTINCT device_class ORDER BY device_class) AS device_classes
            FROM clipped GROUP BY device_id
        ), all_time AS (
            SELECT s.device_id, min(s.occurred_at) AS first_seen_at
            FROM consumption_activity_spans s JOIN visible_media vm ON vm.media_id = s.media_id
            WHERE s.user_id = :viewer_id AND s.created_at <= :as_of_created_at
            GROUP BY s.device_id
        )
        SELECT range_rows.*, all_time.first_seen_at FROM range_rows JOIN all_time USING (device_id)
        ORDER BY range_rows.first_observed_at ASC, range_rows.device_id ASC
    """),
            {"viewer_id": viewer_id, "start": start, "end": query.end, "as_of_created_at": as_of}
            | filter_params,
        ).mappings()
    ]


def top_contributor_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> tuple[list[dict[str, Any]], int]:
    """Current-credit, fully co-attributed activity; totals are intentionally non-additive."""
    media_rows = _media_activity_rows(db, viewer_id=viewer_id, query=query, as_of=as_of)
    media_ids = [row["media_id"] for row in media_rows]
    if not media_ids:
        return [], 0
    credits = (
        db.execute(text(current_contributor_rows_for_media_sql()), {"media_ids": media_ids})
        .mappings()
        .all()
    )
    metrics = {
        row["media_id"]: {
            "active_ms": int(row["active_ms"]),
            "forward_word_position": int(row["forward_word_position"]),
            "forward_media_position_ms": int(row["forward_media_position_ms"]),
        }
        for row in media_rows
    }
    grouped: dict[str, dict[str, Any]] = {}
    for credit in credits:
        contributor = grouped.setdefault(
            credit["handle"],
            {
                "contributor_handle": credit["handle"],
                "display_name": credit["display_name"],
                "roles": set(),
                "media_ids": set(),
            },
        )
        contributor["roles"].add(credit["role"])
        contributor["media_ids"].add(credit["media_id"])
    rows: list[dict[str, Any]] = []
    for contributor in grouped.values():
        contributor_metrics = {
            key: sum(metrics[media_id][key] for media_id in contributor["media_ids"])
            for key in (
                "active_ms",
                "forward_word_position",
                "forward_media_position_ms",
            )
        }
        rows.append(
            {
                "contributor_handle": contributor["contributor_handle"],
                "display_name": contributor["display_name"],
                "roles": sorted(contributor["roles"]),
                **contributor_metrics,
            }
        )
    rows.sort(key=lambda row: (-row["active_ms"], row["contributor_handle"]))
    return rows[:25], sum(int(row["active_ms"]) for row in rows[25:])


def _filtered_sql(sql: str, query: ActivityQuery) -> tuple[str, dict[str, Any]]:
    filters, params = _filters(query)
    return (
        sql.replace(
            "AND s.created_at <= :as_of_created_at",
            "AND s.created_at <= :as_of_created_at" + filters,
        ),
        params,
    )


def _activity_params(
    *,
    viewer_id: UUID,
    query: ActivityQuery,
    as_of: datetime,
) -> dict[str, Any]:
    return {
        "viewer_id": viewer_id,
        "start": query.start or datetime(1970, 1, 1, tzinfo=UTC),
        "end": query.end,
        "time_zone": query.time_zone,
        "as_of_created_at": as_of,
    }


def activity_totals_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    sql, filters = _filtered_sql(activity_totals_sql(), query)
    return [
        dict(row)
        for row in db.execute(
            text(sql),
            _activity_params(viewer_id=viewer_id, query=query, as_of=as_of) | filters,
        ).mappings()
    ]


def _bucket_boundaries_sql(bucket: str) -> str:
    if bucket not in {"Hour", "Day", "Week", "Month", "Year"}:
        raise ValueError(f"unknown activity bucket: {bucket}")
    if bucket == "Hour":
        series = "generate_series(:start, :end - interval '1 microsecond', interval '1 hour')"
    else:
        trunc = {"Day": "day", "Week": "week", "Month": "month", "Year": "year"}[bucket]
        step = {
            "Day": "interval '1 day'",
            "Week": "interval '1 week'",
            "Month": "interval '1 month'",
            "Year": "interval '1 year'",
        }[bucket]
        series = (
            f"generate_series(date_trunc('{trunc}', :start AT TIME ZONE :time_zone), "
            f"date_trunc('{trunc}', (:end - interval '1 microsecond') "
            f"AT TIME ZONE :time_zone), {step}) AT TIME ZONE :time_zone"
        )
    return f"""
        SELECT bucket_start,
               lead(bucket_start, 1, :end) OVER (ORDER BY bucket_start) AS bucket_end
        FROM (SELECT {series} AS bucket_start) generated
        ORDER BY bucket_start
    """


def _local_bucket_label(bucket: str, value: datetime) -> str:
    if bucket == "Hour":
        return value.strftime("%Y-%m-%d %H:00")
    if bucket == "Day":
        return value.date().isoformat()
    if bucket == "Week":
        return f"Week of {value.date().isoformat()}"
    if bucket == "Month":
        return value.strftime("%Y-%m")
    if bucket == "Year":
        return value.strftime("%Y")
    raise ValueError(f"unknown activity bucket: {bucket}")


def timeline_rows(
    db: Session,
    *,
    viewer_id: UUID,
    query: ActivityQuery,
    as_of: datetime,
    bucket: str,
) -> list[dict[str, Any]]:
    """One zero-filled, modality-stacked timeline over natural local buckets."""
    require_bucket_ceiling(
        db,
        bucket=bucket,
        start=query.start or datetime(1970, 1, 1, tzinfo=UTC),
        end=query.end,
        time_zone=query.time_zone,
    )
    params = _activity_params(viewer_id=viewer_id, query=query, as_of=as_of)
    sql, filters = _filtered_sql(timeline_rows_sql(bucket), query)
    facts = db.execute(text(sql), params | filters).mappings().all()
    by_bucket: dict[tuple[datetime, datetime], list[dict[str, Any]]] = {}
    for fact in facts:
        by_bucket.setdefault((fact["bucket_start"], fact["bucket_end"]), []).append(dict(fact))
    boundaries = db.execute(text(_bucket_boundaries_sql(bucket)), params).mappings()
    zone = ZoneInfo(query.time_zone)
    result: list[dict[str, Any]] = []
    for boundary in boundaries:
        start = boundary["bucket_start"]
        end = boundary["bucket_end"]
        rows = by_bucket.get((start, end), [])
        modalities = {row["modality"]: int(row["active_ms"]) for row in rows}
        local_start = start.astimezone(zone)
        offset = local_start.utcoffset()
        result.append(
            {
                "start": start,
                "end": end,
                "local_label": _local_bucket_label(bucket, local_start),
                "utc_offset_minutes": int(offset.total_seconds() // 60) if offset else 0,
                "reading_active_ms": modalities.get("Reading", 0),
                "listening_active_ms": modalities.get("Listening", 0),
                "viewing_active_ms": modalities.get("Viewing", 0),
                "active_ms": sum(int(row["active_ms"]) for row in rows),
                "forward_word_position": sum(int(row["forward_word_position"]) for row in rows),
                "forward_media_position_ms": sum(
                    int(row["forward_media_position_ms"]) for row in rows
                ),
            }
        )
    return result


def local_hour_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    sql, filters = _filtered_sql(local_hours_sql(), query)
    return [
        dict(row)
        for row in db.execute(
            text(sql),
            _activity_params(viewer_id=viewer_id, query=query, as_of=as_of) | filters,
        ).mappings()
    ]


def local_day_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    sql, filters = _filtered_sql(local_days_sql(), query)
    return [
        dict(row)
        for row in db.execute(
            text(sql),
            _activity_params(viewer_id=viewer_id, query=query, as_of=as_of) | filters,
        ).mappings()
    ]


def streak_row(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> dict[str, int]:
    sql, filters = _filtered_sql(streaks_sql(), query)
    params = _activity_params(viewer_id=viewer_id, query=query, as_of=as_of)
    now = datetime.now(UTC)
    params.update(
        {
            "is_live": (query.start is None or query.start <= now) and now < query.end,
            "today_local": now.astimezone(ZoneInfo(query.time_zone)).date(),
        }
    )
    row = db.execute(text(sql), params | filters).mappings().one()
    return {
        "streak": int(row["ending_streak"]),
        "longest_streak": int(row["longest_streak"]),
    }


def session_count(db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime) -> int:
    start = query.start or datetime(1970, 1, 1, tzinfo=UTC)
    sql, filters = _filtered_sql(sessionized_spans_sql(), query)
    return int(
        db.scalar(
            text(f"""
                WITH session_spans AS ({sql}), sessions AS (
                    SELECT media_id, modality, device_id, island
                    FROM session_spans
                    GROUP BY media_id, modality, device_id, island
                )
                SELECT count(*) FROM sessions
            """),
            {
                "viewer_id": viewer_id,
                "start": start,
                "end": query.end,
                "context_start": start - timedelta(milliseconds=ACTIVITY_SESSION_GAP_MS),
                "context_end": query.end + timedelta(milliseconds=ACTIVITY_SESSION_GAP_MS),
                "as_of_created_at": as_of,
            }
            | filters,
        )
        or 0
    )


def _completion_filters(query: ActivityQuery) -> tuple[str, dict[str, Any]]:
    clauses: list[str] = []
    params: dict[str, Any] = {}
    if query.modality is not None:
        clauses.append("f.modality = :modality")
        params["modality"] = query.modality
    if query.media_id is not None:
        clauses.append("f.media_id = :media_id")
        params["media_id"] = query.media_id
    if query.contributor_handle is not None:
        clauses.append(
            f"""EXISTS (
                SELECT 1
                FROM ({current_media_contributor_rows_sql()}) current_credit
                WHERE current_credit.media_id = f.media_id
                  AND current_credit.handle = :contributor_handle
            )"""
        )
        params["contributor_handle"] = query.contributor_handle
    return (" AND " + " AND ".join(clauses)) if clauses else "", params


def _visible_completion_facts_sql(query: ActivityQuery) -> tuple[str, dict[str, Any]]:
    filters, params = _completion_filters(query)
    return (
        f"""
            WITH visible_media AS ({visible_media_ids_cte_sql()})
            SELECT f.id, f.media_id, f.modality, f.created_at, m.title
            FROM consumption_completion_facts f
            JOIN visible_media vm ON vm.media_id = f.media_id
            JOIN media m ON m.id = f.media_id
            WHERE f.user_id = :viewer_id
              AND f.created_at <= :as_of_created_at
              AND (
                CAST(:start AS timestamptz) IS NULL
                OR f.created_at >= CAST(:start AS timestamptz)
              )
              AND f.created_at < :end
              {filters}
        """,
        params,
    )


def completion_stats_rows(
    db: Session,
    *,
    viewer_id: UUID,
    query: ActivityQuery,
    as_of: datetime,
    bucket: str,
) -> dict[str, Any]:
    """Visible first-completion totals and current-credit attribution."""
    require_bucket_ceiling(
        db,
        bucket=bucket,
        start=query.start or datetime(1970, 1, 1, tzinfo=UTC),
        end=query.end,
        time_zone=query.time_zone,
    )
    relation, filters = _visible_completion_facts_sql(query)
    params = {
        "viewer_id": viewer_id,
        "start": query.start,
        "end": query.end,
        "as_of_created_at": as_of,
        "time_zone": query.time_zone,
    } | filters
    facts = [dict(row) for row in db.execute(text(relation), params).mappings().all()]
    by_modality = {"Reading": 0, "Listening": 0, "Viewing": 0}
    media: dict[UUID, dict[str, Any]] = {}
    dates: dict[object, int] = {}
    zone = ZoneInfo(query.time_zone)
    for fact in facts:
        by_modality[fact["modality"]] += 1
        media.setdefault(
            fact["media_id"],
            {
                "media_id": fact["media_id"],
                "title": fact["title"],
                "total": 0,
            },
        )["total"] += 1
        local_date = fact["created_at"].astimezone(zone).date()
        dates[local_date] = dates.get(local_date, 0) + 1

    credits = []
    media_ids = list(media)
    if media_ids:
        credits = (
            db.execute(
                text(current_contributor_rows_for_media_sql()),
                {"media_ids": media_ids},
            )
            .mappings()
            .all()
        )
    contributor_acc: dict[str, dict[str, Any]] = {}
    for credit in credits:
        contributor = contributor_acc.setdefault(
            credit["handle"],
            {
                "contributor_handle": credit["handle"],
                "display_name": credit["display_name"],
                "roles": set(),
                "media_ids": set(),
            },
        )
        contributor["roles"].add(credit["role"])
        contributor["media_ids"].add(credit["media_id"])
    contributors = [
        {
            "contributor_handle": contributor["contributor_handle"],
            "display_name": contributor["display_name"],
            "roles": sorted(contributor["roles"]),
            "total": sum(int(media[media_id]["total"]) for media_id in contributor["media_ids"]),
        }
        for contributor in contributor_acc.values()
    ]
    contributors.sort(key=lambda row: (-int(row["total"]), str(row["contributor_handle"])))

    boundaries = [
        dict(row)
        for row in db.execute(
            text(_bucket_boundaries_sql(bucket)),
            {
                "start": query.start or datetime(1970, 1, 1, tzinfo=UTC),
                "end": query.end,
                "time_zone": query.time_zone,
            },
        ).mappings()
    ]
    timeline_counts = {(row["bucket_start"], row["bucket_end"]): 0 for row in boundaries}
    for fact in facts:
        for start, end in timeline_counts:
            if start <= fact["created_at"] < end:
                timeline_counts[(start, end)] += 1
                break
    timeline = []
    for boundary in boundaries:
        start = boundary["bucket_start"]
        end = boundary["bucket_end"]
        timeline.append(
            {
                "start": start,
                "end": end,
                "local_label": _local_bucket_label(bucket, start.astimezone(zone)),
                "total": timeline_counts[(start, end)],
            }
        )
    media_rows = sorted(
        media.values(),
        key=lambda row: (-int(row["total"]), str(row["media_id"])),
    )
    return {
        "total": len(facts),
        "dates": [
            {"date": local_date, "total": total} for local_date, total in sorted(dates.items())
        ],
        "timeline": timeline,
        "media": media_rows,
        "contributors": contributors,
        "by_modality": by_modality,
    }
