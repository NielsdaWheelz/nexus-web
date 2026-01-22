"""Celery worker entrypoint.

Run with: celery -A apps.worker.main worker --loglevel=info

This module creates and configures the Celery application with structured logging.
Task definitions will be added in future PRs (S1 PR-05).

Logging Convention:
- All task log entries include request_id, task_name, task_id when available
- Tasks accept `request_id: str | None = None` parameter for correlation
- Use configure_task_logging() at the start of each task to set up context
"""

from celery import Celery
from celery.signals import worker_process_init

from nexus.config import get_settings
from nexus.logging import configure_logging, get_logger

settings = get_settings()

# Create Celery app
app = Celery("nexus")

# Configure from settings
app.conf.broker_url = settings.effective_celery_broker_url
app.conf.result_backend = settings.effective_celery_result_backend

# Task configuration
app.conf.task_serializer = "json"
app.conf.result_serializer = "json"
app.conf.accept_content = ["json"]
app.conf.timezone = "UTC"
app.conf.enable_utc = True

# Task autodiscovery - empty for S1; tasks will be added in S1 PR-05
# app.autodiscover_tasks(['nexus.tasks'])

# For testing: allow eager mode
app.conf.task_always_eager = False


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
    logger.info("celery_worker_started")
