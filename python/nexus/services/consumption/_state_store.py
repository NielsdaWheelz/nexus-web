"""Sole DML owner of ``consumption_overrides`` (explicit read-state).

Persistence adapters here alone map the PascalCase domain vocabulary to the
lowercase stored values and defect on an unknown stored value (spec §4). Every
public helper composes inside the caller's already-open command transaction.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.schemas.presence import Absent, Presence

OverrideState = Literal["Unread", "Finished"]

_OVERRIDE_TO_STORED: dict[OverrideState, str] = {"Unread": "unread", "Finished": "finished"}
_OVERRIDE_FROM_STORED: dict[str, OverrideState] = {"unread": "Unread", "finished": "Finished"}


@dataclass(frozen=True, slots=True)
class OverrideRow:
    state: OverrideState
    revision: int


def _decode_row(*, status: object, revision: object) -> OverrideRow:
    stored = str(status)
    if stored not in _OVERRIDE_FROM_STORED:
        # justify-defect: this store is the sole writer of the column and only
        # writes 'unread'/'finished'; any other stored value is corruption.
        raise AssertionError(f"unknown consumption_overrides.status: {stored!r}")
    decoded_revision = int(str(revision))
    if decoded_revision < 0:
        # justify-defect: revisions originate at zero/one and only increment.
        raise AssertionError(f"negative consumption_overrides.revision: {decoded_revision}")
    return OverrideRow(
        state=_OVERRIDE_FROM_STORED[stored],
        revision=decoded_revision,
    )


def load_override(db: Session, *, viewer_id: UUID, media_id: UUID) -> OverrideRow | None:
    row = (
        db.execute(
            text(
                """
                SELECT status, revision
                FROM consumption_overrides
                WHERE user_id = :viewer_id AND media_id = :media_id
                """
            ),
            {"viewer_id": viewer_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    return _decode_row(status=row["status"], revision=row["revision"]) if row is not None else None


def set_override_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, state: OverrideState
) -> int:
    """Write an explicit override and advance its settlement fence."""
    current = load_override(db, viewer_id=viewer_id, media_id=media_id)
    next_revision = 1 if current is None else current.revision + 1
    params = {
        "viewer_id": viewer_id,
        "media_id": media_id,
        "status": _OVERRIDE_TO_STORED[state],
        "revision": next_revision,
    }
    if current is None:
        db.execute(
            text(
                """
                INSERT INTO consumption_overrides (user_id, media_id, status, revision)
                VALUES (:viewer_id, :media_id, :status, :revision)
                """
            ),
            params,
        )
    else:
        updated_revision = db.execute(
            text(
                """
                UPDATE consumption_overrides
                SET status = :status, revision = :revision, created_at = now()
                WHERE user_id = :viewer_id AND media_id = :media_id
                RETURNING revision
                """
            ),
            params,
        ).scalar_one()
        # justify-defect: the serialized owner just selected this exact row.
        assert int(updated_revision) == next_revision
    return next_revision


def override_revision_matches(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    expected_revision: Presence[int],
) -> bool:
    """Exact Presence comparison for a natural-end receipt fence."""
    current = load_override(db, viewer_id=viewer_id, media_id=media_id)
    if isinstance(expected_revision, Absent):
        return current is None
    return current is not None and current.revision == expected_revision.value


def load_override_rows(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, OverrideRow]:
    """Return the explicit override row per media that carries one."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT media_id, status, revision
            FROM consumption_overrides
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
            """
        ),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).fetchall()
    return {
        UUID(str(media_id)): _decode_row(status=status, revision=revision)
        for media_id, status, revision in rows
    }


def load_overrides(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, OverrideState]:
    """Return only explicit states for read-model callers that need no fence."""
    return {
        media_id: row.state
        for media_id, row in load_override_rows(
            db,
            viewer_id=viewer_id,
            media_ids=media_ids,
        ).items()
    }


def clear_override_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Clear the one explicit status override when ResetProgress replaces state."""
    db.execute(
        text(
            """
            DELETE FROM consumption_overrides
            WHERE user_id = :viewer_id AND media_id = :media_id
            """
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Delete every user's override row for a media (media teardown only)."""
    db.execute(
        text("DELETE FROM consumption_overrides WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
