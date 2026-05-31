"""Worker job handler for podcast episode transcription jobs."""

from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services.podcasts.transcripts import run_podcast_transcription_now

logger = get_logger(__name__)


def podcast_transcribe_episode_job(
    media_id: str,
    requested_by_user_id: str | None = None,
    request_id: str | None = None,
    task_id: str | None = None,
) -> dict:
    resolved_task_id = task_id or f"direct:{media_id}"
    try:
        media_uuid = UUID(media_id)
    except (TypeError, ValueError):
        logger.error(
            "podcast_transcription_task_invalid_media_id",
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_id=request_id,
            task_id=resolved_task_id,
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INVALID_REQUEST.value}

    try:
        requested_by_uuid = UUID(requested_by_user_id) if requested_by_user_id else None
    except (TypeError, ValueError):
        logger.error(
            "podcast_transcription_task_invalid_requested_by_user_id",
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_id=request_id,
            task_id=resolved_task_id,
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INVALID_REQUEST.value}

    logger.info(
        "podcast_transcription_task_started",
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_id=request_id,
        task_id=resolved_task_id,
    )

    session_factory = get_session_factory()
    db = session_factory()
    try:
        result = run_podcast_transcription_now(
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
            task_id=resolved_task_id,
        )
        return result
    finally:
        db.close()
