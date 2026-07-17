"""Consumption read model: explicit override + listening state + reader
engagement -> per-item consumption state, progress, and capability activation.

This is the sole projection owner (spec §8 AC-15); adopters read Lectern items
only through the ``service`` boundary that delegates here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import MediaKind
from nexus.schemas.consumption import (
    ChapterOut,
    ConsumptionOut,
    ConsumptionStateValue,
    FooterAudioActivation,
    LecternActivation,
    LecternItemOut,
    LecternSnapshot,
    ListeningStateOut,
    OpenPaneActivation,
    PlayerDescriptor,
    ReadableActivation,
)
from nexus.schemas.media import MediaReadState
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present
from nexus.services.consumption import _listening_store, _reader_engagement_store, _state_store
from nexus.services.consumption._lectern_store import LecternRow
from nexus.services.consumption._listening_store import ListeningRow
from nexus.services.consumption._reader_engagement_store import ReaderEngagementRow
from nexus.services.playback_source import derive_playback_source

_FINISHED_PROGRESSION = 0.95
_MAX_CHAPTERS = 100
_MAX_TITLE_CHARS = 300
_READABLE_KINDS = frozenset(
    {MediaKind.web_article.value, MediaKind.epub.value, MediaKind.pdf.value}
)


def build_snapshot(db: Session, *, viewer_id: UUID, rows: list[LecternRow]) -> LecternSnapshot:
    """Project the viewer's visible rows into the canonical snapshot."""
    visible = [row for row in rows if row.visible]
    return LecternSnapshot(items=_project(db, viewer_id=viewer_id, rows=visible))


def build_item(db: Session, *, viewer_id: UUID, row: LecternRow) -> LecternItemOut:
    """Project one visible row (next-item selection)."""
    return _project(db, viewer_id=viewer_id, rows=[row])[0]


def to_listening_state_out(row: ListeningRow | None) -> ListeningStateOut:
    """Wire shape for one media's listening state (owned-absence defaults)."""
    if row is None:
        return ListeningStateOut(
            position_ms=0,
            duration_ms=absent(),
            playback_speed=1.0,
            write_revision=0,
            reset_epoch=0,
        )
    return ListeningStateOut(
        position_ms=row.position_ms,
        duration_ms=presence_from_nullable(row.duration_ms),
        playback_speed=row.playback_speed,
        write_revision=row.write_revision,
        reset_epoch=row.reset_epoch,
    )


def _project(db: Session, *, viewer_id: UUID, rows: list[LecternRow]) -> list[LecternItemOut]:
    if not rows:
        return []
    media_ids = [row.media_id for row in rows]
    overrides = _state_store.load_overrides(db, viewer_id=viewer_id, media_ids=media_ids)
    listening = _listening_store.load_states(db, viewer_id=viewer_id, media_ids=media_ids)

    activations = {
        row.media_id: _derive_activation(db, row, listening.get(row.media_id)) for row in rows
    }
    doc_media = [
        row.media_id
        for row in rows
        if not isinstance(activations[row.media_id], FooterAudioActivation)
    ]
    engagement = _reader_engagement_store.load_states(db, viewer_id=viewer_id, media_ids=doc_media)

    items: list[LecternItemOut] = []
    for row in rows:
        activation = activations[row.media_id]
        consumption = _derive_consumption(
            activation=activation,
            listening=listening.get(row.media_id),
            engagement=engagement.get(row.media_id),
            duration_seconds=row.duration_seconds,
            override=overrides.get(row.media_id),
        )
        subtitle = present(row.podcast_title) if row.podcast_title is not None else absent()
        items.append(
            LecternItemOut(
                item_id=row.item_id,
                media_id=row.media_id,
                title=row.title[:_MAX_TITLE_CHARS],
                subtitle=subtitle,
                href=f"/media/{row.media_id}",
                consumption=consumption,
                activation=activation,
            )
        )
    return items


def activation_kind(row: LecternRow) -> str:
    """The activation discriminator only (``FooterAudio``/``Readable``/
    ``OpenPane``) without loading listening/chapter state — used by next-item
    capability selection."""
    if row.kind == MediaKind.video.value:
        return "OpenPane"
    if row.kind in _READABLE_KINDS:
        return "Readable"
    if row.kind == MediaKind.podcast_episode.value:
        playback = derive_playback_source(
            kind=row.kind,
            external_playback_url=row.external_playback_url,
            canonical_source_url=row.canonical_source_url,
            provider=row.provider,
            provider_id=row.provider_id,
        )
        return "OpenPane" if playback is None or not playback.stream_url else "FooterAudio"
    # justify-defect: add-time validation rejects unsupported kinds.
    raise AssertionError(f"unsupported Lectern media kind: {row.kind!r}")


