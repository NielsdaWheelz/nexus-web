"""Sole DML owner of ``podcast_listening_states``: where a viewer is in an episode.

The reset epoch is the only fence: a write names the epoch it was taken under, last writer wins
within an epoch and a reset wins across epochs. No row reads as epoch 0. Positions never exceed
a positive known duration; a nonpositive duration is unknown. Every write composes
inside the caller's viewer-locked transaction.
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.consumption import ListeningIn
from nexus.services.consumption import observation


@dataclass(frozen=True, slots=True)
class Listening:
    position_ms: int
    duration_ms: int | None
    episode_rate: float | None
    reset_epoch: int


_COLUMNS = "position_ms, duration_ms, playback_speed, reset_epoch"


def _listening(row) -> Listening:
    return Listening(row.position_ms, row.duration_ms, row.playback_speed, row.reset_epoch)


def write(db: Session, *, viewer_id: UUID, media_id: UUID, sample: ListeningIn) -> Listening | None:
    """Store one sample taken under its epoch; None when the epoch is stale. An absent duration
    or rate keeps the stored one."""
    expected_reset_epoch = sample.expected_reset_epoch
    params = {"viewer_id": viewer_id, "media_id": media_id, "position_ms": sample.position_ms}
    params |= {"duration_ms": sample.duration_ms, "rate": sample.episode_playback_rate}
    params |= {"epoch": expected_reset_epoch}
    row = db.execute(
        text(f"""
            UPDATE podcast_listening_states
            SET duration_ms = COALESCE(:duration_ms, duration_ms),
                position_ms = CASE WHEN COALESCE(:duration_ms, duration_ms) > 0
                    THEN LEAST(:position_ms, COALESCE(:duration_ms, duration_ms))
                    ELSE :position_ms END,
                playback_speed = COALESCE(:rate, playback_speed),
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
                VALUES (:viewer_id, :media_id,
                    CASE WHEN :duration_ms > 0 THEN LEAST(:position_ms, :duration_ms)
                         ELSE :position_ms END, :duration_ms,
                    :rate, now())
                ON CONFLICT (user_id, media_id) DO NOTHING
                RETURNING {_COLUMNS}
            """),
            params,
        ).one_or_none()
    if row is not None:
        observation.advance(db, viewer_id)
    return None if row is None else _listening(row)


def install_preview(
    db: Session, *, viewer_id: UUID, media_id: UUID, position_ms: int, duration_ms: int | None
) -> bool:
    """Install only when no listening row exists; an owned zero bookmark wins."""
    if position_ms == 0:
        return False
    installed = (
        db.execute(
            text("""
                INSERT INTO podcast_listening_states (user_id, media_id, position_ms,
                    duration_ms, last_engaged_at)
                VALUES (:viewer_id, :media_id, :position_ms, :duration_ms, now())
                ON CONFLICT (user_id, media_id) DO NOTHING
                RETURNING 1
            """),
            {"viewer_id": viewer_id, "media_id": media_id}
            | {"position_ms": position_ms, "duration_ms": duration_ms},
        ).one_or_none()
        is not None
    )
    if installed:
        observation.advance(db, viewer_id)
    return installed


def fence(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Retire earlier samples without moving position or changing recency."""
    db.execute(
        text("""
            INSERT INTO podcast_listening_states (user_id, media_id, reset_epoch)
            VALUES (:viewer_id, :media_id, 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET reset_epoch = podcast_listening_states.reset_epoch + 1
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    observation.advance(db, viewer_id)


def reset(db: Session, *, viewer_id: UUID, media_id: UUID) -> Listening:
    """Position zero under the next epoch, no engagement; rate and duration stay."""
    heard = _listening(
        db.execute(
            text(f"""
                INSERT INTO podcast_listening_states (user_id, media_id, reset_epoch)
                VALUES (:viewer_id, :media_id, 1)
                ON CONFLICT (user_id, media_id) DO UPDATE
                SET position_ms = 0,
                    reset_epoch = podcast_listening_states.reset_epoch + 1,
                    last_engaged_at = NULL
                RETURNING {_COLUMNS}
            """),
            {"viewer_id": viewer_id, "media_id": media_id},
        ).one()
    )

    observation.advance(db, viewer_id)
    return heard
