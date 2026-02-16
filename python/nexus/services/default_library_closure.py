"""Default-library closure, intrinsic, and backfill invariant service.

Centralises all s4 provenance helpers so writer touchpoints cannot diverge.

Rules:
- All helpers accept Session and never call commit()/rollback().
- All insert paths use ON CONFLICT DO NOTHING for idempotency.
- Lock ordering for worker paths:
    1. claim/update default_library_backfill_jobs
    2. lock membership row (source_library_id, user_id)
    3. closure/materialization writes + gc
"""

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import Environment, get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants (s4 spec / l3 spec)
# ---------------------------------------------------------------------------

BACKFILL_RETRY_DELAYS_SECONDS: tuple[int, ...] = (60, 300, 900, 3600, 21600)
BACKFILL_MAX_ATTEMPTS: int = 5
BACKFILL_PENDING_AGE_P95_GUARDRAIL_SECONDS: int = 900
BACKFILL_PENDING_COUNT_GUARDRAIL: int = 500

# ---------------------------------------------------------------------------
# Intrinsic / default-library helpers
# ---------------------------------------------------------------------------


def ensure_default_intrinsic(
    db: Session,
    default_library_id: UUID,
    media_id: UUID,
) -> None:
    """Ensure library_media + intrinsic rows exist for a default library.

    Used by all default-library direct writer paths (upload, from_url, etc.).
    Never writes closure edges.
    """
    db.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            VALUES (:lib, :media)
            ON CONFLICT (library_id, media_id) DO NOTHING
        """),
        {"lib": default_library_id, "media": media_id},
    )
    db.execute(
        text("""
            INSERT INTO default_library_intrinsics (default_library_id, media_id)
            VALUES (:lib, :media)
            ON CONFLICT (default_library_id, media_id) DO NOTHING
        """),
        {"lib": default_library_id, "media": media_id},
    )


def remove_default_intrinsic_and_gc(
    db: Session,
    default_library_id: UUID,
    media_id: UUID,
) -> None:
    """Remove intrinsic row and gc the materialized library_media row if unjustified.

    Does NOT delete closure edges -- those are removed only by membership or
    non-default library media removal paths.
    """
    # Remove intrinsic
    db.execute(
        text("""
            DELETE FROM default_library_intrinsics
            WHERE default_library_id = :lib AND media_id = :media
        """),
        {"lib": default_library_id, "media": media_id},
    )
    # GC
    _gc_default_library_media_row(db, default_library_id, media_id)


# ---------------------------------------------------------------------------
# Non-default library helpers (closure edge management)
# ---------------------------------------------------------------------------


def add_media_to_non_default_closure(
    db: Session,
    source_library_id: UUID,
    media_id: UUID,
) -> None:
    """Create closure edges + materialized default rows for all current members.

    Called when media is added to a non-default library.
    """
    # Insert closure edges for each member's default library
    db.execute(
        text("""
            INSERT INTO default_library_closure_edges
                (default_library_id, media_id, source_library_id)
            SELECT dl.id, :media, :source
            FROM memberships m
            JOIN libraries dl
                ON dl.owner_user_id = m.user_id AND dl.is_default = true
            WHERE m.library_id = :source
            ON CONFLICT (default_library_id, media_id, source_library_id) DO NOTHING
        """),
        {"media": media_id, "source": source_library_id},
    )
    # Materialise default library_media rows from those edges
    db.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            SELECT dl.id, :media
            FROM memberships m
            JOIN libraries dl
                ON dl.owner_user_id = m.user_id AND dl.is_default = true
            WHERE m.library_id = :source
            ON CONFLICT (library_id, media_id) DO NOTHING
        """),
        {"media": media_id, "source": source_library_id},
    )


def remove_media_from_non_default_closure(
    db: Session,
    source_library_id: UUID,
    media_id: UUID,
) -> None:
    """Remove closure edges for this source + gc affected default rows."""
    # Collect affected default libraries before deleting edges
    affected = db.execute(
        text("""
            SELECT DISTINCT default_library_id
            FROM default_library_closure_edges
            WHERE source_library_id = :source AND media_id = :media
        """),
        {"source": source_library_id, "media": media_id},
    ).fetchall()

    # Delete edges
    db.execute(
        text("""
            DELETE FROM default_library_closure_edges
            WHERE source_library_id = :source AND media_id = :media
        """),
        {"source": source_library_id, "media": media_id},
    )

    # GC each affected default library
    for (dl_id,) in affected:
        _gc_default_library_media_row(db, dl_id, media_id)


