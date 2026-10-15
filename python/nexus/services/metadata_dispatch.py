"""Replayable manual admission and source-triggered metadata enqueue."""

from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session, defer

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media
from nexus.db.retries import retry_read_committed
from nexus.errors import ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.jobs.queue import JobRow, enqueue_job, jobs_for_payload
from nexus.schemas.metadata_enrichment import (
    BibliographyMetadataJobPayload,
    MetadataEnrichmentAccepted,
    MetadataEnrichmentRequest,
    MetadataRetryAllowed,
    TitleMetadataJobPayload,
)
from nexus.services.metadata_operations import metadata_purpose, metadata_retry
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)
from nexus.services.x_source import x_source_attempt_ids


def enqueue_metadata_enrichment(
    db: Session,
    *,
    media_id: UUID | str,
    requester_user_id: UUID,
    request_id: str | None,
) -> JobRow:
    """Enqueue in the caller's transaction, serialized by the media parent."""
    media_uuid = UUID(str(media_id))
    media = db.scalar(
        select(Media)
        .options(defer(Media.plain_text))
        .where(Media.id == media_uuid)
        .with_for_update()
    )
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    if metadata_purpose(media) == "title":
        source_attempt_id = x_source_attempt_ids(db, media_ids=[media_uuid]).get(media_uuid)
        if source_attempt_id is None:
            raise ConflictError(
                ApiErrorCode.E_RETRY_NOT_ALLOWED, "refresh source to generate a title"
            )
        payload = TitleMetadataJobPayload(
            purpose="title",
            media_id=media_uuid,
            requester_user_id=requester_user_id,
            request_id=request_id,
            source_attempt_id=source_attempt_id,
        )
    else:
        payload = BibliographyMetadataJobPayload(
            purpose="bibliography",
            media_id=media_uuid,
            requester_user_id=requester_user_id,
            request_id=request_id,
        )
    created_at = db.scalar(
        text("""
        SELECT greatest(clock_timestamp(), max(created_at) + interval '1 microsecond')
        FROM background_jobs WHERE kind='enrich_metadata' AND payload->>'media_id'=:media_id
    """),
        {"media_id": str(media_uuid)},
    )
    return enqueue_job(
        db, kind="enrich_metadata", payload=payload.model_dump(mode="json"), created_at=created_at
    )


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
        {
            "expected_job_id": None
            if request.expected_job_id is None
            else str(request.expected_job_id)
        }
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
        jobs = jobs_for_payload(
            db, kind="enrich_metadata", match={"media_id": str(media_id)}, lock=True
        )
        if (existing := replay()) is not None:
            db.rollback()
            return existing
        latest = max(jobs, key=lambda job: (job.created_at, job.id), default=None)
        expected = latest.id if latest else None
        if request.expected_job_id != expected:
            raise ConflictError(
                ApiErrorCode.E_RESOURCE_CONFLICT, "metadata activity changed; refresh and try again"
            )
        retry = metadata_retry(db, media=media, viewer_id=viewer_id, jobs=jobs)
        if not isinstance(retry, MetadataRetryAllowed):
            messages = {
                "not_creator": "only the creator can research metadata",
                "not_eligible": "metadata research is unavailable for this media state",
                "active": "metadata research is already in progress",
                "source_context_missing": "refresh source to generate a title",
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
