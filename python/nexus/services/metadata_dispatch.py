"""Best-effort metadata-enrichment job dispatch."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobRow, enqueue_job, enqueue_unique_job
from nexus.logging import get_logger

logger = get_logger(__name__)

_INITIAL_CAPACITY_WAIT_INDEX = 0
_MAX_ATTEMPTS = 2


def enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID | str,
    request_id: str | None,
    dedupe_key: str | None = None,
) -> tuple[JobRow, bool]:
    """Enqueue one canonical metadata job without committing its transaction."""
    payload = {
        "media_id": str(media_id),
        "request_id": request_id,
        "capacity_wait_index": _INITIAL_CAPACITY_WAIT_INDEX,
    }
    if dedupe_key is not None:
        return enqueue_unique_job(
            db,
            kind="enrich_metadata",
            payload=payload,
            dedupe_key=dedupe_key,
            max_attempts=_MAX_ATTEMPTS,
        )
    return (
        enqueue_job(
            db,
            kind="enrich_metadata",
            payload=payload,
            max_attempts=_MAX_ATTEMPTS,
        ),
        True,
    )


def try_enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID | str,
    request_id: str | None,
) -> bool:
    """Best-effort enqueue on a fresh post-publication session.

    Metadata enrichment is a soft post-ingest enhancement. A queue insert failure
    must not undo an otherwise-readable media capture. Callers therefore provide
    a dedicated session only after publication has committed; an enqueue failure
    may safely roll back that whole short transaction.
    """
    if db.in_transaction():
        raise AssertionError(
            "metadata enrichment requires a fresh dedicated post-publication session"
        )
    media_ref = str(media_id)
    try:
        enqueue_metadata_enrichment(
            db,
            media_id=media_ref,
            request_id=request_id,
        )
        return True
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning(
            "metadata_enrichment_enqueue_failed",
            media_id=media_ref,
            error=str(exc),
        )
        return False
