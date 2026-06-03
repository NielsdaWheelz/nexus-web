"""Viewer listening-state commands."""

from collections.abc import Iterable
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media, visible_media_ids_cte_sql
from nexus.db.models import MediaKind, PodcastListeningState
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, InvalidRequestError, NotFoundError
from nexus.schemas.media import ListeningStateOut


def get_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
) -> ListeningStateOut:
    """Get listener state for one media item scoped to the viewer."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    state = (
        db.query(PodcastListeningState)
        .filter(
            PodcastListeningState.user_id == viewer_id,
            PodcastListeningState.media_id == media_id,
        )
        .one_or_none()
    )
    if state is None:
        return ListeningStateOut(
            position_ms=0,
            duration_ms=None,
            playback_speed=1.0,
            is_completed=False,
        )

    return ListeningStateOut(
        position_ms=int(state.position_ms),
        duration_ms=int(state.duration_ms) if state.duration_ms is not None else None,
        playback_speed=float(state.playback_speed),
        is_completed=bool(state.is_completed),
    )


def upsert_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    position_ms: int | None = None,
    duration_ms: int | None = None,
    playback_speed: float | None = None,
    is_completed: bool | None = None,
) -> None:
    """Upsert listener state for one media item scoped to the viewer."""
    if (
        position_ms is None
        and duration_ms is None
        and playback_speed is None
        and is_completed is None
    ):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "At least one listening-state field is required",
        )

    with transaction(db):
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

        existing_state = (
            db.query(PodcastListeningState)
            .filter(
                PodcastListeningState.user_id == viewer_id,
                PodcastListeningState.media_id == media_id,
            )
            .one_or_none()
        )
        current_position_ms = int(existing_state.position_ms) if existing_state is not None else 0
        current_duration_ms = (
            int(existing_state.duration_ms)
            if existing_state is not None and existing_state.duration_ms is not None
            else None
        )
        current_playback_speed = (
            float(existing_state.playback_speed) if existing_state is not None else 1.0
        )
        current_is_completed = (
            bool(existing_state.is_completed) if existing_state is not None else False
        )

        next_position_ms = int(position_ms) if position_ms is not None else current_position_ms
        next_duration_ms = int(duration_ms) if duration_ms is not None else current_duration_ms
        next_playback_speed = (
            float(playback_speed) if playback_speed is not None else current_playback_speed
        )

        if is_completed is not None:
            next_is_completed = bool(is_completed)
        elif position_ms is not None:
            next_is_completed = current_is_completed or _position_meets_completion_threshold(
                next_position_ms, next_duration_ms
            )
        else:
            next_is_completed = current_is_completed

        if existing_state is None:
            db.add(
                PodcastListeningState(
                    user_id=viewer_id,
                    media_id=media_id,
                    position_ms=next_position_ms,
                    duration_ms=next_duration_ms,
                    playback_speed=next_playback_speed,
                    is_completed=next_is_completed,
                )
            )
            return

        existing_state.position_ms = next_position_ms
        existing_state.duration_ms = next_duration_ms
        existing_state.playback_speed = next_playback_speed
        existing_state.is_completed = next_is_completed
        existing_state.updated_at = db.execute(text("SELECT now()")).scalar_one()


def batch_mark_listening_state_for_viewer(
    db: Session,
    viewer_id: UUID,
    *,
    media_ids: list[UUID],
    is_completed: bool,
) -> None:
    """Batch mark many visible podcast episodes as played/unplayed."""
    deduped_media_ids = _dedupe_uuid_order(media_ids)
    if not deduped_media_ids:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "At least one media_id is required",
        )

    with transaction(db):
        visible_rows = db.execute(
            text(
                f"""
                WITH visible_media AS (
                    {visible_media_ids_cte_sql()}
                )
                SELECT m.id, m.kind
                FROM media m
                JOIN visible_media vm ON vm.media_id = m.id
                WHERE m.id = ANY(:media_ids)
                """
            ),
            {"viewer_id": viewer_id, "media_ids": deduped_media_ids},
        ).fetchall()
        if len(visible_rows) != len(deduped_media_ids):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

        invalid_kind_media_ids = [
            row[0] for row in visible_rows if row[1] != MediaKind.podcast_episode.value
        ]
        if invalid_kind_media_ids:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_KIND,
                "Batch listening-state updates are only supported for podcast episodes",
            )

        now = db.execute(text("SELECT now()")).scalar_one()
        for media_id in deduped_media_ids:
            existing_state = (
                db.query(PodcastListeningState)
                .filter(
                    PodcastListeningState.user_id == viewer_id,
                    PodcastListeningState.media_id == media_id,
                )
                .one_or_none()
            )
            if existing_state is None:
                db.add(
                    PodcastListeningState(
                        user_id=viewer_id,
                        media_id=media_id,
                        position_ms=0,
                        duration_ms=None,
                        playback_speed=1.0,
                        is_completed=is_completed,
                    )
                )
                continue
            existing_state.is_completed = is_completed
            existing_state.updated_at = now
            if not is_completed:
                existing_state.position_ms = 0


def _position_meets_completion_threshold(position_ms: int, duration_ms: int | None) -> bool:
    if duration_ms is None or duration_ms <= 0:
        return False
    return position_ms >= int(float(duration_ms) * 0.95)


def _dedupe_uuid_order(values: Iterable[UUID]) -> list[UUID]:
    ordered: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        normalized = UUID(str(value))
        if normalized in seen:
            continue
        seen.add(normalized)
        ordered.append(normalized)
    return ordered
