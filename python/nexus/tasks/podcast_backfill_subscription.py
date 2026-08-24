"""Worker adapter for one durable Podcast subscription backfill step."""

from collections.abc import Mapping
from typing import Any

from nexus.db.session import get_session_factory
from nexus.jobs.queue import JobExecutionContext
from nexus.services.podcasts.backfill import run_backfill_step


def podcast_backfill_subscription(
    *,
    payload: Mapping[str, Any],
    context: JobExecutionContext,
) -> dict[str, Any]:
    db = get_session_factory()()
    try:
        return run_backfill_step(db, payload=payload, context=context)
    finally:
        db.close()
