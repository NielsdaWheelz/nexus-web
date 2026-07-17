"""Sole DML owner of ``reader_engagement_states`` (current document reading
engagement: last-touched recency and max whole-document progression). Stores
no session, device, span, dwell, or event list — a valid reader save touches
``last_engaged_at``; non-PDF ``locations.total_progression`` advances
``max_total_progression`` to ``GREATEST(existing, new)``.

Every mutation composes inside the caller's already-open command transaction
(mirrors ``_listening_store.py``'s sole-DML-owner pattern).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.ids import new_uuid7
from nexus.schemas.reader import PdfReaderResumeState, ReaderResumeState


@dataclass(frozen=True)
class ReaderEngagementRow:
    """The owned row shape for one (viewer, media) reader engagement state."""

    last_engaged_at: datetime
    max_total_progression: float | None


def load_states(
    db: Session, *, viewer_id: UUID, media_ids: list[UUID]
) -> dict[UUID, ReaderEngagementRow]:
    """Batch-read engagement rows for the consumption projection."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT media_id, last_engaged_at, max_total_progression
            FROM reader_engagement_states
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
            """
        ),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).fetchall()
    return {
        UUID(str(row[0])): ReaderEngagementRow(
            last_engaged_at=row[1],
            max_total_progression=float(row[2]) if row[2] is not None else None,
        )
        for row in rows
    }


def load_recency(db: Session, *, viewer_id: UUID, media_ids: list[UUID]) -> dict[UUID, datetime]:
    """Per-media engagement recency (``last_engaged_at``). One row per (viewer,
    media), so this is the row's own timestamp. Media without a row are simply
    absent from the map."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(
            """
            SELECT media_id, last_engaged_at
            FROM reader_engagement_states
            WHERE user_id = :viewer_id AND media_id = ANY(:media_ids)
            """
        ),
        {"viewer_id": viewer_id, "media_ids": media_ids},
    ).fetchall()
    return {UUID(str(row[0])): row[1] for row in rows}


def recency_subquery_sql(*, user_param: str, media_expr: str) -> str:
    """Scalar subquery -> the viewer's ``last_engaged_at`` for one media. Composed
    by adopters (e.g. library recency) so ``reader_engagement_states`` reads stay
    inside this owner."""
    return f"""(
        SELECT re_recency.last_engaged_at
        FROM reader_engagement_states re_recency
        WHERE re_recency.user_id = {user_param}
          AND re_recency.media_id = {media_expr}
    )"""


def record_engagement_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    locator: ReaderResumeState,
) -> None:
    """Touch ``last_engaged_at`` unconditionally; for non-PDF locators, advance
    ``max_total_progression`` to ``GREATEST(existing, new)``. PDF's own
    ``page_progression`` is page-local, not whole-document, so PDF saves leave
    ``max_total_progression`` untouched/NULL. Plain idempotent
    ``INSERT ... ON CONFLICT (user_id, media_id) DO UPDATE`` — no fencing token
    exists for this table (mirrors ``_listening_store.mark_completed_in_txn``)."""
    progression = (
        None if isinstance(locator, PdfReaderResumeState) else locator.locations.total_progression
    )
    db.execute(
        text(
            """
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
            """
        ),
        {
            "id": new_uuid7(),
            "viewer_id": viewer_id,
            "media_id": media_id,
            "progression": progression,
        },
    )


def delete_all_users_in_txn(db: Session, *, media_id: UUID) -> None:
    """Delete every user's engagement row for a media (media teardown only)."""
    db.execute(
        text("DELETE FROM reader_engagement_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
