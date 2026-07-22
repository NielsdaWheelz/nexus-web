"""Sole DML owner of ``podcast_listening_states`` (position/duration/speed,
completion flag, heartbeat-only ``last_engaged_at``, and the fencing tokens
``write_revision`` / ``reset_epoch``).

Every mutation composes inside the caller's already-open command transaction.
The heartbeat CAS returns ``None`` on a fencing mismatch so the facade can roll
back and surface ``E_STALE_LISTENING_REVISION`` with no writes (spec §5.4).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


@dataclass(frozen=True)
class ListeningRow:
    """The owned row shape for one (viewer, media) listening state."""

    position_ms: int
    duration_ms: int | None
    playback_speed: float
    write_revision: int
    reset_epoch: int
    is_completed: bool


def _row_from_mapping(mapping) -> ListeningRow:
    return ListeningRow(
        position_ms=int(mapping["position_ms"]),
        duration_ms=int(mapping["duration_ms"]) if mapping["duration_ms"] is not None else None,
        playback_speed=float(mapping["playback_speed"]),
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
    playback_speed: float,
    expected_write_revision: int,
    expected_reset_epoch: int,
) -> ListeningRow | None:
    """CAS the fencing tokens, then write position/duration/speed and advance the
    write revision. Returns the post-write row, or ``None`` on a fencing mismatch
    (the caller must then roll back and reject with no writes)."""
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
                "playback_speed": playback_speed,
            },
        )
        return ListeningRow(
            position_ms=position_ms,
            duration_ms=duration_ms,
            playback_speed=playback_speed,
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


def mark_completed_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Set ``is_completed=true`` without moving position; create at zero if absent."""
    db.execute(
        text(
            """
            INSERT INTO podcast_listening_states (
                user_id, media_id, position_ms, duration_ms, playback_speed,
                is_completed, write_revision, reset_epoch, updated_at, last_engaged_at
            )
            VALUES (:viewer_id, :media_id, 0, NULL, 1.0, true, 0, 0, now(), NULL)
            ON CONFLICT (user_id, media_id)
            DO UPDATE SET is_completed = true, updated_at = now()
            """
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def reset_for_unread_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> bool:
    """Reset an EXISTING listening row to unread-at-zero and advance both fencing
    counters. Never creates a row; returns whether a row was reset."""
    current = load_state(db, viewer_id=viewer_id, media_id=media_id)
    if current is None:
        return False
    db.execute(
        text(
            """
            UPDATE podcast_listening_states
            SET position_ms = 0,
                is_completed = false,
                write_revision = write_revision + 1,
                reset_epoch = reset_epoch + 1,
                updated_at = now()
            WHERE user_id = :viewer_id AND media_id = :media_id
            """
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    return True


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Delete every user's listening row for a media (media teardown only)."""
    db.execute(
        text("DELETE FROM podcast_listening_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
