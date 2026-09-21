"""Sole DML owner of activity spans, exclusions, and completion facts.

``capture_key`` is fact identity: a retried batch inserts nothing, and a key
reused with different facts is a conflict. Sessions are never stored — the
exclusion path resolves one from the same sessionised relation the Stats read
uses, so what a viewer excludes is exactly what they were shown.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ConflictError
from nexus.ids import new_uuid7
from nexus.schemas.consumption_activity import (
    ActivityBatchIn,
    ActivityDeviceClass,
    ActivityModality,
    ActivitySpanIn,
    ListeningActivitySpanIn,
    ReadingActivitySpanIn,
)
from nexus.schemas.presence import nullable_from_presence
from nexus.services.consumption.activity_stats import (
    ALL_TIME_END,
    ALL_TIME_START,
    as_of_created_at,
    sessionized_spans_sql,
)

_COMPARED_FIELDS = (
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
_SPAN_COLUMNS = (
    "id, capture_key, user_id, media_id, modality, device_id, device_class, "
    "occurred_at, duration_ms, progress_start, progress_end, word_start, word_end, "
    "media_position_start_ms, media_position_end_ms"
)


def insert_activity_batch_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> None:
    """Insert the unseen spans; re-compare only the keys that did not insert."""
    submitted = {
        span.capture_key: _span_values(
            span,
            viewer_id=viewer_id,
            media_id=media_id,
            device_id=device_id,
            device_class=device_class,
            modality=batch.modality,
        )
        for span in batch.spans
    }
    inserted = set(
        db.execute(
            text(f"""
                INSERT INTO consumption_activity_spans ({_SPAN_COLUMNS})
                SELECT v.id, v.capture_key, :viewer_id, :media_id, :modality, :device_id,
                       :device_class, v.occurred_at, v.duration_ms, v.progress_start,
                       v.progress_end, v.word_start, v.word_end,
                       v.media_position_start_ms, v.media_position_end_ms
                FROM jsonb_to_recordset(CAST(:spans AS jsonb)) AS v(
                    id uuid, capture_key uuid, occurred_at timestamptz, duration_ms bigint,
                    progress_start double precision, progress_end double precision,
                    word_start bigint, word_end bigint,
                    media_position_start_ms bigint, media_position_end_ms bigint
                )
                ON CONFLICT (user_id, capture_key) DO NOTHING
                RETURNING capture_key
            """),
            {
                "viewer_id": viewer_id,
                "media_id": media_id,
                "modality": batch.modality,
                "device_id": device_id,
                "device_class": device_class,
                "spans": json.dumps(list(submitted.values()), default=str),
            },
        ).scalars()
    )
    replayed = [key for key in submitted if key not in inserted]
    if not replayed:
        return
    stored = db.execute(
        text(f"""
            SELECT {_SPAN_COLUMNS}
            FROM consumption_activity_spans
            WHERE user_id = :viewer_id AND capture_key = ANY(:capture_keys)
        """),
        {"viewer_id": viewer_id, "capture_keys": replayed},
    ).mappings()
    for row in stored:
        values = submitted[UUID(str(row["capture_key"]))]
        if any(row[field] != values[field] for field in _COMPARED_FIELDS):
            raise ConflictError(
                ApiErrorCode.E_ACTIVITY_CAPTURE_CONFLICT,
                "Activity capture key was reused with different facts",
            )


def _span_values(
    span: ActivitySpanIn,
    *,
    viewer_id: UUID,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    modality: ActivityModality,
) -> dict[str, Any]:
    values: dict[str, Any] = {
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


def observed_session_exists_in_txn(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    modality: ActivityModality,
    device_id: str,
    started_at: datetime,
    ended_at: datetime,
) -> bool:
    """Whether the interval is exactly one current all-time observed session."""
    relation = sessionized_spans_sql(
        "AND s.media_id = :media_id AND s.modality = :modality AND s.device_id = :device_id"
    )
    return (
        db.scalar(
            text(f"""
                WITH session_spans AS ({relation})
                SELECT 1 FROM session_spans
                GROUP BY media_id, modality, device_id, island
                HAVING min(clipped_start) = :started_at AND max(clipped_end) = :ended_at
                LIMIT 1
            """),
            {
                "viewer_id": viewer_id,
                "media_id": media_id,
                "modality": modality,
                "device_id": device_id,
                "started_at": started_at,
                "ended_at": ended_at,
                "start": ALL_TIME_START,
                "end": ALL_TIME_END,
                "context_start": ALL_TIME_START,
                "context_end": ALL_TIME_END,
                "as_of_created_at": as_of_created_at(db),
            },
        )
        is not None
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
        text("""
            INSERT INTO consumption_activity_exclusions (
                id, user_id, media_id, modality, device_id, started_at, ended_at
            ) VALUES (
                :id, :viewer_id, :media_id, :modality, :device_id, :started_at, :ended_at
            )
        """),
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
    params = {"exclusion_id": exclusion_id, "viewer_id": viewer_id}
    restored = db.scalar(
        text("""
            UPDATE consumption_activity_exclusions
            SET restored_at = now()
            WHERE id = :exclusion_id AND user_id = :viewer_id AND restored_at IS NULL
            RETURNING id
        """),
        params,
    )
    if restored is not None:
        return "Restored"
    present_already = db.scalar(
        text("""
            SELECT 1 FROM consumption_activity_exclusions
            WHERE id = :exclusion_id AND user_id = :viewer_id
        """),
        params,
    )
    return "AlreadyRestored" if present_already is not None else "Missing"


def insert_completion_fact_in_txn(
    db: Session, *, viewer_id: UUID, media_id: UUID, modality: ActivityModality
) -> UUID | None:
    """Insert the one first-completion fact, returning its id when newly created."""
    return db.scalar(
        text("""
            INSERT INTO consumption_completion_facts (id, user_id, media_id, modality)
            VALUES (:id, :viewer_id, :media_id, :modality)
            ON CONFLICT (user_id, media_id) DO NOTHING
            RETURNING id
        """),
        {
            "id": new_uuid7(),
            "viewer_id": viewer_id,
            "media_id": media_id,
            "modality": modality,
        },
    )


def delete_completion_fact_in_txn(
    db: Session, *, viewer_id: UUID, completion_id: UUID
) -> UUID | None:
    """Delete one viewer-owned completion fact and return its media identity."""
    return db.scalar(
        text("""
            DELETE FROM consumption_completion_facts
            WHERE id = :completion_id AND user_id = :viewer_id
            RETURNING media_id
        """),
        {"completion_id": completion_id, "viewer_id": viewer_id},
    )


def delete_all_for_media_in_txn(db: Session, *, media_id: UUID) -> None:
    """Media teardown: drop every viewer's spans, exclusions, and completions."""
    for table in (
        "consumption_activity_exclusions",
        "consumption_activity_spans",
        "consumption_completion_facts",
    ):
        db.execute(text(f"DELETE FROM {table} WHERE media_id = :media_id"), {"media_id": media_id})
