"""SQL fact relations for Consumption personal-history reads.

Every relation starts from current media visibility and this viewer's rows,
clips right-open intervals in Postgres, and honours one snapshot instant:
``as_of`` filters ``created_at`` everywhere, exclusion activation included, so
a page, its cursor, and the totals always agree. Sessions are read-time
projections over spans — gap-and-island at a 30-minute gap over
``(media_id, modality, device_id)`` — never stored rows.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.errors import InvalidRequestError
from nexus.services.consumption.handles import seal_device
from nexus.services.contributor_credits import current_media_contributor_rows_sql

ActivityBucket = Literal["Hour", "Day", "Week", "Month", "Year"]
ALL_TIME_START = datetime.min.replace(tzinfo=UTC)
ALL_TIME_END = datetime.max.replace(tzinfo=UTC)
_RANGE_START = datetime(1970, 1, 1, tzinfo=UTC)
_SESSION_GAP = timedelta(minutes=30)
QUALIFYING_DAY_MS = 300_000
_TOP_ROWS = 25


@dataclass(frozen=True, slots=True)
class ActivityQuery:
    start: datetime | None
    end: datetime
    time_zone: str
    modality: str | None = None
    media_id: UUID | None = None
    contributor_handle: str | None = None
    device_id: str | None = None


def as_of_created_at(db: Session) -> datetime:
    """Database-clock snapshot cutoff, captured once per read."""
    return db.scalar(text("SELECT now()"))


def resolve_device_handle(db: Session, *, viewer_id: UUID, raw: str | None) -> str | None:
    """Resolve an outward pseudonym against only this viewer's own devices."""
    if raw is None:
        return None
    for device_id in db.scalars(
        text(
            "SELECT DISTINCT device_id FROM consumption_activity_spans WHERE user_id = :viewer_id"
        ),
        {"viewer_id": viewer_id},
    ):
        if seal_device(device_id) == raw:
            return device_id
    raise InvalidRequestError(message="Invalid deviceHandle")


def _bind(
    viewer_id: UUID,
    query: ActivityQuery,
    as_of: datetime,
    *,
    alias: str = "s",
    with_device: bool = True,
) -> tuple[str, dict[str, Any]]:
    """The trailing AND-clauses for one relation's alias and every bound value.

    Clauses are built here from fixed text, never from request strings.
    """
    start = query.start or _RANGE_START
    params: dict[str, Any] = {
        "viewer_id": viewer_id,
        "start": start,
        "end": query.end,
        "time_zone": query.time_zone,
        "as_of_created_at": as_of,
        "context_start": start - _SESSION_GAP,
        "context_end": query.end + _SESSION_GAP,
    }
    clauses: list[str] = []
    if query.modality is not None:
        clauses.append(f"{alias}.modality = :modality")
        params["modality"] = query.modality
    if query.media_id is not None:
        clauses.append(f"{alias}.media_id = :media_id")
        params["media_id"] = query.media_id
    if with_device and query.device_id is not None:
        clauses.append(f"{alias}.device_id = :device_id")
        params["device_id"] = query.device_id
    if query.contributor_handle is not None:
        clauses.append(f"""EXISTS (
                SELECT 1
                FROM ({current_media_contributor_rows_sql()}) current_credit
                WHERE current_credit.media_id = {alias}.media_id
                  AND current_credit.handle = :contributor_handle
            )""")
        params["contributor_handle"] = query.contributor_handle
    return (" AND " + " AND ".join(clauses)) if clauses else "", params


_EXCLUDED_SPAN_SQL = """
              AND NOT EXISTS (
                  SELECT 1
                  FROM consumption_activity_exclusions x
                  WHERE x.user_id = s.user_id
                    AND x.media_id = s.media_id
                    AND x.modality = s.modality
                    AND x.device_id = s.device_id
                    AND x.created_at <= :as_of_created_at
                    AND (x.restored_at IS NULL OR x.restored_at > :as_of_created_at)
                    AND s.occurred_at >= x.started_at
                    AND s.occurred_at + s.duration_ms * interval '1 millisecond'
                        <= x.ended_at
              )
"""