def remove_member_closure_and_gc(
    db: Session,
    source_library_id: UUID,
    target_user_id: UUID,
) -> None:
    """Clean up closure edges when a member is removed from a non-default library.

    Removes all edges (d(target_user), *, source_library_id) and gc.
    Also deletes the matching backfill job row if present.
    """
    # Find the target user's default library
    dl_row = db.execute(
        text("""
            SELECT id FROM libraries
            WHERE owner_user_id = :uid AND is_default = true
        """),
        {"uid": target_user_id},
    ).fetchone()

    if dl_row is None:
        return

    default_library_id = dl_row[0]

    # Collect media_ids affected
    affected_media = db.execute(
        text("""
            SELECT DISTINCT media_id
            FROM default_library_closure_edges
            WHERE default_library_id = :dl AND source_library_id = :source
        """),
        {"dl": default_library_id, "source": source_library_id},
    ).fetchall()

    # Delete closure edges
    db.execute(
        text("""
            DELETE FROM default_library_closure_edges
            WHERE default_library_id = :dl AND source_library_id = :source
        """),
        {"dl": default_library_id, "source": source_library_id},
    )

    # GC each affected media row
    for (media_id,) in affected_media:
        _gc_default_library_media_row(db, default_library_id, media_id)

    # Delete matching backfill job row
    db.execute(
        text("""
            DELETE FROM default_library_backfill_jobs
            WHERE default_library_id = :dl
              AND source_library_id = :source
              AND user_id = :uid
        """),
        {"dl": default_library_id, "source": source_library_id, "uid": target_user_id},
    )


# ---------------------------------------------------------------------------
# GC helper
# ---------------------------------------------------------------------------


def _gc_default_library_media_row(
    db: Session,
    default_library_id: UUID,
    media_id: UUID,
) -> None:
    """Delete library_media(default, media) iff no intrinsic and no closure edge."""
    has_intrinsic = db.execute(
        text("""
            SELECT 1 FROM default_library_intrinsics
            WHERE default_library_id = :dl AND media_id = :media
        """),
        {"dl": default_library_id, "media": media_id},
    ).fetchone()
    if has_intrinsic is not None:
        return

    has_edge = db.execute(
        text("""
            SELECT 1 FROM default_library_closure_edges
            WHERE default_library_id = :dl AND media_id = :media
            LIMIT 1
        """),
        {"dl": default_library_id, "media": media_id},
    ).fetchone()
    if has_edge is not None:
        return

    db.execute(
        text("""
            DELETE FROM library_media
            WHERE library_id = :dl AND media_id = :media
        """),
        {"dl": default_library_id, "media": media_id},
    )


# ---------------------------------------------------------------------------
# Backfill job state machine helpers
# ---------------------------------------------------------------------------


def validate_backfill_job_tuple(
    db: Session,
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
) -> str | None:
    """Validate structural integrity of a backfill job tuple.

    Returns None if valid, or an error description string if invalid.
    """
    # Check job exists
    job_exists = db.execute(
        text("""
            SELECT 1 FROM default_library_backfill_jobs
            WHERE default_library_id = :dl
              AND source_library_id = :source
              AND user_id = :uid
        """),
        {"dl": default_library_id, "source": source_library_id, "uid": user_id},
    ).fetchone()
    if job_exists is None:
        return "job_row_missing"

    # Check default_library_id is a default library owned by user_id
    dl_check = db.execute(
        text("""
            SELECT 1 FROM libraries
            WHERE id = :dl AND is_default = true AND owner_user_id = :uid
        """),
        {"dl": default_library_id, "uid": user_id},
    ).fetchone()
    if dl_check is None:
        return "default_library_invalid"

    # Check source_library_id is non-default
    src_check = db.execute(
        text("""
            SELECT is_default FROM libraries WHERE id = :source
        """),
        {"source": source_library_id},
    ).fetchone()
    if src_check is None:
        return "source_library_missing"
    if src_check[0]:
        return "source_library_is_default"

    return None


