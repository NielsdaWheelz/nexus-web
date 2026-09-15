"""Best-effort metadata-enrichment job dispatch."""

from __future__ import annotations

from functools import cache
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.jobs.queue import enqueue_job, enqueue_unique_job
from nexus.logging import get_logger

logger = get_logger(__name__)

# The one durable step path of the billed-once metadata turn (spec §7). The job
# owner writes checkpoints under it and the retry lifecycle reads them.
METADATA_STEP_PATH = "codex/metadata"


@cache
def _metadata_max_attempts() -> int:
    """Resolve the registry's attempt budget for ``enrich_metadata`` once."""
    # Deferred registry import (same shape as content_indexing and
    # media_content_reindex): nexus.jobs.registry's enrich_metadata handler
    # imports nexus.tasks.enrich_metadata, which imports this module, so the two
    # are mutually dependent and each side resolves the other at call time
    # rather than at import time. The cache above keeps that resolution to one
    # lookup per process instead of one per enqueue.
    from nexus.jobs.registry import get_default_registry

    return get_default_registry()["enrich_metadata"].max_attempts


def enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID | str,
    requester_user_id: UUID,
    request_id: str | None,
    dedupe_key: str | None = None,
) -> bool:
    """Enqueue one canonical metadata job without committing its transaction."""
    payload = {
        "media_id": str(media_id),
        "requester_user_id": str(requester_user_id),
        "request_id": request_id,
    }
    max_attempts = _metadata_max_attempts()
    if dedupe_key is not None:
        _, inserted = enqueue_unique_job(
            db,
            kind="enrich_metadata",
            payload=payload,
            dedupe_key=dedupe_key,
            max_attempts=max_attempts,
        )
        return inserted
    enqueue_job(
        db,
        kind="enrich_metadata",
        payload=payload,
        max_attempts=max_attempts,
    )
    return True


def try_enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID | str,
    requester_user_id: UUID,
    request_id: str | None,
) -> bool:
    """Best-effort enqueue on a fresh post-publication session.

    Metadata enrichment is a soft post-ingest enhancement. A queue insert failure
    must not undo an otherwise-readable media capture. Callers therefore provide
    a dedicated session only after publication has committed; an enqueue failure
    may safely roll back that whole short transaction.
    """
    # justify-service-invariant-check: whether the caller's session already
    # opened a transaction is runtime session state, not expressible in types.
    if db.in_transaction():
        raise AssertionError(
            "metadata enrichment requires a fresh dedicated post-publication session"
        )
    media_ref = str(media_id)
    try:
        enqueue_metadata_enrichment(
            db,
            media_id=media_ref,
            requester_user_id=requester_user_id,
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
