"""Postgres queue primitives: one durable table, one transition per function."""

from __future__ import annotations

import json
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.errors import integrity_constraint_name

PENDING = "pending"
RUNNING = "running"
SUCCEEDED = "succeeded"
FAILED = "failed"
DEAD = "dead"

TERMINAL_STATUSES = frozenset({SUCCEEDED, DEAD})

type JobResourceClass = Literal["Light", "Heavy"]

_CHAT_ADMISSION_LOCK_KEY = "codex-personal-generation-chat-admission.v1"

# The one definition of "the Heavy lease is occupied", interpolated into the claim
# candidate query and into the worker's idle wait. Constant, parameterless text.
HEAVY_CAPACITY_OCCUPIED_SQL = """EXISTS (
    SELECT 1 FROM background_job_capacity_leases
    WHERE resource_class = 'Heavy' AND job_id IS NOT NULL
      AND lease_expires_at > clock_timestamp()
)"""

# A row is claimable when it is due, or when its running lease expired with retry
# budget left. Both branches match a partial index on background_jobs.
_DUE_SQL = """
    (status IN ('pending', 'failed') AND available_at <= clock_timestamp())
    OR (status = 'running' AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= clock_timestamp() AND attempts < max_attempts)
"""

_LIVE_ATTEMPT_SQL = """
    SELECT * FROM background_jobs
    WHERE id = :job_id AND status = 'running' AND claimed_by = :worker_id
      AND attempts = :attempt_no AND lease_expires_at > clock_timestamp()
    FOR UPDATE
"""


@dataclass(frozen=True)
class JobRow:
    """Typed view of one background_jobs row."""

    id: UUID
    kind: str
    payload: dict[str, Any]
    status: str
    attempts: int
    max_attempts: int
    available_at: datetime
    lease_expires_at: datetime | None
    claimed_by: str | None
    execution_id: UUID | None
    dedupe_key: str | None
    error_code: str | None
    last_error: str | None
    result: dict[str, Any] | None
    started_at: datetime | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class JobExecutionContext:
    """Identity of one running attempt, threaded into every job handler.

    The lease-fenced primitives below require this exact running attempt,
    claimant and unexpired lease. ``execution_id`` is the claim's non-resetting
    identity: ``(job_id, attempts)`` repeats across a dead-job repair, this
    never does, so history names executions by it.
    """

    job_id: UUID
    worker_id: str
    attempt_no: int
    resource_class: JobResourceClass
    execution_id: UUID


@dataclass(frozen=True)
class ClaimedJob:
    """A freshly claimed attempt, and the execution it displaced when the claim
    reclaimed an expired running row."""

    job: JobRow
    context: JobExecutionContext
    reclaimed: bool
    displaced_execution_id: UUID | None


@dataclass(frozen=True)
class ScheduleAt:
    """Run the rescheduled attempt at one owned absolute instant."""

    instant: datetime


@dataclass(frozen=True)
class ScheduleAfter:
    """Run the rescheduled attempt after a delay measured on the database clock."""

    seconds: int


type RescheduleSchedule = ScheduleAt | ScheduleAfter


@dataclass(frozen=True)
class RescheduleRequested:
    """Handler return value asking the worker to self-reschedule this attempt.

    The worker calls :func:`reschedule_running_job` on the handler's behalf and
    settles nothing else for the attempt; handlers never call it directly.
    """

    schedule: RescheduleSchedule
    payload: Mapping[str, Any] | None = None


def lock_chat_generation_admission_in_current_transaction(db: Session) -> None:
    """Serialize Chat queue admission against new background generations."""
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": _CHAT_ADMISSION_LOCK_KEY},
    )


def _heavy_capacity_available(db: Session) -> bool:
    """Lock the single Heavy lease, reclaiming an expired holder, and report emptiness."""
    holder = (
        db.execute(
            text(
                "SELECT job_id, lease_expires_at > clock_timestamp() AS live"
                " FROM background_job_capacity_leases WHERE resource_class = 'Heavy' FOR UPDATE"
            )
        )
        .mappings()
        .one()
    )
    if holder["job_id"] is None:
        return True
    if holder["live"]:
        return False
    _release_heavy_capacity(db, UUID(str(holder["job_id"])))
    return True