def claim_backfill_job_pending(
    db: Session,
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
) -> dict | None:
    """Atomically transition pending -> running via single statement.

    Returns dict with job row data if claimed, None if no pending row found.
    """
    now = datetime.now(UTC)
    result = db.execute(
        text("""
            UPDATE default_library_backfill_jobs
            SET status = 'running', updated_at = :now
            WHERE default_library_id = :dl
              AND source_library_id = :source
              AND user_id = :uid
              AND status = 'pending'
            RETURNING default_library_id, source_library_id, user_id,
                      status, attempts, last_error_code, created_at,
                      updated_at, finished_at
        """),
        {"dl": default_library_id, "source": source_library_id, "uid": user_id, "now": now},
    )
    row = result.fetchone()
    if row is None:
        return None
    return _backfill_row_to_dict(row)


def mark_backfill_job_completed(
    db: Session,
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
) -> bool:
    """Status-guarded running -> completed. Returns True if transition happened."""
    now = datetime.now(UTC)
    result = db.execute(
        text("""
            UPDATE default_library_backfill_jobs
            SET status = 'completed', finished_at = :now, updated_at = :now
            WHERE default_library_id = :dl
              AND source_library_id = :source
              AND user_id = :uid
              AND status = 'running'
        """),
        {"dl": default_library_id, "source": source_library_id, "uid": user_id, "now": now},
    )
    return result.rowcount > 0


def mark_backfill_job_failed(
    db: Session,
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
    error_code: str,
) -> int:
    """Status-guarded running -> failed, increment attempts.

    Returns the new attempts count (0 if no row was updated).
    """
    now = datetime.now(UTC)
    result = db.execute(
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
              AND status = 'running'
            RETURNING attempts
        """),
        {
            "dl": default_library_id,
            "source": source_library_id,
            "uid": user_id,
            "error_code": error_code,
            "now": now,
        },
    )
    row = result.fetchone()
    return row[0] if row else 0


def reset_backfill_job_to_pending_for_retry(
    db: Session,
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
) -> bool:
    """Transition failed -> pending for auto-retry. Clears finished_at and error_code."""
    now = datetime.now(UTC)
    result = db.execute(
        text("""
            UPDATE default_library_backfill_jobs
            SET status = 'pending',
                finished_at = NULL,
                last_error_code = NULL,
                updated_at = :now
            WHERE default_library_id = :dl
              AND source_library_id = :source
              AND user_id = :uid
              AND status = 'failed'
        """),
        {"dl": default_library_id, "source": source_library_id, "uid": user_id, "now": now},
    )
    return result.rowcount > 0


def requeue_backfill_job(
    db: Session,
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
) -> dict:
    """Operator requeue: reset pending|failed|completed -> pending.

    Lock the job row first. Returns dict with job state + idempotent/enqueue flags.
    Raises NotFoundError if row missing.
    """
    from nexus.errors import ApiErrorCode, NotFoundError

    row = db.execute(
        text("""
            SELECT default_library_id, source_library_id, user_id,
                   status, attempts, last_error_code, created_at,
                   updated_at, finished_at
            FROM default_library_backfill_jobs
            WHERE default_library_id = :dl
              AND source_library_id = :source
              AND user_id = :uid
            FOR UPDATE
        """),
        {"dl": default_library_id, "source": source_library_id, "uid": user_id},
    ).fetchone()

    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Backfill job not found")

    current_status = row[3]

    # Running -> idempotent no-op
    if current_status == "running":
        data = _backfill_row_to_dict(row)
        data["idempotent"] = True
        data["enqueue_dispatched"] = False
        return data

    # Reset to pending
    now = datetime.now(UTC)
    db.execute(
        text("""
            UPDATE default_library_backfill_jobs
            SET status = 'pending',
                attempts = 0,
                last_error_code = NULL,
                finished_at = NULL,
                updated_at = :now
            WHERE default_library_id = :dl
              AND source_library_id = :source
              AND user_id = :uid
        """),
        {"dl": default_library_id, "source": source_library_id, "uid": user_id, "now": now},
    )

    data = {
        "default_library_id": default_library_id,
        "source_library_id": source_library_id,
        "user_id": user_id,
        "status": "pending",
        "attempts": 0,
        "last_error_code": None,
        "updated_at": now,
        "finished_at": None,
        "idempotent": False,
        "enqueue_dispatched": False,
    }
    return data


def materialize_closure_for_source(
    db: Session,
    default_library_id: UUID,
    source_library_id: UUID,
) -> int:
    """Insert missing closure edges + materialized default rows for all media in source.

    Returns count of edges inserted. All inserts are idempotent.
    """
    result = db.execute(
        text("""
            INSERT INTO default_library_closure_edges
                (default_library_id, media_id, source_library_id)
            SELECT :dl, lm.media_id, :source
            FROM library_media lm
            WHERE lm.library_id = :source
            ON CONFLICT (default_library_id, media_id, source_library_id) DO NOTHING
        """),
        {"dl": default_library_id, "source": source_library_id},
    )
    edges_count = result.rowcount

    db.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            SELECT :dl, lm.media_id
            FROM library_media lm
            WHERE lm.library_id = :source
            ON CONFLICT (library_id, media_id) DO NOTHING
        """),
        {"dl": default_library_id, "source": source_library_id},
    )

    return edges_count


