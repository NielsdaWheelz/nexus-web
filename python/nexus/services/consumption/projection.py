"""The consumption read model.

Explicit override, then the podcast listening ladder, then reader engagement:
that precedence is derived once in Python (for Lectern items) and once in SQL
(for every listing that joins :func:`engagement_fact_rows_sql` or
:func:`episode_state_case_sql`). This module is the sole owner of both; no
adopter reads the consumption tables directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import visible_media_ids_cte_sql
from nexus.db.models import MediaKind
from nexus.schemas.consumption import (
    ChapterOut,
    ConsumptionMediaKind,
    ConsumptionOut,
    ConsumptionStateValue,
    FooterAudioActivation,
    LecternActivation,
    LecternItemOut,
    LecternSnapshot,
    ListeningStateOut,
    OpenPaneActivation,
    PlaybackRateResolution,
    PlayerDescriptor,
    PodcastPlaybackPreference,
    ReadableActivation,
)
from nexus.schemas.consumption_activity import ActivityModality
from nexus.schemas.media import MediaReadState, PlaybackSourceOut
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present
from nexus.services.consumption import _listening_store, state
from nexus.services.consumption._lectern_store import LecternRow
from nexus.services.consumption._listening_store import ListeningRow
from nexus.services.playback_source import derive_playback_source
from nexus.services.podcasts.playback_preferences import (
    SubscriptionPlaybackSettings,
    load_subscription_playback_settings,
)

FINISHED_PROGRESSION = 0.95
_MAX_CHAPTERS = 100
_MAX_TITLE_CHARS = 300
_READABLE_KINDS = frozenset(
    {MediaKind.web_article.value, MediaKind.epub.value, MediaKind.pdf.value}
)
_COMPLETION_MODALITY: dict[str, ActivityModality] = {
    MediaKind.web_article.value: "Reading",
    MediaKind.epub.value: "Reading",
    MediaKind.pdf.value: "Reading",
    MediaKind.podcast_episode.value: "Listening",
    MediaKind.video.value: "Viewing",
}
_TO_READ_STATE: dict[ConsumptionStateValue, MediaReadState] = {
    "Unread": "unread",
    "InProgress": "in_progress",
    "Finished": "finished",
}


def completion_modality_for_kind(kind: str) -> ActivityModality:
    return _COMPLETION_MODALITY[kind]


def build_snapshot(db: Session, *, viewer_id: UUID, rows: list[LecternRow]) -> LecternSnapshot:
    """Project the viewer's visible rows into the canonical snapshot."""
    return LecternSnapshot(
        items=_project(db, viewer_id=viewer_id, rows=[r for r in rows if r.visible])
    )


def build_item(db: Session, *, viewer_id: UUID, row: LecternRow) -> LecternItemOut:
    return _project(db, viewer_id=viewer_id, rows=[row])[0]


def activation_kind(row: LecternRow) -> str:
    """The activation discriminator alone, without loading listening state."""
    if row.kind in _READABLE_KINDS:
        return "Readable"
    return "FooterAudio" if _stream_source(row) is not None else "OpenPane"


def _stream_source(row: LecternRow) -> PlaybackSourceOut | None:
    """The playable audio source, or ``None`` when the row opens a pane instead."""
    if row.kind != MediaKind.podcast_episode.value:
        return None
    source = derive_playback_source(
        kind=row.kind,
        external_playback_url=row.external_playback_url,
        canonical_source_url=row.canonical_source_url,
        provider=row.provider,
        provider_id=row.provider_id,
    )
    return source if source is not None and source.stream_url else None