def _lock_heavy_capacity_for_job(
    db: Session, *, job_id: UUID, worker_id: str, attempt_no: int
) -> bool:
    """Lock the Heavy lease and report whether this exact live attempt holds it."""
    return (
        db.execute(
            text(
                """
                SELECT job_id FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy' AND job_id = :job_id AND worker_id = :worker_id
                  AND attempt_no = :attempt_no AND lease_expires_at > clock_timestamp()
                FOR UPDATE
                """
            ),
            {"job_id": job_id, "worker_id": worker_id, "attempt_no": attempt_no},
        ).first()
        is not None
    )


def _release_heavy_capacity(db: Session, job_id: UUID) -> None:
    """Free the Heavy lease if this job holds it; a Light job matches nothing."""
    db.execute(
        text(
            """
            UPDATE background_job_capacity_leases
            SET job_id = NULL, worker_id = NULL, attempt_no = NULL, lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE resource_class = 'Heavy' AND job_id = :job_id
            """
        ),
        {"job_id": job_id},
    )


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
    if kind == "chat_run":
        lock_chat_generation_admission_in_current_transaction(db)
    row = _fetch_one_job(
        db,
        """
        INSERT INTO background_jobs (kind, payload, priority, max_attempts, available_at, dedupe_key)
        VALUES (:kind, CAST(:payload AS jsonb), :priority, :max_attempts,
                COALESCE(:available_at, now()), :dedupe_key)
        RETURNING *
        """,
        kind=kind,
        payload=json.dumps(dict(payload or {})),
        priority=priority,
        max_attempts=max_attempts,
        available_at=available_at,
        dedupe_key=dedupe_key,
    )
    _notify(db, kind)
    return row


def enqueue_unique_job(
    db: Session,
    *,
    kind: str,
    payload: Mapping[str, Any] | None = None,
    dedupe_key: str,
    priority: int = 100,
    max_attempts: int = 3,
    available_at: datetime | None = None,
) -> tuple[JobRow, bool]:
    """Insert one deduped job, returning the row and whether this call inserted it."""
    existing = _fetch_job(db, _BY_DEDUPE_KEY_SQL, dedupe_key=dedupe_key)
    if existing is not None:
        return existing, False
    try:
        with db.begin_nested():
            inserted = enqueue_job(
                db,
                kind=kind,
                payload=payload,
                priority=priority,
                max_attempts=max_attempts,
                available_at=available_at,
                dedupe_key=dedupe_key,
            )
        return inserted, True
    except IntegrityError as exc:
        if integrity_constraint_name(exc) != "idx_background_jobs_dedupe_key_unique":
            raise
        raced = _fetch_job(db, _BY_DEDUPE_KEY_SQL, dedupe_key=dedupe_key)
        if raced is None:
            raise
        return raced, False


_BY_DEDUPE_KEY_SQL = "SELECT * FROM background_jobs WHERE dedupe_key = :dedupe_key"


def claim_next_job(
    db: Session,
    *,
    worker_id: str,
    lease_seconds: int,
    heavy_kinds: Sequence[str],
    allowed_kinds: Sequence[str],
) -> ClaimedJob | None:
    """Claim the first due capacity-eligible job in canonical queue order."""
    candidate = (
        db.execute(
            text(
                f"""
                SELECT * FROM background_jobs
                WHERE ({_DUE_SQL})
                  AND kind = ANY(CAST(:allowed_kinds AS text[]))
                  AND (NOT (kind = ANY(CAST(:heavy_kinds AS text[])))
                       OR NOT {HEAVY_CAPACITY_OCCUPIED_SQL})
                ORDER BY priority ASC,
                         CASE WHEN status = 'running' THEN lease_expires_at ELSE available_at END,
                         created_at ASC, id ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
                """
            ),
            {"allowed_kinds": list(allowed_kinds), "heavy_kinds": list(heavy_kinds)},
        )
        .mappings()
        .first()
    )
    if candidate is None:
        return None
    return _claim_locked_job(db, candidate, worker_id, lease_seconds, frozenset(heavy_kinds))


