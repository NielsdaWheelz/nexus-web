"""Celery task for podcast episode transcription jobs."""

from uuid import UUID

from nexus.celery import celery_app
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services import podcasts as podcast_service

logger = get_logger(__name__)


@celery_app.task(bind=True, max_retries=0, name="podcast_transcribe_episode_job")
def podcast_transcribe_episode_job(
    self,
    media_id: str,
    requested_by_user_id: str | None = None,
    request_id: str | None = None,
) -> dict:
    try:
        media_uuid = UUID(media_id)
    except (TypeError, ValueError):
        logger.error(
            "podcast_transcription_task_invalid_media_id",
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_id=request_id,
            task_id=self.request.id,
        )
        return {"status": "failed", "error_code": "E_INVALID_REQUEST"}

    try:
        requested_by_uuid = UUID(requested_by_user_id) if requested_by_user_id else None
    except (TypeError, ValueError):
        logger.warning(
            "podcast_transcription_task_invalid_requested_by_user_id",
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_id=request_id,
            task_id=self.request.id,
        )
        requested_by_uuid = None

    logger.info(
        "podcast_transcription_task_started",
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_id=request_id,
        task_id=self.request.id,
    )

    session_factory = get_session_factory()
    db = session_factory()
    try:
        result = podcast_service.run_podcast_transcription_now(
            db,
            media_id=media_uuid,
            requested_by_user_id=requested_by_uuid,
            request_id=request_id,
        )
        logger.info(
            "podcast_transcription_task_completed",
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_id=request_id,
            result=result,
            task_id=self.request.id,
        )
        return result
    finally:
        db.close()


def run_podcast_transcribe_now(
    db,
    *,
    media_id: UUID,
    requested_by_user_id: UUID | None,
    request_id: str | None = None,
) -> dict:
    """Synchronous helper used by integration tests."""
    return podcast_service.run_podcast_transcription_now(
        db,
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_id=request_id,
    )
