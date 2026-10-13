"""Terminal failure publication for durable media source attempts, and the ingest
job's two queue hooks (import-light: they run in the background supervisor)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ResourceFailureDimension
from nexus.jobs.queue import JobRow
from nexus.schemas.import_history import (
    SourceFailed,
    assume_safe_failure_code,
    queue_failure_code,
)
from nexus.services import media_source_types as source_types
from nexus.services.import_history import append_processing_event
from nexus.services.media_processing_state import (
    MediaFailureStage,
    mark_media_failed_by_id,
    mark_ready_for_reading_by_id,
)
from nexus.services.podcasts.transcription_failure import (
    PodcastTranscriptionFailure,
    publish_podcast_transcription_failure,
)
from nexus.services.source_history import source_failure_progress, source_history_stage
from nexus.services.transcripts.state import set_media_transcript_state
from nexus.services.x_source import has_retained_x_publication

# Keyed by a resource failure's dimension (``background_jobs.result``).
_RESOURCE_LIMIT_MESSAGES: dict[ResourceFailureDimension, str] = {
    "Memory": "Source processing exceeded its memory resource limit.",
    "Time": "Source processing exceeded its time resource limit.",
    "Structure": "Source structure exceeded its processing resource limit.",
    "Output": "Source output exceeded its processing resource limit.",
}


@dataclass(frozen=True)
class SourceAttemptFailure:
    media_id: UUID
    attempt_id: UUID
    failure_stage: MediaFailureStage
    error_code: str
    error_message: str
    now: datetime
    execution_id: UUID | None
    """The worker execution that observed the failure; null when the failure
    was published outside any execution (acceptance or enqueue time)."""


def source_attempt_failure_stage(source_type: str) -> MediaFailureStage:
    """The one Media failure stage owned by a source type."""
    if source_type in source_types.TRANSCRIPT_SOURCE_TYPES:
        return "transcribe"
    return "extract"


def publish_source_attempt_failure(db: Session, failure: SourceAttemptFailure) -> None:
    """Settle one attempt and publish all of its terminal domain projections.

    Lock the media and attempt first. A retained X publication stays ready;
    its failed refresh is represented by this attempt, not by the saved copy.
    """
    db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR NO KEY UPDATE"),
        {"media_id": failure.media_id},
    ).one()
    attempt = (
        db.execute(
            text(
                """
                UPDATE media_source_attempts
                SET status = 'failed',
                    error_code = :error_code,
                    error_message = :error_message,
                    finished_at = :now,
                    updated_at = :now
                WHERE id = :attempt_id
                  AND media_id = :media_id
                  AND status IN ('accepted', 'queued', 'running')
                RETURNING source_type, processing_stage, progress_completed,
                          progress_total, progress_unit
                """
            ),
            {
                "attempt_id": failure.attempt_id,
                "media_id": failure.media_id,
                "error_code": failure.error_code,
                "error_message": failure.error_message[:1000],
                "now": failure.now,
            },
        )
        .mappings()
        .one()
    )
    source_type = str(attempt["source_type"])
    append_processing_event(
        db,
        media_id=failure.media_id,
        facts=SourceFailed(
            source_attempt_id=failure.attempt_id,
            execution_id=failure.execution_id,
            origin="Domain",
            terminal=True,
            progress=source_failure_progress(
                processing_stage=attempt["processing_stage"],
                progress_completed=int(attempt["progress_completed"]),
                progress_total=attempt["progress_total"],
                progress_unit=attempt["progress_unit"],
            ),
        ),
        stage=source_history_stage(
            source_type=source_type, processing_stage=attempt["processing_stage"]
        ),
        failure_code=assume_safe_failure_code(failure.error_code),
    )

    if source_type == source_types.PODCAST_EPISODE_TRANSCRIPT:
        publish_podcast_transcription_failure(
            db,
            PodcastTranscriptionFailure(
                media_id=failure.media_id,
                error_code=failure.error_code,
                error_message=failure.error_message,
                now=failure.now,
            ),
        )
        return

    if source_type in {
        source_types.X_AUTHOR_THREAD,
        source_types.X_POST,
    } and has_retained_x_publication(db, media_id=failure.media_id):
        mark_ready_for_reading_by_id(db, media_id=failure.media_id, now=failure.now)
        return

    mark_media_failed_by_id(
        db,
        media_id=failure.media_id,
        stage=failure.failure_stage,
        error_code=failure.error_code,
        error_message=failure.error_message[:1000],
        now=failure.now,
    )
    if source_type in source_types.TRANSCRIPT_SOURCE_TYPES:
        set_media_transcript_state(
            db,
            media_id=failure.media_id,
            transcript_state="unavailable",
            transcript_coverage="none",
            last_request_reason=None,
            last_error_code=failure.error_code,
            now=failure.now,
        )


def on_failure(db: Session, job: JobRow) -> dict[str, str] | None:
    """An ingest attempt that failed after its source work finished completes instead.

    Its own committed success wins over a dying child; an attempt that is not this
    job's, or not the media's latest, makes the job superseded.
    """
    attempt = (
        db.execute(
            text("""SELECT a.job_id, a.status, a.id = (
                    SELECT latest.id FROM media_source_attempts latest
                    WHERE latest.media_id = a.media_id
                    ORDER BY latest.attempt_no DESC, latest.created_at DESC, latest.id DESC
                    LIMIT 1) AS latest
                FROM media_source_attempts a WHERE a.id = :attempt_id AND a.media_id = :media_id"""),
            {"attempt_id": job.payload["attempt_id"], "media_id": job.payload["media_id"]},
        )
        .mappings()
        .one_or_none()
    )
    if attempt is None or attempt["job_id"] != job.id or not attempt["latest"]:
        return {"status": "superseded"}
    return {"kind": "SourceProjectionSucceeded"} if attempt["status"] == "succeeded" else None


def on_dead_letter(db: Session, job: JobRow) -> None:
    """A dead ingest job fails its still-running attempt when a retry cannot help.

    A resource limit fails any source; a podcast transcript fails so a later request
    can admit a new attempt. Other sources keep the dead job for the repair offer.
    """
    attempt_id, media_id = UUID(job.payload["attempt_id"]), UUID(job.payload["media_id"])
    source_type = db.scalar(
        text("""SELECT source_type FROM media_source_attempts
            WHERE id = :attempt_id AND media_id = :media_id
              AND status IN ('accepted', 'queued', 'running')"""),
        {"attempt_id": attempt_id, "media_id": media_id},
    )
    resource = job.error_code == ApiErrorCode.E_RESOURCE_LIMIT.value
    if source_type is None or not (
        resource or source_type == source_types.PODCAST_EPISODE_TRANSCRIPT
    ):
        return
    assert job.error_code and job.last_error and job.execution_id  # a dead claim has all three
    message = job.last_error
    if resource:
        assert job.result is not None  # the worker records a resource failure's dimension
        message = _RESOURCE_LIMIT_MESSAGES[job.result["dimension"]]
    publish_source_attempt_failure(
        db,
        SourceAttemptFailure(
            media_id=media_id,
            attempt_id=attempt_id,
            failure_stage=source_attempt_failure_stage(source_type),
            error_code=queue_failure_code(job.error_code),
            error_message=message,
            now=db.scalar(text("SELECT clock_timestamp()")),
            execution_id=job.execution_id,
        ),
    )
