"""Replayable manual admission and source-triggered metadata enqueue."""

from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, defer

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media
from nexus.db.retries import retry_read_committed
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs.queue import JobRow, enqueue_job, lock_jobs_for_payload
from nexus.logging import get_logger
from nexus.schemas.metadata_enrichment import (
    MetadataEnrichmentAccepted,
    MetadataEnrichmentRequest,
    MetadataRetryAllowed,
)
from nexus.schemas.presence import Presence, absent, presence_from_nullable, present
from nexus.services.metadata_operations import metadata_retry
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)

logger = get_logger(__name__)


def enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID | str,
    requester_user_id: UUID,
    request_id: str | None,
) -> JobRow:
    """Enqueue in the caller's transaction, serialized by the media parent."""
    from nexus.jobs.registry import get_default_registry

    media_uuid = UUID(str(media_id))
    exists = db.scalar(select(Media.id).where(Media.id == media_uuid).with_for_update())
    if exists is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    created_at = db.scalar(
        text("""
        SELECT greatest(clock_timestamp(), max(created_at) + interval '1 microsecond')
        FROM background_jobs WHERE kind='enrich_metadata' AND payload->>'media_id'=:media_id
    """),
        {"media_id": str(media_uuid)},
    )
    payload = {
        "media_id": str(media_uuid),
        "requester_user_id": str(requester_user_id),
        "request_id": request_id,
    }
    attempts = get_default_registry()["enrich_metadata"].max_attempts
    return enqueue_job(
        db,
        kind="enrich_metadata",
        payload=payload,
        max_attempts=attempts,
        created_at=created_at,
    )


def try_enqueue_metadata_enrichment(
    db: Session, *, media_id: UUID | str, requester_user_id: UUID, request_id: str | None
) -> Presence[JobRow]:
    """Best-effort automatic enqueue never undoes an already-readable capture."""
    try:
        return present(
            enqueue_metadata_enrichment(
                db, media_id=media_id, requester_user_id=requester_user_id, request_id=request_id
            )
        )
    except SQLAlchemyError as exc:
        db.rollback()
        logger.warning("metadata_enrichment_enqueue_failed", media_id=str(media_id), error=str(exc))
        return absent()


def admit_metadata_enrichment(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    request: MetadataEnrichmentRequest,
    request_id: str | None,
) -> MetadataEnrichmentAccepted:
    """One media lock owns replay, expected activity, barriers, insert and receipt."""
    scope = f"media_metadata_enrichment:{media_id}"
    request_bytes = canonical_json_bytes(
        {"expected_job_id": request.expected_job_id.model_dump(mode="json")}
    )

    def authorize(*, lock: bool) -> Media:
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
        query = select(Media).options(defer(Media.plain_text)).where(Media.id == media_id)
        if lock:
            query = query.with_for_update()
        media = db.scalar(query)
        if media is None:
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
        if lock and not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
        if media.created_by_user_id != viewer_id:
            raise ForbiddenError(ApiErrorCode.E_FORBIDDEN, "only the creator can research metadata")
        return media

    def replay() -> MetadataEnrichmentAccepted | None:
        response = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        return (
            MetadataEnrichmentAccepted.model_validate_json(canonical_json_bytes(response))
            if response is not None
            else None
        )

    authorize(lock=False)
    if (existing := replay()) is not None:
        db.rollback()
        return existing
    db.rollback()

    def admit() -> MetadataEnrichmentAccepted:
        media = authorize(lock=True)
        jobs = lock_jobs_for_payload(
            db, kind="enrich_metadata", expected_payload_match={"media_id": str(media_id)}
        )
        if (existing := replay()) is not None:
            db.rollback()
            return existing
        latest = max(jobs, key=lambda job: (job.created_at, job.id), default=None)
        expected = presence_from_nullable(latest.id if latest else None)
        if request.expected_job_id != expected:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "metadata activity changed; refresh and try again"
            )
        retry = metadata_retry(media=media, viewer_id=viewer_id, jobs=jobs)
        if not isinstance(retry, MetadataRetryAllowed):
            messages = {
                "not_creator": "only the creator can research metadata",
                "not_eligible": "metadata research is unavailable for this media state",
                "active": "metadata research is already in progress",
            }
            raise ConflictError(ApiErrorCode.E_RETRY_NOT_ALLOWED, messages[retry.reason])
        job = enqueue_metadata_enrichment(
            db, media_id=media_id, requester_user_id=viewer_id, request_id=request_id
        )
        result = MetadataEnrichmentAccepted(media_id=media_id, job_id=job.id)
        record_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
            response_json=result.model_dump(mode="json"),
        )
        db.commit()
        return result

    return retry_read_committed(db, "metadata_enrichment.admit", admit)
