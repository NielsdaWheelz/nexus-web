"""Activity ingest: the writes behind personal history.

A span's ``capture_key`` is its identity: a replayed key stores nothing, and a key reused with
different facts rolls the whole batch back.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.ids import new_uuid7
from nexus.schemas.consumption import ActivityBatchIn, ActivityDeviceClass
from nexus.schemas.presence import Absent, Present, nullable_from_presence
from nexus.services.consumption import viewer_txn

# The stored facts a replayed capture key must match; Viewing spans carry no measurements.
_FACTS = """media_id modality device_id device_class occurred_at duration_ms progress_start
    progress_end word_start word_end media_position_start_ms media_position_end_ms""".split()


def record_batch(
    viewer_id: UUID,
    *,
    media_id: UUID,
    device_id: str,
    device_class: ActivityDeviceClass,
    batch: ActivityBatchIn,
) -> None:
    """Store recent, ordered, non-overlapping spans exactly once per capture key."""
    shared = {"user_id": viewer_id, "media_id": media_id, "modality": batch.modality}
    shared |= {"device_id": device_id, "device_class": device_class}
    rows = [
        shared
        | {"id": new_uuid7()}
        | {
            name: nullable_from_presence(value) if isinstance(value, Absent | Present) else value
            for name, value in span
        }
        for span in batch.spans
    ]

    def run(db: Session) -> None:
        now, previous_end = datetime.now(UTC), None
        for span in batch.spans:
            if span.occurred_at < now - timedelta(days=30):
                raise InvalidRequestError(
                    ApiErrorCode.E_ACTIVITY_EXPIRED, "Activity span is too old"
                )
            if span.occurred_at > now + timedelta(minutes=5):
                raise InvalidRequestError(message="Activity span is in the future")
            if previous_end is not None and span.occurred_at < previous_end:
                raise InvalidRequestError(
                    message="Activity spans must be ordered and non-overlapping"
                )
            previous_end = span.occurred_at + timedelta(milliseconds=span.duration_ms)
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
        facts = ", ".join(_FACTS)
        # One statement reads one snapshot: the join sees only keys stored before this batch.
        if db.scalar(
            text(f"""
                WITH submitted AS (
                    SELECT * FROM jsonb_populate_recordset(
                        NULL::consumption_activity_spans, CAST(:rows AS jsonb))
                ), inserted AS (
                    INSERT INTO consumption_activity_spans (id, capture_key, user_id, {facts})
                    SELECT id, capture_key, user_id, {facts} FROM submitted
                    ON CONFLICT (user_id, capture_key) DO NOTHING
                )
                SELECT count(*) FROM submitted s
                JOIN consumption_activity_spans stored USING (user_id, capture_key)
                WHERE ({", ".join(f"stored.{f}" for f in _FACTS)})
                      IS DISTINCT FROM ({", ".join(f"s.{f}" for f in _FACTS)})
            """),
            {"rows": json.dumps(rows, default=str)},
        ):
            raise ConflictError(
                ApiErrorCode.E_ACTIVITY_CAPTURE_CONFLICT,
                "Activity capture key was reused with different facts",
            )
        db.commit()

    viewer_txn("record_activity_batch", viewer_id, run)
