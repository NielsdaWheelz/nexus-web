"""Canonical episode consumption observations and their account watermark.

Mutation owners advance under the existing viewer lock in the transaction that
changes consumption. Reads use the caller's snapshot and grant no resource access.
The watermark orders observations; it never fences writes or catalog membership.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.consumption import (
    ConsumptionData,
    EpisodeConsumptionEntry,
    EpisodeConsumptionObservation,
    EpisodeConsumptionState,
)


def advance(db: Session, viewer_id: UUID) -> None:
    db.execute(
        text("UPDATE users SET consumption_revision = consumption_revision + 1 WHERE id = :viewer"),
        {"viewer": viewer_id},
    )


def revision(db: Session, viewer_id: UUID) -> str:
    return str(
        db.execute(
            text("SELECT consumption_revision FROM users WHERE id = :viewer"),
            {"viewer": viewer_id},
        ).scalar_one()
    )


def states(
    db: Session, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, EpisodeConsumptionState]:
    rows = db.execute(
        text("""
            SELECT m.id, COALESCE(pls.reset_epoch, 0) AS reset_epoch,
                   co.revision, co.status, pls.position_ms,
                   pls.duration_ms,
                   EXISTS (SELECT 1 FROM consumption_queue_items q
                           WHERE q.user_id = :viewer AND q.media_id = m.id) AS lectern_member
            FROM media m JOIN podcast_episodes pe ON pe.media_id = m.id
            LEFT JOIN podcast_listening_states pls ON pls.media_id = m.id AND pls.user_id = :viewer
            LEFT JOIN consumption_overrides co ON co.media_id = m.id AND co.user_id = :viewer
            WHERE m.id = ANY(:ids) AND m.kind = 'podcast_episode'
        """),
        {"viewer": viewer_id, "ids": media_ids},
    )
    return {
        row.id: EpisodeConsumptionState(
            reset_epoch=row.reset_epoch,
            consumption_override_revision=row.revision,
            consumption_override_status=row.status,
            position_ms=row.position_ms,
            duration_ms=row.duration_ms,
            lectern_member=row.lectern_member,
        )
        for row in rows
    }


def read(db: Session, viewer_id: UUID, media_id: UUID) -> EpisodeConsumptionObservation:
    return EpisodeConsumptionObservation(
        media_id=media_id,
        consumption_revision=revision(db, viewer_id),
        state=states(db, viewer_id, [media_id])[media_id],
    )


def stamp[T](db: Session, viewer_id: UUID, data: T, media_ids: list[UUID]) -> ConsumptionData[T]:
    return ConsumptionData(
        data=data,
        consumption_revision=revision(db, viewer_id),
        episode_consumption=[
            EpisodeConsumptionEntry(media_id=media_id, state=state)
            for media_id, state in states(db, viewer_id, media_ids).items()
        ],
    )
