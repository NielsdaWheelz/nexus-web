"""Periodic bounded admission of due Podcast subscription generations."""

from dataclasses import asdict

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.services.podcasts.refresh import admit_due_refresh_runs


def podcast_refresh_due_job() -> dict:
    settings = get_settings()
    with get_session_factory()() as db:
        return asdict(
            admit_due_refresh_runs(
                db,
                limit=settings.podcast_refresh_due_limit,
            )
        )
