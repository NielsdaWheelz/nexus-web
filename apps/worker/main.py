"""Celery worker entrypoint.

Run with: celery -A apps.worker.main:celery_app worker -Q ingest --concurrency=1 --loglevel=info

This module imports the Celery app and explicitly registers all tasks.
Task definitions are in nexus.tasks package - no autodiscovery.

Logging Convention:
- All task log entries include request_id, task_name, task_id when available
- Tasks accept `request_id: str | None = None` parameter for correlation
- Use configure_task_logging() at the start of each task to set up context

Queue Configuration:
- ingest: Web article ingestion tasks (Playwright + Node.js)
- default: General background tasks

Concurrency Notes:
- Start with --concurrency=1 for ingest queue due to Chromium memory cost
- Scale by running multiple workers on separate machines/containers
"""

from celery.signals import worker_process_init

from nexus.celery import celery_app
from nexus.celery_contract import REQUIRED_WORKER_TASK_NAMES, TASK_CONTRACT_VERSION
from nexus.logging import configure_logging, get_logger

# =============================================================================
# Task Registration (explicit imports - no autodiscovery)
# =============================================================================
# Import tasks to register them with Celery
# Each import registers the task with the celery_app
from nexus.tasks import (
    backfill_default_library_closure_job,  # noqa: F401
    ingest_epub,  # noqa: F401
    ingest_pdf,  # noqa: F401
    ingest_web_article,  # noqa: F401
    ingest_youtube_video,  # noqa: F401
    podcast_active_subscription_poll_job,  # noqa: F401
    podcast_sync_subscription_job,  # noqa: F401
    reconcile_stale_ingest_media_job,  # noqa: F401
)

REQUIRED_TASK_NAMES = set(REQUIRED_WORKER_TASK_NAMES)


def _assert_required_task_registration() -> None:
    registered = set(celery_app.tasks.keys())
    missing = sorted(REQUIRED_TASK_NAMES - registered)
    if missing:
        raise RuntimeError(
            "Celery worker startup aborted: missing task registrations "
            f"{', '.join(missing)}. Ensure nexus.tasks imports are complete."
        )


_assert_required_task_registration()

# =============================================================================
# Worker Lifecycle
# =============================================================================


@worker_process_init.connect
def setup_worker_logging(**kwargs):
    """Configure structlog when worker process starts.

    This ensures all Celery worker logs use the same JSON structured format
    as the FastAPI application, with consistent fields:
    - timestamp
    - level
    - message
    - request_id (when available)
    - task_name (when available)
    - task_id (when available)
    """
    configure_logging()
    logger = get_logger(__name__)
    logger.info(
        "celery_worker_started",
        queue="ingest",
        task_contract_version=TASK_CONTRACT_VERSION,
    )


# Export celery_app for Celery to find
# Command: celery -A apps.worker.main:celery_app worker ...
__all__ = ["celery_app"]
