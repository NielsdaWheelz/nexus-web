"""Owner of `Media` processing-status transitions.

The failure-field tuple (status, stage, error code/message, timestamps) must move
together. Format lifecycles (pdf, epub, upload) call these transitions instead of
mutating the columns directly, so the state machine has one owner.
"""

from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, MediaKind, ProcessingStatus

type MediaFailureStage = Literal[
    "upload",
    "extract",
    "transcribe",
    "embed",
    "metadata",
    "other",
]

_MEDIA_FAILURE_STAGES = frozenset(stage.value for stage in FailureStage)


def is_metadata_enrichment_eligible(*, kind: str, processing_status: str) -> bool:
    """Metadata research does not require an audio/video transcript."""
    return processing_status == ProcessingStatus.ready_for_reading or (
        processing_status == ProcessingStatus.pending
        and kind in (MediaKind.video, MediaKind.podcast_episode)
    )


def require_media_failure_stage(value: str) -> MediaFailureStage:
    """Narrow a boundary string to the closed Media failure-stage contract."""
    if value not in _MEDIA_FAILURE_STAGES:
        raise AssertionError(f"unsupported Media failure stage: {value!r}")
    return cast(MediaFailureStage, value)


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
    updated = db.execute(
        text(
            """
            UPDATE media
            SET processing_status = 'failed',
                failure_stage = :failure_stage,
                last_error_code = :error_code,
                last_error_message = :error_message,
                processing_completed_at = NULL,
                failed_at = :now,
                updated_at = :now
            WHERE id = :media_id
            RETURNING id
            """
        ),
        {
            "media_id": media_id,
            "failure_stage": stage,
            "error_code": error_code,
            "error_message": error_message,
            "now": now,
        },
    ).one_or_none()
    if updated is None:
        raise AssertionError("terminal Media failure target is absent")


def begin_extraction(db: Session, media: Media) -> None:
    """Clear failure metadata, bump the attempt counter, and start an extraction attempt.

    Flushes without committing: callers continue the surrounding ingest transaction.
    """
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


def mark_source_queued(db: Session, media: Media) -> None:
    """Clear failure metadata and expose queued source work as active processing.

    This does not bump ``processing_attempts``. The source worker/materializer
    counts the actual processing run when it starts.
    """
    media.processing_status = ProcessingStatus.extracting
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


def mark_ready_for_reading_by_id(db: Session, *, media_id: UUID, now: datetime) -> None:
    """Mark readable extraction complete by id; callers own the transaction."""
    db.execute(
        text(
            """
            UPDATE media
            SET processing_status = :processing_status,
                failure_stage = NULL,
                last_error_code = NULL,
                last_error_message = NULL,
                processing_completed_at = :now,
                failed_at = NULL,
                updated_at = :now
            WHERE id = :media_id
            """
        ),
        {
            "media_id": media_id,
            "processing_status": ProcessingStatus.ready_for_reading.value,
            "now": now,
        },
    )


def mark_stage_warning(
    db: Session,
    media: Media,
    *,
    stage: str,
    error_code: str,
    error_message: str,
) -> None:
    """Record non-terminal failure metadata without changing readability."""
    media.failure_stage = FailureStage(stage)
    media.last_error_code = error_code
    media.last_error_message = error_message
    media.failed_at = func.now()
    media.updated_at = func.now()
    db.flush()
