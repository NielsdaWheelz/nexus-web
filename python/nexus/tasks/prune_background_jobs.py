"""Operator-safe pruning for terminal background job rows."""

from __future__ import annotations

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.jobs.queue import prune_terminal_jobs
from nexus.jobs.registry import get_default_registry
from nexus.logging import get_logger

logger = get_logger(__name__)


def prune_background_jobs_job(request_id: str | None = None) -> dict[str, int]:
    settings = get_settings()
    excluded_dead_kinds = {
        definition.kind
        for definition in get_default_registry().values()
        if definition.never_prune_dead
    }

    session_factory = get_session_factory()
    with session_factory() as db:
        deleted = prune_terminal_jobs(
            db,
            succeeded_after_days=settings.background_job_prune_succeeded_after_days,
            dead_after_days=settings.background_job_prune_dead_after_days,
            limit=settings.background_job_prune_batch_size,
            excluded_dead_kinds=excluded_dead_kinds,
        )
        db.commit()

    logger.info(
        "background_jobs_pruned",
        deleted_count=deleted,
        request_id=request_id,
    )
    return {"deleted_count": deleted}