def _derive_activation(
    db: Session, row: LecternRow, listening: ListeningRow | None
) -> LecternActivation:
    if row.kind == MediaKind.video.value:
        # Video never binds to <audio>; it always opens a media pane (spec §4).
        return OpenPaneActivation()
    if row.kind in _READABLE_KINDS:
        return ReadableActivation()
    if row.kind == MediaKind.podcast_episode.value:
        playback = derive_playback_source(
            kind=row.kind,
            external_playback_url=row.external_playback_url,
            canonical_source_url=row.canonical_source_url,
            provider=row.provider,
            provider_id=row.provider_id,
        )
        if playback is None or not playback.stream_url:
            # Podcast without playable audio -> media pane.
            return OpenPaneActivation()
        return FooterAudioActivation(
            stream_url=playback.stream_url,
            source_url=playback.source_url,
            position_ms=listening.position_ms if listening is not None else 0,
            write_revision=listening.write_revision if listening is not None else 0,
            reset_epoch=listening.reset_epoch if listening is not None else 0,
            playback_speed=listening.playback_speed if listening is not None else 1.0,
            duration_ms=_footer_duration_ms(listening, row.duration_seconds),
            artwork_url=present(row.podcast_image_url)
            if row.podcast_image_url is not None
            else absent(),
            chapters=_load_chapters(db, row.media_id),
        )
    # justify-defect: add-time validation rejects unsupported kinds, so a Lectern
    # row can only carry one of the derivable kinds above.
    raise AssertionError(f"unsupported Lectern media kind: {row.kind!r}")


def _footer_duration_ms(
    listening: ListeningRow | None, duration_seconds: int | None
) -> Absent | Present[int]:
    if listening is not None and listening.duration_ms is not None:
        return present(listening.duration_ms)
    if duration_seconds is not None:
        return present(duration_seconds * 1000)
    return absent()


def _derive_consumption(
    *,
    activation: LecternActivation,
    listening: ListeningRow | None,
    engagement: ReaderEngagementRow | None,
    duration_seconds: int | None,
    override: _state_store.OverrideState | None,
) -> ConsumptionOut:
    if isinstance(activation, FooterAudioActivation):
        state, progress = _audio_state(listening, duration_seconds)
    else:
        state, progress = _doc_state(engagement)
    if override is not None:
        state = override
    return ConsumptionOut(state=state, progress=progress)


def _audio_state(
    listening: ListeningRow | None, duration_seconds: int | None
) -> tuple[ConsumptionStateValue, Absent | Present[float]]:
    position = listening.position_ms if listening is not None else 0
    duration_ms = listening.duration_ms if listening is not None else None
    if duration_ms is None and duration_seconds is not None:
        duration_ms = duration_seconds * 1000
    is_completed = listening.is_completed if listening is not None else False

    fraction = None
    if duration_ms is not None and duration_ms > 0:
        fraction = min(1.0, position / duration_ms)
    progress: Absent | Present[float] = present(fraction) if fraction is not None else absent()

    if is_completed or (fraction is not None and fraction >= _FINISHED_PROGRESSION):
        return "Finished", progress
    if position > 0:
        return "InProgress", progress
    return "Unread", progress


def _doc_state(
    engagement: ReaderEngagementRow | None,
) -> tuple[ConsumptionStateValue, Absent | Present[float]]:
    """No dwell threshold: any retained engagement row means in-progress (spec
    §4.4 precedence item 3; the 80/20 loss note in §1 — "any retained engagement
    row now means in-progress")."""
    if engagement is None:
        return "Unread", absent()
    progress: Absent | Present[float] = (
        present(engagement.max_total_progression)
        if engagement.max_total_progression is not None
        else absent()
    )
    if (
        engagement.max_total_progression is not None
        and engagement.max_total_progression >= _FINISHED_PROGRESSION
    ):
        return "Finished", progress
    return "InProgress", progress


# ---------------------------------------------------------------------------
# Collection read-state projection (adopters read through the service boundary)
# ---------------------------------------------------------------------------

