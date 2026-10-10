"""Terminal episode transcription failure. The worker supervisor imports it: no provider."""

from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode
from nexus.services.media_processing_state import mark_media_failed_by_id
from nexus.services.transcripts.state import set_media_transcript_state


@dataclass(frozen=True)
class PodcastTranscriptionFailure:
    media_id: UUID
    error_code: str
    error_message: str
    now: datetime


def publish_podcast_transcription_failure(
    db: Session, failure: PodcastTranscriptionFailure
) -> None:
    """Media failed, the job failed, the transcript ``unavailable`` or ``failed_provider``
    (which a later request may retry)."""
    mark_media_failed_by_id(
        db,
        media_id=failure.media_id,
        stage="transcribe",
        error_code=failure.error_code,
        error_message=failure.error_message[:1000],
        now=failure.now,
    )
    db.execute(
        text("""
            UPDATE podcast_transcription_jobs
            SET status = 'failed', error_code = :code, completed_at = :now, updated_at = :now
            WHERE media_id = :id
        """),
        {"id": failure.media_id, "code": failure.error_code, "now": failure.now},
    )
    unavailable = failure.error_code == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value
    set_media_transcript_state(
        db,
        media_id=failure.media_id,
        transcript_state="unavailable" if unavailable else "failed_provider",
        transcript_coverage="none",
        last_error_code=failure.error_code,
        now=failure.now,
    )