def _clipped_spans_sql(filters: str, *, corrected: bool) -> str:
    """Visible range-clipped observed facts, before or after active exclusions.

    Exclusion matching is containment, not overlap: a span counts as excluded
    only when it lies wholly inside the excluded interval.
    """
    return f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()}),
        source AS (
            SELECT s.id, s.media_id, s.modality, s.device_id, s.device_class,
                   s.occurred_at, s.duration_ms, s.progress_start, s.progress_end,
                   s.word_start, s.word_end, s.media_position_start_ms,
                   s.media_position_end_ms, s.created_at, m.title,
                   s.occurred_at + s.duration_ms * interval '1 millisecond' AS ended_at
            FROM consumption_activity_spans s
            JOIN visible_media vm ON vm.media_id = s.media_id
            JOIN media m ON m.id = s.media_id
            WHERE s.user_id = :viewer_id
              AND s.created_at <= :as_of_created_at
              AND s.occurred_at < :end
              AND s.occurred_at + s.duration_ms * interval '1 millisecond' > :start
              {filters}
              {_EXCLUDED_SPAN_SQL if corrected else ""}
        )
        SELECT source.*,
               GREATEST(occurred_at, :start) AS clipped_start,
               LEAST(ended_at, :end) AS clipped_end
        FROM source
    """


def sessionized_spans_sql(filters: str) -> str:
    """Gap-and-island spans with ±30 minutes of context and clipped output facts.

    Session identity uses the running prior maximum end, not merely ``LAG``, so
    overlapping intervals cannot manufacture a false gap. The context window is
    why a session straddling the range boundary can report that it continues
    before or after it. Binds the same values as :func:`_clipped_spans_sql`
    plus ``:context_start``/``:context_end``.
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
              {filters}
              {_EXCLUDED_SPAN_SQL}
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
                          OR occurred_at >= prior_max_end + interval '30 minutes'
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
        )
        SELECT id, media_id, modality, device_id, title,
               island::text AS island,
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
               {_clipped_delta_sql("word_end - word_start")} AS clipped_word_delta,
               {_clipped_delta_sql("media_position_end_ms - media_position_start_ms")}
                   AS clipped_media_delta,
               island_bounds.island_start < :start AS continues_before_range,
               island_bounds.island_end > :end AS continues_after_range
        FROM islands
        JOIN island_bounds USING (media_id, modality, device_id, island)
        WHERE occurred_at < :end AND ended_at > :start
    """


def _clipped_delta_sql(delta: str) -> str:
    return f"""round(
                   greatest(0, coalesce({delta}, 0))
                   * extract(epoch FROM LEAST(ended_at, :end) - GREATEST(occurred_at, :start))
                   / extract(epoch FROM ended_at - occurred_at)
               )::bigint"""


def _weighted_delta_sql(delta: str) -> str:
    return f"""sum(round(greatest(0, coalesce({delta}, 0))
                   * extract(epoch FROM clipped_end - clipped_start)
                   / extract(epoch FROM ended_at - occurred_at)))::bigint"""


def activity_totals_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    """Recorded observed facts per modality, minus exact active exclusions."""
    filters, params = _bind(viewer_id, query, as_of)
    return _rows(
        db,
        f"""
        WITH recorded AS ({_clipped_spans_sql(filters, corrected=False)}),
        effective AS ({_clipped_spans_sql(filters, corrected=True)}),
        modalities AS (SELECT DISTINCT modality FROM recorded),
        recorded_totals AS (
            SELECT modality,
                   sum(extract(epoch FROM clipped_end - clipped_start) * 1000)::bigint
                       AS recorded_active_ms
            FROM recorded GROUP BY modality
        ), effective_totals AS (
            SELECT modality,
                   sum(extract(epoch FROM clipped_end - clipped_start) * 1000)::bigint AS active_ms,
                   {_weighted_delta_sql("word_end - word_start")} AS forward_word_position,
                   {_weighted_delta_sql("media_position_end_ms - media_position_start_ms")}
                       AS forward_media_position_ms
            FROM effective GROUP BY modality
        )
        SELECT modalities.modality,
               coalesce(recorded_active_ms, 0)::bigint AS recorded_active_ms,
               (coalesce(recorded_active_ms, 0) - coalesce(active_ms, 0))::bigint
                   AS excluded_active_ms,
               coalesce(active_ms, 0)::bigint AS active_ms,
               coalesce(forward_word_position, 0)::bigint AS forward_word_position,
               coalesce(forward_media_position_ms, 0)::bigint AS forward_media_position_ms
        FROM modalities
        LEFT JOIN recorded_totals USING (modality)
        LEFT JOIN effective_totals USING (modality)
        """,
        params,
    )


def _minute_pieces_sql(filters: str, bucket_expr: str) -> str:
    """Active milliseconds grouped by a local expression over minute pieces."""
    return f"""
        WITH clipped AS ({_clipped_spans_sql(filters, corrected=True)}), pieces AS (
            SELECT {bucket_expr} AS bucket,
                   greatest(clipped.clipped_start, minute_start) AS piece_start,
                   least(clipped.clipped_end, minute_start + interval '1 minute') AS piece_end
            FROM clipped
            CROSS JOIN LATERAL generate_series(
                date_trunc('minute', clipped.clipped_start),
                date_trunc('minute', clipped.clipped_end - interval '1 microsecond'),
                interval '1 minute'
            ) minute_start
        )
        SELECT bucket, sum(extract(epoch FROM piece_end - piece_start) * 1000)::bigint AS active_ms
        FROM pieces GROUP BY bucket
    """


def _local_days_sql(filters: str) -> str:
    pieces = _minute_pieces_sql(filters, "(minute_start AT TIME ZONE :time_zone)::date")
    return f"SELECT bucket AS local_date, active_ms FROM ({pieces}) days ORDER BY local_date"


def local_day_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    filters, params = _bind(viewer_id, query, as_of)
    return _rows(db, _local_days_sql(filters), params)


def local_hour_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    """Exactly 24 wall-clock rows; repeated fall-back hours intentionally fold."""
    filters, params = _bind(viewer_id, query, as_of)
    pieces = _minute_pieces_sql(
        filters, "extract(hour FROM minute_start AT TIME ZONE :time_zone)::int"
    )
    return _rows(
        db,
        f"""
        WITH hourly AS ({pieces}), hours AS (SELECT generate_series(0, 23) AS hour)
        SELECT hours.hour, coalesce(hourly.active_ms, 0)::bigint AS active_ms
        FROM hours LEFT JOIN hourly ON hourly.bucket = hours.hour
        ORDER BY hours.hour
        """,
        params,
    )


def streak_row(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> dict[str, int]:
    """Current and longest runs of qualifying local days."""
    filters, params = _bind(viewer_id, query, as_of)
    now = datetime.now(UTC)
    params["is_live"] = (query.start is None or query.start <= now) and now < query.end
    params["today_local"] = now.astimezone(ZoneInfo(query.time_zone)).date()
    row = (
        db.execute(
            text(f"""
            WITH days AS ({_local_days_sql(filters)}), qualifying AS (
                SELECT local_date,
                       local_date - row_number() OVER (ORDER BY local_date)::int AS island
                FROM days WHERE active_ms >= {QUALIFYING_DAY_MS}
            ), runs AS (
                SELECT min(local_date) AS start_date, max(local_date) AS end_date,
                       count(*)::int AS length
                FROM qualifying GROUP BY island
            ), ranked AS (
                SELECT *,
                       row_number() OVER (ORDER BY length DESC, start_date ASC) AS longest_rank,
                       row_number() OVER (ORDER BY end_date DESC, start_date ASC) AS ending_rank
                FROM runs
            )
            SELECT coalesce(max(length) FILTER (WHERE longest_rank = 1), 0)::int AS longest_streak,
                   coalesce(max(length) FILTER (
                       WHERE ending_rank = 1
                         AND (NOT :is_live OR end_date IN (:today_local, :today_local - 1))
                   ), 0)::int AS ending_streak
            FROM ranked
        """),
            params,
        )
        .mappings()
        .one()
    )
    return {"streak": int(row["ending_streak"]), "longest_streak": int(row["longest_streak"])}


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
    """One page of derived sessions, newest first, fetching ``limit + 1``.

    ``after`` is already resolved against this viewer: the private media and
    device keys never enter an outward cursor.
    """
    filters, params = _bind(viewer_id, query, as_of)
    params["limit_plus_one"] = limit + 1
    keyset = ""
    if after is not None:
        keyset = """WHERE (session_start, media_id, modality, sort_identity) <
            (:after_start, :after_media_id, :after_modality, :after_sort_identity)"""
        params |= {
            "after_start": after[0],
            "after_media_id": after[1],
            "after_modality": after[2],
            "after_sort_identity": after[3],
        }
    order = (
        "active_ms DESC, session_start ASC, media_id ASC, modality ASC, sort_identity ASC"
        if longest_first
        else "session_start DESC, media_id DESC, modality DESC, sort_identity DESC"
    )
    return _rows(
        db,
        f"""
        WITH session_spans AS ({sessionized_spans_sql(filters)}), sessions AS (
            SELECT media_id, modality, device_id, device_id AS sort_identity,
                   min(title) AS title,
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
        """,
        params,
    )


def longest_session_row(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> dict[str, Any] | None:
    """Greatest clipped active duration, then the complete deterministic key."""
    rows = session_rows(
        db, viewer_id=viewer_id, query=query, as_of=as_of, limit=1, longest_first=True
    )
    return rows[0] if rows else None


def session_count(db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime) -> int:
    filters, params = _bind(viewer_id, query, as_of)
    return int(
        db.scalar(
            text(f"""
                WITH session_spans AS ({sessionized_spans_sql(filters)}), sessions AS (
                    SELECT media_id, modality, device_id, island
                    FROM session_spans
                    GROUP BY media_id, modality, device_id, island
                )
                SELECT count(*) FROM sessions
            """),
            params,
        )
        or 0
    )


def media_activity_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    """Every visible media's activity in the range, most active first.

    The heaviest relation in the read, so the caller runs it once and feeds
    both the media and the contributor breakdown.
    """
    filters, params = _bind(viewer_id, query, as_of)
    return _rows(
        db,
        f"""
        WITH clipped AS ({_clipped_spans_sql(filters, corrected=True)})
        SELECT media_id, min(title) AS title,
               sum(extract(epoch FROM clipped_end - clipped_start) * 1000)::bigint AS active_ms,
               {_weighted_delta_sql("word_end - word_start")} AS forward_word_position,
               {_weighted_delta_sql("media_position_end_ms - media_position_start_ms")}
                   AS forward_media_position_ms
        FROM clipped GROUP BY media_id
        ORDER BY active_ms DESC, media_id ASC
        """,
        params,
    )


def top_media_rows(media_activity: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """The top 25 media plus the remainder's activity."""
    return _top(media_activity)


def top_contributor_rows(
    db: Session, media_activity: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], int]:
    """Current-credit, fully co-attributed activity; totals are non-additive."""
    metrics = ("active_ms", "forward_word_position", "forward_media_position_ms")
    return _top(
        _contributor_rows(
            db,
            totals_by_media={
                row["media_id"]: {metric: int(row[metric]) for metric in metrics}
                for row in media_activity
            },
            metrics=metrics,
        )
    )


