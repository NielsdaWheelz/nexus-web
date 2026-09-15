"""Terminal Podcast transcription failure publication owner."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode
from nexus.services.media_fact_revisions import bump_all_media_fact_collections
from nexus.services.media_failure_projection import mark_media_failed_by_id
from nexus.services.transcripts.state import set_media_transcript_state

from .transcription_reservation_settlement import release_transcription_reservation


@dataclass(frozen=True)
class PodcastTranscriptionFailure:
    media_id: UUID
    error_code: str
    error_message: str
    now: datetime


def publish_podcast_transcription_failure(
    db: Session,
    failure: PodcastTranscriptionFailure,
) -> None:
    """Settle Media, job, reservation, transcript, and collection facts once."""
    if failure.error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value:
        transcript_state = "unavailable"
    elif failure.error_code == ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value:
        transcript_state = "failed_quota"
    else:
        transcript_state = "failed_provider"

    mark_media_failed_by_id(
        db,
        media_id=failure.media_id,
        stage="transcribe",
        error_code=failure.error_code,
        error_message=failure.error_message[:1000],
        now=failure.now,
    )
    updated_job = db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET
                status = 'failed',
                error_code = :error_code,
                completed_at = :now,
                updated_at = :now
            WHERE media_id = :media_id
            RETURNING media_id
            """
        ),
        {
            "media_id": failure.media_id,
            "error_code": failure.error_code,
            "now": failure.now,
        },
    ).one_or_none()
    if updated_job is None:
        raise AssertionError("Podcast transcript failure has no transcription job")
    release_transcription_reservation(
        db,
        media_id=failure.media_id,
        now=failure.now,
    )
    set_media_transcript_state(
        db,
        media_id=failure.media_id,
        transcript_state=transcript_state,
        transcript_coverage="none",
        semantic_status="none",
        last_error_code=failure.error_code,
        now=failure.now,
    )
    bump_all_media_fact_collections(db)