def _project(db: Session, *, viewer_id: UUID, rows: list[LecternRow]) -> list[LecternItemOut]:
    if not rows:
        return []
    media_ids = [row.media_id for row in rows]
    sources = {row.media_id: _stream_source(row) for row in rows}
    audio_ids = [media_id for media_id, source in sources.items() if source is not None]
    overrides = state.load_override_rows(db, viewer_id=viewer_id, media_ids=media_ids)
    listening = _listening_store.load_states(db, viewer_id=viewer_id, media_ids=media_ids)
    subscriptions = load_subscription_playback_settings(
        db,
        viewer_id=viewer_id,
        podcast_ids=[row.podcast_id for row in rows if row.podcast_id is not None],
    )
    chapters = _load_chapters(db, audio_ids)
    engagement = state.load_engagement_rows(
        db, viewer_id=viewer_id, media_ids=[m for m in media_ids if sources[m] is None]
    )

    items: list[LecternItemOut] = []
    for row in rows:
        source = sources[row.media_id]
        listening_row = listening.get(row.media_id)
        engagement_row = engagement.get(row.media_id)
        override = overrides.get(row.media_id)
        if source is None:
            activation: LecternActivation = (
                ReadableActivation() if row.kind in _READABLE_KINDS else OpenPaneActivation()
            )
            derived, progress = _doc_state(engagement_row)
        else:
            # justify-defect: every podcast_episode row joins its parent relation.
            assert row.podcast_id is not None
            activation = _footer_audio(
                source=source,
                listening=listening_row,
                podcast_id=row.podcast_id,
                subscription=subscriptions.get(row.podcast_id),
                override=override,
                duration_seconds=row.duration_seconds,
                artwork_url=row.podcast_image_url,
                chapters=chapters.get(row.media_id, []),
            )
            derived, progress = _audio_state(listening_row, row.duration_seconds)
        items.append(
            LecternItemOut(
                item_id=row.item_id,
                media_id=row.media_id,
                kind=cast(ConsumptionMediaKind, row.kind),
                title=row.title[:_MAX_TITLE_CHARS],
                subtitle=present(row.podcast_title) if row.podcast_title is not None else absent(),
                href=f"/media/{row.media_id}",
                added_at=row.added_at,
                consumption=ConsumptionOut(
                    state=override.state if override is not None else derived,
                    progress=progress,
                    progress_resettable=(
                        override is not None
                        or engagement_row is not None
                        or (
                            listening_row is not None
                            and (listening_row.position_ms > 0 or listening_row.is_completed)
                        )
                    ),
                ),
                activation=activation,
            )
        )
    return items


def _footer_audio(
    *,
    source: PlaybackSourceOut,
    listening: ListeningRow | None,
    podcast_id: UUID,
    subscription: SubscriptionPlaybackSettings | None,
    override: state.OverrideRow | None,
    duration_seconds: int | None,
    artwork_url: str | None,
    chapters: list[ChapterOut],
) -> FooterAudioActivation:
    """The one footer-playable activation, shared by Lectern items and descriptors."""
    duration_ms: Absent | Present[int] = absent()
    if listening is not None and listening.duration_ms is not None:
        duration_ms = present(listening.duration_ms)
    elif duration_seconds is not None:
        duration_ms = present(duration_seconds * 1000)
    return FooterAudioActivation(
        stream_url=source.stream_url,
        source_url=source.source_url,
        position_ms=listening.position_ms if listening is not None else 0,
        write_revision=listening.write_revision if listening is not None else 0,
        reset_epoch=listening.reset_epoch if listening is not None else 0,
        playback_rate=_playback_rate(
            episode_rate=listening.playback_speed if listening is not None else None,
            podcast_id=podcast_id,
            subscription_preference=subscription.playback_rate
            if subscription is not None
            else None,
        ),
        pause_shortening_mode=(
            subscription.pause_shortening_mode if subscription is not None else absent()
        ),
        consumption_override_revision=(
            present(override.revision) if override is not None else absent()
        ),
        duration_ms=duration_ms,
        artwork_url=present(artwork_url) if artwork_url is not None else absent(),
        chapters=chapters,
    )


def _playback_rate(
    *,
    episode_rate: float | None,
    podcast_id: UUID,
    subscription_preference: Absent | Present[float] | None,
) -> PlaybackRateResolution:
    """Episode rate wins, then the subscription preference, then the product default."""
    podcast_preference = (
        present(
            PodcastPlaybackPreference.model_validate(
                {"podcast_id": podcast_id, "value": subscription_preference.model_dump()}
            )
        )
        if subscription_preference is not None
        else absent()
    )
    if episode_rate is not None:
        return PlaybackRateResolution(
            value=episode_rate, source="Episode", podcast_preference=podcast_preference
        )
    if isinstance(subscription_preference, Present):
        return PlaybackRateResolution(
            value=subscription_preference.value,
            source="Podcast",
            podcast_preference=podcast_preference,
        )
    return PlaybackRateResolution(value=1, source="Product", podcast_preference=podcast_preference)


