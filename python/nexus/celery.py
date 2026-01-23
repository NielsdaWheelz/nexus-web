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
}

# Default queue
celery_app.conf.task_default_queue = "default"

# For testing: allow eager mode (synchronous execution)
celery_app.conf.task_always_eager = False


def get_celery_app() -> Celery:
    """Get the Celery application instance.

    Returns:
        Configured Celery application.
    """
    return celery_app
