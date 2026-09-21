"""Terminal Podcast transcription failure publication."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode
from nexus.services.media_fact_revisions import bump_all_media_fact_collections
from nexus.services.media_processing_state import mark_media_failed_by_id
from nexus.services.transcripts.state import set_media_transcript_state

from .transcription_usage import release_transcription_reservation

_TRANSCRIPT_STATE_BY_ERROR = {
    ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value: "unavailable",
    ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED.value: "failed_quota",
}


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
    """Settle Media, job, reservation, transcript state and collections once."""
    mark_media_failed_by_id(
        db,
        media_id=failure.media_id,
        stage="transcribe",
        error_code=failure.error_code,
        error_message=failure.error_message[:1000],
        now=failure.now,
    )
    db.execute(
        text(
            """
            UPDATE podcast_transcription_jobs
            SET status = 'failed',
                error_code = :error_code,
                completed_at = :now,
                updated_at = :now
            WHERE media_id = :media_id
            """
        ),
        {"media_id": failure.media_id, "error_code": failure.error_code, "now": failure.now},
    )
    release_transcription_reservation(db, media_id=failure.media_id, now=failure.now)
    set_media_transcript_state(
        db,
        media_id=failure.media_id,
        transcript_state=_TRANSCRIPT_STATE_BY_ERROR.get(failure.error_code, "failed_provider"),
        transcript_coverage="none",
        semantic_status="none",
        last_error_code=failure.error_code,
        now=failure.now,
    )
    bump_all_media_fact_collections(db)
