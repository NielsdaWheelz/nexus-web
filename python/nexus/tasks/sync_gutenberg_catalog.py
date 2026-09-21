"""Worker task for refreshing the local Project Gutenberg catalog mirror."""

from typing import Any

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.gutenberg import sync_project_gutenberg_catalog

logger = get_logger(__name__)


def sync_gutenberg_catalog_job(request_id: str, scheduler_identity: str) -> dict[str, Any]:
    db = get_session_factory()()
    try:
        result = sync_project_gutenberg_catalog(db)
    finally:
        db.close()
    logger.info(
        "gutenberg_catalog_sync_completed",
        request_id=request_id,
        scheduler_identity=scheduler_identity,
        result=result,
    )
    return result
