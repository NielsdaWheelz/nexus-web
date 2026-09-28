"""Metadata-enrichment job admission and enqueue."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs.queue import enqueue_job, enqueue_unique_job, lock_jobs_for_payload
from nexus.logging import get_logger
from nexus.services.durable_step_journal import Uncertain, decode_step_states
from nexus.services.media_processing_state import is_metadata_enrichment_eligible

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


def retry_metadata_for_viewer(
    db: Session, viewer_id: UUID, media_id: UUID, *, request_id: str | None
) -> dict:
    """Enqueue LLM metadata re-enrichment for the creator's media."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "Only the creator can re-enrich metadata.")
    if not is_metadata_enrichment_eligible(
        kind=media.kind, processing_status=media.processing_status
    ):
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Media must be readable or pending audio/video before metadata can be re-enriched.",
        )

    jobs = lock_jobs_for_payload(
        db, kind="enrich_metadata", expected_payload_match={"media_id": str(media_id)}
    )
    if any(
        (state := decode_step_states(job.payload).get(METADATA_STEP_PATH)) is not None
        and state.dispatch_phase is Uncertain
        for job in jobs
    ):
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Metadata enrichment has an unresolved generation turn.",
        )
    if any(job.status in {"pending", "running"} for job in jobs):
        raise ConflictError(
            ApiErrorCode.E_RETRY_NOT_ALLOWED, "Metadata enrichment is already in progress."
        )

    enqueue_metadata_enrichment(
        db, media_id=media.id, requester_user_id=viewer_id, request_id=request_id
    )
    db.commit()
    return {
        "media_id": str(media.id),
        "processing_status": media.processing_status.value,
        "metadata_enrichment_enqueued": True,
    }
