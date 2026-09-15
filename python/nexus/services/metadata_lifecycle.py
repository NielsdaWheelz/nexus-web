"""Metadata enrichment retry lifecycle orchestration."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs.queue import lock_jobs_for_payload
from nexus.services.durable_step_journal import Uncertain, decode_step_states
from nexus.services.media_processing_state import is_metadata_enrichment_eligible
from nexus.services.metadata_dispatch import METADATA_STEP_PATH, enqueue_metadata_enrichment


def retry_metadata_for_viewer(
    db: Session,
    viewer_id: UUID,
    media_id: UUID,
    *,
    request_id: str | None = None,
) -> dict:
    """Enqueue LLM metadata re-enrichment for the viewer's media."""
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media = db.execute(select(Media).where(Media.id == media_id).with_for_update()).scalar()
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    if media.created_by_user_id != viewer_id:
        raise ForbiddenError(
            ApiErrorCode.E_FORBIDDEN,
            "Only the creator can re-enrich metadata.",
        )

    if not is_metadata_enrichment_eligible(
        kind=media.kind, processing_status=media.processing_status
    ):
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Media must be readable or pending audio/video before metadata can be re-enriched.",
        )

    jobs = lock_jobs_for_payload(
        db,
        kind="enrich_metadata",
        expected_payload_match={"media_id": str(media_id)},
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
            ApiErrorCode.E_RETRY_NOT_ALLOWED,
            "Metadata enrichment is already in progress.",
        )

    enqueue_metadata_enrichment(
        db,
        media_id=media.id,
        requester_user_id=viewer_id,
        request_id=request_id,
    )
    db.commit()

    return {
        "media_id": str(media.id),
        "processing_status": media.processing_status.value,
        "metadata_enrichment_enqueued": True,
    }