def claim_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    lease_seconds: int,
    heavy_kinds: Sequence[str],
    allowed_kinds: Sequence[str],
) -> ClaimedJob | None:
    """Claim one exact due job so unrelated due work is never claimed as a side effect."""
    candidate = (
        db.execute(
            text(
                f"""
                SELECT * FROM background_jobs
                WHERE id = :job_id AND kind = ANY(CAST(:allowed_kinds AS text[])) AND ({_DUE_SQL})
                FOR UPDATE
                """
            ),
            {"job_id": job_id, "allowed_kinds": list(allowed_kinds)},
        )
        .mappings()
        .first()
    )
    if candidate is None:
        return None
    return _claim_locked_job(db, candidate, worker_id, lease_seconds, frozenset(heavy_kinds))


def _claim_locked_job(
    db: Session,
    candidate: Mapping[Any, Any],
    worker_id: str,
    lease_seconds: int,
    heavy_kinds: Collection[str],
) -> ClaimedJob | None:
    """Take the already-locked candidate row, and the Heavy lease when it needs one."""
    is_heavy = str(candidate["kind"]) in heavy_kinds
    if is_heavy and not _heavy_capacity_available(db):
        return None
    reclaimed = str(candidate["status"]) == RUNNING
    claimed = (
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET status = 'running', attempts = attempts + 1, claimed_by = :worker_id,
                    execution_id = gen_random_uuid(),
                    started_at = COALESCE(started_at, clock_timestamp()),
                    lease_expires_at =
                        clock_timestamp() + (CAST(:lease_seconds AS integer) * interval '1 second'),
                    error_code = CASE WHEN :reclaimed THEN 'E_WORKER_INTERRUPTED' ELSE error_code END,
                    last_error = CASE
                        WHEN :reclaimed THEN 'Worker lease expired; job reclaimed.' ELSE last_error
                    END,
                    updated_at = clock_timestamp()
                WHERE id = :job_id
                RETURNING *
                """
            ),
            {
                "job_id": candidate["id"],
                "worker_id": worker_id,
                "lease_seconds": lease_seconds,
                "reclaimed": reclaimed,
            },
        )
        .mappings()
        .one()
    )
    if is_heavy:
        db.execute(
            text(
                """
                UPDATE background_job_capacity_leases
                SET job_id = :job_id, worker_id = :worker_id, attempt_no = :attempt_no,
                    lease_expires_at = :lease_expires_at, updated_at = clock_timestamp()
                WHERE resource_class = 'Heavy'
                """
            ),
            {
                "job_id": claimed["id"],
                "worker_id": worker_id,
                "attempt_no": claimed["attempts"],
                "lease_expires_at": claimed["lease_expires_at"],
            },
        )
    job = _row_to_job(claimed)
    displaced = candidate["execution_id"]
    return ClaimedJob(
        job=job,
        context=JobExecutionContext(
            job_id=job.id,
            worker_id=worker_id,
            attempt_no=job.attempts,
            resource_class="Heavy" if is_heavy else "Light",
            execution_id=UUID(str(claimed["execution_id"])),
        ),
        reclaimed=reclaimed,
        displaced_execution_id=UUID(str(displaced)) if reclaimed and displaced else None,
    )


def dead_letter_expired_job(db: Session, *, allowed_kinds: Sequence[str]) -> JobRow | None:
    """Mark one exhausted, expired running job dead so the caller can repair it here."""
    job = _fetch_job(
        db,
        """
        WITH candidate AS (
            SELECT id FROM background_jobs
            WHERE status = 'running' AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= now() AND attempts >= max_attempts
              AND kind = ANY(:allowed_kinds)
            ORDER BY lease_expires_at ASC, created_at ASC, id ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE background_jobs j
        SET status = 'dead', lease_expires_at = NULL, claimed_by = NULL, finished_at = now(),
            error_code = 'E_WORKER_INTERRUPTED',
            last_error = 'Worker lease expired after max attempts.', updated_at = now()
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING j.*
        """,
        allowed_kinds=list(allowed_kinds),
    )
    if job is not None:
        _release_heavy_capacity(db, job.id)
    return job


def get_job(db: Session, job_id: UUID) -> JobRow | None:
    """Read one queue row."""
    return _fetch_job(db, "SELECT * FROM background_jobs WHERE id = :job_id", job_id=job_id)


def lock_job(db: Session, job_id: UUID) -> JobRow | None:
    """Lock one queue row for a composing domain mutation."""
    return _fetch_job(
        db, "SELECT * FROM background_jobs WHERE id = :job_id FOR UPDATE", job_id=job_id
    )


def lock_running_job_attempt(
    db: Session, *, job_id: UUID, worker_id: str, attempt_no: int
) -> JobRow | None:
    """Lock one exact live attempt as terminal-write authority for this transaction."""
    return _fetch_job(
        db, _LIVE_ATTEMPT_SQL, job_id=job_id, worker_id=worker_id, attempt_no=attempt_no
    )


def lock_running_job_claim(db: Session, *, context: JobExecutionContext) -> bool:
    """Fence one effect transaction to the exact live running attempt."""
    return _lock_context_attempt(db, context) is not None


def _lock_context_attempt(db: Session, context: JobExecutionContext) -> JobRow | None:
    return lock_running_job_attempt(
        db,
        job_id=context.job_id,
        worker_id=context.worker_id,
        attempt_no=context.attempt_no,
    )


def running_job_claim_is_current(
    db: Session, *, job_id: UUID, worker_id: str, attempt_no: int
) -> bool:
    """Whether this exact running attempt still owns an unexpired lease."""
    return bool(
        db.execute(
            text(
                """
                SELECT EXISTS(
                    SELECT 1 FROM background_jobs
                    WHERE id = :job_id AND status = 'running' AND claimed_by = :worker_id
                      AND attempts = :attempt_no AND lease_expires_at > now()
                )
                """
            ),
            {"job_id": job_id, "worker_id": worker_id, "attempt_no": attempt_no},
        ).scalar_one()
    )


def heartbeat_job(
    *,
    session_factory: Callable[[], Session],
    context: JobExecutionContext,
    lease_seconds: int,
) -> bool:
    """Extend one exact running attempt and its Heavy lease, owning the Session.

    Owning the Session keeps the heartbeat thread from committing a caller's
    partial state; the job lock is always taken before the capacity lock.
    """
    with session_factory() as db, db.begin():
        if _lock_context_attempt(db, context) is None or not _holds_capacity(db, context):
            return False
        _renew_lease(db, context=context, lease_seconds=lease_seconds)
    return True


def lock_and_renew_running_job_claim(
    db: Session, *, context: JobExecutionContext, lease_seconds: int
) -> JobRow | None:
    """Lock and renew the exact current attempt, holding both locks through commit.

    Callers publish authoritative domain state only after this succeeds, and
    commit before the renewed lease expires.
    """
    if _lock_context_attempt(db, context) is None or not _holds_capacity(db, context):
        return None
    return _renew_lease(db, context=context, lease_seconds=lease_seconds)


def _holds_capacity(db: Session, context: JobExecutionContext) -> bool:
    """A Light attempt needs no lease; a Heavy one must still hold the single lease."""
    return context.resource_class == "Light" or _lock_heavy_capacity_for_job(
        db,
        job_id=context.job_id,
        worker_id=context.worker_id,
        attempt_no=context.attempt_no,
    )


def _renew_lease(db: Session, *, context: JobExecutionContext, lease_seconds: int) -> JobRow:
    """Write one identical new expiry to the locked job and its Heavy lease."""
    row = _fetch_one_job(
        db,
        """
        UPDATE background_jobs
        SET lease_expires_at =
                clock_timestamp() + (CAST(:lease_seconds AS integer) * interval '1 second'),
            updated_at = clock_timestamp()
        WHERE id = :job_id
        RETURNING *
        """,
        job_id=context.job_id,
        lease_seconds=lease_seconds,
    )
    if context.resource_class == "Heavy":
        db.execute(
            text(
                """
                UPDATE background_job_capacity_leases
                SET lease_expires_at = :lease_expires_at, updated_at = clock_timestamp()
                WHERE resource_class = 'Heavy' AND job_id = :job_id
                """
            ),
            {"job_id": context.job_id, "lease_expires_at": row.lease_expires_at},
        )
    return row


def update_running_job_payload(
    db: Session, *, job_id: UUID, worker_id: str, attempt_no: int, payload: Mapping[str, Any]
) -> bool:
    """Lease-fenced durable checkpoint write of a running job's whole payload."""
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET payload = CAST(:payload AS jsonb), updated_at = now()
            WHERE id = :job_id AND status = 'running' AND claimed_by = :worker_id
              AND attempts = :attempt_no AND lease_expires_at > now()
            RETURNING id
            """
        ),
        {
            "job_id": job_id,
            "worker_id": worker_id,
            "attempt_no": attempt_no,
            "payload": json.dumps(dict(payload)),
        },
    ).first()
    return updated is not None


def reschedule_running_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
    schedule: RescheduleSchedule,
    payload: Mapping[str, Any] | None = None,
) -> bool:
    """Return one running attempt to pending at a new time, refunding its attempt."""
    if (
        lock_running_job_attempt(db, job_id=job_id, worker_id=worker_id, attempt_no=attempt_no)
        is None
    ):
        return False
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'pending',
                available_at = CASE
                    WHEN CAST(:delay_seconds AS integer) IS NULL THEN CAST(:instant AS timestamptz)
                    ELSE now() + (CAST(:delay_seconds AS integer) * interval '1 second')
                END,
                payload = COALESCE(CAST(:payload AS jsonb), payload),
                attempts = GREATEST(attempts - 1, 0), claimed_by = NULL, lease_expires_at = NULL,
                updated_at = now()
            WHERE id = :job_id
            """
        ),
        {
            "job_id": job_id,
            "instant": schedule.instant if isinstance(schedule, ScheduleAt) else None,
            "delay_seconds": None if isinstance(schedule, ScheduleAt) else schedule.seconds,
            "payload": None if payload is None else json.dumps(dict(payload)),
        },
    )
    _release_heavy_capacity(db, job_id)
    return True


