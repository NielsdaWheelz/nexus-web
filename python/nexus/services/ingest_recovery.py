"""Internal ingest reconciliation enqueue and aggregate ingest health."""

from __future__ import annotations

from datetime import datetime
from typing import TypedDict

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.job_topology import (
    BACKGROUND_WORKER_JOB_KINDS,
    INTERACTIVE_WORKER_JOB_KINDS,
)
from nexus.jobs.queue import enqueue_job, ingest_operation_health
from nexus.logging import get_logger
from nexus.runtime_health import ACCEPTED_SOURCE_JOB_DEFECT_COUNT_SQL
from nexus.schemas.presence import Presence, absent, present
from nexus.services.media_upload_sessions import UPLOAD_SESSION_DERIVED_STATE_SQL

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
    # The upload owner owns the derived-state precedence; this aggregate selects it
    # rather than restating the rule, so operator health and Activity cannot drift.
    uploads = (
        db.execute(
            text(
                f"""
                WITH derived AS (
                    SELECT {UPLOAD_SESSION_DERIVED_STATE_SQL} AS derived_state
                    FROM media_upload_sessions
                )
                SELECT
                    count(*) FILTER (WHERE derived_state = 'CapabilityExpired')
                        AS expired_count,
                    count(*) FILTER (
                        WHERE derived_state IN ('VerificationFailed', 'TransportFailed')
                    ) AS failed_count,
                    count(*) FILTER (WHERE derived_state = 'Verifying')
                        AS active_verification_count
                FROM derived
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
