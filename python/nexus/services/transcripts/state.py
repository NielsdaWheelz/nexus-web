"""Transcript state persistence and its transaction-bound media notifications.

Absolute state upserts converge on retry; publication revisions advance once inside
that publication transaction. PostgreSQL delivers notifications only after commit.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

TranscriptOrigin = Literal["Publisher", "Imported", "Generated"]


def read_transcript_content_revision(db: Session, *, media_id: UUID) -> int:
    """An absent lifecycle row shares the opaque pre-revision baseline of zero."""
    revision = db.scalar(
        text("SELECT content_revision FROM media_transcript_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    return 0 if revision is None else int(revision)


def advance_transcript_content_revision(db: Session, *, media_id: UUID) -> None:
    """Advance once with a current-transcript replacement, after its state upsert."""
    revision = db.scalar(
        text("""
            UPDATE media_transcript_states SET content_revision = content_revision + 1
            WHERE media_id = :media_id RETURNING content_revision
        """),
        {"media_id": media_id},
    )
    if revision is None:
        # justify-defect: transcript publication must establish its state before
        # advancing the content identity in the same transaction.
        raise AssertionError("transcript publication has no lifecycle row")
    db.execute(text("SELECT pg_notify('media_events', :id)"), {"id": str(media_id)})


def set_media_transcript_state(
    db: Session,
    *,
    media_id: UUID,
    transcript_state: str,
    transcript_coverage: str,
    last_request_reason: str | None = None,
    last_error_code: str | None = None,
    transcript_origin: TranscriptOrigin | None = None,
    now: datetime,
) -> None:
    """Upsert the lifecycle row; origin survives only while the state is readable."""
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id, transcript_state, transcript_coverage, last_request_reason,
                last_error_code, transcript_origin, created_at, updated_at
            )
            VALUES (
                :media_id, :transcript_state, :transcript_coverage, :last_request_reason,
                :last_error_code,
                CASE
                    WHEN :transcript_state IN ('ready', 'partial')
                    THEN CAST(:transcript_origin AS text)
                    ELSE NULL
                END,
                :now, :now
            )
            ON CONFLICT (media_id) DO UPDATE
            SET transcript_state = EXCLUDED.transcript_state,
                transcript_coverage = EXCLUDED.transcript_coverage,
                last_request_reason = COALESCE(
                    EXCLUDED.last_request_reason, media_transcript_states.last_request_reason
                ),
                last_error_code = EXCLUDED.last_error_code,
                transcript_origin = CASE
                    WHEN EXCLUDED.transcript_state NOT IN ('ready', 'partial') THEN NULL
                    WHEN EXCLUDED.transcript_origin IS NOT NULL THEN EXCLUDED.transcript_origin
                    ELSE media_transcript_states.transcript_origin
                END,
                updated_at = EXCLUDED.updated_at
            """
        ),
        {
            "media_id": media_id,
            "transcript_state": transcript_state,
            "transcript_coverage": transcript_coverage,
            "last_request_reason": last_request_reason,
            "last_error_code": last_error_code,
            "transcript_origin": transcript_origin,
            "now": now,
        },
    )

    db.execute(text("SELECT pg_notify('media_events', :id)"), {"id": str(media_id)})


def ensure_media_transcript_state_row(
    db: Session,
    *,
    media_id: UUID,
    now: datetime,
    request_reason: str | None = None,
) -> None:
    """Create the lifecycle row when the Media does not have one yet."""
    db.execute(
        text(
            """
            INSERT INTO media_transcript_states (
                media_id, transcript_state, transcript_coverage, last_request_reason,
                last_error_code, created_at, updated_at
            )
            VALUES (:media_id, 'not_requested', 'none', :last_request_reason, NULL, :now, :now)
            ON CONFLICT (media_id) DO NOTHING
            """
        ),
        {"media_id": media_id, "last_request_reason": request_reason, "now": now},
    )
