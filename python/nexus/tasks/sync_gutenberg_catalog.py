"""Worker task for refreshing the local Project Gutenberg catalog mirror."""

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.gutenberg import sync_project_gutenberg_catalog

logger = get_logger(__name__)


def sync_gutenberg_catalog_job(
    request_id: str | None = None,
    scheduler_identity: str | None = None,
) -> dict:
    resolved_scheduler_identity = scheduler_identity or f"worker:{request_id or 'periodic'}"
    logger.info(
        "gutenberg_catalog_sync_started",
        request_id=request_id,
        scheduler_identity=resolved_scheduler_identity,
    )

    session_factory = get_session_factory()
    db = session_factory()
    try:
        result = sync_project_gutenberg_catalog(db)
        logger.info(
            "gutenberg_catalog_sync_completed",
            request_id=request_id,
            scheduler_identity=resolved_scheduler_identity,
            result=result,
        )
        return result
    finally:
        db.close()
