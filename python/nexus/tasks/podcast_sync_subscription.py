"""Worker job handler for podcast subscription sync data-plane ingestion."""

from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.podcasts import (
    run_podcast_subscription_sync_now as run_podcast_subscription_sync_now_service,
)

logger = get_logger(__name__)


def podcast_sync_subscription_job(
    user_id: str,
    podcast_id: str,
    request_id: str | None = None,
    task_id: str | None = None,
) -> dict:
    user_uuid = UUID(user_id)
    podcast_uuid = UUID(podcast_id)
    resolved_task_id = task_id or f"direct:{podcast_id}"

    logger.info(
        "podcast_sync_task_started",
        user_id=user_id,
        podcast_id=podcast_id,
        request_id=request_id,
        task_id=resolved_task_id,
    )

    session_factory = get_session_factory()
    db = session_factory()
    try:
        result = run_podcast_subscription_sync_now(
            db,
            user_id=user_uuid,
            podcast_id=podcast_uuid,
            request_id=request_id,
        )
        logger.info(
            "podcast_sync_task_completed",
            user_id=user_id,
            podcast_id=podcast_id,
            request_id=request_id,
            result=result,
            task_id=resolved_task_id,
        )
        return result
    finally:
        db.close()


def run_podcast_subscription_sync_now(
    db,
    *,
    user_id: UUID,
    podcast_id: UUID,
    request_id: str | None = None,
) -> dict:
    """Synchronous helper used by integration tests."""
    return run_podcast_subscription_sync_now_service(
        db,
        user_id=user_id,
        podcast_id=podcast_id,
        request_id=request_id,
    )
