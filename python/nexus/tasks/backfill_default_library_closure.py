"""Worker job handler for default-library closure backfill materialization.

Worker behaviour:
1. Claim pending durable row atomically (pending -> running).
2. Validate tuple integrity; invalid tuple is terminal failure.
3. Lock membership row before materialization (strict revocation).
4. If membership absent, complete with zero inserts.
5. Materialise closure edges + default library entry rows.
6. Status-guarded complete/fail transitions.
7. Deterministic retry: delays [60, 300, 900, 3600, 21600], max 5 attempts.
"""

from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError

from nexus.db.session import get_session_factory
from nexus.logging import get_logger
from nexus.services.default_library_closure import (
    claim_backfill_job_pending,
    get_backfill_backlog_health,
    handle_backfill_job_failure,
    mark_backfill_job_completed,
    mark_backfill_job_terminally_failed,
    materialize_closure_for_source,
    validate_backfill_job_tuple,
)

logger = get_logger(__name__)


def backfill_default_library_closure_job(
    default_library_id: str,
    source_library_id: str,
    user_id: str,
    request_id: str | None = None,
    task_id: str | None = None,
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

    resolved_task_id = task_id or f"direct:{default_library_id}:{source_library_id}:{user_id}"
    log_ctx = {
        "task_name": "backfill_default_library_closure_job",
        "task_id": resolved_task_id,
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
    # justify-ignore-error: task boundary records unexpected failures on the
    # durable backfill row before re-raising to the worker.
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
        mark_backfill_job_terminally_failed(
            db,
            default_library_id=dl_uuid,
            source_library_id=src_uuid,
            user_id=uid_uuid,
            error_code=f"tuple_invalid:{error}",
        )
        db.commit()
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
    except SQLAlchemyError as exc:
        logger.warning(
            "backfill_backlog_health_check_failed",
            error=str(exc),
            **log_ctx,
        )

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
        result = handle_backfill_job_failure(
            db,
            dl_uuid,
            src_uuid,
            uid_uuid,
            error_msg,
            request_id=request_id,
        )
    except SQLAlchemyError as exc:
        logger.exception("backfill_failure_handler_error", error=str(exc), **log_ctx)
        try:
            db.rollback()
        except SQLAlchemyError as rollback_exc:
            logger.warning(
                "backfill_failure_handler_rollback_failed",
                error=str(rollback_exc),
                **log_ctx,
            )
        return

    if result.status == "stale":
        logger.info("backfill_failure_stale", **log_ctx)
        return
    if result.status == "retry_scheduled":
        logger.info(
            "backfill_retry_scheduled",
            attempts=result.attempts,
            delay=result.retry_delay_seconds,
            dispatched=result.enqueue_dispatched,
            **log_ctx,
        )
        return
    if result.status == "retry_reset_failed":
        logger.warning(
            "backfill_retry_reset_failed",
            attempts=result.attempts,
            delay=result.retry_delay_seconds,
            **log_ctx,
        )
        return
    logger.warning(
        "backfill_terminal_failure",
        attempts=result.attempts,
        **log_ctx,
    )