# The kinds whose read-state derives from the listening threshold rather than
# reader engagement. AUDIO_KINDS died with consumption_queue.py; the
# projection owns this derivation now (spec §7 delete map).
_AUDIO_READ_STATE_KINDS = frozenset({MediaKind.podcast_episode.value})

_STATE_TO_READ_STATE: dict[ConsumptionStateValue, MediaReadState] = {
    "Unread": "unread",
    "InProgress": "in_progress",
    "Finished": "finished",
}


@dataclass(frozen=True)
class MediaReadStateOut:
    """Per-media collection read-state: explicit override wins, else the audio
    listening threshold (podcast episodes) or reader engagement (documents)."""

    state: MediaReadState
    progress_fraction: float | None


def media_read_states(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, MediaReadStateOut]:
    """Batch read-state for arbitrary media (MediaOut listings, episode surfaces).

    Explicit override is the highest-priority input; otherwise podcast episodes
    derive from the listening threshold (position/duration with the projection-only
    95% signal, no ``is_completed`` side effect) and everything else from reader
    engagement (any row -> in progress; ``max_total_progression >= 0.95`` ->
    finished). Override changes state only; progress stays derived (spec §5.2)."""
    if not media_ids:
        return {}
    kinds = _media_kinds(db, media_ids)
    overrides = _state_store.load_overrides(db, viewer_id=viewer_id, media_ids=media_ids)
    audio_ids = [mid for mid in media_ids if kinds.get(mid) in _AUDIO_READ_STATE_KINDS]
    doc_ids = [mid for mid in media_ids if kinds.get(mid) not in _AUDIO_READ_STATE_KINDS]
    listening = _listening_store.load_states(db, viewer_id=viewer_id, media_ids=audio_ids)
    durations = _episode_durations(db, audio_ids)
    engagement = _reader_engagement_store.load_states(db, viewer_id=viewer_id, media_ids=doc_ids)

    result: dict[UUID, MediaReadStateOut] = {}
    for media_id in media_ids:
        if kinds.get(media_id) in _AUDIO_READ_STATE_KINDS:
            state, progress = _audio_state(listening.get(media_id), durations.get(media_id))
        else:
            state, progress = _doc_state(engagement.get(media_id))
        override = overrides.get(media_id)
        if override is not None:
            state = override
        result[media_id] = MediaReadStateOut(
            state=_STATE_TO_READ_STATE[state],
            progress_fraction=progress.value if isinstance(progress, Present) else None,
        )
    return result


def listening_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    """Per-media listening-engagement recency (owner-scoped read for MediaOut)."""
    return _listening_store.load_recency(db, viewer_id=viewer_id, media_ids=media_ids)


def reader_engagement_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    """Per-media reader-engagement recency (owner-scoped read for MediaOut)."""
    return _reader_engagement_store.load_recency(db, viewer_id=viewer_id, media_ids=media_ids)


@dataclass(frozen=True)
class _PlayerDescriptorRow:
    """Podcast-episode metadata needed to derive a ``PlayerDescriptor``."""

    media_id: UUID
    title: str
    external_playback_url: str | None
    canonical_source_url: str | None
    provider: str | None
    provider_id: str | None
    podcast_title: str | None
    podcast_image_url: str | None
    duration_seconds: int | None


def player_descriptors(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, PlayerDescriptor]:
    """Batch ``PlayerDescriptor`` for podcast-episode media (MediaOut/episode-list
    adopters, spec §6: "Lectern, podcast, and media DTOs reuse the same
    server-derived title/subtitle + FooterAudio descriptor"). Derives exactly like
    a Lectern item (``derive_playback_source`` + listening join + chapters +
    artwork/title, spec §4), with one listening-state load and one chapters load
    for the whole batch regardless of page size. A media absent from the returned
    mapping is either not a podcast episode or has no playable audio (its derived
    activation would be ``OpenPane``); callers project that into ``Presence``
    (Absent)."""
    rows = _load_player_descriptor_rows(db, media_ids)
    if not rows:
        return {}
    row_media_ids = [row.media_id for row in rows]
    listening = _listening_store.load_states(db, viewer_id=viewer_id, media_ids=row_media_ids)
    chapters_by_media = _load_chapters_batch(db, row_media_ids)

    result: dict[UUID, PlayerDescriptor] = {}
    for row in rows:
        playback = derive_playback_source(
            kind=MediaKind.podcast_episode.value,
            external_playback_url=row.external_playback_url,
            canonical_source_url=row.canonical_source_url,
            provider=row.provider,
            provider_id=row.provider_id,
        )
        if playback is None or not playback.stream_url:
            continue
        listening_row = listening.get(row.media_id)
        result[row.media_id] = PlayerDescriptor(
            media_id=row.media_id,
            title=row.title[:_MAX_TITLE_CHARS],
            subtitle=present(row.podcast_title) if row.podcast_title is not None else absent(),
            activation=FooterAudioActivation(
                stream_url=playback.stream_url,
                source_url=playback.source_url,
                position_ms=listening_row.position_ms if listening_row is not None else 0,
                write_revision=listening_row.write_revision if listening_row is not None else 0,
                reset_epoch=listening_row.reset_epoch if listening_row is not None else 0,
                playback_speed=listening_row.playback_speed if listening_row is not None else 1.0,
                duration_ms=_footer_duration_ms(listening_row, row.duration_seconds),
                artwork_url=present(row.podcast_image_url)
                if row.podcast_image_url is not None
                else absent(),
                chapters=chapters_by_media.get(row.media_id, []),
            ),
        )
    return result


