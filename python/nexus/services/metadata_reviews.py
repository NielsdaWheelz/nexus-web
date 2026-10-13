"""Personal acknowledgement of an exact no-findings metadata operation."""

from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.db.models import Media
from nexus.db.retries import retry_read_committed
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, NotFoundError
from nexus.ids import new_uuid7
from nexus.jobs.queue import get_job
from nexus.schemas.metadata_enrichment import (
    MetadataNoFindingsOperation,
    MetadataResultReviewed,
    MetadataResultReviewRequest,
)
from nexus.services.metadata_operations import metadata_operations_for_jobs
from nexus.services.resource_mutation_replay import (
    canonical_json_bytes,
    lookup_replay,
    record_replay,
)


def review_metadata_result(
    db: Session,
    *,
    viewer_id: UUID,
    media_id: UUID,
    job_id: UUID,
    request: MetadataResultReviewRequest,
) -> MetadataResultReviewed:
    """Authorize before replay, then serialize fresh acknowledgement on its media."""
    scope = f"media_metadata_result_review:{media_id}"
    request_bytes = canonical_json_bytes({"job_id": str(job_id)})

    def replay() -> MetadataResultReviewed | None:
        response = lookup_replay(
            db,
            viewer_id=viewer_id,
            scope=scope,
            client_mutation_id=request.client_mutation_id,
            request_bytes=request_bytes,
        )
        return (
            MetadataResultReviewed.model_validate_json(canonical_json_bytes(response))
            if response is not None
            else None
        )

    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
    if (existing := replay()) is not None:
        db.rollback()
        return existing
    db.rollback()

    def review() -> MetadataResultReviewed:
        with transaction(db):
            exists = db.scalar(select(Media.id).where(Media.id == media_id).with_for_update())
            if exists is None or not can_read_media(db, viewer_id, media_id):
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "media not found")
            if (existing := replay()) is not None:
                return existing
            job = get_job(db, job_id, lock=True)
            if (
                job is None
                or job.kind != "enrich_metadata"
                or job.payload.get("media_id") != str(media_id)
            ):
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "metadata result not found")
            operation = metadata_operations_for_jobs(db, viewer_id=viewer_id, job_ids=[job_id])[
                job_id
            ]
            if not isinstance(operation, MetadataNoFindingsOperation):
                raise ConflictError(
                    ApiErrorCode.E_RESOURCE_CONFLICT,
                    "only a no-findings metadata result can be marked reviewed",
                )
            reviewed_at = db.scalar(
                text("""
                    SELECT reviewed_at FROM metadata_result_reviews
                    WHERE viewer_id = :viewer_id AND job_id = :job_id
                """),
                {"viewer_id": viewer_id, "job_id": job_id},
            )
            if reviewed_at is None:
                reviewed_at = db.execute(
                    text("""
                        INSERT INTO metadata_result_reviews (id, viewer_id, job_id, reviewed_at)
                        VALUES (:id, :viewer_id, :job_id, clock_timestamp())
                        RETURNING reviewed_at
                    """),
                    {"id": new_uuid7(), "viewer_id": viewer_id, "job_id": job_id},
                ).scalar_one()
                db.execute(
                    text("SELECT pg_notify('media_events', :media_id)"),
                    {"media_id": str(media_id)},
                )
            result = MetadataResultReviewed(job_id=job_id, reviewed_at=reviewed_at)
            record_replay(
                db,
                viewer_id=viewer_id,
                scope=scope,
                client_mutation_id=request.client_mutation_id,
                request_bytes=request_bytes,
                response_json=result.model_dump(mode="json"),
            )
            return result

    return retry_read_committed(db, "metadata_result.review", review)


def delete_viewer_media_reviews(db: Session, *, viewer_id: UUID, media_id: UUID) -> None:
    """Remove only this viewer's acknowledgements, in the removal transaction."""
    db.execute(
        text("""
            DELETE FROM metadata_result_reviews review USING background_jobs job
            WHERE review.viewer_id = :viewer_id AND review.job_id = job.id
              AND job.kind = 'enrich_metadata' AND job.payload->>'media_id' = :media_id
        """),
        {"viewer_id": viewer_id, "media_id": str(media_id)},
    )


def delete_media_reviews(db: Session, *, media_id: UUID) -> None:
    """Physical teardown removes every dependent review; job evidence survives."""
    db.execute(
        text("""
            DELETE FROM metadata_result_reviews review USING background_jobs job
            WHERE review.job_id = job.id AND job.kind = 'enrich_metadata'
              AND job.payload->>'media_id' = :media_id
        """),
        {"media_id": str(media_id)},
    )
