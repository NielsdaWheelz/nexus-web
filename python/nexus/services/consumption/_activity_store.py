"""Sole DML owner of Consumption activity, exclusions, and completion facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError
from nexus.ids import new_uuid7
from nexus.schemas.consumption_activity import (
    ActivityBatchIn,
    ActivityDeviceClass,
    ActivityModality,
    ListeningActivitySpanIn,
    ReadingActivitySpanIn,
    ViewingActivitySpanIn,
)
from nexus.schemas.presence import nullable_from_presence


@dataclass(frozen=True)
class ActivitySpanRow:
    id: UUID
    capture_key: UUID
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


@dataclass(frozen=True, slots=True)
class ActivityBatchInsertResult:
    accepted_count: int
    deduplicated_count: int


@dataclass(frozen=True, slots=True)
class ObservedSessionRow:
    started_at: datetime
    ended_at: datetime


ActivitySpanIn = ReadingActivitySpanIn | ListeningActivitySpanIn | ViewingActivitySpanIn

_CAPTURE_SEMANTIC_FIELDS = (
    "media_id",
    "modality",
    "device_id",
    "device_class",
    "occurred_at",
    "duration_ms",
    "progress_start",
    "progress_end",
    "word_start",
    "word_end",
    "media_position_start_ms",
    "media_position_end_ms",
)


def _span_values(
    *,
    viewer_id: UUID,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    modality: ActivityModality,
    span: ActivitySpanIn,
) -> dict[str, object]:
    values: dict[str, object] = {
        "id": new_uuid7(),
        "capture_key": span.capture_key,
        "user_id": viewer_id,
        "media_id": media_id,
        "modality": modality,
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
    return values


def insert_activity_batch_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> ActivityBatchInsertResult:
    """Insert only unseen capture facts after exact semantic comparison."""
    submitted = [
        _span_values(
            viewer_id=viewer_id,
            media_id=media_id,
            device_id=device_id,
            device_class=device_class,
            modality=batch.modality,
            span=span,
        )
        for span in batch.spans
    ]
    existing = {
        row["capture_key"]: dict(row)
        for row in db.execute(
            text(
                """
                SELECT capture_key, media_id, modality, device_id, device_class,
                       occurred_at, duration_ms, progress_start, progress_end,
                       word_start, word_end, media_position_start_ms,
                       media_position_end_ms
                FROM consumption_activity_spans
                WHERE user_id = :viewer_id
                  AND capture_key = ANY(:capture_keys)
                """
            ),
            {
                "viewer_id": viewer_id,
                "capture_keys": [values["capture_key"] for values in submitted],
            },
        ).mappings()
    }
    missing: list[dict[str, object]] = []
    for values in submitted:
        stored = existing.get(values["capture_key"])
        if stored is None:
            missing.append(values)
            continue
        if any(stored[field] != values[field] for field in _CAPTURE_SEMANTIC_FIELDS):
            raise ConflictError(
                ApiErrorCode.E_ACTIVITY_CAPTURE_CONFLICT,
                "Activity capture key was reused with different facts",
            )
    if missing:
        db.execute(
            text(
                """
                INSERT INTO consumption_activity_spans (
                    id, capture_key, user_id, media_id, modality, device_id,
                    device_class, occurred_at, duration_ms, progress_start,
                    progress_end, word_start, word_end,
                    media_position_start_ms, media_position_end_ms
                ) VALUES (
                    :id, :capture_key, :user_id, :media_id, :modality, :device_id,
                    :device_class, :occurred_at, :duration_ms, :progress_start,
                    :progress_end, :word_start, :word_end,
                    :media_position_start_ms, :media_position_end_ms
                )
                """
            ),
            missing,
        )
    return ActivityBatchInsertResult(
        accepted_count=len(missing),
        deduplicated_count=len(submitted) - len(missing),
    )


def observed_session_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    modality: ActivityModality,
    device_id: str,
    started_at: datetime,
    ended_at: datetime,
) -> ObservedSessionRow | None:
    """Resolve one exact current all-time observed gap-and-island session."""
    row = (
        db.execute(
            text(
                """
            WITH spans AS (
                SELECT occurred_at,
                       occurred_at + duration_ms * interval '1 millisecond' AS ended_at,
                       id,
                       max(occurred_at + duration_ms * interval '1 millisecond') OVER (
                           ORDER BY occurred_at, id
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                       ) AS prior_max_end
                FROM consumption_activity_spans
                WHERE user_id = :viewer_id
                  AND media_id = :media_id
                  AND modality = :modality
                  AND device_id = :device_id
                  AND NOT EXISTS (
                      SELECT 1
                      FROM consumption_activity_exclusions x
                      WHERE x.user_id = consumption_activity_spans.user_id
                        AND x.media_id = consumption_activity_spans.media_id
                        AND x.modality = consumption_activity_spans.modality
                        AND x.device_id = consumption_activity_spans.device_id
                        AND x.restored_at IS NULL
                        AND consumption_activity_spans.occurred_at >= x.started_at
                        AND consumption_activity_spans.occurred_at
                              + consumption_activity_spans.duration_ms
                                  * interval '1 millisecond'
                            <= x.ended_at
                  )
            ), marked AS (
                SELECT *,
                       CASE WHEN prior_max_end IS NULL
                                  OR occurred_at >= prior_max_end + interval '30 minutes'
                            THEN 1 ELSE 0 END AS starts_island
                FROM spans
            ), islanded AS (
                SELECT *, sum(starts_island) OVER (ORDER BY occurred_at, id) AS island
                FROM marked
            ), sessions AS (
                SELECT min(occurred_at) AS started_at, max(ended_at) AS ended_at
                FROM islanded
                GROUP BY island
            )
            SELECT started_at, ended_at
            FROM sessions
            WHERE started_at = :started_at AND ended_at = :ended_at
            """
            ),
            {
                "viewer_id": viewer_id,
                "media_id": media_id,
                "modality": modality,
                "device_id": device_id,
                "started_at": started_at,
                "ended_at": ended_at,
            },
        )
        .mappings()
        .one_or_none()
    )
    return (
        ObservedSessionRow(started_at=row["started_at"], ended_at=row["ended_at"])
        if row is not None
        else None
    )


def insert_exclusion_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    modality: ActivityModality,
    device_id: str,
    started_at: datetime,
    ended_at: datetime,
) -> UUID:
    exclusion_id = new_uuid7()
    db.execute(
        text(
            """
            INSERT INTO consumption_activity_exclusions (
                id, user_id, media_id, modality, device_id, started_at, ended_at
            ) VALUES (
                :id, :viewer_id, :media_id, :modality, :device_id, :started_at, :ended_at
            )
            """
        ),
        {
            "id": exclusion_id,
            "viewer_id": viewer_id,
            "media_id": media_id,
            "modality": modality,
            "device_id": device_id,
            "started_at": started_at,
            "ended_at": ended_at,
        },
    )
    return exclusion_id


def restore_exclusion_in_txn(
    db: Session, *, viewer_id: UUID, exclusion_id: UUID
) -> Literal["Restored", "Missing", "AlreadyRestored"]:
    row = db.execute(
        text(
            """
            SELECT restored_at
            FROM consumption_activity_exclusions
            WHERE id = :exclusion_id AND user_id = :viewer_id
            """
        ),
        {"exclusion_id": exclusion_id, "viewer_id": viewer_id},
    ).one_or_none()
    if row is None:
        return "Missing"
    if row[0] is not None:
        return "AlreadyRestored"
    result = db.execute(
        text(
            """
            UPDATE consumption_activity_exclusions
            SET restored_at = now()
            WHERE id = :exclusion_id
              AND user_id = :viewer_id
              AND restored_at IS NULL
            """
        ),
        {"exclusion_id": exclusion_id, "viewer_id": viewer_id},
    )
    if not isinstance(result, CursorResult) or result.rowcount != 1:
        raise AssertionError(
            "activity exclusion restore did not affect exactly one row"
        )  # justify-service-invariant-check: the viewer lock serializes restore.
    return "Restored"


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
        text("DELETE FROM consumption_activity_exclusions WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM consumption_activity_spans WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM consumption_completion_facts WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