def _load_player_descriptor_rows(db: Session, media_ids: list[UUID]) -> list[_PlayerDescriptorRow]:
    if not media_ids:
        return []
    rows = db.execute(
        text(
            """
            SELECT
                m.id AS media_id,
                m.title,
                m.external_playback_url,
                m.canonical_source_url,
                m.provider,
                m.provider_id,
                p.title AS podcast_title,
                p.image_url AS podcast_image_url,
                pe.duration_seconds
            FROM media m
            JOIN podcast_episodes pe ON pe.media_id = m.id
            LEFT JOIN podcasts p ON p.id = pe.podcast_id
            WHERE m.id = ANY(:media_ids) AND m.kind = :kind
            """
        ),
        {"media_ids": media_ids, "kind": MediaKind.podcast_episode.value},
    ).mappings()
    return [
        _PlayerDescriptorRow(
            media_id=UUID(str(row["media_id"])),
            title=str(row["title"]),
            external_playback_url=_opt_str(row["external_playback_url"]),
            canonical_source_url=_opt_str(row["canonical_source_url"]),
            provider=_opt_str(row["provider"]),
            provider_id=_opt_str(row["provider_id"]),
            podcast_title=_opt_str(row["podcast_title"]),
            podcast_image_url=_opt_str(row["podcast_image_url"]),
            duration_seconds=int(row["duration_seconds"])
            if row["duration_seconds"] is not None
            else None,
        )
        for row in rows
    ]


def _opt_str(value: object) -> str | None:
    return str(value) if value is not None else None


def _media_kinds(db: Session, media_ids: list[UUID]) -> dict[UUID, str]:
    if not media_ids:
        return {}
    rows = db.execute(
        text("SELECT id, kind FROM media WHERE id = ANY(:ids)"),
        {"ids": media_ids},
    ).fetchall()
    return {UUID(str(row[0])): str(row[1]) for row in rows}


def _episode_durations(db: Session, media_ids: list[UUID]) -> dict[UUID, int]:
    if not media_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT media_id, duration_seconds
            FROM podcast_episodes
            WHERE media_id = ANY(:ids) AND duration_seconds IS NOT NULL
            """
        ),
        {"ids": media_ids},
    ).fetchall()
    return {UUID(str(row[0])): int(row[1]) for row in rows}


# ---------------------------------------------------------------------------
# Episode-state SQL fragment builders (podcast list/detail/library adopters
# compose these; the raw consumption-table reads live only here, spec §8 AC-15).
# ---------------------------------------------------------------------------


def episode_state_case_sql(*, listening_alias: str, override_alias: str, episode_alias: str) -> str:
    """CASE expression -> ``played`` | ``in_progress`` | ``unplayed`` for a podcast
    episode. Explicit override is highest-priority (``finished`` -> played,
    ``unread`` -> unplayed); otherwise the audio read-model: ``is_completed`` or the
    projection-only 95% progression -> played, any position -> in_progress, else
    unplayed. Requires the joins from :func:`episode_state_joins_sql` and an
    episode alias exposing ``duration_seconds``."""
    duration_ms = (
        f"COALESCE({listening_alias}.duration_ms, {episode_alias}.duration_seconds * 1000)"
    )
    return f"""
        CASE
            WHEN {override_alias}.status = 'finished' THEN 'played'
            WHEN {override_alias}.status = 'unread' THEN 'unplayed'
            WHEN {listening_alias}.is_completed IS TRUE THEN 'played'
            WHEN {duration_ms} > 0
                 AND {listening_alias}.position_ms::float8 / {duration_ms}
                     >= {_FINISHED_PROGRESSION}
                THEN 'played'
            WHEN COALESCE({listening_alias}.position_ms, 0) > 0 THEN 'in_progress'
            ELSE 'unplayed'
        END
    """


def episode_state_joins_sql(
    *, user_param: str, media_expr: str, listening_alias: str, override_alias: str
) -> str:
    """LEFT JOINs binding the viewer's listening row and explicit override for
    ``media_expr`` (e.g. ``pe.media_id``). ``user_param`` is the bound viewer id
    parameter (e.g. ``:viewer_id``)."""
    return f"""
        LEFT JOIN podcast_listening_states {listening_alias}
          ON {listening_alias}.user_id = {user_param}
         AND {listening_alias}.media_id = {media_expr}
        LEFT JOIN consumption_overrides {override_alias}
          ON {override_alias}.user_id = {user_param}
         AND {override_alias}.media_id = {media_expr}
    """


def listening_recency_subquery_sql(*, user_param: str, media_expr: str) -> str:
    """Scalar subquery -> the viewer's listening-row ``updated_at`` for one media."""
    return f"""(
        SELECT ls_recency.updated_at
        FROM podcast_listening_states ls_recency
        WHERE ls_recency.user_id = {user_param}
          AND ls_recency.media_id = {media_expr}
    )"""


