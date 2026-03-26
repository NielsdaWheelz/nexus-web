"""Worker job handler for scheduled active podcast subscription polling."""

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.podcasts import (
    run_scheduled_active_subscription_poll as run_scheduled_active_subscription_poll_service,
)

logger = get_logger(__name__)


def podcast_active_subscription_poll_job(
    request_id: str | None = None,
    scheduler_identity: str | None = None,
) -> dict:
    settings = get_settings()
    resolved_scheduler_identity = scheduler_identity or f"worker:{request_id or 'periodic'}"
    logger.info(
        "podcast_active_poll_task_started",
        task_id=resolved_scheduler_identity,
        request_id=request_id,
        scheduler_identity=resolved_scheduler_identity,
        run_limit=settings.podcast_active_poll_limit,
    )

    session_factory = get_session_factory()
    db = session_factory()
    try:
        result = run_podcast_active_subscription_poll_now(
            db,
            limit=settings.podcast_active_poll_limit,
            run_lease_seconds=settings.podcast_active_poll_run_lease_seconds,
            scheduler_identity=resolved_scheduler_identity,
        )
        logger.info(
            "podcast_active_poll_task_completed",
            task_id=resolved_scheduler_identity,
            request_id=request_id,
            scheduler_identity=resolved_scheduler_identity,
            result=result,
        )
        return result
    finally:
        db.close()


def run_podcast_active_subscription_poll_now(
    db,
    *,
    limit: int,
    run_lease_seconds: int,
    scheduler_identity: str | None,
) -> dict:
    """Synchronous helper used by integration tests."""
    settings = get_settings()
    return run_scheduled_active_subscription_poll_service(
        db,
        limit=limit,
        run_lease_seconds=run_lease_seconds,
        sync_lease_seconds=settings.podcast_sync_running_lease_seconds,
        scheduler_identity=scheduler_identity,
    )
