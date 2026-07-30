"""Worker job handler for exact-epoch Podcast subscription sync."""

from collections.abc import Mapping
from dataclasses import asdict
from typing import Any

from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext
from nexus.logging import get_logger
from nexus.services.podcasts.sync import run_podcast_subscription_sync_now

logger = get_logger(__name__)


def podcast_sync_subscription_job(
    *,
    payload: Mapping[str, Any],
    context: JobExecutionContext,
) -> dict:
    logger.info(
        "podcast_sync_task_started",
        job_id=str(context.job_id),
        attempt_no=context.attempt_no,
        subscription_id=str(payload.get("subscription_id")),
    )

    session_factory = get_session_factory()
    db = session_factory()
    try:
        result = asdict(
            run_podcast_subscription_sync_now(
                db,
                payload=payload,
                context=context,
            )
        )
        logger.info(
            "podcast_sync_task_completed",
            job_id=str(context.job_id),
            attempt_no=context.attempt_no,
            result=result,
        )
        return result
    finally:
        db.close()
