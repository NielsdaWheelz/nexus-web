"""Internal ingest recovery commands and aggregate health."""

from __future__ import annotations

from datetime import datetime
from typing import TypedDict
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import (
    BACKGROUND_WORKER_JOB_KINDS,
    INTERACTIVE_WORKER_JOB_KINDS,
    get_settings,
)
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode, ConflictError, NotFoundError
from nexus.jobs.queue import (
    current_dead_job_for_payload,
    enqueue_job,
    ingest_operation_health,
    lock_jobs_for_payload,
    requeue_dead_job,
)
from nexus.logging import get_logger
from nexus.schemas.presence import Presence, absent, present
from nexus.services.content_indexing import request_media_content_reindex

logger = get_logger(__name__)


class IngestRecoveryHealth(TypedDict):
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
    queue = ingest_operation_health(
        db,
        interactive_kinds=INTERACTIVE_WORKER_JOB_KINDS,
        background_kinds=BACKGROUND_WORKER_JOB_KINDS,
    )
    now = db.execute(text("SELECT now()")).scalar_one()
    latest = queue["latest_reconciler"]
    latest_age_seconds: int | None = None
    latest_succeeded = False
    if isinstance(latest, dict):
        observed_at = latest.get("finished_at") or latest.get("created_at")
        if isinstance(observed_at, datetime):
            latest_age_seconds = int((now - observed_at).total_seconds())
        latest_succeeded = latest.get("status") == "succeeded"

    stale_source_count = int(source["stale_count"] or 0)
    stale_index_count = int(index["stale_count"] or 0)
    degraded = (
        stale_source_count > 0
        or stale_index_count > 0
        or int(queue["dead_source_count"]) > 0
        or int(queue["dead_index_count"]) > 0
        or not latest_succeeded
        or latest_age_seconds is None
        or latest_age_seconds > 2 * int(settings.ingest_reconcile_schedule_seconds)
    )
    return {
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


def retry_dead_content_index_job(*, media_id: UUID) -> UUID:
    db = get_session_factory()()
    try:

        def replay() -> UUID:
            state = (
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
            if state is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Content index not found.")
            job = current_dead_job_for_payload(
                db,
                kind="media_content_reindex_job",
                expected_payload_match={
                    "media_id": str(media_id),
                    "revision": int(state["revision"]),
                },
            )
            if job is None:
                raise ConflictError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "The current content-index operation is not suspended.",
                )
            if not requeue_dead_job(db, job_id=job.id):
                # justify-defect: the exact dead row is locked in this transaction.
                raise AssertionError("locked dead content-index job could not be replayed")
            db.commit()
            return job.id

        return retry_serializable(db, "retry_dead_content_index_job", replay)
    finally:
        db.close()


def retry_dead_source_job(*, media_id: UUID) -> UUID:
    db = get_session_factory()()
    try:

        def replay() -> UUID:
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
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Source operation not found.")
            job = current_dead_job_for_payload(
                db,
                kind="ingest_media_source",
                expected_payload_match={"attempt_id": str(row["attempt_id"])},
            )
            if job is None or job.id != row["job_id"]:
                raise ConflictError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "The current source operation is not suspended.",
                )
            if not requeue_dead_job(db, job_id=job.id):
                # justify-defect: the exact dead row is locked in this transaction.
                raise AssertionError("locked dead source job could not be replayed")
            db.commit()
            return job.id

        return retry_serializable(db, "retry_dead_source_job", replay)
    finally:
        db.close()


def repair_legacy_failed_content_index(
    *,
    media_id: UUID,
    request_id: str | None,
) -> UUID:
    db = get_session_factory()()
    try:

        def repair() -> UUID:
            row = (
                db.execute(
                    text(
                        """
                    SELECT cis.revision, cis.status
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
            if row is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Content index not found.")
            if row["status"] != "failed":
                raise ConflictError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "Only a legacy failed content index can be repaired.",
                )
            jobs = lock_jobs_for_payload(
                db,
                kind="media_content_reindex_job",
                expected_payload_match={
                    "media_id": str(media_id),
                    "revision": int(row["revision"]),
                },
            )
            if any(job.status in {"pending", "failed", "running", "dead"} for job in jobs):
                raise ConflictError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "The current content index already has an owned operation.",
                )
            intent = request_media_content_reindex(
                db,
                media_id=media_id,
                reason="operator_repair",
                request_id=request_id,
            )
            db.commit()
            return intent.background_job_id

        return retry_serializable(db, "repair_legacy_failed_content_index", repair)
    finally:
        db.close()
