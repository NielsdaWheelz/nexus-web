"""Celery task for default-library closure backfill materialization.

Worker behaviour (per s4 spec section 7.4):
1. Claim pending durable row atomically (pending -> running).
2. Validate tuple integrity; invalid tuple is terminal failure.
3. Lock membership row before materialization (strict revocation).
4. If membership absent, complete with zero inserts.
5. Materialise closure edges + default library_media rows.
6. Status-guarded complete/fail transitions.
7. Deterministic retry: delays [60, 300, 900, 3600, 21600], max 5 attempts.
"""

from uuid import UUID

from nexus.celery import celery_app
from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.default_library_closure import (
    BACKFILL_MAX_ATTEMPTS,
    BACKFILL_RETRY_DELAYS_SECONDS,
    claim_backfill_job_pending,
    enqueue_backfill_task,
    get_backfill_backlog_health,
    mark_backfill_job_completed,
    mark_backfill_job_failed,
    materialize_closure_for_source,
    reset_backfill_job_to_pending_for_retry,
    validate_backfill_job_tuple,
)

logger = get_logger(__name__)


@celery_app.task(
    bind=True,
    max_retries=0,
    name="backfill_default_library_closure_job",
)
def backfill_default_library_closure_job(
    self,
    default_library_id: str,
    source_library_id: str,
    user_id: str,
    request_id: str | None = None,
) -> dict:
    """Backfill closure edges for a user's default library from a source library.

    Args:
        default_library_id: UUID of the user's default library.
        source_library_id: UUID of the non-default source library.
        user_id: UUID of the user.
        request_id: Optional correlation ID for logging.

    Returns:
        Dict with result status.
    """
    dl_uuid = UUID(default_library_id)
    src_uuid = UUID(source_library_id)
    uid_uuid = UUID(user_id)

    log_ctx = {
        "task_name": "backfill_default_library_closure_job",
        "task_id": self.request.id,
        "request_id": request_id,
        "default_library_id": default_library_id,
        "source_library_id": source_library_id,
        "user_id": user_id,
    }
    logger.info("backfill_task_started", **log_ctx)

    session_factory = get_session_factory()
    db = session_factory()

    try:
        return _execute_backfill(db, dl_uuid, src_uuid, uid_uuid, request_id, log_ctx)
    except Exception as exc:
        logger.error("backfill_task_unexpected_error", error=str(exc), **log_ctx)
        _handle_failure(db, dl_uuid, src_uuid, uid_uuid, str(exc), request_id, log_ctx)
        raise
    finally:
        db.close()


def _execute_backfill(
    db,
    dl_uuid: UUID,
    src_uuid: UUID,
    uid_uuid: UUID,
    request_id: str | None,
    log_ctx: dict,
) -> dict:
    """Core backfill logic."""
    from sqlalchemy import text

    # Step 1: Validate tuple integrity
    error = validate_backfill_job_tuple(db, dl_uuid, src_uuid, uid_uuid)
    if error is not None:
        logger.warning("backfill_tuple_invalid", error=error, **log_ctx)
        # Terminal failure: mark failed without retry
        _mark_terminal_failure(db, dl_uuid, src_uuid, uid_uuid, f"tuple_invalid:{error}")
        return {"status": "failed", "reason": f"tuple_invalid:{error}"}

    # Step 2: Claim pending row atomically
    claimed = claim_backfill_job_pending(db, dl_uuid, src_uuid, uid_uuid)
    db.commit()

    if claimed is None:
        logger.info("backfill_claim_noop", **log_ctx)
        return {"status": "skipped", "reason": "not_pending"}

    # Step 3: Lock membership row for strict revocation
    membership = db.execute(
        text("""
            SELECT 1 FROM memberships
            WHERE library_id = :source AND user_id = :uid
            FOR UPDATE
        """),
        {"source": src_uuid, "uid": uid_uuid},
    ).fetchone()

    if membership is None:
        # Membership revoked: complete with zero inserts
        mark_backfill_job_completed(db, dl_uuid, src_uuid, uid_uuid)
        db.commit()
        logger.info("backfill_completed_no_membership", **log_ctx)
        return {"status": "completed", "reason": "membership_absent", "edges_inserted": 0}

    # Step 4: Materialise
    edges = materialize_closure_for_source(db, dl_uuid, src_uuid)

    # Step 5: Mark completed (status-guarded)
    mark_backfill_job_completed(db, dl_uuid, src_uuid, uid_uuid)
    db.commit()

    # Step 6: Check backlog health and log warning if degraded
    try:
        health = get_backfill_backlog_health(db)
        if health["degraded"]:
            logger.warning(
                "backfill_backlog_degraded",
                pending_count=health["pending_count"],
                pending_age_p95=health["pending_age_p95_seconds"],
                **log_ctx,
            )
    except Exception:
        pass  # guardrail check is advisory only

    logger.info("backfill_completed", edges_inserted=edges, **log_ctx)
    return {"status": "completed", "edges_inserted": edges}


def _handle_failure(
    db,
    dl_uuid: UUID,
    src_uuid: UUID,
    uid_uuid: UUID,
    error_msg: str,
    request_id: str | None,
    log_ctx: dict,
) -> None:
    """Handle task failure: mark failed and attempt retry if under threshold."""
    try:
        new_attempts = mark_backfill_job_failed(db, dl_uuid, src_uuid, uid_uuid, error_msg[:500])
        db.commit()

        if new_attempts == 0:
            # Status guard prevented update (stale task)
            logger.info("backfill_failure_stale", **log_ctx)
            return

        if new_attempts < BACKFILL_MAX_ATTEMPTS:
            # Retry: reset to pending and enqueue with delay
            delay_index = new_attempts - 1
            delay = BACKFILL_RETRY_DELAYS_SECONDS[delay_index]
            reset_ok = reset_backfill_job_to_pending_for_retry(db, dl_uuid, src_uuid, uid_uuid)
            db.commit()

            if reset_ok:
                dispatched = enqueue_backfill_task(
                    dl_uuid,
                    src_uuid,
                    uid_uuid,
                    request_id=request_id,
                    countdown=delay,
                )
                logger.info(
                    "backfill_retry_scheduled",
                    attempts=new_attempts,
                    delay=delay,
                    dispatched=dispatched,
                    **log_ctx,
                )
        else:
            logger.warning(
                "backfill_terminal_failure",
                attempts=new_attempts,
                **log_ctx,
            )
    except Exception:
        logger.exception("backfill_failure_handler_error", **log_ctx)
        try:
            db.rollback()
        except Exception:
            pass


def _mark_terminal_failure(
    db,
    dl_uuid: UUID,
    src_uuid: UUID,
    uid_uuid: UUID,
    error_code: str,
) -> None:
    """Mark a backfill job as terminal failed without retry."""
    from datetime import UTC, datetime

    from sqlalchemy import text

    now = datetime.now(UTC)
    db.execute(
        text("""
            UPDATE default_library_backfill_jobs
            SET status = 'failed',
                attempts = attempts + 1,
                last_error_code = :error_code,
                finished_at = :now,
                updated_at = :now
            WHERE default_library_id = :dl
              AND source_library_id = :source
              AND user_id = :uid
        """),
        {
            "dl": dl_uuid,
            "source": src_uuid,
            "uid": uid_uuid,
            "error_code": error_code,
            "now": now,
        },
    )
    db.commit()
