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

from nexus.celery_contract import build_beat_schedule, build_task_routes
from nexus.config import get_settings

settings = get_settings()

# Create Celery app
celery_app = Celery("nexus")

# Configure from settings
celery_app.conf.broker_url = settings.effective_celery_broker_url
celery_app.conf.result_backend = settings.effective_celery_result_backend

# Celery requires explicit SSL config for rediss:// URLs
if settings.effective_celery_broker_url.startswith("rediss://"):
    import ssl

    celery_app.conf.broker_use_ssl = {"ssl_cert_reqs": ssl.CERT_REQUIRED}
    celery_app.conf.redis_backend_use_ssl = {"ssl_cert_reqs": ssl.CERT_REQUIRED}

# Task configuration
celery_app.conf.task_serializer = "json"
celery_app.conf.result_serializer = "json"
celery_app.conf.accept_content = ["json"]
celery_app.conf.timezone = "UTC"
celery_app.conf.enable_utc = True

# Queue routing for ingestion tasks
celery_app.conf.task_routes = build_task_routes()

celery_app.conf.beat_schedule = build_beat_schedule(settings)

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
    from nexus.db import session as session_mod
    from nexus.db.engine import get_engine  # noqa: F811

    get_engine.cache_clear()
    session_mod._SessionLocal = None


def get_celery_app() -> Celery:
    """Get the Celery application instance.

    Returns:
        Configured Celery application.
    """
    return celery_app
