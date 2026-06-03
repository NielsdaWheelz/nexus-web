"""Owner of `Media` processing-status transitions.

The failure-field tuple (status, stage, error code/message, timestamps) must move
together. Format lifecycles (pdf, epub, upload) call these transitions instead of
mutating the columns directly, so the state machine has one owner.
"""

from sqlalchemy import func
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, ProcessingStatus


def mark_failed(
    db: Session,
    media: Media,
    *,
    stage: str,
    error_code: str,
    error_message: str,
) -> None:
    """Transition media to the terminal failed state and commit."""
    media.processing_status = ProcessingStatus.failed
    media.failure_stage = FailureStage(stage)
    media.last_error_code = error_code
    media.last_error_message = error_message
    media.failed_at = func.now()
    media.updated_at = func.now()
    db.commit()


def begin_extraction(db: Session, media: Media) -> None:
    """Clear failure metadata, bump the attempt counter, and start an extraction attempt.

    Flushes without committing: callers continue the surrounding ingest transaction.
    """
    media.processing_status = ProcessingStatus.extracting
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_started_at = func.now()
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = func.now()
    db.flush()


def reset_for_reingest(db: Session, media: Media) -> None:
    """Clear failure metadata, bump attempts, and restart source extraction."""
    media.processing_status = ProcessingStatus.extracting
    media.processing_attempts = (media.processing_attempts or 0) + 1
    media.processing_started_at = func.now()
    media.processing_completed_at = None
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = func.now()
    db.flush()


def mark_ready_for_reading(db: Session, media: Media) -> None:
    """Clear failure metadata and mark readable extraction complete."""
    media.processing_status = ProcessingStatus.ready_for_reading
    media.processing_completed_at = func.now()
    media.failure_stage = None
    media.last_error_code = None
    media.last_error_message = None
    media.failed_at = None
    media.updated_at = func.now()
    db.flush()
