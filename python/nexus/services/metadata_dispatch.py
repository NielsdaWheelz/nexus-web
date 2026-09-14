"""Best-effort metadata-enrichment job dispatch."""

from __future__ import annotations

from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger

logger = get_logger(__name__)


def try_enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID | str,
    request_id: str | None,
) -> bool:
    """Enqueue metadata enrichment on the caller's session.

    Metadata enrichment is a soft post-ingest enhancement. A queue insert failure
    must not undo an otherwise-readable media capture, so the insert is isolated
    behind a savepoint and failures are logged rather than raised.
    """
    media_ref = str(media_id)
    try:
        with db.begin_nested():
            enqueue_job(
                db,
                kind="enrich_metadata",
                payload={"media_id": media_ref, "request_id": request_id},
                max_attempts=1,
            )
        return True
    except SQLAlchemyError as exc:
        logger.warning(
            "metadata_enrichment_enqueue_failed",
            media_id=media_ref,
            error=str(exc),
        )
        return False