# ---------------------------------------------------------------------------
# Enqueue helper
# ---------------------------------------------------------------------------


def enqueue_backfill_task(
    default_library_id: UUID,
    source_library_id: UUID,
    user_id: UUID,
    request_id: str | None = None,
    countdown: int | None = None,
) -> bool:
    """Best-effort enqueue of backfill worker task.

    Never raises. Returns True if dispatch succeeded, False otherwise.
    In test env, skips dispatch and returns False.
    """
    settings = get_settings()
    if settings.nexus_env == Environment.TEST:
        logger.debug(
            "backfill_enqueue_skipped: test environment dl=%s src=%s user=%s",
            default_library_id,
            source_library_id,
            user_id,
        )
        return False

    try:
        from nexus.tasks.backfill_default_library_closure import (
            backfill_default_library_closure_job,
        )

        kwargs = {"request_id": request_id} if request_id else {}
        apply_kwargs: dict = {
            "args": [str(default_library_id), str(source_library_id), str(user_id)],
            "kwargs": kwargs,
            "queue": "ingest",
        }
        if countdown is not None:
            apply_kwargs["countdown"] = countdown

        backfill_default_library_closure_job.apply_async(**apply_kwargs)
        logger.info(
            "backfill_enqueue_ok: dl=%s src=%s user=%s countdown=%s",
            default_library_id,
            source_library_id,
            user_id,
            countdown,
        )
        return True
    except Exception:
        logger.exception(
            "backfill_enqueue_failed: dl=%s src=%s user=%s",
            default_library_id,
            source_library_id,
            user_id,
        )
        return False


# ---------------------------------------------------------------------------
# Backlog guardrail helper
# ---------------------------------------------------------------------------


def get_backfill_backlog_health(db: Session) -> dict:
    """Check backfill backlog health for guardrail monitoring.

    Returns dict with pending_count, pending_age_p95_seconds, degraded.
    """
    row = db.execute(
        text("""
            SELECT
                COUNT(*) AS pending_count,
                COALESCE(
                    EXTRACT(EPOCH FROM now())
                    - percentile_cont(0.05)
                          WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM updated_at)),
                    0
                ) AS pending_age_p95_seconds
            FROM default_library_backfill_jobs
            WHERE status = 'pending'
        """)
    ).fetchone()

    pending_count = row[0]
    pending_age_p95 = float(row[1])

    degraded = (
        pending_count > BACKFILL_PENDING_COUNT_GUARDRAIL
        or pending_age_p95 > BACKFILL_PENDING_AGE_P95_GUARDRAIL_SECONDS
    )

    return {
        "pending_count": pending_count,
        "pending_age_p95_seconds": pending_age_p95,
        "degraded": degraded,
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _backfill_row_to_dict(row: tuple) -> dict:
    """Convert a backfill job query row to dict."""
    return {
        "default_library_id": row[0],
        "source_library_id": row[1],
        "user_id": row[2],
        "status": row[3],
        "attempts": row[4],
        "last_error_code": row[5],
        "updated_at": row[7],
        "finished_at": row[8],
    }
