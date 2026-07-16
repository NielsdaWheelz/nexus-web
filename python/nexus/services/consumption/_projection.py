"""Consumption read model: explicit override + listening state + attention
aggregates -> per-item consumption state, progress, and capability activation.

This is the sole projection owner (spec §8 AC-15); adopters read Lectern items
only through the ``service`` boundary that delegates here.
"""

from __future__ import annotations

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
    ReadableActivation,
)
from nexus.schemas.presence import Absent, Present, absent, presence_from_nullable, present
from nexus.services import attention
from nexus.services.consumption import _listening_store, _state_store
from nexus.services.consumption._lectern_store import LecternRow
from nexus.services.consumption._listening_store import ListeningRow
from nexus.services.playback_source import derive_playback_source

_FINISHED_PROGRESSION = 0.95
_DOC_DWELL_FINISHED_MS = 120_000
_SESSION_DWELL_IN_PROGRESS_MS = 30_000
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
    aggregates = attention.session_aggregates(db, viewer_id=viewer_id, media_ids=doc_media)

    items: list[LecternItemOut] = []
    for row in rows:
        activation = activations[row.media_id]
        consumption = _derive_consumption(
            activation=activation,
            listening=listening.get(row.media_id),
            aggregate=aggregates.get(row.media_id),
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
    aggregate: attention.SessionAggregate | None,
    duration_seconds: int | None,
    override: _state_store.OverrideState | None,
) -> ConsumptionOut:
    if isinstance(activation, FooterAudioActivation):
        state, progress = _audio_state(listening, duration_seconds)
    else:
        state, progress = _doc_state(aggregate)
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
    aggregate: attention.SessionAggregate | None,
) -> tuple[ConsumptionStateValue, Absent | Present[float]]:
    if aggregate is None:
        return "Unread", absent()
    progress: Absent | Present[float] = (
        present(aggregate.max_progression) if aggregate.max_progression is not None else absent()
    )
    if (
        aggregate.max_progression is not None and aggregate.max_progression >= _FINISHED_PROGRESSION
    ) or aggregate.total_dwell_ms >= _DOC_DWELL_FINISHED_MS:
        return "Finished", progress
    if aggregate.max_session_dwell_ms >= _SESSION_DWELL_IN_PROGRESS_MS:
        return "InProgress", progress
    return "Unread", progress


def _load_chapters(db: Session, media_id: UUID) -> list[ChapterOut]:
    rows = db.execute(
        text(
            """
            SELECT title, t_start_ms, t_end_ms
            FROM podcast_episode_chapters
            WHERE media_id = :media_id
            ORDER BY chapter_idx ASC
            LIMIT :limit
            """
        ),
        {"media_id": media_id, "limit": _MAX_CHAPTERS},
    ).fetchall()
    return [
        ChapterOut(
            title=str(row[0])[:_MAX_TITLE_CHARS],
            start_ms=int(row[1]),
            end_ms=presence_from_nullable(int(row[2]) if row[2] is not None else None),
        )
        for row in rows
    ]
