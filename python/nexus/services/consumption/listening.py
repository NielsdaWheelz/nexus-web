"""Sole DML owner of ``podcast_listening_states``: where a viewer is in an episode.

The reset epoch is the only fence: a write names the epoch it was taken under, last writer wins
within an epoch and a reset wins across epochs. No row reads as epoch 0. Positions never exceed
the known duration. Every write composes inside the caller's viewer-locked transaction.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session


@dataclass(frozen=True, slots=True)
class Listening:
    position_ms: int
    duration_ms: int | None
    episode_rate: float | None
    reset_epoch: int


_COLUMNS = "position_ms, duration_ms, playback_speed, reset_epoch"


def _listening(row) -> Listening:
    return Listening(row.position_ms, row.duration_ms, row.playback_speed, row.reset_epoch)


def load_many(db: Session, *, viewer_id: UUID, media_ids: list[UUID]) -> dict[UUID, Listening]:
    rows = db.execute(
        text(f"""
            SELECT media_id, {_COLUMNS} FROM podcast_listening_states
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    return {row.media_id: _listening(row) for row in rows}


def write(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    position_ms: int,
    duration_ms: int | None,
    episode_rate: float | None,
    expected_reset_epoch: int,
) -> Listening | None:
    """Store one sample taken under ``expected_reset_epoch``; None when the epoch is stale.
    An absent duration or rate keeps the stored one."""
    params = {"viewer_id": viewer_id, "media_id": media_id, "position_ms": position_ms}
    params |= {"duration_ms": duration_ms, "rate": episode_rate, "epoch": expected_reset_epoch}
    row = db.execute(
        text(f"""
            UPDATE podcast_listening_states
            SET duration_ms = COALESCE(:duration_ms, duration_ms),
                position_ms = LEAST(:position_ms, COALESCE(:duration_ms, duration_ms)),
                playback_speed = COALESCE(:rate, playback_speed),
                updated_at = now(),
                last_engaged_at = now()
            WHERE user_id = :viewer_id AND media_id = :media_id AND reset_epoch = :epoch
            RETURNING {_COLUMNS}
        """),
        params,
    ).one_or_none()
    if row is None and expected_reset_epoch == 0:
        row = db.execute(
            text(f"""
                INSERT INTO podcast_listening_states (user_id, media_id, position_ms,
                    duration_ms, playback_speed, last_engaged_at)
                VALUES (:viewer_id, :media_id, LEAST(:position_ms, :duration_ms), :duration_ms,
                    :rate, now())
                ON CONFLICT (user_id, media_id) DO NOTHING
                RETURNING {_COLUMNS}
            """),
            params,
        ).one_or_none()
    return None if row is None else _listening(row)


def install_preview(
    db: Session, *, viewer_id: UUID, media_id: UUID, position_ms: int, duration_ms: int | None
) -> bool:
    """Install a preview's position when the viewer has no progress; whether it did."""
    if position_ms == 0:
        return False
    return (
        db.execute(
            text("""
                INSERT INTO podcast_listening_states (user_id, media_id, position_ms,
                    duration_ms, last_engaged_at)
                VALUES (:viewer_id, :media_id, :position_ms, :duration_ms, now())
                ON CONFLICT (user_id, media_id) DO UPDATE
                SET position_ms = EXCLUDED.position_ms,
                    duration_ms = COALESCE(EXCLUDED.duration_ms,
                        podcast_listening_states.duration_ms),
                    updated_at = now(),
                    last_engaged_at = now()
                WHERE podcast_listening_states.position_ms = 0
                RETURNING 1
            """),
            {"viewer_id": viewer_id, "media_id": media_id}
            | {"position_ms": position_ms, "duration_ms": duration_ms},
        ).one_or_none()
        is not None
    )


def reset(db: Session, *, viewer_id: UUID, media_id: UUID) -> Listening:
    """Position zero under the next epoch, no engagement; rate and duration stay."""
    return _listening(
        db.execute(
            text(f"""
                INSERT INTO podcast_listening_states (user_id, media_id, reset_epoch)
                VALUES (:viewer_id, :media_id, 1)
                ON CONFLICT (user_id, media_id) DO UPDATE
                SET position_ms = 0,
                    reset_epoch = podcast_listening_states.reset_epoch + 1,
                    updated_at = now(),
                    last_engaged_at = NULL
                RETURNING {_COLUMNS}
            """),
            {"viewer_id": viewer_id, "media_id": media_id},
        ).one()
    )


def recency(db: Session, *, viewer_id: UUID, media_ids: list[UUID]) -> dict[UUID, datetime]:
    """When the viewer last listened; state-only changes do not count."""
    rows = db.execute(
        text("""
            SELECT media_id, last_engaged_at FROM podcast_listening_states
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
              AND last_engaged_at IS NOT NULL
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    )
    return {row.media_id: row.last_engaged_at for row in rows}


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Media teardown: every viewer's row for the media."""
    db.execute(
        text("DELETE FROM podcast_listening_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
