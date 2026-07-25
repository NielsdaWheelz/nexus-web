"""Sole DML owner of Consumption's activity and completion facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.ids import new_uuid7
from nexus.schemas.consumption_activity import (
    ActivityBatchIn,
    ActivityDeviceClass,
    ActivityModality,
    ListeningActivitySpanIn,
    ReadingActivitySpanIn,
)
from nexus.schemas.presence import nullable_from_presence


@dataclass(frozen=True)
class ActivitySpanRow:
    id: UUID
    user_id: UUID
    media_id: UUID
    modality: ActivityModality
    device_id: str
    device_class: ActivityDeviceClass
    occurred_at: datetime
    duration_ms: int
    progress_start: float | None
    progress_end: float | None
    word_start: int | None
    word_end: int | None
    media_position_start_ms: int | None
    media_position_end_ms: int | None
    created_at: datetime


@dataclass(frozen=True)
class CompletionFactRow:
    id: UUID
    user_id: UUID
    media_id: UUID
    modality: ActivityModality
    created_at: datetime


def insert_activity_batch_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> None:
    """Insert one already-validated, single-lane browser batch."""
    rows: list[dict[str, object]] = []
    for span in batch.spans:
        values: dict[str, object] = {
            "id": new_uuid7(),
            "user_id": viewer_id,
            "media_id": media_id,
            "modality": batch.modality,
            "device_id": device_id,
            "device_class": device_class,
            "occurred_at": span.occurred_at,
            "duration_ms": span.duration_ms,
            "progress_start": None,
            "progress_end": None,
            "word_start": None,
            "word_end": None,
            "media_position_start_ms": None,
            "media_position_end_ms": None,
        }
        if isinstance(span, ReadingActivitySpanIn):
            values["progress_start"] = nullable_from_presence(span.progress_start)
            values["progress_end"] = nullable_from_presence(span.progress_end)
            values["word_start"] = nullable_from_presence(span.word_start)
            values["word_end"] = nullable_from_presence(span.word_end)
        elif isinstance(span, ListeningActivitySpanIn):
            values["progress_start"] = nullable_from_presence(span.progress_start)
            values["progress_end"] = nullable_from_presence(span.progress_end)
            values["media_position_start_ms"] = nullable_from_presence(span.media_position_start_ms)
            values["media_position_end_ms"] = nullable_from_presence(span.media_position_end_ms)
        rows.append(values)
    db.execute(
        text(
            """
            INSERT INTO consumption_activity_spans (
                id, user_id, media_id, modality, device_id, device_class, occurred_at,
                duration_ms, progress_start, progress_end, word_start, word_end,
                media_position_start_ms, media_position_end_ms
            ) VALUES (
                :id, :user_id, :media_id, :modality, :device_id, :device_class, :occurred_at,
                :duration_ms, :progress_start, :progress_end, :word_start, :word_end,
                :media_position_start_ms, :media_position_end_ms
            )
            """
        ),
        rows,
    )


def insert_completion_fact_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    modality: ActivityModality,
) -> UUID | None:
    """Insert the one first-completion fact, returning its ID when newly created."""
    existing = db.scalar(
        text(
            """
            SELECT id
            FROM consumption_completion_facts
            WHERE user_id = :viewer_id AND media_id = :media_id
            """
        ),
        {"viewer_id": viewer_id, "media_id": media_id},
    )
    if existing is not None:
        return None
    completion_id = new_uuid7()
    db.execute(
        text(
            """
            INSERT INTO consumption_completion_facts (id, user_id, media_id, modality)
            VALUES (:id, :viewer_id, :media_id, :modality)
            """
        ),
        {
            "id": completion_id,
            "viewer_id": viewer_id,
            "media_id": media_id,
            "modality": modality,
        },
    )
    return completion_id


def delete_completion_fact_in_txn(
    db: Session, *, viewer_id: UUID, completion_id: UUID
) -> UUID | None:
    """Delete one viewer-owned completion fact and return its media identity."""
    row = db.execute(
        text(
            """
            DELETE FROM consumption_completion_facts
            WHERE id = :completion_id AND user_id = :viewer_id
            RETURNING media_id
            """
        ),
        {"completion_id": completion_id, "viewer_id": viewer_id},
    ).fetchone()
    return UUID(str(row[0])) if row is not None else None


def delete_all_for_media_in_txn(db: Session, *, media_id: UUID) -> None:
    """Remove retained activity facts as part of explicit media teardown."""
    db.execute(
        text("DELETE FROM consumption_activity_spans WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM consumption_completion_facts WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