def _top(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    return rows[:_TOP_ROWS], sum(int(row["active_ms"]) for row in rows[_TOP_ROWS:])


def _contributor_rows(
    db: Session, *, totals_by_media: dict[Any, dict[str, int]], metrics: tuple[str, ...]
) -> list[dict[str, Any]]:
    """Group current credits into contributor rows, each summing its media's metrics.

    A media credited to several contributors counts in full for each, so these
    rows deliberately do not add up to the range total.
    """
    if not totals_by_media:
        return []
    credits = db.execute(
        text(f"""
            SELECT * FROM ({current_media_contributor_rows_sql()}) credit
            WHERE credit.media_id = ANY(CAST(:media_ids AS uuid[]))
        """),
        {"media_ids": list(totals_by_media)},
    ).mappings()
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
    rows = [
        {
            "contributor_handle": contributor["contributor_handle"],
            "display_name": contributor["display_name"],
            "roles": sorted(contributor["roles"]),
            **{
                metric: sum(
                    totals_by_media[media_id][metric] for media_id in contributor["media_ids"]
                )
                for metric in metrics
            },
        }
        for contributor in grouped.values()
    ]
    rows.sort(key=lambda row: (-int(row[metrics[0]]), str(row["contributor_handle"])))
    return rows


def device_breakdown_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    """Private device facts for a later sealed-handle projection."""
    filters, params = _bind(viewer_id, query, as_of)
    return _rows(
        db,
        f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()}),
        clipped AS ({_clipped_spans_sql(filters, corrected=True)}),
        recorded AS ({_clipped_spans_sql(filters, corrected=False)}),
        range_rows AS (
            SELECT device_id,
                   sum(extract(epoch FROM clipped_end - clipped_start) * 1000)::bigint AS active_ms
            FROM clipped GROUP BY device_id
        ), recorded_range AS (
            SELECT device_id, min(clipped_start) AS first_observed_at,
                   max(clipped_end) AS last_observed_at,
                   array_agg(DISTINCT device_class ORDER BY device_class) AS device_classes
            FROM recorded GROUP BY device_id
        ), all_time AS (
            SELECT s.device_id, min(s.occurred_at) AS first_seen_at
            FROM consumption_activity_spans s
            JOIN visible_media vm ON vm.media_id = s.media_id
            WHERE s.user_id = :viewer_id AND s.created_at <= :as_of_created_at
            GROUP BY s.device_id
        )
        SELECT recorded_range.*, coalesce(range_rows.active_ms, 0)::bigint AS active_ms,
               all_time.first_seen_at
        FROM recorded_range
        LEFT JOIN range_rows USING (device_id)
        JOIN all_time USING (device_id)
        ORDER BY recorded_range.first_observed_at ASC, recorded_range.device_id ASC
        """,
        params,
    )


def active_exclusion_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime
) -> list[dict[str, Any]]:
    """Active visible exclusions and the duration each one removes."""
    filters, params = _bind(viewer_id, query, as_of, alias="x")
    return _rows(
        db,
        f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT x.id AS exclusion_id, x.media_id, m.title, x.modality,
               x.device_id, x.started_at, x.ended_at,
               coalesce(sum(
                   extract(epoch FROM
                       least(s.occurred_at + s.duration_ms * interval '1 millisecond', :end)
                       - greatest(s.occurred_at, :start)
                   ) * 1000
               ), 0)::bigint AS excluded_active_ms
        FROM consumption_activity_exclusions x
        JOIN visible_media vm ON vm.media_id = x.media_id
        JOIN media m ON m.id = x.media_id
        LEFT JOIN consumption_activity_spans s
          ON s.user_id = x.user_id
         AND s.media_id = x.media_id
         AND s.modality = x.modality
         AND s.device_id = x.device_id
         AND s.created_at <= :as_of_created_at
         AND s.occurred_at >= x.started_at
         AND s.occurred_at + s.duration_ms * interval '1 millisecond' <= x.ended_at
         AND s.occurred_at < :end
         AND s.occurred_at + s.duration_ms * interval '1 millisecond' > :start
        WHERE x.user_id = :viewer_id
          AND x.created_at <= :as_of_created_at
          AND (x.restored_at IS NULL OR x.restored_at > :as_of_created_at)
          AND x.started_at < :end
          AND x.ended_at > :start
          {filters}
        GROUP BY x.id, x.media_id, m.title, x.modality, x.device_id, x.started_at, x.ended_at
        HAVING count(s.id) > 0
        ORDER BY x.started_at DESC, x.id DESC
        """,
        params,
    )


