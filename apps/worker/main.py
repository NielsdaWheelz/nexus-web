"""Celery worker entrypoint.

Run with: celery -A apps.worker.main worker --loglevel=info

This module creates and configures the Celery application.
Task definitions will be added in future PRs (S1 PR-05).
"""

from celery import Celery

from nexus.config import get_settings

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
