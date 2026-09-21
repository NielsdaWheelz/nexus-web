"""Terminal failure publication for durable media source attempts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, ResourceFailureDimension
from nexus.schemas.import_history import SourceFailed, assume_safe_failure_code
from nexus.schemas.presence import Presence, present
from nexus.services import media_source_types as source_types
from nexus.services.import_history import append_processing_event
from nexus.services.media_fact_revisions import bump_all_media_fact_collections
from nexus.services.media_processing_state import MediaFailureStage, mark_media_failed_by_id
from nexus.services.podcasts.transcription_failure import (
    PodcastTranscriptionFailure,
    publish_podcast_transcription_failure,
)
from nexus.services.source_history import source_failure_progress, source_history_stage
from nexus.services.transcripts.state import set_media_transcript_state

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
    retry_after_seconds: int | None
    now: datetime
    execution_id: Presence[UUID]
    """The worker execution that observed the failure; Absent when the failure
    was published outside any execution (acceptance or enqueue time)."""


@dataclass(frozen=True)
class ResourceLimitedSourceAttempt:
    media_id: UUID
    attempt_id: UUID
    dimension: ResourceFailureDimension
    execution_id: Presence[UUID]


def source_attempt_failure_stage(source_type: str) -> MediaFailureStage:
    """The one Media failure stage owned by a source type."""
    if source_type in source_types.TRANSCRIPT_SOURCE_TYPES:
        return "transcribe"
    return "extract"


def publish_resource_limited_source_attempt(
    db: Session, command: ResourceLimitedSourceAttempt
) -> str:
    """Publish a bounded child resource failure and return its queue-safe message."""
    message = _RESOURCE_LIMIT_MESSAGES[command.dimension]
    now = db.execute(text("SELECT clock_timestamp()")).scalar_one()
    source_type = db.execute(
        text("SELECT source_type FROM media_source_attempts WHERE id = :attempt_id"),
        {"attempt_id": command.attempt_id},
    ).scalar_one()
    publish_source_attempt_failure(
        db,
        SourceAttemptFailure(
            media_id=command.media_id,
            attempt_id=command.attempt_id,
            failure_stage=source_attempt_failure_stage(str(source_type)),
            error_code=ApiErrorCode.E_RESOURCE_LIMIT.value,
            error_message=message,
            retry_after_seconds=None,
            now=now,
            execution_id=command.execution_id,
        ),
    )
    return message


def publish_source_attempt_failure(db: Session, failure: SourceAttemptFailure) -> None:
    """Settle one attempt and publish all of its terminal domain projections.

    The media row and the attempt are locked first: the attempt's ``error_code``
    and the media's ``last_error_code`` are written in this one transaction and
    must never disagree.
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
                    retry_after_seconds = :retry_after_seconds,
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
                "retry_after_seconds": failure.retry_after_seconds,
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
        stage=present(
            source_history_stage(
                source_type=source_type, processing_stage=attempt["processing_stage"]
            )
        ),
        failure_code=present(assume_safe_failure_code(failure.error_code)),
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
            semantic_status="failed",
            last_request_reason=None,
            last_error_code=failure.error_code,
            now=failure.now,
        )
    bump_all_media_fact_collections(db)