def complete_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
    result_payload: Mapping[str, Any] | None = None,
) -> bool:
    """Mark one exact live running attempt succeeded and clear its failure history."""
    if (
        lock_running_job_attempt(db, job_id=job_id, worker_id=worker_id, attempt_no=attempt_no)
        is None
    ):
        return False
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'succeeded', result = CAST(:result AS jsonb), lease_expires_at = NULL,
                claimed_by = NULL, error_code = NULL, last_error = NULL, finished_at = now(),
                updated_at = now()
            WHERE id = :job_id
            """
        ),
        {"job_id": job_id, "result": _json_or_none(result_payload)},
    )
    _release_heavy_capacity(db, job_id)
    return True


def fail_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
    error_code: str,
    error_message: str,
    retry_delays_seconds: Sequence[int],
    result_payload: Mapping[str, Any] | None = None,
    force_dead: bool = False,
) -> JobRow | None:
    """Apply the retry-or-dead transition to one exact live running attempt."""
    owned = lock_running_job_attempt(db, job_id=job_id, worker_id=worker_id, attempt_no=attempt_no)
    if owned is None:
        return None
    is_dead = force_dead or owned.attempts >= owned.max_attempts
    failed = _fetch_job(
        db,
        """
        UPDATE background_jobs
        SET status = :status,
            available_at = now() + (CAST(:retry_delay AS integer) * interval '1 second'),
            lease_expires_at = NULL, claimed_by = NULL, error_code = :error_code,
            last_error = :last_error, result = CAST(:result AS jsonb),
            finished_at = CASE WHEN :is_dead THEN now() ELSE NULL END, updated_at = now()
        WHERE id = :job_id
        RETURNING *
        """,
        job_id=job_id,
        status=DEAD if is_dead else FAILED,
        error_code=error_code,
        last_error=error_message[:1000],
        retry_delay=0 if is_dead else _retry_delay(owned.attempts, retry_delays_seconds),
        is_dead=is_dead,
        result=_json_or_none(result_payload),
    )
    _release_heavy_capacity(db, job_id)
    if not is_dead:
        _notify(db, owned.kind)
    return failed


def requeue_dead_job(db: Session, *, job_id: UUID) -> bool:
    """Operator repair: dead -> pending with a fresh attempt budget, error preserved."""
    status = db.execute(
        text("SELECT status FROM background_jobs WHERE id = :job_id FOR UPDATE"),
        {"job_id": job_id},
    ).scalar_one_or_none()
    if status != DEAD:
        return False
    kind = db.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'pending', attempts = 0, available_at = now(), claimed_by = NULL,
                lease_expires_at = NULL, finished_at = NULL, updated_at = now()
            WHERE id = :job_id
            RETURNING kind
            """
        ),
        {"job_id": job_id},
    ).scalar_one()
    _notify(db, str(kind))
    return True


