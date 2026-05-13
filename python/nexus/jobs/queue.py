"""Central Postgres queue primitives for durable background jobs."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

PENDING = "pending"
RUNNING = "running"
SUCCEEDED = "succeeded"
FAILED = "failed"
DEAD = "dead"

TERMINAL_STATUSES = frozenset({SUCCEEDED, DEAD})


@dataclass(frozen=True)
class JobRow:
    """Typed view of one background_jobs row."""

    id: UUID
    kind: str
    payload: dict[str, Any]
    status: str
    priority: int
    attempts: int
    max_attempts: int
    available_at: datetime
    lease_expires_at: datetime | None
    claimed_by: str | None
    dedupe_key: str | None
    error_code: str | None
    last_error: str | None
    result: dict[str, Any] | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime


def enqueue_job(
    db: Session,
    *,
    kind: str,
    payload: Mapping[str, Any] | None = None,
    priority: int = 100,
    max_attempts: int = 3,
    available_at: datetime | None = None,
    dedupe_key: str | None = None,
) -> JobRow:
    """Insert one background job row without forcing commit."""
    row = (
        db.execute(
            text(
                """
                INSERT INTO background_jobs (
                    kind,
                    payload,
                    status,
                    priority,
                    attempts,
                    max_attempts,
                    available_at,
                    lease_expires_at,
                    claimed_by,
                    dedupe_key,
                    error_code,
                    last_error,
                    result,
                    started_at,
                    finished_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    :kind,
                    CAST(:payload AS jsonb),
                    'pending',
                    :priority,
                    0,
                    :max_attempts,
                    COALESCE(:available_at, now()),
                    NULL,
                    NULL,
                    :dedupe_key,
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    now(),
                    now()
                )
                RETURNING *
                """
            ),
            {
                "kind": kind,
                "payload": json.dumps(dict(payload or {})),
                "priority": int(priority),
                "max_attempts": max(int(max_attempts), 1),
                "available_at": available_at,
                "dedupe_key": dedupe_key,
            },
        )
        .mappings()
        .one()
    )
    return _row_to_job(row)


def enqueue_unique_job(
    db: Session,
    *,
    kind: str,
    payload: Mapping[str, Any] | None = None,
    dedupe_key: str,
    priority: int = 100,
    max_attempts: int = 3,
    available_at: datetime | None = None,
) -> JobRow:
    """Insert one deduped job by dedupe_key, returning the existing row when present."""
    inserted = (
        db.execute(
            text(
                """
                INSERT INTO background_jobs (
                    kind,
                    payload,
                    status,
                    priority,
                    attempts,
                    max_attempts,
                    available_at,
                    lease_expires_at,
                    claimed_by,
                    dedupe_key,
                    error_code,
                    last_error,
                    result,
                    started_at,
                    finished_at,
                    created_at,
                    updated_at
                )
                VALUES (
                    :kind,
                    CAST(:payload AS jsonb),
                    'pending',
                    :priority,
                    0,
                    :max_attempts,
                    COALESCE(:available_at, now()),
                    NULL,
                    NULL,
                    :dedupe_key,
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    NULL,
                    now(),
                    now()
                )
                ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
                DO NOTHING
                RETURNING *
                """
            ),
            {
                "kind": kind,
                "payload": json.dumps(dict(payload or {})),
                "priority": int(priority),
                "max_attempts": max(int(max_attempts), 1),
                "available_at": available_at,
                "dedupe_key": dedupe_key,
            },
        )
        .mappings()
        .first()
    )
    if inserted is not None:
        return _row_to_job(inserted)

    existing = (
        db.execute(
            text("SELECT * FROM background_jobs WHERE dedupe_key = :dedupe_key"),
            {"dedupe_key": dedupe_key},
        )
        .mappings()
        .first()
    )
    if existing is not None:
        return _row_to_job(existing)

    raise RuntimeError(f"Concurrent enqueue for dedupe_key={dedupe_key!r} did not commit.")


def claim_next_job(
    db: Session,
    *,
    worker_id: str,
    lease_seconds: int,
    allowed_kinds: Sequence[str] | None = None,
) -> JobRow | None:
    """Claim one due job atomically using FOR UPDATE SKIP LOCKED."""
    if allowed_kinds is not None and len(allowed_kinds) == 0:
        return None

    claimed = (
        db.execute(
            text(
                """
                WITH candidate AS (
                    SELECT id
                    FROM (
                        SELECT id, priority, ready_at, created_at
                        FROM (
                            SELECT id, priority, available_at AS ready_at, created_at
                            FROM background_jobs
                            WHERE status IN ('pending', 'failed')
                              AND available_at <= now()
                              AND (:allow_all_kinds OR kind = ANY(:allowed_kinds))
                            ORDER BY priority ASC, available_at ASC, created_at ASC, id ASC
                            FOR UPDATE SKIP LOCKED
                            LIMIT 1
                        ) due

                        UNION ALL

                        SELECT id, priority, ready_at, created_at
                        FROM (
                            SELECT id, priority, lease_expires_at AS ready_at, created_at
                            FROM background_jobs
                            WHERE status = 'running'
                              AND lease_expires_at IS NOT NULL
                              AND lease_expires_at <= now()
                              AND (:allow_all_kinds OR kind = ANY(:allowed_kinds))
                            ORDER BY priority ASC, lease_expires_at ASC, created_at ASC, id ASC
                            FOR UPDATE SKIP LOCKED
                            LIMIT 1
                        ) expired
                    ) candidates
                    ORDER BY priority ASC, ready_at ASC, created_at ASC, id ASC
                    LIMIT 1
                )
                UPDATE background_jobs j
                SET
                    status = 'running',
                    attempts = j.attempts + 1,
                    claimed_by = :worker_id,
                    started_at = COALESCE(j.started_at, now()),
                    lease_expires_at = now() + (CAST(:lease_seconds AS integer) * interval '1 second'),
                    updated_at = now()
                FROM candidate
                WHERE j.id = candidate.id
                RETURNING j.*
                """
            ),
            {
                "worker_id": worker_id,
                "lease_seconds": max(int(lease_seconds), 1),
                "allow_all_kinds": allowed_kinds is None,
                "allowed_kinds": list(allowed_kinds or []),
            },
        )
        .mappings()
        .first()
    )
    if claimed is None:
        return None
    return _row_to_job(claimed)


def heartbeat_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    lease_seconds: int,
) -> bool:
    """Extend lease for one running row owned by worker_id."""
    updated = db.execute(
        text(
            """
                UPDATE background_jobs
                SET
                    lease_expires_at = now() + (CAST(:lease_seconds AS integer) * interval '1 second'),
                    updated_at = now()
                WHERE id = :job_id
                  AND status = 'running'
                  AND claimed_by = :worker_id
                RETURNING id
                """
        ),
        {
            "job_id": job_id,
            "worker_id": worker_id,
            "lease_seconds": max(int(lease_seconds), 1),
        },
    ).first()
    return updated is not None


def complete_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    result_payload: Mapping[str, Any] | None = None,
) -> bool:
    """Mark one running row as succeeded when owned by worker_id."""
    updated = db.execute(
        text(
            """
                UPDATE background_jobs
                SET
                    status = 'succeeded',
                    result = CAST(:result_payload AS jsonb),
                    lease_expires_at = NULL,
                    claimed_by = NULL,
                    finished_at = now(),
                    updated_at = now()
                WHERE id = :job_id
                  AND status = 'running'
                  AND claimed_by = :worker_id
                RETURNING id
                """
        ),
        {
            "job_id": job_id,
            "worker_id": worker_id,
            "result_payload": (
                json.dumps(dict(result_payload)) if result_payload is not None else None
            ),
        },
    ).first()
    return updated is not None


def fail_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    error_code: str,
    error_message: str,
    retry_delays_seconds: Sequence[int],
) -> str | None:
    """Apply retry/dead transition for a failed running job owned by worker_id."""
    row = (
        db.execute(
            text(
                """
                SELECT id, status, attempts, max_attempts
                FROM background_jobs
                WHERE id = :job_id
                  AND status = 'running'
                  AND claimed_by = :worker_id
                FOR UPDATE
                """
            ),
            {"job_id": job_id, "worker_id": worker_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        return None

    attempts = int(row["attempts"])
    max_attempts = int(row["max_attempts"])
    should_dead_letter = attempts >= max_attempts

    if should_dead_letter:
        new_status = DEAD
        retry_delay_seconds = 0
    else:
        retry_delay_seconds = _retry_delay_for_attempt(attempts, retry_delays_seconds)
        new_status = FAILED

    db.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = :status,
                available_at = now() + (CAST(:retry_delay_seconds AS integer) * interval '1 second'),
                lease_expires_at = NULL,
                claimed_by = NULL,
                error_code = :error_code,
                last_error = :last_error,
                finished_at = CASE WHEN :is_dead THEN now() ELSE NULL END,
                updated_at = now()
            WHERE id = :job_id
            """
        ),
        {
            "job_id": job_id,
            "status": new_status,
            "error_code": error_code,
            "last_error": error_message[:1000],
            "retry_delay_seconds": retry_delay_seconds,
            "is_dead": should_dead_letter,
        },
    )
    return new_status


