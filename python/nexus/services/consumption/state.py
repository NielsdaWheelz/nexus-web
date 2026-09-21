"""Explicit read-state overrides and reader engagement.

Sole DML owner of ``consumption_overrides`` (the viewer's explicit Unread /
Finished statement, whose ``revision`` is the natural-end fence) and of
``reader_engagement_states`` (last-touched recency plus the maximum whole-
document progression a reader save has reached). Every mutation composes
inside the caller's already-open, viewer-locked transaction.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.ids import new_uuid7
from nexus.schemas.presence import Absent, Presence
from nexus.schemas.reader import PdfReaderResumeState, ReaderResumeState

OverrideState = Literal["Unread", "Finished"]

_TO_STORED: dict[OverrideState, str] = {"Unread": "unread", "Finished": "finished"}
_FROM_STORED: dict[str, OverrideState] = {"unread": "Unread", "finished": "Finished"}


@dataclass(frozen=True, slots=True)
class OverrideRow:
    state: OverrideState
    revision: int


@dataclass(frozen=True, slots=True)
class ReaderEngagementRow:
    last_engaged_at: datetime
    max_total_progression: float | None


def load_override_rows(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, OverrideRow]:
    """The explicit override row per media that carries one."""
    if not media_ids:
        return {}
    rows = db.execute(
        text("""
            SELECT media_id, status, revision
            FROM consumption_overrides
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).fetchall()
    return {
        UUID(str(media_id)): OverrideRow(state=_FROM_STORED[str(status)], revision=int(revision))
        for media_id, status, revision in rows
    }


def set_override_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, state: OverrideState
) -> None:
    """Write an explicit override and advance its settlement fence."""
    db.execute(
        text("""
            INSERT INTO consumption_overrides (user_id, media_id, status, revision)
            VALUES (:viewer_id, :media_id, :status, 1)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET status = EXCLUDED.status,
                revision = consumption_overrides.revision + 1,
                created_at = now()
        """),
        {"viewer_id": viewer_id, "media_id": media_id, "status": _TO_STORED[state]},
    )


def clear_override_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    db.execute(
        text(
            "DELETE FROM consumption_overrides WHERE user_id = :viewer_id AND media_id = :media_id"
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def override_revision_matches(
    db: Session, *, viewer_id: UUID, media_id: UUID, expected_revision: Presence[int]
) -> bool:
    """Presence-exact natural-end fence: Absent means 'no override row'."""
    current = load_override_rows(db, viewer_id=viewer_id, media_ids=[media_id]).get(media_id)
    if isinstance(expected_revision, Absent):
        return current is None
    return current is not None and current.revision == expected_revision.value


def load_engagement_rows(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, ReaderEngagementRow]:
    if not media_ids:
        return {}
    rows = db.execute(
        text("""
            SELECT media_id, last_engaged_at, max_total_progression
            FROM reader_engagement_states
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
        """),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).fetchall()
    return {
        UUID(str(media_id)): ReaderEngagementRow(
            last_engaged_at=last_engaged_at,
            max_total_progression=float(progression) if progression is not None else None,
        )
        for media_id, last_engaged_at, progression in rows
    }


def engagement_recency(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, datetime]:
    """Per-media ``last_engaged_at``; media without a row are simply absent."""
    return {
        media_id: row.last_engaged_at
        for media_id, row in load_engagement_rows(
            db, viewer_id=viewer_id, media_ids=media_ids
        ).items()
    }


def record_engagement_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, locator: ReaderResumeState
) -> None:
    """Touch recency; for non-PDF locators advance ``max_total_progression``.

    A PDF's ``page_progression`` is page-local, not whole-document, so PDF
    saves leave the maximum untouched.
    """
    progression = (
        None if isinstance(locator, PdfReaderResumeState) else locator.locations.total_progression
    )
    db.execute(
        text("""
            INSERT INTO reader_engagement_states (
                id, user_id, media_id, last_engaged_at, max_total_progression
            )
            VALUES (:id, :viewer_id, :media_id, now(), :progression)
            ON CONFLICT (user_id, media_id) DO UPDATE
            SET last_engaged_at = now(),
                max_total_progression = GREATEST(
                    reader_engagement_states.max_total_progression,
                    EXCLUDED.max_total_progression
                )
        """),
        {
            "id": new_uuid7(),
            "viewer_id": viewer_id,
            "media_id": media_id,
            "progression": progression,
        },
    )


def delete_engagement_in_txn(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    db.execute(
        text("""
            DELETE FROM reader_engagement_states
            WHERE user_id = :viewer_id AND media_id = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": media_id},
    )


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Media teardown: drop every viewer's override and engagement row."""
    db.execute(
        text("DELETE FROM consumption_overrides WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM reader_engagement_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