def promote_unclaimed_job(
    db: Session,
    *,
    job_id: UUID,
    kind: str,
    payload: Mapping[str, Any],
    dedupe_key: str,
    priority: int,
) -> bool:
    """Make one exact pending operation due now without replacing a live claim."""
    row = lock_job(db, job_id)
    if row is None:
        raise RuntimeError("Queue promotion target is missing")
    if row.kind != kind or row.payload != dict(payload) or (row.dedupe_key or "") != dedupe_key:
        raise RuntimeError("Queue promotion target does not match the exact operation")
    if row.status == RUNNING:
        return False
    if row.status not in {PENDING, FAILED} or row.claimed_by is not None:
        raise RuntimeError("Queue promotion target is not an active unclaimed operation")
    db.execute(
        text(
            "UPDATE background_jobs SET priority = :priority, available_at = now(),"
            " updated_at = now() WHERE id = :job_id"
        ),
        {"job_id": job_id, "priority": priority},
    )
    _notify(db, kind)
    return True


def update_unclaimed_job(
    db: Session,
    *,
    job_id: UUID,
    kind: str,
    expected_payload_match: Mapping[str, Any],
    payload: Mapping[str, Any],
    available_at: datetime | None = None,
) -> bool:
    """Pre-claim CAS update of a still-pending, unclaimed job matched by payload."""
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET payload = CAST(:payload AS jsonb),
                available_at = COALESCE(:available_at, available_at), updated_at = now()
            WHERE id = :job_id AND status = 'pending' AND claimed_by IS NULL AND kind = :kind
              AND payload @> CAST(:match AS jsonb)
            RETURNING id
            """
        ),
        {
            "job_id": job_id,
            "kind": kind,
            "match": json.dumps(dict(expected_payload_match)),
            "payload": json.dumps(dict(payload)),
            "available_at": available_at,
        },
    ).first()
    return updated is not None


def reset_unclaimed_job_for_new_intent(
    db: Session, *, job_id: UUID, kind: str, payload: Mapping[str, Any], max_attempts: int
) -> JobRow:
    """Replace one waiting job with a genuinely new intent and retry budget."""
    row = _fetch_job(
        db,
        """
        UPDATE background_jobs
        SET payload = CAST(:payload AS jsonb), status = 'pending', attempts = 0,
            max_attempts = :max_attempts, available_at = now(), lease_expires_at = NULL,
            claimed_by = NULL, error_code = NULL, last_error = NULL, result = NULL,
            started_at = NULL, finished_at = NULL, updated_at = now()
        WHERE id = :job_id AND kind = :kind AND status IN ('pending', 'failed')
          AND claimed_by IS NULL
        RETURNING *
        """,
        job_id=job_id,
        kind=kind,
        payload=json.dumps(dict(payload)),
        max_attempts=max_attempts,
    )
    if row is None:
        raise RuntimeError("Queue reset target is not an active unclaimed operation")
    _notify(db, kind)
    return row


def supersede_unclaimed_job(db: Session, *, job_id: UUID, kind: str) -> None:
    """Complete one obsolete waiting operation, skipping a row another writer holds.

    SKIP LOCKED never skips a row this transaction already locked, and waiting on
    a foreign lock here would close a wait cycle with the worker's settlement.
    """
    db.execute(
        text(
            """
            WITH waiting AS (
                SELECT id FROM background_jobs
                WHERE id = :job_id AND kind = :kind AND status IN ('pending', 'failed')
                  AND claimed_by IS NULL
                FOR UPDATE SKIP LOCKED
            )
            UPDATE background_jobs
            SET status = 'succeeded', result = '{"status":"superseded"}'::jsonb,
                lease_expires_at = NULL, claimed_by = NULL, finished_at = now(),
                updated_at = now()
            FROM waiting
            WHERE background_jobs.id = waiting.id
            """
        ),
        {"job_id": job_id, "kind": kind},
    )


def revoke_jobs_by_dedupe_keys(db: Session, *, kind: str, dedupe_keys: Collection[str]) -> None:
    """Delete owned queue rows and their payload-carried replay state.

    The caller invalidates the domain owner under its own lock first; a running
    worker then loses both its queue lease and its domain target.
    """
    if not dedupe_keys:
        return
    targets = (
        db.execute(
            text(
                "SELECT id FROM background_jobs WHERE kind = :kind"
                " AND dedupe_key = ANY(:dedupe_keys) ORDER BY id ASC FOR UPDATE"
            ),
            {"kind": kind, "dedupe_keys": list(dedupe_keys)},
        )
        .scalars()
        .all()
    )
    for job_id in targets:
        _release_heavy_capacity(db, UUID(str(job_id)))
    db.execute(
        text("DELETE FROM background_jobs WHERE id = ANY(:job_ids)"), {"job_ids": list(targets)}
    )


def find_nonterminal_jobs_for_payload(
    db: Session, *, kind: str, expected_payload_match: Mapping[str, Any]
) -> list[JobRow]:
    """Every pending/running/failed job of one kind whose payload contains the match."""
    return _fetch_jobs(
        db,
        """
        SELECT * FROM background_jobs
        WHERE kind = :kind AND status NOT IN ('succeeded', 'dead')
          AND payload @> CAST(:match AS jsonb)
        ORDER BY created_at ASC, id ASC
        """,
        kind=kind,
        match=json.dumps(dict(expected_payload_match)),
    )


def lock_jobs_for_payload(
    db: Session, *, kind: str, expected_payload_match: Mapping[str, Any]
) -> list[JobRow]:
    """Lock every queue row for one domain identity in stable order."""
    return _fetch_jobs(
        db,
        """
        SELECT * FROM background_jobs
        WHERE kind = :kind AND payload @> CAST(:match AS jsonb)
        ORDER BY id ASC
        FOR UPDATE
        """,
        kind=kind,
        match=json.dumps(dict(expected_payload_match)),
    )


def current_dead_job_for_payload(
    db: Session, *, kind: str, expected_payload_match: Mapping[str, Any]
) -> JobRow | None:
    """Lock and return the exact dead job for one current domain identity."""
    return _fetch_job(
        db,
        """
        SELECT * FROM background_jobs
        WHERE kind = :kind AND status = 'dead' AND payload @> CAST(:match AS jsonb)
        ORDER BY id ASC
        FOR UPDATE
        """,
        kind=kind,
        match=json.dumps(dict(expected_payload_match)),
    )


def parser_operation_has_live_job(db: Session, *, operation_id: UUID) -> bool:
    """Whether a parser-temp owner has exact nonterminal source or reindex work."""
    return bool(
        db.execute(
            text(
                """
                SELECT EXISTS (
                    SELECT 1
                    FROM media_source_attempts attempt
                    JOIN background_jobs job ON job.id = attempt.job_id
                    WHERE attempt.id = :operation_id AND job.kind = 'ingest_media_source'
                      AND job.payload @> jsonb_build_object(
                          'attempt_id', attempt.id::text, 'media_id', attempt.media_id::text)
                      AND job.status IN ('pending', 'failed', 'running')
                    UNION ALL
                    SELECT 1
                    FROM background_jobs job
                    WHERE job.id = :operation_id AND job.kind = 'media_content_reindex_job'
                      AND job.status IN ('pending', 'failed', 'running')
                )
                """
            ),
            {"operation_id": operation_id},
        ).scalar_one()
    )


def prune_terminal_jobs(
    db: Session,
    *,
    succeeded_after_days: int,
    dead_after_days: int,
    limit: int,
    excluded_dead_kinds: Collection[str] = (),
) -> int:
    """Delete old terminal rows; dead rows of excluded kinds stay discoverable."""
    deleted = db.execute(
        text(
            """
            DELETE FROM background_jobs
            WHERE id IN (
                SELECT id FROM background_jobs
                WHERE (status = 'succeeded' AND finished_at IS NOT NULL
                       AND finished_at < now() - (CAST(:succeeded_days AS integer) * interval '1 day'))
                   OR (status = 'dead' AND finished_at IS NOT NULL
                       AND finished_at < now() - (CAST(:dead_days AS integer) * interval '1 day')
                       AND NOT (kind = ANY(CAST(:excluded_dead_kinds AS text[]))))
                ORDER BY finished_at ASC, id ASC
                LIMIT :limit
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id
            """
        ),
        {
            "succeeded_days": succeeded_after_days,
            "dead_days": dead_after_days,
            "limit": limit,
            "excluded_dead_kinds": list(excluded_dead_kinds),
        },
    ).all()
    return len(deleted)


def _fetch_job(db: Session, sql: str, /, **params: Any) -> JobRow | None:
    """Run one job-row statement and decode its first row."""
    row = db.execute(text(sql), params).mappings().first()
    return None if row is None else _row_to_job(row)


def _fetch_one_job(db: Session, sql: str, /, **params: Any) -> JobRow:
    """Run one job-row statement that must return exactly one row."""
    return _row_to_job(db.execute(text(sql), params).mappings().one())


def _fetch_jobs(db: Session, sql: str, /, **params: Any) -> list[JobRow]:
    """Run one job-row statement and decode every row."""
    return [_row_to_job(row) for row in db.execute(text(sql), params).mappings().all()]


def _notify(db: Session, kind: str) -> None:
    db.execute(text("SELECT pg_notify('nexus_background_jobs', :kind)"), {"kind": kind})


def _json_or_none(payload: Mapping[str, Any] | None) -> str | None:
    return None if payload is None else json.dumps(dict(payload))


def _retry_delay(attempt_number: int, retry_delays_seconds: Sequence[int]) -> int:
    if not retry_delays_seconds:
        return 0
    return retry_delays_seconds[min(max(attempt_number - 1, 0), len(retry_delays_seconds) - 1)]


def _row_to_job(row: Mapping[Any, Any]) -> JobRow:
    return JobRow(
        id=UUID(str(row["id"])),
        kind=str(row["kind"]),
        payload=dict(row["payload"] or {}),
        status=str(row["status"]),
        attempts=int(row["attempts"]),
        max_attempts=int(row["max_attempts"]),
        available_at=row["available_at"],
        lease_expires_at=row["lease_expires_at"],
        claimed_by=row["claimed_by"],
        execution_id=None if row["execution_id"] is None else UUID(str(row["execution_id"])),
        dedupe_key=row["dedupe_key"],
        error_code=row["error_code"],
        last_error=row["last_error"],
        result=dict(row["result"]) if row["result"] is not None else None,
        started_at=row["started_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