def _bucket_boundaries_sql(bucket: ActivityBucket) -> str:
    """Natural local bucket edges; binds ``:start``, ``:end``, ``:time_zone``."""
    if bucket == "Hour":
        series = "generate_series(:start, :end - interval '1 microsecond', interval '1 hour')"
    else:
        grain = {"Day": "day", "Week": "week", "Month": "month", "Year": "year"}[bucket]
        series = (
            f"generate_series(date_trunc('{grain}', :start AT TIME ZONE :time_zone), "
            f"date_trunc('{grain}', (:end - interval '1 microsecond') "
            f"AT TIME ZONE :time_zone), interval '1 {grain}') AT TIME ZONE :time_zone"
        )
    return f"""
        SELECT bucket_start,
               lead(bucket_start, 1, :end) OVER (ORDER BY bucket_start) AS bucket_end
        FROM (SELECT {series} AS bucket_start) generated
        ORDER BY bucket_start
    """


def _boundaries(
    db: Session, bucket: ActivityBucket, params: dict[str, Any]
) -> list[dict[str, Any]]:
    """Reject, never truncate, a timeline whose requested grain exceeds 400 rows.

    Reads one row past the ceiling so an unbounded range is refused without
    first materializing its whole generated series.
    """
    rows = _rows(
        db,
        f"SELECT * FROM ({_bucket_boundaries_sql(bucket)}) bounded ORDER BY bucket_start LIMIT 401",
        params,
    )
    if len(rows) > 400:
        raise InvalidRequestError(message="Consumption timeline exceeds 400 buckets")
    return rows


