"""Metadata-enrichment job dispatch."""

from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.jobs.queue import enqueue_job, enqueue_unique_job
from nexus.logging import get_logger

logger = get_logger(__name__)

# The one durable step path of the billed-once metadata turn.
METADATA_STEP_PATH = "codex/metadata"


def enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID | str,
    requester_user_id: UUID,
    request_id: str | None,
    dedupe_key: str | None = None,
) -> bool:
    """Enqueue one metadata job in the caller's transaction; unique when keyed."""
    # The registry's handler imports this module: resolve it at call time.
    from nexus.jobs.registry import get_default_registry

    payload = {
        "media_id": str(media_id),
        "requester_user_id": str(requester_user_id),
        "request_id": request_id,
    }
    attempts = get_default_registry()["enrich_metadata"].max_attempts
    if dedupe_key is None:
        enqueue_job(db, kind="enrich_metadata", payload=payload, max_attempts=attempts)
        return True
    _, inserted = enqueue_unique_job(
        db,
        kind="enrich_metadata",
        payload=payload,
        dedupe_key=dedupe_key,
        max_attempts=attempts,
    )
    return inserted


def try_enqueue_metadata_enrichment(
    db: Session, *, media_id: UUID | str, requester_user_id: UUID, request_id: str | None
) -> bool:
    """Best-effort enqueue: a queue failure must not undo a readable capture."""
    try:
        enqueue_metadata_enrichment(
            db, media_id=media_id, requester_user_id=requester_user_id, request_id=request_id
        )
        return True
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("metadata_enrichment_enqueue_failed", media_id=str(media_id), error=str(exc))
        return False
