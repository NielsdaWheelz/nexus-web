"""Celery application configuration.

Central configuration for Celery used by both API (for enqueuing)
and worker (for executing tasks).

Usage:
    from nexus.celery import celery_app

    # Enqueue task:
    celery_app.send_task("ingest_web_article", args=[media_id, actor_user_id])

    # Or import task directly:
    from nexus.tasks import ingest_web_article
    ingest_web_article.apply_async(args=[media_id, actor_user_id], queue="ingest")
"""

from celery import Celery
from celery.signals import worker_process_init

from nexus.config import get_settings

settings = get_settings()

# Create Celery app
celery_app = Celery("nexus")

# Configure from settings
celery_app.conf.broker_url = settings.effective_celery_broker_url
celery_app.conf.result_backend = settings.effective_celery_result_backend

# Task configuration
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]
celery_app.conf.timezone = "UTC"
celery_app.conf.enable_utc = True

# Queue routing for ingestion tasks
celery_app.conf.task_routes = {
    "nexus.tasks.ingest_web_article.*": {"queue": "ingest"},
    "ingest_epub": {"queue": "ingest"},
    "backfill_default_library_closure_job": {"queue": "ingest"},
    "podcast_sync_subscription_job": {"queue": "ingest"},
    "podcast_active_subscription_poll_job": {"queue": "ingest"},
}

celery_app.conf.beat_schedule = {
    "podcast_active_subscription_poll": {
        "task": "podcast_active_subscription_poll_job",
        "schedule": float(settings.podcast_active_poll_schedule_seconds),
        "options": {"queue": "ingest"},
    }
}

# Default queue
celery_app.conf.task_default_queue = "default"

# For testing: allow eager mode (synchronous execution)
celery_app.conf.task_always_eager = False


@worker_process_init.connect
def _reset_db_on_fork(**kwargs):
    """Dispose inherited DB engine after Celery prefork.

    The parent process may have created a SQLAlchemy engine (and its
    connection pool) before fork().  libpq connections are not fork-safe,
    so each child must create its own.  Clearing the lru_cache and the
    session-factory singleton forces lazy re-creation on first use.
    """
    from nexus.db.engine import get_engine  # noqa: F811
    from nexus.db import session as session_mod

    get_engine.cache_clear()
    session_mod._SessionLocal = None


def get_celery_app() -> Celery:
    """Get the Celery application instance.

    Returns:
        Configured Celery application.
    """
    return celery_app