def reader_engagement_recency_subquery_sql(*, user_param: str, media_expr: str) -> str:
    """Scalar subquery -> the viewer's reader-engagement ``last_engaged_at`` for
    one media."""
    return _reader_engagement_store.recency_subquery_sql(
        user_param=user_param, media_expr=media_expr
    )


def listening_recency_max_subquery_sql(*, user_param: str, podcast_expr: str) -> str:
    """Scalar subquery -> MAX listening ``updated_at`` across a podcast's episodes."""
    return f"""(
        SELECT MAX(ls_pod.updated_at)
        FROM podcast_episodes pe_ls
        JOIN podcast_listening_states ls_pod
          ON ls_pod.user_id = {user_param}
         AND ls_pod.media_id = pe_ls.media_id
        WHERE pe_ls.podcast_id = {podcast_expr}
    )"""


def _chapter_out_or_none(*, title_raw: Any, start_ms: Any, end_ms: Any) -> ChapterOut | None:
    """Build one ``ChapterOut``, or ``None`` for a malformed empty/whitespace-only
    title. Chapters are presentation-only data sourced from third-party feeds;
    ``ChapterOut.title`` requires ``min_length=1``, so a malformed row is excluded
    here rather than rewritten or allowed to raise and 500 the whole snapshot."""
    title = str(title_raw)[:_MAX_TITLE_CHARS]
    if not title.strip():
        return None
    return ChapterOut(
        title=title,
        start_ms=int(start_ms),
        end_ms=presence_from_nullable(int(end_ms) if end_ms is not None else None),
    )


def _load_chapters(db: Session, media_id: UUID) -> list[ChapterOut]:
    return _load_chapters_batch(db, [media_id]).get(media_id, [])


def _load_chapters_batch(db: Session, media_ids: list[UUID]) -> dict[UUID, list[ChapterOut]]:
    """Batch chapter load for a page of media: one query regardless of page size
    (spec §4 "first 100 by canonical ordinal"; used by both the Lectern
    projection and :func:`player_descriptors`). The first-100 cap counts raw
    stored rows by ordinal, matching the single-media form; a malformed row
    inside that window is excluded, not replaced by the 101st row."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT media_id, title, t_start_ms, t_end_ms
            FROM podcast_episode_chapters
            WHERE media_id = ANY(:media_ids)
            ORDER BY media_id ASC, chapter_idx ASC
            """
        ),
        {"media_ids": media_ids},
    ).fetchall()
    result: dict[UUID, list[ChapterOut]] = {}
    raw_counts: dict[UUID, int] = {}
    for row in rows:
        media_id = UUID(str(row[0]))
        raw_count = raw_counts.get(media_id, 0)
        if raw_count >= _MAX_CHAPTERS:
            continue
        raw_counts[media_id] = raw_count + 1
        chapter = _chapter_out_or_none(title_raw=row[1], start_ms=row[2], end_ms=row[3])
        if chapter is not None:
            result.setdefault(media_id, []).append(chapter)
    return result
