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
from nexus.logging import configure_logging, get_logger

# =============================================================================
# Task Registration (explicit imports - no autodiscovery)
# =============================================================================

# Import tasks to register them with Celery
# Each import registers the task with the celery_app
from nexus.tasks import ingest_web_article  # noqa: F401

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
    logger.info("celery_worker_started", queue="ingest")


# Export celery_app for Celery to find
# Command: celery -A apps.worker.main:celery_app worker ...
__all__ = ["celery_app"]
