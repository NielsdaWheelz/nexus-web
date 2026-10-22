"""The consumption read model other slices compose.

Read state has one rule, written once in SQL: explicit override, then current listening
position, then reader engagement, else unread. Listings join :func:`engagement_fact_rows_sql` or
:func:`episode_state_case_sql`; Lectern items, descriptors and :func:`media_read_states` read
the same relation. The server owns where a play starts: an episode with persisted
completion starts over.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from math import ceil
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.schemas import consumption as wire
from nexus.schemas.media_summary import ConsumptionState, MediaDurationOut
from nexus.schemas.reading_time import ReadingTimeEstimateOut
from nexus.services.consumption import reader_cursor
from nexus.services.playback_source import episode_playback_source

FINISHED_PROGRESSION = 0.95


def _duration_sql(listening_alias: str, episode_alias: str) -> str:
    return f"COALESCE({listening_alias}.duration_ms, {episode_alias}.duration_seconds * 1000)"


def _read_state_case_sql(
    *,
    listening: str,
    override: str,
    labels: tuple[str, str, str],
    media_kind: str | None = None,
    engagement: str | None = None,
) -> str:
    """Override, then the audio ladder, then reader engagement, then unread.

    ``media_kind`` guards the audio ladder for a mixed-kind relation; without it the relation
    is podcast-episode only. ``engagement`` adds the reader arm.
    """
    finished, in_progress, unread = labels
    audio = f"""
            WHEN COALESCE({listening}.position_ms, 0) > 0 THEN '{in_progress}'"""
    if media_kind is not None:
        audio = f"""
            WHEN {media_kind} = 'podcast_episode' THEN
                CASE{audio}
                    ELSE '{unread}'
                END"""
    reader = (
        f"""
            WHEN {engagement}.media_id IS NOT NULL THEN '{in_progress}'"""
        if engagement is not None
        else ""
    )
    return f"""
        CASE
            WHEN {override}.status = 'finished' THEN '{finished}'
            WHEN {override}.status = 'unread' THEN '{unread}'{audio}{reader}
            ELSE '{unread}'
        END
    """


def engagement_fact_rows_sql(*, media_ids_param: str | None = None) -> str:
    """Canonical consumption facts for one viewer (binds ``:viewer_id``).

    Columns: ``media_id``, ``read_state``, ``progress_fraction``, ``progress_resettable``,
    ``last_engaged_at``. The candidate union stays MATERIALIZED: listings compose this as a
    joined subquery, and inlining re-runs the union once per outer row. ``media_ids_param``
    names a bound UUID array applied inside every candidate arm.
    """
    duration_ms = _duration_sql("pls", "pe")
    candidate_filter = f"AND media_id = ANY(:{media_ids_param})" if media_ids_param else ""
    read_state = _read_state_case_sql(
        listening="pls",
        override="co",
        labels=("Finished", "InProgress", "Unread"),
        media_kind="m.kind",
        engagement="res",
    )
    return f"""
        WITH consumption_media_ids AS MATERIALIZED (
            SELECT media_id FROM consumption_overrides
            WHERE user_id = :viewer_id {candidate_filter}
            UNION
            SELECT media_id FROM reader_engagement_states
            WHERE user_id = :viewer_id {candidate_filter}
            UNION
            SELECT media_id FROM podcast_listening_states
            WHERE user_id = :viewer_id {candidate_filter}
        )
        SELECT
            ids.media_id,
            {read_state} AS read_state,
            CASE
                WHEN m.kind = 'podcast_episode' AND pls.media_id IS NOT NULL
                     AND {duration_ms} > 0
                    THEN LEAST(1.0, GREATEST(0.0, pls.position_ms::float8 / {duration_ms}))
                WHEN m.kind <> 'podcast_episode' THEN cursor.total_progression
                ELSE NULL
            END AS progress_fraction,
            CASE
                WHEN m.kind = 'podcast_episode'
                    THEN co.status IS NOT NULL OR COALESCE(pls.position_ms, 0) > 0
                ELSE co.status IS NOT NULL OR res.media_id IS NOT NULL
            END AS progress_resettable,
            CASE
                WHEN m.kind = 'podcast_episode' THEN pls.last_engaged_at
                ELSE res.last_engaged_at
            END AS last_engaged_at
        FROM consumption_media_ids ids
        JOIN media m ON m.id = ids.media_id
        LEFT JOIN consumption_overrides co
          ON co.user_id = :viewer_id AND co.media_id = ids.media_id
        LEFT JOIN reader_engagement_states res
          ON res.user_id = :viewer_id AND res.media_id = ids.media_id
        LEFT JOIN podcast_listening_states pls
          ON pls.user_id = :viewer_id AND pls.media_id = ids.media_id
        LEFT JOIN podcast_episodes pe ON pe.media_id = ids.media_id
        LEFT JOIN ({reader_cursor.current_position_rows_sql()}) cursor
          ON cursor.media_id = ids.media_id
    """


def episode_state_case_sql(*, listening_alias: str, override_alias: str) -> str:
    """``played`` | ``in_progress`` | ``unplayed`` for one podcast episode.

    Requires the joins of :func:`episode_state_joins_sql`.
    """
    return _read_state_case_sql(
        listening=listening_alias,
        override=override_alias,
        labels=("played", "in_progress", "unplayed"),
    )


def episode_state_joins_sql(
    *, user_param: str, media_expr: str, listening_alias: str, override_alias: str
) -> str:
    """LEFT JOINs binding the viewer's listening row and explicit override."""
    return f"""
        LEFT JOIN podcast_listening_states {listening_alias}
          ON {listening_alias}.user_id = {user_param}
         AND {listening_alias}.media_id = {media_expr}
        LEFT JOIN consumption_overrides {override_alias}
          ON {override_alias}.user_id = {user_param}
         AND {override_alias}.media_id = {media_expr}
    """


