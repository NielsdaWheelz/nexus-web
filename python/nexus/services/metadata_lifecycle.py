"""Metadata enrichment retry lifecycle orchestration."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media, ProcessingStatus
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs.queue import enqueue_job


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

    if media.processing_status not in {
        ProcessingStatus.ready_for_reading,
        ProcessingStatus.embedding,
        ProcessingStatus.ready,
    }:
        raise ConflictError(
            ApiErrorCode.E_RETRY_INVALID_STATE,
            "Media must be readable before metadata can be re-enriched.",
        )

    enqueue_job(
        db,
        kind="enrich_metadata",
        payload={"media_id": str(media.id), "request_id": request_id},
        max_attempts=1,
    )
    db.commit()

    return {
        "media_id": str(media.id),
        "processing_status": media.processing_status.value,
        "metadata_enrichment_enqueued": True,
    }
