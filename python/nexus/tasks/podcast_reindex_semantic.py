"""Worker job handler for podcast transcript semantic reindex repair."""

from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services import podcasts as podcast_service

logger = get_logger(__name__)


def podcast_reindex_semantic_job(
    media_id: str,
    requested_by_user_id: str | None = None,
    request_reason: str = "operator_requeue",
    request_id: str | None = None,
    task_id: str | None = None,
) -> dict:
    resolved_task_id = task_id or f"direct:{media_id}"
    try:
        media_uuid = UUID(media_id)
    except (TypeError, ValueError):
        logger.error(
            "podcast_semantic_repair_invalid_media_id",
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_reason=request_reason,
            request_id=request_id,
            task_id=resolved_task_id,
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INVALID_REQUEST.value}

    logger.info(
        "podcast_semantic_repair_task_started",
        media_id=media_id,
        requested_by_user_id=requested_by_user_id,
        request_reason=request_reason,
        request_id=request_id,
        task_id=resolved_task_id,
    )
    session_factory = get_session_factory()
    db = session_factory()
    try:
        result = podcast_service.repair_podcast_transcript_semantic_index_now(
            db,
            media_id=media_uuid,
            request_reason=request_reason,
            request_id=request_id,
        )
        db.commit()
        logger.info(
            "podcast_semantic_repair_task_completed",
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_reason=request_reason,
            request_id=request_id,
            result=result,
            task_id=resolved_task_id,
        )
        return result
    except Exception as exc:
        db.rollback()
        logger.exception(
            "podcast_semantic_repair_task_failed",
            media_id=media_id,
            requested_by_user_id=requested_by_user_id,
            request_reason=request_reason,
            request_id=request_id,
            task_id=resolved_task_id,
            error=str(exc),
        )
        return {"status": "failed", "error_code": ApiErrorCode.E_INTERNAL.value}
    finally:
        db.close()
