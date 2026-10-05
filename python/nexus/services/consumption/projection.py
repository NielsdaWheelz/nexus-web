"""The consumption read model other slices compose.

Read state has one rule, written once in SQL: explicit override, then the
podcast listening ladder, then reader engagement, else unread. Listings join
:func:`engagement_fact_rows_sql` or :func:`episode_state_case_sql`; Lectern
items and :func:`media_read_states` read the same relation.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from math import ceil
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.schemas.consumption import (
    ChapterOut,
    ConsumptionOut,
    ConsumptionStateValue,
    FooterAudioActivation,
    LecternItemOut,
    LecternSnapshot,
    ListeningStateOut,
    OpenPaneActivation,
    PlaybackRateResolution,
    PlayerDescriptor,
    PlayerDisplay,
    PodcastPlaybackPreference,
    ReadableActivation,
)
from nexus.schemas.media import MediaReadState
from nexus.schemas.media_summary import MediaDurationOut, MediaSummaryOut
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present
from nexus.schemas.reading_time import ReadingTimeEstimateOut
from nexus.services.consumption import _listening_store
from nexus.services.consumption._lectern_store import LecternRow
from nexus.services.consumption._listening_store import ListeningRow
from nexus.services.playback_source import derive_playback_source
from nexus.services.podcasts.playback_preferences import load_subscription_playback_settings

FINISHED_PROGRESSION = 0.95
_READABLE_KINDS = frozenset({"web_article", "epub", "pdf"})
_TO_READ_STATE: dict[str, MediaReadState] = {
    "Unread": "unread",
    "InProgress": "in_progress",
    "Finished": "finished",
}


def _read_state_case_sql(
    *,
    listening: str,
    override: str,
    episode: str,
    labels: tuple[str, str, str],
    media_kind: str | None = None,
    engagement: str | None = None,
) -> str:
    """Override, then the audio ladder, then reader engagement, then unread.

    ``media_kind`` guards the audio ladder for a mixed-kind relation; without it
    the relation is podcast-episode only. ``engagement`` adds the reader arm.
    """
    finished, in_progress, unread = labels
    duration = f"COALESCE({listening}.duration_ms, {episode}.duration_seconds * 1000)"
    audio = f"""
            WHEN {listening}.is_completed IS TRUE THEN '{finished}'
            WHEN {duration} > 0
                 AND {listening}.position_ms::float8 / {duration} >= {FINISHED_PROGRESSION}
                THEN '{finished}'
            WHEN COALESCE({listening}.position_ms, 0) > 0 THEN '{in_progress}'"""
    if media_kind is not None:
        audio = f"""
            WHEN {media_kind} = 'podcast_episode' THEN
                CASE{audio}
                    ELSE '{unread}'
                END"""
    reader = (
        f"""
            WHEN {engagement}.media_id IS NOT NULL THEN
                CASE
                    WHEN {engagement}.max_total_progression >= {FINISHED_PROGRESSION}
                        THEN '{finished}'
                    ELSE '{in_progress}'
                END"""
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

    Columns: ``media_id``, ``read_state``, ``progress_fraction``,
    ``progress_resettable``, ``last_engaged_at``. The candidate union stays
    MATERIALIZED: listings compose this as a joined subquery, and inlining
    re-runs the union once per outer row. ``media_ids_param`` names a bound
    UUID array applied inside every candidate arm.
    """
    duration_ms = "COALESCE(pls.duration_ms, pe.duration_seconds * 1000)"
    candidate_filter = f"AND media_id = ANY(:{media_ids_param})" if media_ids_param else ""
    read_state = _read_state_case_sql(
        listening="pls",
        override="co",
        episode="pe",
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
                WHEN m.kind = 'podcast_episode' AND {duration_ms} > 0
                    THEN LEAST(1.0, pls.position_ms::float8 / {duration_ms})
                WHEN m.kind <> 'podcast_episode' THEN res.max_total_progression
                ELSE NULL
            END AS progress_fraction,
            CASE
                WHEN m.kind = 'podcast_episode' THEN (
                    co.media_id IS NOT NULL
                    OR COALESCE(pls.position_ms, 0) > 0
                    OR pls.is_completed IS TRUE
                )
                ELSE (co.media_id IS NOT NULL OR res.media_id IS NOT NULL)
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
    """


def episode_state_case_sql(*, listening_alias: str, override_alias: str, episode_alias: str) -> str:
    """``played`` | ``in_progress`` | ``unplayed`` for one podcast episode.

    Requires the joins of :func:`episode_state_joins_sql` and an episode alias
    exposing ``duration_seconds``.
    """
    return _read_state_case_sql(
        listening=listening_alias,
        override=override_alias,
        episode=episode_alias,
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


def lectern_membership_rows_sql() -> str:
    """Complete Lectern membership, hidden rows included. Binds ``:viewer_id``."""
    return "SELECT q.media_id FROM consumption_queue_items q WHERE q.user_id = :viewer_id"


def _read_states(
    db: Session, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, tuple[ConsumptionStateValue, float | None, bool]]:
    """``(state, progress, resettable)`` for media with any consumption row."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(engagement_fact_rows_sql(media_ids_param="media_ids")),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).mappings()
    return {
        row["media_id"]: (
            cast(ConsumptionStateValue, row["read_state"]),
            row["progress_fraction"],
            row["progress_resettable"],
        )
        for row in rows
    }


@dataclass(frozen=True)
class MediaReadStateOut:
    state: MediaReadState
    progress_fraction: float | None
    progress_resettable: bool


def media_read_states(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, MediaReadStateOut]:
    """Read state for every requested media; media with no rows are unread."""
    states = _read_states(db, viewer_id, media_ids)
    return {
        media_id: MediaReadStateOut(_TO_READ_STATE[state], progress, resettable)
        for media_id in media_ids
        for state, progress, resettable in [states.get(media_id, ("Unread", None, False))]
    }


def consumption_for_media(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, Present[ConsumptionOut]]:
    """Wire consumption for every requested media; media with no rows are unread."""
    states = _read_states(db, viewer_id, media_ids)
    return {
        media_id: present(
            ConsumptionOut(
                state=state,
                progress=presence_from_nullable(progress),
                progress_resettable=resettable,
            )
        )
        for media_id in media_ids
        for state, progress, resettable in [states.get(media_id, ("Unread", None, False))]
    }


def build_snapshot(
    db: Session, *, viewer_id: UUID, rows: list[LecternRow], summaries: dict[UUID, MediaSummaryOut]
) -> LecternSnapshot:
    """The viewer's visible Lectern rows as the canonical snapshot."""
    return LecternSnapshot(
        items=_items(db, viewer_id, [row for row in rows if row.visible], summaries)
    )


def build_item(
    db: Session, *, viewer_id: UUID, row: LecternRow, summaries: dict[UUID, MediaSummaryOut]
) -> LecternItemOut:
    return _items(db, viewer_id, [row], summaries)[0]


def _items(
    db: Session, viewer_id: UUID, rows: list[LecternRow], summaries: dict[UUID, MediaSummaryOut]
) -> list[LecternItemOut]:
    states = _read_states(db, viewer_id, [row.media_id for row in rows])
    descriptors = player_descriptors(
        db,
        viewer_id=viewer_id,
        media_ids=[row.media_id for row in rows if row.kind == "podcast_episode"],
    )
    items = []
    for row in rows:
        state, progress, resettable = states.get(row.media_id, ("Unread", None, False))
        descriptor = descriptors.get(row.media_id)
        items.append(
            LecternItemOut(
                item_id=row.item_id,
                media_summary=summaries[row.media_id],
                href=f"/media/{row.media_id}",
                added_at=row.added_at,
                consumption=ConsumptionOut(
                    state=state,
                    progress=presence_from_nullable(progress),
                    progress_resettable=resettable,
                ),
                activation=descriptor.activation
                if descriptor
                else ReadableActivation()
                if row.kind in _READABLE_KINDS
                else OpenPaneActivation(),
                player_display=present(
                    PlayerDisplay(title=descriptor.title, subtitle=descriptor.subtitle)
                )
                if descriptor
                else absent(),
            )
        )
    return items


def activation_kind(row: LecternRow) -> str:
    """The activation discriminator alone, without loading listening state."""
    if row.kind in _READABLE_KINDS:
        return "Readable"
    source = (
        derive_playback_source(
            kind=row.kind,
            external_playback_url=row.external_playback_url,
            canonical_source_url=row.canonical_source_url,
            provider=row.provider,
            provider_id=row.provider_id,
        )
        if row.kind == "podcast_episode"
        else None
    )
    return "FooterAudio" if source is not None and source.stream_url else "OpenPane"


def player_descriptors(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, PlayerDescriptor]:
    """Footer-playable descriptors; a media missing from the result has no playable audio."""
    if not media_ids:
        return {}
    rows = (
        db.execute(
            text("""
                SELECT m.id AS media_id, m.title, m.external_playback_url,
                       m.canonical_source_url, m.provider, m.provider_id,
                       pe.podcast_id, p.title AS podcast_title,
                       p.image_url AS podcast_image_url, pe.duration_seconds
                FROM media m
                JOIN podcast_episodes pe ON pe.media_id = m.id
                LEFT JOIN podcasts p ON p.id = pe.podcast_id
                WHERE m.id = ANY(:media_ids) AND m.kind = 'podcast_episode'
            """),
            {"media_ids": media_ids},
        )
        .mappings()
        .all()
    )
    ids = [row["media_id"] for row in rows]
    listening = _listening_store.load_states(db, viewer_id=viewer_id, media_ids=ids)
    subscriptions = load_subscription_playback_settings(
        db, viewer_id=viewer_id, podcast_ids=[row["podcast_id"] for row in rows]
    )
    revisions = override_revisions(db, viewer_id=viewer_id, media_ids=ids)
    chapters: dict[UUID, list[ChapterOut]] = {}
    for chapter in db.execute(
        text("""
            SELECT media_id, title, t_start_ms, t_end_ms FROM (
                SELECT *, row_number() OVER (PARTITION BY media_id ORDER BY chapter_idx) AS n
                FROM podcast_episode_chapters WHERE media_id = ANY(:media_ids)
            ) first WHERE n <= 100
            ORDER BY media_id, chapter_idx
        """),
        {"media_ids": ids},
    ):
        if chapter.title[:300].strip():
            chapters.setdefault(chapter.media_id, []).append(
                ChapterOut(
                    title=chapter.title[:300],
                    start_ms=chapter.t_start_ms,
                    end_ms=presence_from_nullable(chapter.t_end_ms),
                )
            )

    result: dict[UUID, PlayerDescriptor] = {}
    for row in rows:
        source = derive_playback_source(
            kind="podcast_episode",
            external_playback_url=row["external_playback_url"],
            canonical_source_url=row["canonical_source_url"],
            provider=row["provider"],
            provider_id=row["provider_id"],
        )
        if source is None or not source.stream_url:
            continue
        media_id, podcast_id = row["media_id"], row["podcast_id"]
        heard = listening.get(media_id)
        subscription = subscriptions.get(podcast_id)
        preference = subscription.playback_rate if subscription is not None else None
        rate_source: Literal["Episode", "Podcast", "Product"]
        if heard is not None and heard.playback_speed is not None:
            rate, rate_source = heard.playback_speed, "Episode"
        elif isinstance(preference, Present):
            rate, rate_source = preference.value, "Podcast"
        else:
            rate, rate_source = 1.0, "Product"
        listened_ms = heard.duration_ms if heard is not None else None
        duration_ms = _duration_ms(listened_ms, row["duration_seconds"])
        result[media_id] = PlayerDescriptor(
            media_id=media_id,
            title=row["title"][:300],
            subtitle=presence_from_nullable(
                row["podcast_title"][:300] if row["podcast_title"] is not None else None
            ),
            activation=FooterAudioActivation(
                stream_url=source.stream_url,
                source_url=source.source_url,
                position_ms=heard.position_ms if heard is not None else 0,
                write_revision=heard.write_revision if heard is not None else 0,
                reset_epoch=heard.reset_epoch if heard is not None else 0,
                playback_rate=PlaybackRateResolution(
                    value=rate,
                    source=rate_source,
                    podcast_preference=present(
                        PodcastPlaybackPreference.model_validate(
                            {"podcast_id": podcast_id, "value": preference.model_dump()}
                        )
                    )
                    if preference is not None
                    else absent(),
                ),
                pause_shortening_mode=subscription.pause_shortening_mode
                if subscription is not None
                else absent(),
                consumption_override_revision=presence_from_nullable(revisions.get(media_id)),
                duration_ms=presence_from_nullable(duration_ms),
                artwork_url=presence_from_nullable(row["podcast_image_url"]),
                chapters=chapters.get(media_id, []),
            ),
        )
    return result


def listening_duration(
    *, position_ms: int, listening_duration_ms: int | None, feed_duration_seconds: int | None
) -> Absent | Present[MediaDurationOut]:
    """Display media time at 1×."""
    duration_ms = _duration_ms(listening_duration_ms, feed_duration_seconds)
    if duration_ms is None or duration_ms <= 0:
        return absent()
    return present(
        MediaDurationOut(
            modality="Listen",
            estimate=ReadingTimeEstimateOut(
                total_minutes=ceil(duration_ms / 60_000),
                remaining_minutes=present(ceil(max(0, duration_ms - position_ms) / 60_000)),
            ),
        )
    )


def _duration_ms(listening_ms: int | None, feed_seconds: int | None) -> int | None:
    """Media time at 1×: the listening record's duration before the feed's."""
    if listening_ms is not None:
        return listening_ms
    return feed_seconds * 1000 if feed_seconds is not None else None


def to_listening_state_out(row: ListeningRow | None) -> ListeningStateOut:
    """One media's listening state; no row reads as zero with Absent duration and rate."""
    return ListeningStateOut(
        position_ms=row.position_ms if row is not None else 0,
        duration_ms=presence_from_nullable(row.duration_ms if row is not None else None),
        episode_playback_rate=presence_from_nullable(
            row.playback_speed if row is not None else None
        ),
        write_revision=row.write_revision if row is not None else 0,
        reset_epoch=row.reset_epoch if row is not None else 0,
    )


def override_revisions(db: Session, *, viewer_id: UUID, media_ids: list[UUID]) -> dict[UUID, int]:
    """The explicit override's revision (the natural-end fence) per media that has one."""
    rows = db.execute(
        text("""
            SELECT media_id, revision FROM consumption_overrides
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    return {row.media_id: row.revision for row in rows}


def media_kinds(db: Session, media_ids: list[UUID]) -> dict[UUID, str]:
    rows = db.execute(text("SELECT id, kind FROM media WHERE id = ANY(:ids)"), {"ids": media_ids})
    return {row.id: row.kind for row in rows}


def listening_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    return _listening_store.load_recency(db, viewer_id=viewer_id, media_ids=media_ids)


def reader_engagement_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    rows = db.execute(
        text("""
            SELECT media_id, last_engaged_at FROM reader_engagement_states
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    return {row.media_id: row.last_engaged_at for row in rows}


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