def requeue_job(
    db: Session,
    *,
    job_id: UUID,
    delay_seconds: int = 0,
) -> bool:
    """Move failed/dead row back to pending for operator-initiated replay."""
    updated = db.execute(
        text(
            """
                UPDATE background_jobs
                SET
                    status = 'pending',
                    available_at = now() + (CAST(:delay_seconds AS integer) * interval '1 second'),
                    lease_expires_at = NULL,
                    claimed_by = NULL,
                    error_code = NULL,
                    last_error = NULL,
                    finished_at = NULL,
                    updated_at = now()
                WHERE id = :job_id
                  AND status IN ('failed', 'dead')
                RETURNING id
                """
        ),
        {
            "job_id": job_id,
            "delay_seconds": max(int(delay_seconds), 0),
        },
    ).first()
    return updated is not None


def prune_terminal_jobs(
    db: Session,
    *,
    succeeded_after_days: int,
    dead_after_days: int,
    limit: int,
) -> int:
    """Delete old terminal queue rows from the hot background_jobs table."""
    deleted = (
        db.execute(
            text(
                """
                DELETE FROM background_jobs
                WHERE id IN (
                    SELECT id
                    FROM background_jobs
                    WHERE (
                        status = 'succeeded'
                        AND finished_at IS NOT NULL
                        AND finished_at < now() - (CAST(:succeeded_after_days AS integer) * interval '1 day')
                    )
                    OR (
                        status = 'dead'
                        AND finished_at IS NOT NULL
                        AND finished_at < now() - (CAST(:dead_after_days AS integer) * interval '1 day')
                    )
                    ORDER BY finished_at ASC, id ASC
                    LIMIT :limit
                    FOR UPDATE SKIP LOCKED
                )
                RETURNING id
                """
            ),
            {
                "succeeded_after_days": max(int(succeeded_after_days), 1),
                "dead_after_days": max(int(dead_after_days), 1),
                "limit": max(int(limit), 1),
            },
        )
        .mappings()
        .all()
    )
    return len(deleted)


def _retry_delay_for_attempt(attempt_number: int, retry_delays_seconds: Sequence[int]) -> int:
    if not retry_delays_seconds:
        return 0
    index = min(max(int(attempt_number) - 1, 0), len(retry_delays_seconds) - 1)
    return max(int(retry_delays_seconds[index]), 0)


def _row_to_job(row: Mapping[Any, Any]) -> JobRow:
    return JobRow(
        id=UUID(str(row["id"])),
        kind=str(row["kind"]),
        payload=dict(row["payload"] or {}),
        status=str(row["status"]),
        priority=int(row["priority"]),
        attempts=int(row["attempts"]),
        max_attempts=int(row["max_attempts"]),
        available_at=row["available_at"],
        lease_expires_at=row["lease_expires_at"],
        claimed_by=row["claimed_by"],
        dedupe_key=row["dedupe_key"],
        error_code=row["error_code"],
        last_error=row["last_error"],
        result=dict(row["result"]) if row["result"] is not None else None,
        started_at=row["started_at"],
        finished_at=row["finished_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
