"""Periodic bounded admission of due Podcast subscription generations."""

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.services.podcasts.refresh import admit_due_subscriptions


def podcast_refresh_due_job() -> dict:
    with get_session_factory()() as db:
        return {
            "subscription_count": admit_due_subscriptions(
                db, limit=get_settings().podcast_refresh_due_limit
            )
        }