def _local_label(bucket: ActivityBucket, value: datetime) -> str:
    if bucket == "Hour":
        return value.strftime("%Y-%m-%d %H:00")
    if bucket == "Day":
        return value.date().isoformat()
    if bucket == "Week":
        return f"Week of {value.date().isoformat()}"
    if bucket == "Month":
        return value.strftime("%Y-%m")
    return value.strftime("%Y")


def timeline_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime, bucket: ActivityBucket
) -> list[dict[str, Any]]:
    """One zero-filled, modality-stacked timeline over natural local buckets.

    Per-bucket word and media deltas are apportioned by largest remainder so
    they sum to the range total rather than drifting with rounding.
    """
    filters, params = _bind(viewer_id, query, as_of)
    boundaries = _boundaries(db, bucket, params)
    facts = _rows(
        db,
        f"""
        WITH buckets AS ({_bucket_boundaries_sql(bucket)}),
        clipped AS ({_clipped_spans_sql(filters, corrected=True)}), intersections AS (
            SELECT b.bucket_start, b.bucket_end, c.id, c.modality,
                   greatest(c.clipped_start, b.bucket_start) AS overlap_start,
                   least(c.clipped_end, b.bucket_end) AS overlap_end,
                   extract(epoch FROM c.ended_at - c.occurred_at) * 1000 AS span_ms,
                   extract(epoch FROM c.clipped_end - c.clipped_start) * 1000 AS range_ms,
                   greatest(0, coalesce(c.word_end - c.word_start, 0)) AS word_delta,
                   greatest(0, coalesce(
                       c.media_position_end_ms - c.media_position_start_ms, 0
                   )) AS media_delta
            FROM buckets b
            JOIN clipped c ON c.clipped_start < b.bucket_end AND c.clipped_end > b.bucket_start
        ), weighted AS (
            SELECT *, (extract(epoch FROM overlap_end - overlap_start) * 1000)::bigint AS active_ms,
                   word_delta * extract(epoch FROM overlap_end - overlap_start) * 1000 / span_ms
                       AS word_exact,
                   media_delta * extract(epoch FROM overlap_end - overlap_start) * 1000 / span_ms
                       AS media_exact,
                   round(word_delta * range_ms / span_ms)::bigint AS word_range_total,
                   round(media_delta * range_ms / span_ms)::bigint AS media_range_total
            FROM intersections
        ), allocated AS (
            SELECT *, floor(word_exact)::bigint AS word_floor,
                   floor(media_exact)::bigint AS media_floor,
                   sum(floor(word_exact)::bigint) OVER (PARTITION BY id) AS word_floor_sum,
                   sum(floor(media_exact)::bigint) OVER (PARTITION BY id) AS media_floor_sum,
                   row_number() OVER (
                       PARTITION BY id
                       ORDER BY (word_exact - floor(word_exact)) DESC, bucket_start, id
                   ) AS word_rank,
                   row_number() OVER (
                       PARTITION BY id
                       ORDER BY (media_exact - floor(media_exact)) DESC, bucket_start, id
                   ) AS media_rank
            FROM weighted
        ), apportioned AS (
            SELECT *, word_range_total - word_floor_sum AS word_remainder_count,
                   media_range_total - media_floor_sum AS media_remainder_count
            FROM allocated
        )
        SELECT bucket_start, bucket_end, modality, sum(active_ms)::bigint AS active_ms,
               sum(word_floor + CASE WHEN word_rank <= word_remainder_count THEN 1 ELSE 0 END
                   )::bigint AS forward_word_position,
               sum(media_floor + CASE WHEN media_rank <= media_remainder_count THEN 1 ELSE 0 END
                   )::bigint AS forward_media_position_ms
        FROM apportioned
        GROUP BY bucket_start, bucket_end, modality
        ORDER BY bucket_start, modality
        """,
        params,
    )
    by_bucket: dict[tuple[datetime, datetime], list[dict[str, Any]]] = {}
    for fact in facts:
        by_bucket.setdefault((fact["bucket_start"], fact["bucket_end"]), []).append(fact)
    zone = ZoneInfo(query.time_zone)
    timeline: list[dict[str, Any]] = []
    for boundary in boundaries:
        start, end = boundary["bucket_start"], boundary["bucket_end"]
        rows = by_bucket.get((start, end), [])
        modalities = {row["modality"]: int(row["active_ms"]) for row in rows}
        local_start = start.astimezone(zone)
        offset = local_start.utcoffset()
        timeline.append(
            {
                "start": start,
                "end": end,
                "local_label": _local_label(bucket, local_start),
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
    return timeline


def completion_stats_rows(
    db: Session, *, viewer_id: UUID, query: ActivityQuery, as_of: datetime, bucket: ActivityBucket
) -> dict[str, Any]:
    """Visible first-completion totals, dates, timeline, and current-credit attribution."""
    filters, params = _bind(viewer_id, query, as_of, alias="f", with_device=False)
    boundaries = _boundaries(db, bucket, params)
    facts = _rows(
        db,
        f"""
        WITH visible_media AS ({visible_media_ids_cte_sql()})
        SELECT f.id, f.media_id, f.modality, f.created_at, m.title
        FROM consumption_completion_facts f
        JOIN visible_media vm ON vm.media_id = f.media_id
        JOIN media m ON m.id = f.media_id
        WHERE f.user_id = :viewer_id
          AND f.created_at <= :as_of_created_at
          AND f.created_at >= :start
          AND f.created_at < :end
          {filters}
        """,
        params,
    )
    zone = ZoneInfo(query.time_zone)
    by_modality = {"Reading": 0, "Listening": 0, "Viewing": 0}
    media: dict[Any, dict[str, Any]] = {}
    dates: dict[Any, int] = {}
    for fact in facts:
        by_modality[fact["modality"]] += 1
        row = media.setdefault(
            fact["media_id"], {"media_id": fact["media_id"], "title": fact["title"], "total": 0}
        )
        row["total"] += 1
        local_date = fact["created_at"].astimezone(zone).date()
        dates[local_date] = dates.get(local_date, 0) + 1

    timeline = [
        {
            "start": boundary["bucket_start"],
            "end": boundary["bucket_end"],
            "local_label": _local_label(bucket, boundary["bucket_start"].astimezone(zone)),
            "total": sum(
                1
                for fact in facts
                if boundary["bucket_start"] <= fact["created_at"] < boundary["bucket_end"]
            ),
        }
        for boundary in boundaries
    ]
    return {
        "total": len(facts),
        "dates": [{"date": day, "total": total} for day, total in sorted(dates.items())],
        "timeline": timeline,
        "media": sorted(media.values(), key=lambda row: (-int(row["total"]), str(row["media_id"]))),
        "contributors": _contributor_rows(
            db,
            totals_by_media={
                media_id: {"total": int(row["total"])} for media_id, row in media.items()
            },
            metrics=("total",),
        ),
        "by_modality": by_modality,
    }


def encode_session_cursor(*, as_of: datetime, query: ActivityQuery, row: dict[str, Any]) -> str:
    """Outward pagination state: no UUID, no device id, no private key.

    Every field is re-resolved against the viewer on decode, so the cursor
    carries no authority of its own — only the snapshot instant and the
    keyset position it continues.
    """
    payload = {
        "v": 2,
        "a": as_of.isoformat(),
        "q": _query_hash(query),
        "s": row["session_start"].isoformat(),
        "m": f"media:{row['media_id']}",
        "o": row["modality"],
        "i": seal_device(str(row["device_id"])),
    }
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def decode_session_cursor(
    raw: str, *, query: ActivityQuery, db: Session, viewer_id: UUID
) -> tuple[datetime, tuple[datetime, UUID, str, str]]:
    """Reopen the same snapshot, or refuse a cursor the request no longer matches."""
    try:
        value = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
        if (
            not isinstance(value, dict)
            or set(value) != {"v", "a", "q", "s", "m", "o", "i"}
            or value["v"] != 2
            or value["q"] != _query_hash(query)
            or value["o"] not in {"Reading", "Listening", "Viewing"}
            or not isinstance(value["m"], str)
            or not value["m"].startswith("media:")
        ):
            raise ValueError("cursor does not match this request")
        as_of = datetime.fromisoformat(value["a"])
        session_start = datetime.fromisoformat(value["s"])
        if as_of.tzinfo is None or session_start.tzinfo is None:
            raise ValueError("cursor instants must be aware")
        device_id = resolve_device_handle(db, viewer_id=viewer_id, raw=value["i"])
        if device_id is None:
            raise ValueError("cursor names no device")
    except (
        ValueError,
        TypeError,
        KeyError,
        UnicodeDecodeError,
        binascii.Error,
        json.JSONDecodeError,
    ) as exc:
        raise InvalidRequestError(message="Invalid sessions cursor") from exc
    return as_of, (session_start, UUID(value["m"][len("media:") :]), value["o"], device_id)


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


def _rows(db: Session, sql: str, params: dict[str, Any]) -> list[dict[str, Any]]:
    return [dict(row) for row in db.execute(text(sql), params).mappings()]
