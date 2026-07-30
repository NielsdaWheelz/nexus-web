"""Daily bounded retention for terminal Podcast refresh runs."""

from nexus.db.session import get_session_factory
from nexus.services.podcasts.refresh import prune_terminal_refresh_runs


def podcast_refresh_run_prune_job() -> dict:
    with get_session_factory()() as db:
        return {"deleted_run_count": prune_terminal_refresh_runs(db)}