def player_descriptors(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, PlayerDescriptor]:
    """Batch footer-playable descriptors for podcast-episode media.

    Derives exactly like a Lectern item, with one listening load and one
    chapters load for the whole page. A media absent from the result is either
    not an episode or has no playable audio.
    """
    if not media_ids:
        return {}
    rows = [
        dict(row)
        for row in db.execute(
            text("""
                SELECT m.id AS media_id, m.title, m.external_playback_url,
                       m.canonical_source_url, m.provider, m.provider_id,
                       pe.podcast_id, p.title AS podcast_title,
                       p.image_url AS podcast_image_url, pe.duration_seconds
                FROM media m
                JOIN podcast_episodes pe ON pe.media_id = m.id
                LEFT JOIN podcasts p ON p.id = pe.podcast_id
                WHERE m.id = ANY(:media_ids) AND m.kind = :kind
            """),
            {"media_ids": media_ids, "kind": MediaKind.podcast_episode.value},
        ).mappings()
    ]
    if not rows:
        return {}
    for row in rows:
        row["media_id"] = UUID(str(row["media_id"]))
        row["podcast_id"] = UUID(str(row["podcast_id"]))
    row_media_ids = [row["media_id"] for row in rows]
    listening = _listening_store.load_states(db, viewer_id=viewer_id, media_ids=row_media_ids)
    subscriptions = load_subscription_playback_settings(
        db, viewer_id=viewer_id, podcast_ids=[row["podcast_id"] for row in rows]
    )
    overrides = state.load_override_rows(db, viewer_id=viewer_id, media_ids=row_media_ids)
    chapters = _load_chapters(db, row_media_ids)

    result: dict[UUID, PlayerDescriptor] = {}
    for row in rows:
        source = derive_playback_source(
            kind=MediaKind.podcast_episode.value,
            external_playback_url=row["external_playback_url"],
            canonical_source_url=row["canonical_source_url"],
            provider=row["provider"],
            provider_id=row["provider_id"],
        )
        if source is None or not source.stream_url:
            continue
        media_id = row["media_id"]
        subtitle = row["podcast_title"]
        duration_seconds = row["duration_seconds"]
        result[media_id] = PlayerDescriptor(
            media_id=media_id,
            title=str(row["title"])[:_MAX_TITLE_CHARS],
            subtitle=present(str(subtitle)) if subtitle is not None else absent(),
            activation=_footer_audio(
                source=source,
                listening=listening.get(media_id),
                podcast_id=row["podcast_id"],
                subscription=subscriptions.get(row["podcast_id"]),
                override=overrides.get(media_id),
                duration_seconds=int(duration_seconds) if duration_seconds is not None else None,
                artwork_url=row["podcast_image_url"],
                chapters=chapters.get(media_id, []),
            ),
        )
    return result


def to_listening_state_out(row: ListeningRow | None) -> ListeningStateOut:
    """Wire shape for one media's listening state (owned-absence defaults)."""
    if row is None:
        return ListeningStateOut(
            position_ms=0,
            duration_ms=absent(),
            episode_playback_rate=absent(),
            write_revision=0,
            reset_epoch=0,
        )
    return ListeningStateOut(
        position_ms=row.position_ms,
        duration_ms=presence_from_nullable(row.duration_ms),
        episode_playback_rate=presence_from_nullable(row.playback_speed),
        write_revision=row.write_revision,
        reset_epoch=row.reset_epoch,
    )


def _audio_state(
    listening: ListeningRow | None, duration_seconds: int | None
) -> tuple[ConsumptionStateValue, Absent | Present[float]]:
    if listening is None:
        return "Unread", absent()
    duration_ms = listening.duration_ms
    if duration_ms is None and duration_seconds is not None:
        duration_ms = duration_seconds * 1000
    fraction = (
        min(1.0, listening.position_ms / duration_ms)
        if duration_ms is not None and duration_ms > 0
        else None
    )
    progress: Absent | Present[float] = present(fraction) if fraction is not None else absent()
    if listening.is_completed or (fraction is not None and fraction >= FINISHED_PROGRESSION):
        return "Finished", progress
    if listening.position_ms > 0:
        return "InProgress", progress
    return "Unread", progress


def _doc_state(
    engagement: state.ReaderEngagementRow | None,
) -> tuple[ConsumptionStateValue, Absent | Present[float]]:
    """Any retained engagement row means in-progress; there is no dwell threshold."""
    if engagement is None:
        return "Unread", absent()
    reached = engagement.max_total_progression
    progress: Absent | Present[float] = present(reached) if reached is not None else absent()
    if reached is not None and reached >= FINISHED_PROGRESSION:
        return "Finished", progress
    return "InProgress", progress


