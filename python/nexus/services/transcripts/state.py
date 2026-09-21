"""The single persistence owner for a Media's current transcript state."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

TranscriptOrigin = Literal["Publisher", "Imported", "Generated"]


def set_media_transcript_state(
    db: Session,
    *,
    media_id: UUID,
    transcript_state: str,
    transcript_coverage: str,
    semantic_status: str | None = None,
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
                media_id, transcript_state, transcript_coverage, semantic_status,
                last_request_reason, last_error_code, transcript_origin,
                created_at, updated_at
            )
            VALUES (
                :media_id, :transcript_state, :transcript_coverage,
                COALESCE(:semantic_status, 'none'),
                :last_request_reason, :last_error_code,
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
                semantic_status = COALESCE(
                    :semantic_status, media_transcript_states.semantic_status
                ),
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
            "semantic_status": semantic_status,
            "last_request_reason": last_request_reason,
            "last_error_code": last_error_code,
            "transcript_origin": transcript_origin,
            "now": now,
        },
    )


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
                media_id, transcript_state, transcript_coverage, semantic_status,
                last_request_reason, last_error_code, created_at, updated_at
            )
            VALUES (:media_id, 'not_requested', 'none', 'none', :last_request_reason, NULL, :now, :now)
            ON CONFLICT (media_id) DO NOTHING
            """
        ),
        {"media_id": media_id, "last_request_reason": request_reason, "now": now},
    )
