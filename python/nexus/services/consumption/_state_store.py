"""Sole DML owner of ``consumption_overrides`` (explicit read-state).

Persistence adapters here alone map the PascalCase domain vocabulary to the
lowercase stored values and defect on an unknown stored value (spec §4). Every
public helper composes inside the caller's already-open command transaction.
"""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

OverrideState = Literal["Unread", "Finished"]

_OVERRIDE_TO_STORED: dict[OverrideState, str] = {"Unread": "unread", "Finished": "finished"}
_OVERRIDE_FROM_STORED: dict[str, OverrideState] = {"unread": "Unread", "finished": "Finished"}


def set_override_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, state: OverrideState
) -> None:
    """Upsert the explicit override for (viewer, media)."""
    db.execute(
        text(
            """
            INSERT INTO consumption_overrides (user_id, media_id, status)
            VALUES (:user_id, :media_id, :status)
            ON CONFLICT (user_id, media_id)
            DO UPDATE SET status = EXCLUDED.status, created_at = now()
            """
        ),
        {"user_id": viewer_id, "media_id": media_id, "status": _OVERRIDE_TO_STORED[state]},
    )


def load_overrides(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, OverrideState]:
    """Return the explicit override state per media that carries one."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT media_id, status
            FROM consumption_overrides
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
            """
        ),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).fetchall()
    result: dict[UUID, OverrideState] = {}
    for media_id, status in rows:
        stored = str(status)
        if stored not in _OVERRIDE_FROM_STORED:
            # justify-defect: this store is the sole writer of the column and only
            # writes 'unread'/'finished'; any other stored value is corruption.
            raise AssertionError(f"unknown consumption_overrides.status: {stored!r}")
        result[UUID(str(media_id))] = _OVERRIDE_FROM_STORED[stored]
    return result


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Delete every user's override row for a media (media teardown only)."""
    db.execute(
        text("DELETE FROM consumption_overrides WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