def _load_chapters(db: Session, media_ids: list[UUID]) -> dict[UUID, list[ChapterOut]]:
    """First 100 stored rows per media by ordinal; a blank-title row is dropped.

    The cap counts raw rows, so a malformed row inside the window is excluded
    rather than replaced by the 101st.
    """
    if not media_ids:
        return {}
    rows = db.execute(
        text("""
            SELECT media_id, title, t_start_ms, t_end_ms
            FROM podcast_episode_chapters
            WHERE media_id = ANY(:media_ids)
            ORDER BY media_id ASC, chapter_idx ASC
        """),
        {"media_ids": media_ids},
    ).fetchall()
    result: dict[UUID, list[ChapterOut]] = {}
    seen: dict[UUID, int] = {}
    for media_id_raw, title_raw, start_ms, end_ms in rows:
        media_id = UUID(str(media_id_raw))
        raw_count = seen.get(media_id, 0)
        if raw_count >= _MAX_CHAPTERS:
            continue
        seen[media_id] = raw_count + 1
        title = str(title_raw)[:_MAX_TITLE_CHARS]
        if not title.strip():
            continue
        result.setdefault(media_id, []).append(
            ChapterOut(
                title=title,
                start_ms=int(start_ms),
                end_ms=presence_from_nullable(int(end_ms) if end_ms is not None else None),
            )
        )
    return result


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
    """Composable canonical consumption facts for one viewer. Binds ``:viewer_id``.

    Columns: ``media_id``, ``read_state``, ``progress_fraction``,
    ``progress_resettable``, ``last_engaged_at``. The candidate union stays
    MATERIALIZED: four listing surfaces compose this as a joined subquery, and
    inlining re-runs the union once per outer candidate. ``media_ids_param``
    names a bound UUID array applied inside every candidate arm.
    """
    duration_ms = "COALESCE(pls.duration_ms, pe.duration_seconds * 1000)"
    candidate_filter = f"AND media_id = ANY(:{media_ids_param})" if media_ids_param else ""
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
            {
        _read_state_case_sql(
            listening="pls",
            override="co",
            episode="pe",
            labels=("Finished", "InProgress", "Unread"),
            media_kind="m.kind",
            engagement="res",
        )
    } AS read_state,
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

    Requires the joins from :func:`episode_state_joins_sql` and an episode alias
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
    """Complete Lectern membership (hidden rows included). Binds ``:viewer_id``."""
    return "SELECT q.media_id FROM consumption_queue_items q WHERE q.user_id = :viewer_id"


def lectern_item_count(db: Session, *, viewer_id: UUID) -> int:
    """Count every Lectern row, including hidden rows."""
    return int(
        db.execute(
            text("SELECT COUNT(*) FROM consumption_queue_items WHERE user_id = :viewer_id"),
            {"viewer_id": viewer_id},
        ).scalar_one()
    )


@dataclass(frozen=True)
class MediaReadStateOut:
    state: MediaReadState
    progress_fraction: float | None
    progress_resettable: bool


def media_read_states(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, MediaReadStateOut]:
    """Batch read-state for arbitrary media; media with no rows are Unread."""
    if not media_ids:
        return {}
    result = {
        media_id: MediaReadStateOut(
            state="unread", progress_fraction=None, progress_resettable=False
        )
        for media_id in media_ids
    }
    rows = db.execute(
        text(engagement_fact_rows_sql(media_ids_param="media_ids")),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).mappings()
    for row in rows:
        fraction = row["progress_fraction"]
        result[UUID(str(row["media_id"]))] = MediaReadStateOut(
            state=_TO_READ_STATE[cast(ConsumptionStateValue, row["read_state"])],
            progress_fraction=float(fraction) if fraction is not None else None,
            progress_resettable=bool(row["progress_resettable"]),
        )
    return result


def listening_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    return _listening_store.load_recency(db, viewer_id=viewer_id, media_ids=media_ids)


def reader_engagement_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    return state.engagement_recency(db, viewer_id=viewer_id, media_ids=media_ids)


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
    if limit < 1:
        return ()
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
    ).mappings()
    return tuple(
        RecentEngagementAnchorFact(
            media_id=UUID(str(row["media_id"])), activity_at=row["activity_at"]
        )
        for row in rows
    )


def media_kinds(db: Session, media_ids: list[UUID]) -> dict[UUID, str]:
    """The stored ``media.kind`` for each id present."""
    if not media_ids:
        return {}
    rows = db.execute(
        text("SELECT id, kind FROM media WHERE id = ANY(:ids)"), {"ids": media_ids}
    ).fetchall()
    return {UUID(str(media_id)): str(kind) for media_id, kind in rows}