@dataclass(frozen=True, slots=True)
class ReadState:
    state: ConsumptionState
    progress: float | None
    resettable: bool


def media_read_states(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, ReadState]:
    """Read state for every requested media; media with no rows are Unread."""
    rows = db.execute(
        text(engagement_fact_rows_sql(media_ids_param="media_ids")),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    found = {
        row.media_id: ReadState(row.read_state, row.progress_fraction, row.progress_resettable)
        for row in rows
    }
    return {
        media_id: found.get(media_id, ReadState("Unread", None, False)) for media_id in media_ids
    }


def player_descriptors(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, wire.PlayerDescriptor]:
    """Descriptors of the playable episodes among ``media_ids``; others are missing."""
    duration = _duration_sql("pls", "pe")
    rows = db.execute(
        text(f"""
            SELECT m.id AS media_id, m.title, m.external_playback_url, m.canonical_source_url,
                   m.provider, m.provider_id, p.title AS podcast_title, p.image_url,
                   {duration} AS duration_ms, COALESCE(pls.reset_epoch, 0) AS reset_epoch,
                   CASE WHEN co.status = 'finished'
                        THEN 0 ELSE COALESCE(pls.position_ms, 0) END AS position_ms,
                   co.revision AS override_revision,
                   COALESCE(pls.playback_speed, ps.default_playback_speed, 1.0) AS rate,
                   ps.podcast_id, ps.pause_shortening_mode
            FROM media m
            JOIN podcast_episodes pe ON pe.media_id = m.id
            LEFT JOIN podcasts p ON p.id = pe.podcast_id
            LEFT JOIN podcast_listening_states pls
              ON pls.user_id = :viewer_id AND pls.media_id = m.id
            LEFT JOIN consumption_overrides co ON co.user_id = :viewer_id AND co.media_id = m.id
            LEFT JOIN podcast_subscriptions ps
              ON ps.user_id = :viewer_id AND ps.podcast_id = pe.podcast_id
            WHERE m.id = ANY(:media_ids) AND m.kind = 'podcast_episode'
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).all()
    chapters: dict[UUID, list[wire.ChapterOut]] = {}
    for chapter in db.execute(
        text("""
            SELECT media_id, title, t_start_ms, t_end_ms FROM (
                SELECT *, row_number() OVER (PARTITION BY media_id ORDER BY chapter_idx) AS n
                FROM podcast_episode_chapters WHERE media_id = ANY(:media_ids)
            ) first WHERE n <= 100
            ORDER BY media_id, chapter_idx
        """),
        {"media_ids": [row.media_id for row in rows]},
    ):
        if chapter.title[:300].strip():
            chapters.setdefault(chapter.media_id, []).append(
                wire.ChapterOut(
                    title=chapter.title[:300],
                    start_ms=chapter.t_start_ms,
                    end_ms=chapter.t_end_ms,
                )
            )
    descriptors: dict[UUID, wire.PlayerDescriptor] = {}
    for row in rows:
        source = episode_playback_source(
            kind="podcast_episode",
            has_episode=True,
            external_playback_url=row.external_playback_url,
            canonical_source_url=row.canonical_source_url,
            provider=row.provider,
            provider_id=row.provider_id,
        )
        if source is None:
            continue
        subtitle = row.podcast_title[:300] if row.podcast_title is not None else None
        descriptors[row.media_id] = wire.PlayerDescriptor(
            media_id=row.media_id,
            title=row.title[:300],
            subtitle=subtitle,
            artwork_url=row.image_url,
            stream_url=source.stream_url,
            position_ms=row.position_ms,
            duration_ms=row.duration_ms,
            reset_epoch=row.reset_epoch,
            consumption_override_revision=row.override_revision,
            playback_rate=float(row.rate),
            podcast_id=row.podcast_id,
            pause_shortening_mode=row.pause_shortening_mode,
            chapters=chapters.get(row.media_id, []),
        )
    return descriptors


def listening_duration(
    *, position_ms: int, listening_duration_ms: int | None, feed_duration_seconds: int | None
) -> MediaDurationOut | None:
    """Display media time at 1×: the listening record's duration before the feed's."""
    duration_ms = (
        listening_duration_ms
        if listening_duration_ms is not None
        else feed_duration_seconds * 1000
        if feed_duration_seconds is not None
        else None
    )
    if duration_ms is None or duration_ms <= 0:
        return None
    return MediaDurationOut(
        modality="Listen",
        estimate=ReadingTimeEstimateOut(
            total_minutes=ceil(duration_ms / 60_000),
            remaining_minutes=ceil(max(0, duration_ms - position_ms) / 60_000),
        ),
    )


def media_kind(db: Session, media_id: UUID) -> str | None:
    return db.scalar(text("SELECT kind FROM media WHERE id = :id"), {"id": media_id})


def engagement_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    """When the viewer last read or listened; state-only changes do not count."""
    rows = db.execute(
        text("""
            SELECT media_id, max(last_engaged_at) AS at FROM (
                SELECT media_id, last_engaged_at FROM reader_engagement_states
                WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
                UNION ALL
                SELECT media_id, last_engaged_at FROM podcast_listening_states
                WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
                  AND last_engaged_at IS NOT NULL
            ) engaged GROUP BY media_id
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    return {row.media_id: row.at for row in rows}


@dataclass(frozen=True, slots=True)
class RecentEngagementAnchorFact:
    media_id: UUID
    activity_at: datetime


def recent_engagement_anchor_facts(
    db: Session, *, viewer_id: UUID, limit: int
) -> tuple[RecentEngagementAnchorFact, ...]:
    """Newest distinct visible media by reader or listener engagement.

    Both indexed sources are bounded independently before their small merge.
    """
    rows = db.execute(
        text(f"""
            WITH reader_recent AS (
                SELECT engagement.media_id, engagement.last_engaged_at
                FROM reader_engagement_states engagement
                WHERE engagement.user_id = :viewer_id
                  AND engagement.media_id IN ({visible_media_ids_cte_sql()})
                ORDER BY engagement.last_engaged_at DESC, engagement.media_id ASC
                LIMIT :limit
            ),
            listening_recent AS (
                SELECT listening.media_id, listening.last_engaged_at
                FROM podcast_listening_states listening
                WHERE listening.user_id = :viewer_id
                  AND listening.last_engaged_at IS NOT NULL
                  AND listening.media_id IN ({visible_media_ids_cte_sql()})
                ORDER BY listening.last_engaged_at DESC, listening.media_id ASC
                LIMIT :limit
            ),
            combined AS (
                SELECT media_id, last_engaged_at FROM reader_recent
                UNION ALL
                SELECT media_id, last_engaged_at FROM listening_recent
            )
            SELECT media_id, MAX(last_engaged_at) AS activity_at
            FROM combined
            GROUP BY media_id
            ORDER BY activity_at DESC, media_id ASC
            LIMIT :limit
        """),
        {"viewer_id": viewer_id, "limit": limit},
    )
    return tuple(RecentEngagementAnchorFact(row.media_id, row.activity_at) for row in rows)
