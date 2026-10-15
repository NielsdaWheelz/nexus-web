"""Owner of `Media` processing-status transitions.

The failure-field tuple (status, stage, error code/message, timestamps) always moves
together, so lifecycles call these instead of touching the columns.
"""

from datetime import datetime
from typing import Literal
from uuid import UUID

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.services.x_source import has_retained_x_publication

type MediaFailureStage = Literal["upload", "extract", "transcribe", "embed", "other"]


def mark_media_failed_by_id(
    db: Session,
    *,
    media_id: UUID,
    stage: MediaFailureStage,
    error_code: str,
    error_message: str,
    now: datetime,
) -> None:
    """Transition one locked Media row to terminal failure."""
    db.execute(
        text("""
            UPDATE media
            SET processing_status = 'failed',
                failure_stage = :failure_stage,
                last_error_code = :error_code,
                last_error_message = :error_message,
                failed_at = :now,
                updated_at = :now
            WHERE id = :media_id
        """),
        {
            "media_id": media_id,
            "failure_stage": stage,
            "error_code": error_code,
            "error_message": error_message,
            "now": now,
        },
    )


def _clear_failure(media: Media) -> None:
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = func.now()


def mark_extracting(db: Session, media: Media) -> None:
    """Move queued or starting source work to extracting, failure cleared."""
    if media.provider == "x" and has_retained_x_publication(db, media_id=media.id):
        if media.processing_status != ProcessingStatus.ready_for_reading:
            mark_ready_for_reading(db, media)
        return
    media.processing_status = ProcessingStatus.extracting
    media.processing_started_at = func.now()
    _clear_failure(media)
    db.flush()


def mark_ready_for_reading(db: Session, media: Media) -> None:
    """Mark readable extraction complete."""
    media.processing_status = ProcessingStatus.ready_for_reading
    _clear_failure(media)
    db.flush()


def mark_ready_for_reading_by_id(db: Session, *, media_id: UUID, now: datetime) -> None:
    """Mark readable extraction complete by id; callers own the transaction."""
    db.execute(
        text("""
            UPDATE media
            SET processing_status = :processing_status,
                failure_stage = NULL,
                last_error_code = NULL,
                last_error_message = NULL,
                failed_at = NULL,
                updated_at = :now
            WHERE id = :media_id
        """),
        {
            "media_id": media_id,
            "processing_status": ProcessingStatus.ready_for_reading.value,
            "now": now,
        },
    )


def mark_stage_warning(
    db: Session, media: Media, *, stage: str, error_code: str, error_message: str
) -> None:
    """Record non-terminal failure metadata without changing readability."""
    media.failure_stage = FailureStage(stage)
    media.last_error_code = error_code
    media.last_error_message = error_message
    media.failed_at = func.now()
    media.updated_at = func.now()
    db.flush()
