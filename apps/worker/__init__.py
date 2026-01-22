"""Celery worker package.

Export the Celery app for the celery CLI command.
Run with: celery -A apps.worker worker --loglevel=info
"""

from apps.worker.main import app as celery_app

__all__ = ["celery_app"]
