"""Internal ingest recovery commands and aggregate health."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, TypedDict
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.config import get_settings
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode, ConflictError, ForbiddenError, NotFoundError
from nexus.job_topology import (
    BACKGROUND_WORKER_JOB_KINDS,
    INTERACTIVE_WORKER_JOB_KINDS,
)
from nexus.jobs.queue import (
    current_dead_job_for_payload,
    enqueue_job,
    ingest_operation_health,
    requeue_dead_job,
)
from nexus.logging import get_logger
from nexus.runtime_health import ACCEPTED_SOURCE_JOB_DEFECT_COUNT_SQL
from nexus.schemas.presence import Presence, absent, present

logger = get_logger(__name__)


class IngestRecoveryHealth(TypedDict):
    expired_upload_session_count: int
    failed_upload_session_count: int
    active_upload_verification_lease_count: int
    accepted_jobless_source_attempt_count: int
    resource_limited_source_job_count: int
    stale_source_attempt_count: int
    oldest_stale_source_attempt_age_seconds: Presence[int]
    fresh_pending_content_index_count: int
    stale_content_index_count: int
    suspended_source_job_count: int
    suspended_content_index_job_count: int
    oldest_due_interactive_job_age_seconds: Presence[int]
    oldest_due_background_job_age_seconds: Presence[int]
    latest_reconciler_age_seconds: Presence[int]
    latest_reconciler_succeeded: bool
    stale_threshold_seconds: int
    degraded: bool


def get_ingest_recovery_health(db: Session) -> IngestRecoveryHealth:
    settings = get_settings()
    stale_seconds = int(settings.ingest_stale_extracting_seconds)
    source = (
        db.execute(
            text(
                """
            SELECT
                count(*) FILTER (
                    WHERE m.processing_started_at
                        < now() - (CAST(:stale_seconds AS integer) * interval '1 second')
                ) AS stale_count,
                extract(
                    epoch FROM now() - min(m.processing_started_at) FILTER (
                        WHERE m.processing_started_at
                            < now()
                              - (CAST(:stale_seconds AS integer) * interval '1 second')
                    )
                ) AS oldest_stale_age
            FROM media_source_attempts msa
            JOIN media m ON m.id = msa.media_id
            WHERE msa.status IN ('accepted', 'queued', 'running')
              AND m.processing_status = 'extracting'
              AND m.processing_started_at IS NOT NULL
              AND msa.id = (
                  SELECT latest.id
                  FROM media_source_attempts latest
                  WHERE latest.media_id = msa.media_id
                  ORDER BY
                      latest.attempt_no DESC,
                      latest.created_at DESC,
                      latest.id DESC
                  LIMIT 1
              )
            """
            ),
            {"stale_seconds": stale_seconds},
        )
        .mappings()
        .one()
    )
    index = (
        db.execute(
            text(
                """
            SELECT
                count(*) FILTER (
                    WHERE cis.status = 'pending'
                      AND cis.updated_at
                          >= now()
                            - (CAST(:stale_seconds AS integer) * interval '1 second')
                ) AS fresh_pending_count,
                count(*) FILTER (
                    WHERE (
                        cis.status = 'pending'
                        AND cis.updated_at
                            < now()
                              - (CAST(:stale_seconds AS integer) * interval '1 second')
                    )
                    OR (
                        cis.status = 'indexing'
                        AND cis.updated_at
                            < now()
                              - (CAST(:stale_seconds AS integer) * interval '1 second')
                    )
                ) AS stale_count
            FROM content_index_states cis
            JOIN media m
              ON cis.owner_kind = 'media'
             AND m.id = cis.owner_id
            WHERE m.kind IN ('web_article', 'epub', 'pdf')
              AND m.processing_status = 'ready_for_reading'
            """
            ),
            {"stale_seconds": stale_seconds},
        )
        .mappings()
        .one()
    )
    uploads = (
        db.execute(
            text(
                """
                SELECT
                    count(*) FILTER (
                        WHERE published_at IS NULL
                          AND verification_failed_at IS NULL
                          AND NOT (
                              verification_token IS NOT NULL
                              AND verification_expires_at > now()
                          )
                          AND transport_failed_at IS NULL
                          AND upload_url_expires_at <= now()
                    ) AS expired_count,
                    count(*) FILTER (
                        WHERE published_at IS NULL
                          AND (
                              verification_failed_at IS NOT NULL
                              OR transport_failed_at IS NOT NULL
                          )
                    ) AS failed_count,
                    count(*) FILTER (
                        WHERE published_at IS NULL
                          AND verification_token IS NOT NULL
                          AND verification_expires_at > now()
                    ) AS active_verification_count
                FROM media_upload_sessions
                """
            )
        )
        .mappings()
        .one()
    )
    publication = (
        db.execute(
            text(
                """
                WITH latest_source AS (
                    SELECT DISTINCT ON (msa.media_id)
                        msa.id,
                        msa.media_id,
                        msa.status,
                        msa.job_id
                    FROM media_source_attempts msa
                    ORDER BY
                        msa.media_id,
                        msa.attempt_no DESC,
                        msa.created_at DESC,
                        msa.id DESC
                )
                SELECT
                    count(*) FILTER (
                        WHERE (
                            ls.status = 'failed'
                            AND source_job.status = 'dead'
                            AND source_job.error_code = 'E_RESOURCE_LIMIT'
                        )
                        OR (
                            ls.status = 'succeeded'
                            AND source_job.status = 'succeeded'
                            AND source_job.error_code IS NULL
                            AND source_job.result IN (
                                '{"kind":"SourceProjectionSucceeded","child_exit":{"kind":"ResourceFailure","dimension":"Memory"}}'::jsonb,
                                '{"kind":"SourceProjectionSucceeded","child_exit":{"kind":"ResourceFailure","dimension":"Time"}}'::jsonb,
                                '{"kind":"SourceProjectionSucceeded","child_exit":{"kind":"ResourceFailure","dimension":"Structure"}}'::jsonb,
                                '{"kind":"SourceProjectionSucceeded","child_exit":{"kind":"ResourceFailure","dimension":"Output"}}'::jsonb
                            )
                        )
                    ) AS resource_limited_count
                FROM latest_source ls
                LEFT JOIN background_jobs source_job ON source_job.id = ls.job_id
                """
            )
        )
        .mappings()
        .one()
    )
    accepted_source_job_defect_count = int(
        db.scalar(text(ACCEPTED_SOURCE_JOB_DEFECT_COUNT_SQL)) or 0
    )
    queue = ingest_operation_health(
        db,
        interactive_kinds=INTERACTIVE_WORKER_JOB_KINDS,
        background_kinds=BACKGROUND_WORKER_JOB_KINDS,
    )
    now = db.execute(text("SELECT now()")).scalar_one()
    latest_success = queue["latest_successful_reconciler"]
    latest_completed = queue["latest_completed_reconciler"]
    latest_age_seconds: int | None = None
    if isinstance(latest_success, dict):
        observed_at = latest_success.get("finished_at")
        if isinstance(observed_at, datetime):
            latest_age_seconds = int((now - observed_at).total_seconds())
    latest_succeeded = (
        isinstance(latest_completed, dict) and latest_completed.get("status") == "succeeded"
    )

    stale_source_count = int(source["stale_count"] or 0)
    stale_index_count = int(index["stale_count"] or 0)
    accepted_jobless_count = accepted_source_job_defect_count
    degraded = (
        stale_source_count > 0
        or stale_index_count > 0
        or accepted_jobless_count > 0
        or int(queue["dead_source_count"]) > 0
        or int(queue["dead_index_count"]) > 0
        or not latest_succeeded
        or latest_age_seconds is None
        or latest_age_seconds > 2 * int(settings.ingest_reconcile_schedule_seconds)
    )
    return {
        "expired_upload_session_count": int(uploads["expired_count"] or 0),
        "failed_upload_session_count": int(uploads["failed_count"] or 0),
        "active_upload_verification_lease_count": int(uploads["active_verification_count"] or 0),
        "accepted_jobless_source_attempt_count": accepted_jobless_count,
        "resource_limited_source_job_count": int(publication["resource_limited_count"] or 0),
        "stale_source_attempt_count": stale_source_count,
        "oldest_stale_source_attempt_age_seconds": (
            absent()
            if source["oldest_stale_age"] is None
            else present(int(source["oldest_stale_age"]))
        ),
        "fresh_pending_content_index_count": int(index["fresh_pending_count"] or 0),
        "stale_content_index_count": stale_index_count,
        "suspended_source_job_count": int(queue["dead_source_count"]),
        "suspended_content_index_job_count": int(queue["dead_index_count"]),
        "oldest_due_interactive_job_age_seconds": (
            absent()
            if queue["oldest_due_interactive_age_seconds"] is None
            else present(int(queue["oldest_due_interactive_age_seconds"]))
        ),
        "oldest_due_background_job_age_seconds": (
            absent()
            if queue["oldest_due_background_age_seconds"] is None
            else present(int(queue["oldest_due_background_age_seconds"]))
        ),
        "latest_reconciler_age_seconds": (
            absent() if latest_age_seconds is None else present(latest_age_seconds)
        ),
        "latest_reconciler_succeeded": latest_succeeded,
        "stale_threshold_seconds": stale_seconds,
        "degraded": degraded,
    }


def enqueue_stale_ingest_reconcile(*, request_id: str | None = None) -> None:
    db = get_session_factory()()
    try:
        enqueue_job(
            db,
            kind="reconcile_stale_ingest_media_job",
            payload={"request_id": request_id},
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        logger.error(
            "stale_ingest_reconcile_enqueue_failed",
            error=str(exc),
            request_id=request_id,
        )
        raise ApiError(
            ApiErrorCode.E_INTERNAL,
            "Failed to enqueue stale ingest reconciler.",
        ) from exc
    finally:
        db.close()


RepairScope = Literal["Source", "Search"]


def repair_media_work(
    db: Session,
    *,
    media_id: UUID,
    scope: RepairScope,
    viewer_id: UUID | None = None,
    is_admin: bool = False,
) -> UUID:
    """Requeue only exact dead work for the current source attempt or index revision."""

    def repair() -> UUID:
        if viewer_id is not None:
            if not can_read_media(db, viewer_id, media_id):
                raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
            creator_id = db.execute(
                text("SELECT created_by_user_id FROM media WHERE id = :media_id"),
                {"media_id": media_id},
            ).scalar_one()
            if creator_id != viewer_id and not is_admin:
                raise ForbiddenError(ApiErrorCode.E_OWNER_REQUIRED, "Media owner required")

        if scope == "Source":
            row = (
                db.execute(
                    text(
                        """
                        SELECT msa.id AS attempt_id, msa.job_id
                        FROM media m
                        JOIN media_source_attempts msa ON msa.media_id = m.id
                        WHERE m.id = :media_id
                        ORDER BY msa.attempt_no DESC, msa.created_at DESC, msa.id DESC
                        LIMIT 1
                        FOR UPDATE OF m, msa
                        """
                    ),
                    {"media_id": media_id},
                )
                .mappings()
                .one_or_none()
            )
            if row is None or row["job_id"] is None:
                job = None
                exact = False
            else:
                job = current_dead_job_for_payload(
                    db,
                    kind="ingest_media_source",
                    expected_payload_match={
                        "media_id": str(media_id),
                        "attempt_id": str(row["attempt_id"]),
                    },
                )
                exact = job is not None and job.id == row["job_id"]
        elif scope == "Search":
            row = (
                db.execute(
                    text(
                        """
                        SELECT cis.revision
                        FROM media m
                        JOIN content_index_states cis
                          ON cis.owner_kind = 'media'
                         AND cis.owner_id = m.id
                        WHERE m.id = :media_id
                        FOR UPDATE OF m, cis
                        """
                    ),
                    {"media_id": media_id},
                )
                .mappings()
                .one_or_none()
            )
            job = (
                None
                if row is None
                else current_dead_job_for_payload(
                    db,
                    kind="media_content_reindex_job",
                    expected_payload_match={
                        "media_id": str(media_id),
                        "revision": int(row["revision"]),
                    },
                )
            )
            exact = job is not None
        else:
            # justify-defect: RepairScope is a closed transport-owned union.
            raise AssertionError(f"unknown media repair scope: {scope!r}")

        if not exact or job is None:
            raise ConflictError(
                ApiErrorCode.E_REPAIR_NOT_ALLOWED,
                "No exact current dead operation is repairable.",
            )
        if not requeue_dead_job(db, job_id=job.id):
            # justify-defect: current_dead_job_for_payload locked this exact dead row.
            raise AssertionError("locked dead media job could not be requeued")
        db.commit()
        return job.id

    return retry_serializable(db, "repair_media_work", repair)
