"""Sole DML owner of ``podcast_listening_states`` (position/duration/rate,
completion flag, heartbeat-only ``last_engaged_at``, and the fencing tokens
``write_revision`` / ``reset_epoch``).

Every mutation composes inside the caller's already-open command transaction.
The heartbeat CAS returns ``None`` on a fencing mismatch so the facade can roll
back and surface ``E_STALE_LISTENING_REVISION`` with no writes (spec §5.4).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from nexus.schemas.presence import Presence, Present, nullable_from_presence


@dataclass(frozen=True)
class ListeningRow:
    """The owned row shape for one (viewer, media) listening state."""

    position_ms: int
    duration_ms: int | None
    playback_speed: float | None
    write_revision: int
    reset_epoch: int
    is_completed: bool


def _row_from_mapping(mapping) -> ListeningRow:
    return ListeningRow(
        position_ms=int(mapping["position_ms"]),
        duration_ms=int(mapping["duration_ms"]) if mapping["duration_ms"] is not None else None,
        playback_speed=(
            float(mapping["playback_speed"]) if mapping["playback_speed"] is not None else None
        ),
        write_revision=int(mapping["write_revision"]),
        reset_epoch=int(mapping["reset_epoch"]),
        is_completed=bool(mapping["is_completed"]),
    )


_SELECT_ONE_SQL = text(
    """
    SELECT position_ms, duration_ms, playback_speed, write_revision, reset_epoch, is_completed
    FROM podcast_listening_states
    WHERE user_id = :viewer_id AND media_id = :media_id
    """
)


def load_state(db: Session, *, viewer_id: UUID, media_id: UUID) -> ListeningRow | None:
    """Read one listening row, or ``None`` when the viewer has no state yet."""
    row = (
        db.execute(_SELECT_ONE_SQL, {"viewer_id": viewer_id, "media_id": media_id})
        .mappings()
        .one_or_none()
    )
    return _row_from_mapping(row) if row is not None else None


def load_states(db: Session, *, viewer_id: UUID, media_ids: list[UUID]) -> dict[UUID, ListeningRow]:
    """Batch-read listening rows for the projection and reset responses."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT media_id, position_ms, duration_ms, playback_speed,
                   write_revision, reset_epoch, is_completed
            FROM podcast_listening_states
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
            """
        ),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).mappings()
    return {UUID(str(row["media_id"])): _row_from_mapping(row) for row in rows}


def load_recency(db: Session, *, viewer_id: UUID, media_ids: list[UUID]) -> dict[UUID, datetime]:
    """Per-media listening ``last_engaged_at``. Manual state-only mutations do
    not create engagement, so rows whose engagement clock is NULL are absent."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT media_id, last_engaged_at
            FROM podcast_listening_states
            WHERE user_id = :viewer_id
              AND media_id = ANY(:media_ids)
              AND last_engaged_at IS NOT NULL
            """
        ),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).fetchall()
    return {UUID(str(row[0])): row[1] for row in rows}


def record_heartbeat_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    position_ms: int,
    duration_ms: int | None,
    episode_playback_rate: Presence[float],
    expected_write_revision: int,
    expected_reset_epoch: int,
) -> ListeningRow | None:
    """CAS the fencing tokens, then write position/duration/rate and advance the
    write revision. An absent rate inserts NULL or preserves the current value."""
    current = load_state(db, viewer_id=viewer_id, media_id=media_id)
    if current is None:
        # An absent row reads as revision 0 / epoch 0.
        if expected_write_revision != 0 or expected_reset_epoch != 0:
            return None
        db.execute(
            text(
                """
                INSERT INTO podcast_listening_states (
                    user_id, media_id, position_ms, duration_ms, playback_speed,
                    is_completed, write_revision, reset_epoch, updated_at, last_engaged_at
                )
                VALUES (
                    :viewer_id, :media_id, :position_ms, :duration_ms, :playback_speed,
                    false, 1, 0, now(), now()
                )
                """
            ),
            {
                "viewer_id": viewer_id,
                "media_id": media_id,
                "position_ms": position_ms,
                "duration_ms": duration_ms,
                "playback_speed": nullable_from_presence(episode_playback_rate),
            },
        )
        return ListeningRow(
            position_ms=position_ms,
            duration_ms=duration_ms,
            playback_speed=nullable_from_presence(episode_playback_rate),
            write_revision=1,
            reset_epoch=0,
            is_completed=False,
        )

    if (
        expected_write_revision != current.write_revision
        or expected_reset_epoch != current.reset_epoch
    ):
        return None

    next_revision = current.write_revision + 1
    playback_speed = (
        episode_playback_rate.value
        if isinstance(episode_playback_rate, Present)
        else current.playback_speed
    )
    db.execute(
        text(
            """
            UPDATE podcast_listening_states
            SET position_ms = :position_ms,
                duration_ms = :duration_ms,
                playback_speed = :playback_speed,
                write_revision = :next_revision,
                updated_at = now(),
                last_engaged_at = now()
            WHERE user_id = :viewer_id AND media_id = :media_id
            """
        ),
        {
            "viewer_id": viewer_id,
            "media_id": media_id,
            "position_ms": position_ms,
            "duration_ms": duration_ms,
            "playback_speed": playback_speed,
            "next_revision": next_revision,
        },
    )
    return ListeningRow(
        position_ms=position_ms,
        duration_ms=duration_ms,
        playback_speed=playback_speed,
        write_revision=next_revision,
        reset_epoch=current.reset_epoch,
        is_completed=current.is_completed,
    )


def install_preview_position_if_empty_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    position_ms: int,
    duration_ms: int | None,
) -> bool:
    """Install post-acquisition Preview progress without replacing owned progress."""
    current = load_state(db, viewer_id=viewer_id, media_id=media_id)
    if position_ms == 0 or (
        current is not None and (current.position_ms > 0 or current.is_completed)
    ):
        return False
    if current is None:
        db.execute(
            text(
                """
                INSERT INTO podcast_listening_states (
                    user_id, media_id, position_ms, duration_ms, playback_speed,
                    is_completed, write_revision, reset_epoch, updated_at, last_engaged_at
                )
                VALUES (
                    :viewer_id, :media_id, :position_ms, :duration_ms, NULL,
                    false, 1, 0, now(), now()
                )
                """
            ),
            {
                "viewer_id": viewer_id,
                "media_id": media_id,
                "position_ms": position_ms,
                "duration_ms": duration_ms,
            },
        )
        return True
    db.execute(
        text(
            """
            UPDATE podcast_listening_states
            SET position_ms = :position_ms,
                duration_ms = COALESCE(:duration_ms, duration_ms),
                write_revision = write_revision + 1,
                updated_at = now(),
                last_engaged_at = now()
            WHERE user_id = :viewer_id AND media_id = :media_id
            """
        ),
        {
            "viewer_id": viewer_id,
            "media_id": media_id,
            "position_ms": position_ms,
            "duration_ms": duration_ms,
        },
    )
    return True


def mark_completed_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Set ``is_completed=true`` without moving position; create at zero if absent."""
    db.execute(
        text(
            """
            INSERT INTO podcast_listening_states (
                user_id, media_id, position_ms, duration_ms, playback_speed,
                is_completed, write_revision, reset_epoch, updated_at, last_engaged_at
            )
            VALUES (:viewer_id, :media_id, 0, NULL, NULL, true, 0, 0, now(), NULL)
            ON CONFLICT (user_id, media_id)
            DO UPDATE SET is_completed = true, updated_at = now()
            """
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def reset_progress_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> ListeningRow:
    """Replace podcast current progress with zero and advance both fences."""
    current = load_state(db, viewer_id=viewer_id, media_id=media_id)
    if current is None:
        db.execute(
            text(
                """
                INSERT INTO podcast_listening_states (
                    user_id, media_id, position_ms, duration_ms, playback_speed,
                    is_completed, write_revision, reset_epoch, updated_at, last_engaged_at
                )
                VALUES (:viewer_id, :media_id, 0, NULL, NULL, false, 1, 1, now(), NULL)
                """
            ),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        return ListeningRow(
            position_ms=0,
            duration_ms=None,
            playback_speed=None,
            write_revision=1,
            reset_epoch=1,
            is_completed=False,
        )

    next_revision = current.write_revision + 1
    next_epoch = current.reset_epoch + 1
    result = cast(
        CursorResult[Any],
        db.execute(
            text(
                """
                UPDATE podcast_listening_states
                SET position_ms = 0,
                    is_completed = false,
                    write_revision = :next_revision,
                    reset_epoch = :next_epoch,
                    updated_at = now(),
                    last_engaged_at = NULL
                WHERE user_id = :viewer_id AND media_id = :media_id
                """
            ),
            {
                "viewer_id": viewer_id,
                "media_id": media_id,
                "next_revision": next_revision,
                "next_epoch": next_epoch,
            },
        ),
    )
    # justify-defect: the owner just read this exact row inside the serialized
    # command transaction.
    assert result.rowcount == 1
    return ListeningRow(
        position_ms=0,
        duration_ms=current.duration_ms,
        playback_speed=current.playback_speed,
        write_revision=next_revision,
        reset_epoch=next_epoch,
        is_completed=False,
    )


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Delete every user's listening row for a media (media teardown only)."""
    db.execute(
        text("DELETE FROM podcast_listening_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
