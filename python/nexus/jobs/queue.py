"""Central Postgres queue primitives for durable background jobs."""

from __future__ import annotations

import json
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, assert_never
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

type JobFailureTransition = Literal["failed", "dead"]
"""The two outcomes of a failed attempt: scheduled retry or dead letter."""

PERIODIC_PRIORITY_RECONCILIATION_LIMIT = 256
_PERIODIC_IDENTITY_PAYLOAD_KEYS = frozenset({"request_id", "scheduler_identity"})

_CHAT_GENERATION_ADMISSION_LOCK_KEY = "codex-personal-generation-chat-admission.v1"

type JobResourceClass = Literal["Light", "Heavy"]


def lock_chat_generation_admission_in_current_transaction(db: Session) -> None:
    """Serialize Chat queue admission against new background generations.

    Chat mutation owners take this before domain row locks; ``_insert_job_row``
    repeats it as a re-entrant doorway assertion. Background generation takes
    its generation-owner lock, then this lock, then atomically arms dispatch.
    """

    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": _CHAT_GENERATION_ADMISSION_LOCK_KEY},
    )


_INSERT_JOB_SQL = text(
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
)


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
    """Identity of one running worker attempt, threaded into every job handler.

    The worker builds this from the claimed row and passes it to
    `JobDefinition.handler` as a required keyword argument alongside payload.
    Handlers that need a durable checkpoint or self-reschedule use these exact
    values (job_id, worker_id, attempt_no) with the lease-fenced primitives
    below -- queue-owned checkpoint writes from a worker require that exact
    running attempt, claimant, and unexpired lease. ``execution_id`` is the
    claim's non-resetting identity: ``(job_id, attempts)`` repeats across a
    dead-job repair, this never does, so history names executions by it.
    """

    job_id: UUID
    worker_id: str
    attempt_no: int
    resource_class: JobResourceClass
    execution_id: UUID


@dataclass(frozen=True)
class InterruptedExecution:
    """A claim reclaimed an expired running row; ``execution_id`` is that row's
    previous execution, ``None`` when it was claimed before execution identity
    existed."""

    execution_id: UUID | None


@dataclass(frozen=True)
class ClaimedJob:
    job: JobRow
    interrupted: InterruptedExecution | None


@dataclass(frozen=True)
class ScheduleAt:
    """Run the rescheduled attempt at one owned absolute instant."""

    instant: datetime


@dataclass(frozen=True)
class ScheduleAfter:
    """Run the rescheduled attempt after a delay measured on the database clock."""

    seconds: int

    def __post_init__(self) -> None:
        # justify-service-invariant-check: a non-negative integer is not
        # expressible in the type system.
        if self.seconds < 0:
            raise ValueError("ScheduleAfter.seconds must be non-negative")


type RescheduleSchedule = ScheduleAt | ScheduleAfter


@dataclass(frozen=True)
class RescheduleRequested:
    """Sentinel handler return value requesting a self-reschedule.

    A handler that must wait (e.g. until a checkpoint's `cleanupNotBefore` or
    `writeMayLandUntil`) returns this instead of a normal result mapping. The
    worker recognizes it, calls `reschedule_running_job` on the handler's
    behalf using the worker's own job/attempt identity, and then does not call
    `complete_job` or `fail_job` for this attempt. Handlers must not call
    `reschedule_running_job` themselves and also return normally -- returning
    this marker is the one supported mechanism.
    """

    schedule: RescheduleSchedule
    payload: Mapping[str, Any] | None = None


# The single definition of "the Heavy lease is occupied", for queue-owned SQL that
# must answer that question inline instead of through the helpers below (the
# worker's idle wait). It is a constant, parameterless boolean expression that
# callers interpolate into their own statement text; nothing untrusted is ever
# interpolated into SQL here.
HEAVY_CAPACITY_OCCUPIED_SQL = """EXISTS (
    SELECT 1
    FROM background_job_capacity_leases capacity
    JOIN background_jobs holder ON holder.id = capacity.job_id
    WHERE capacity.resource_class = 'Heavy'
      AND (
          capacity.lease_expires_at > clock_timestamp()
          OR holder.lease_expires_at > clock_timestamp()
      )
)"""


@dataclass(frozen=True)
class _HeavyCapacityLease:
    job_id: UUID | None
    worker_id: str | None
    attempt_no: int | None
    lease_expires_at: datetime | None
    database_now: datetime


def _lock_heavy_capacity(db: Session) -> _HeavyCapacityLease:
    row = (
        db.execute(
            text(
                """
                SELECT job_id, worker_id, attempt_no, lease_expires_at,
                       clock_timestamp() AS database_now
                FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy'
                FOR UPDATE
                """
            )
        )
        .mappings()
        .one()
    )
    return _capacity_from_row(row)


def _capacity_from_row(row: Mapping[Any, Any]) -> _HeavyCapacityLease:
    holder = (row["job_id"], row["worker_id"], row["attempt_no"], row["lease_expires_at"])
    if all(value is None for value in holder):
        return _HeavyCapacityLease(None, None, None, None, row["database_now"])
    # justify-defect: the queue owner writes all four holder fields together, so
    # a partially populated holder is an impossible persisted state.
    if any(value is None for value in holder):
        raise AssertionError("Heavy capacity holder has an invalid persisted shape")
    attempt_no = int(row["attempt_no"])
    # justify-defect: a holder is only ever written from a claimed attempt, whose
    # attempts counter has already been incremented to at least one.
    if attempt_no < 1:
        raise AssertionError("Heavy capacity holder has a non-positive attempt number")
    return _HeavyCapacityLease(
        UUID(str(row["job_id"])),
        str(row["worker_id"]),
        attempt_no,
        row["lease_expires_at"],
        row["database_now"],
    )


def _read_heavy_capacity(db: Session) -> _HeavyCapacityLease:
    """Read the Heavy holder without locking it.

    Verification-only callers use this so they never pin the single capacity row
    for the length of their transaction. Only admission, which must
    read-decide-acquire atomically, takes ``FOR UPDATE``.
    """
    row = (
        db.execute(
            text(
                """
                SELECT job_id, worker_id, attempt_no, lease_expires_at,
                       clock_timestamp() AS database_now
                FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy'
                """
            )
        )
        .mappings()
        .one()
    )
    return _capacity_from_row(row)


def _lock_heavy_capacity_for_job(db: Session, job_id: UUID) -> _HeavyCapacityLease | None:
    """Lock the Heavy row only when this exact job holds it.

    A Light job never matches, so its transitions take no lock at all and can
    never contend with Heavy admission.
    """
    row = (
        db.execute(
            text(
                """
                SELECT job_id, worker_id, attempt_no, lease_expires_at,
                       clock_timestamp() AS database_now
                FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy'
                  AND job_id = :job_id
                FOR UPDATE
                """
            ),
            {"job_id": job_id},
        )
        .mappings()
        .first()
    )
    return None if row is None else _capacity_from_row(row)


def _lock_heavy_capacity_for_jobs(
    db: Session, job_ids: Collection[UUID]
) -> _HeavyCapacityLease | None:
    """Lock capacity only when it names one of the already-locked target jobs."""
    if not job_ids:
        return None
    row = (
        db.execute(
            text(
                """
                SELECT job_id, worker_id, attempt_no, lease_expires_at,
                       clock_timestamp() AS database_now
                FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy'
                  AND job_id = ANY(CAST(:job_ids AS uuid[]))
                FOR UPDATE
                """
            ),
            {"job_ids": list(job_ids)},
        )
        .mappings()
        .first()
    )
    return None if row is None else _capacity_from_row(row)


def _clear_heavy_capacity(db: Session, lease: _HeavyCapacityLease) -> None:
    if lease.job_id is None:
        return
    cleared = db.execute(
        text(
            """
            UPDATE background_job_capacity_leases
            SET job_id = NULL,
                worker_id = NULL,
                attempt_no = NULL,
                lease_expires_at = NULL,
                updated_at = clock_timestamp()
            WHERE resource_class = 'Heavy'
              AND job_id = :job_id
              AND worker_id = :worker_id
              AND attempt_no = :attempt_no
              AND lease_expires_at = :lease_expires_at
            RETURNING resource_class
            """
        ),
        {
            "job_id": lease.job_id,
            "worker_id": lease.worker_id,
            "attempt_no": lease.attempt_no,
            "lease_expires_at": lease.lease_expires_at,
        },
    ).first()
    # justify-defect: every caller passes a holder it read under the row lock it
    # still holds, so the exact four holder fields cannot have moved underneath it.
    if cleared is None:
        raise AssertionError("Heavy capacity holder changed while locked")


def _heavy_capacity_appears_available(lease: _HeavyCapacityLease) -> bool:
    """Use one unlocked snapshot only to avoid selecting clearly blocked Heavy work."""
    return (
        lease.job_id is None
        or lease.lease_expires_at is None
        or lease.lease_expires_at <= lease.database_now
    )


def _heavy_capacity_is_available(db: Session, lease: _HeavyCapacityLease) -> bool:
    """Revalidate the capacity authority while its row is locked.

    Job and capacity lease expiry are written and renewed atomically. Admission
    therefore never locks the holder job underneath the capacity row; a stale
    holder is reclaimed solely from the authoritative capacity expiry.
    """
    if lease.job_id is None:
        return True
    if lease.lease_expires_at is not None and lease.lease_expires_at > lease.database_now:
        return False
    _clear_heavy_capacity(db, lease)
    return True


def _capacity_matches_running_job(
    capacity: _HeavyCapacityLease,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
    resource_class: JobResourceClass,
) -> bool:
    if resource_class == "Light":
        return capacity.job_id != job_id
    return (
        capacity.job_id == job_id
        and capacity.worker_id == worker_id
        and capacity.attempt_no == attempt_no
        and capacity.lease_expires_at is not None
        and capacity.lease_expires_at > capacity.database_now
    )


def _claim_locked_job(
    db: Session,
    *,
    candidate: Mapping[Any, Any],
    worker_id: str,
    lease_seconds: int,
    heavy_kinds: Collection[str],
) -> ClaimedJob | None:
    is_heavy = str(candidate["kind"]) in heavy_kinds
    if is_heavy:
        capacity = _lock_heavy_capacity(db)
        if not _heavy_capacity_is_available(db, capacity):
            return None
    was_interrupted = str(candidate["status"]) == RUNNING
    claimed = (
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET status = 'running',
                    attempts = attempts + 1,
                    claimed_by = :worker_id,
                    execution_id = gen_random_uuid(),
                    started_at = COALESCE(started_at, clock_timestamp()),
                    lease_expires_at =
                        clock_timestamp()
                        + (CAST(:lease_seconds AS integer) * interval '1 second'),
                    error_code = CASE
                        WHEN :was_interrupted THEN 'E_WORKER_INTERRUPTED'
                        ELSE error_code
                    END,
                    last_error = CASE
                        WHEN :was_interrupted THEN 'Worker lease expired; job reclaimed.'
                        ELSE last_error
                    END,
                    updated_at = clock_timestamp()
                WHERE id = :job_id
                RETURNING *
                """
            ),
            {
                "job_id": candidate["id"],
                "worker_id": worker_id,
                "lease_seconds": max(int(lease_seconds), 1),
                "was_interrupted": was_interrupted,
            },
        )
        .mappings()
        .one()
    )
    if is_heavy:
        acquired = db.execute(
            text(
                """
                UPDATE background_job_capacity_leases
                SET job_id = :job_id,
                    worker_id = :worker_id,
                    attempt_no = :attempt_no,
                    lease_expires_at = :lease_expires_at,
                    updated_at = clock_timestamp()
                WHERE resource_class = 'Heavy'
                  AND job_id IS NULL
                RETURNING resource_class
                """
            ),
            {
                "job_id": claimed["id"],
                "worker_id": worker_id,
                "attempt_no": claimed["attempts"],
                "lease_expires_at": claimed["lease_expires_at"],
            },
        ).first()
        # justify-defect: this transaction still holds both the candidate job
        # lock and the capacity lock under the global job-before-capacity order.
        if acquired is None:
            raise AssertionError("Heavy job claim did not acquire capacity")
    interrupted = None
    if was_interrupted:
        previous = candidate["execution_id"]
        interrupted = InterruptedExecution(
            execution_id=None if previous is None else UUID(str(previous))
        )
    return ClaimedJob(job=_row_to_job(claimed), interrupted=interrupted)


def _insert_job_row(
    db: Session,
    *,
    kind: str,
    payload: Mapping[str, Any] | None,
    priority: int,
    max_attempts: int,
    available_at: datetime | None,
    dedupe_key: str | None,
) -> JobRow:
    if kind == "chat_run":
        lock_chat_generation_admission_in_current_transaction(db)
    row = (
        db.execute(
            _INSERT_JOB_SQL,
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
    db.execute(text("SELECT pg_notify('nexus_background_jobs', :kind)"), {"kind": kind})
    return _row_to_job(row)


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
    return _insert_job_row(
        db,
        kind=kind,
        payload=payload,
        priority=priority,
        max_attempts=max_attempts,
        available_at=available_at,
        dedupe_key=dedupe_key,
    )


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
    """Insert one deduped job by dedupe_key, returning the row and whether it inserted."""
    existing = (
        db.execute(
            text("SELECT * FROM background_jobs WHERE dedupe_key = :dedupe_key"),
            {"dedupe_key": dedupe_key},
        )
        .mappings()
        .first()
    )
    if existing is not None:
        return _row_to_job(existing), False

    try:
        with db.begin_nested():
            inserted = _insert_job_row(
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
        existing_after_conflict = (
            db.execute(
                text("SELECT * FROM background_jobs WHERE dedupe_key = :dedupe_key"),
                {"dedupe_key": dedupe_key},
            )
            .mappings()
            .first()
        )
        if existing_after_conflict is None:
            raise
        return _row_to_job(existing_after_conflict), False


def _validate_periodic_scheduler_row(
    row: Mapping[Any, Any],
    *,
    kind: str,
    interval_seconds: int,
    checkpoint_keys: Collection[str],
) -> None:
    interval = int(interval_seconds)
    if interval <= 0:
        raise ValueError("Periodic scheduler interval must be positive")

    prefix = f"periodic:{kind}:"
    dedupe_key = row["dedupe_key"]
    payload = dict(row["payload"] or {})
    request_id = payload.get("request_id")
    scheduler_identity = payload.get("scheduler_identity")
    checkpoint_key_set = frozenset(checkpoint_keys)
    if any(
        not isinstance(key, str)
        or not key
        or key != key.strip()
        or key in _PERIODIC_IDENTITY_PAYLOAD_KEYS
        for key in checkpoint_key_set
    ):
        raise ValueError("Periodic scheduler checkpoint keys must be canonical and disjoint")
    allowed_payload_keys = _PERIODIC_IDENTITY_PAYLOAD_KEYS | checkpoint_key_set
    if (
        str(row["kind"]) != kind
        or not isinstance(dedupe_key, str)
        or not dedupe_key.startswith(prefix)
        or not _PERIODIC_IDENTITY_PAYLOAD_KEYS.issubset(payload)
        or not set(payload).issubset(allowed_payload_keys)
        or request_id != dedupe_key
        or not isinstance(scheduler_identity, str)
        or not scheduler_identity
        or scheduler_identity != scheduler_identity.strip()
    ):
        raise RuntimeError("Periodic scheduler target does not match the exact operation")

    try:
        slot_start = datetime.fromisoformat(dedupe_key.removeprefix(prefix))
    except ValueError as exc:
        raise RuntimeError("Periodic scheduler target does not match the exact operation") from exc
    if (
        slot_start.tzinfo is not UTC
        or slot_start.isoformat() != dedupe_key.removeprefix(prefix)
        or int(slot_start.timestamp()) % interval != 0
    ):
        raise RuntimeError("Periodic scheduler target does not match the exact operation")


def reconcile_periodic_job_priorities(
    db: Session,
    *,
    kind: str,
    interval_seconds: int,
    priority: int,
    checkpoint_keys: Collection[str],
) -> int:
    """Apply current priority to every active canonical slot for one kind.

    The bounded dedupe-prefix query leaves on-demand rows and downstream work
    that only carries the periodic request correlation untouched while finding
    namespace claimants globally so a foreign kind cannot occupy the dedupe
    namespace. Every selected row must satisfy the full scheduler identity,
    declared checkpoint envelope, and aligned slot contract before any priority
    is changed. Overflow fails the whole scheduling transaction instead of
    partially converging a backlog.
    """
    prefix = f"periodic:{kind}:"
    rows = (
        db.execute(
            text(
                """
                SELECT *
                FROM background_jobs
                WHERE status IN ('pending', 'failed', 'running')
                  AND left(COALESCE(dedupe_key, ''), char_length(:prefix)) = :prefix
                ORDER BY created_at ASC, id ASC
                LIMIT :scan_limit
                FOR UPDATE
                """
            ),
            {
                "prefix": prefix,
                "scan_limit": PERIODIC_PRIORITY_RECONCILIATION_LIMIT + 1,
            },
        )
        .mappings()
        .all()
    )
    if len(rows) > PERIODIC_PRIORITY_RECONCILIATION_LIMIT:
        raise RuntimeError(
            f"Periodic scheduler active slot limit exceeds {PERIODIC_PRIORITY_RECONCILIATION_LIMIT}"
        )
    for row in rows:
        _validate_periodic_scheduler_row(
            row,
            kind=kind,
            interval_seconds=interval_seconds,
            checkpoint_keys=checkpoint_keys,
        )

    stale_job_ids = [UUID(str(row["id"])) for row in rows if int(row["priority"]) != int(priority)]
    if not stale_job_ids:
        return 0
    updated_ids = set(
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET priority = :priority
                WHERE id = ANY(CAST(:job_ids AS uuid[]))
                RETURNING id
                """
            ),
            {
                "job_ids": [str(job_id) for job_id in stale_job_ids],
                "priority": int(priority),
            },
        ).scalars()
    )
    if updated_ids != set(stale_job_ids):
        raise AssertionError("Periodic scheduler priority reconciliation lost a locked row")
    return len(updated_ids)


def claim_next_job(
    db: Session,
    *,
    worker_id: str,
    lease_seconds: int,
    heavy_kinds: Sequence[str],
    allowed_kinds: Sequence[str],
) -> ClaimedJob | None:
    """Claim the first due capacity-eligible job in canonical queue order."""
    heavy_kind_set = frozenset(heavy_kinds)
    # A lane that admits no Heavy kind never needs the capacity row, and must not
    # lock it: doing so couples the interactive lane's claim loop to background
    # capacity state it can neither hold nor release.
    lane_admits_heavy = bool(heavy_kind_set & set(allowed_kinds))
    capacity_available = (
        _heavy_capacity_appears_available(_read_heavy_capacity(db)) if lane_admits_heavy else False
    )
    candidate = (
        db.execute(
            text(
                """
                SELECT *
                FROM background_jobs
                WHERE (
                    (status IN ('pending', 'failed') AND available_at <= clock_timestamp())
                    OR
                    (status = 'running'
                     AND lease_expires_at IS NOT NULL
                     AND lease_expires_at <= clock_timestamp()
                     AND attempts < max_attempts)
                )
                  AND kind = ANY(CAST(:allowed_kinds AS text[]))
                  AND (
                      :capacity_available
                      OR NOT (kind = ANY(CAST(:heavy_kinds AS text[])))
                  )
                ORDER BY
                    priority ASC,
                    CASE
                        WHEN status = 'running' THEN lease_expires_at
                        ELSE available_at
                    END ASC,
                    created_at ASC,
                    id ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
                """
            ),
            {
                "allowed_kinds": list(allowed_kinds),
                "capacity_available": capacity_available,
                "heavy_kinds": list(heavy_kind_set),
            },
        )
        .mappings()
        .first()
    )
    if candidate is None:
        return None
    return _claim_locked_job(
        db,
        candidate=candidate,
        worker_id=worker_id,
        lease_seconds=lease_seconds,
        heavy_kinds=heavy_kind_set,
    )


def claim_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    lease_seconds: int,
    heavy_kinds: Sequence[str],
    allowed_kinds: Sequence[str],
) -> ClaimedJob | None:
    """Claim one exact due operation through the canonical queue transition.

    Normal workers use :func:`claim_next_job`; exact-operation drivers such as
    the Oracle reconciler use this doorway so unrelated due work is never
    claimed as a side effect.
    """
    heavy_kind_set = frozenset(heavy_kinds)
    candidate = (
        db.execute(
            text(
                """
                SELECT *
                FROM background_jobs
                WHERE id = :job_id
                  AND kind = ANY(CAST(:allowed_kinds AS text[]))
                  AND (
                      (status IN ('pending', 'failed') AND available_at <= clock_timestamp())
                      OR
                      (status = 'running'
                       AND lease_expires_at IS NOT NULL
                       AND lease_expires_at <= clock_timestamp()
                       AND attempts < max_attempts)
                  )
                FOR UPDATE
                """
            ),
            {
                "job_id": job_id,
                "allowed_kinds": list(allowed_kinds),
            },
        )
        .mappings()
        .first()
    )
    if candidate is None:
        return None
    return _claim_locked_job(
        db,
        candidate=candidate,
        worker_id=worker_id,
        lease_seconds=lease_seconds,
        heavy_kinds=heavy_kind_set,
    )


def dead_letter_expired_job(
    db: Session,
    *,
    allowed_kinds: Sequence[str],
) -> JobRow | None:
    """Mark one exhausted, expired running job dead and return it.

    This is intentionally separate from claim_next_job so the worker can run
    kind-specific dead-letter side effects in the same transaction that moves
    the queue row to dead.
    """
    row = (
        db.execute(
            text(
                """
                WITH candidate AS (
                    SELECT id
                    FROM background_jobs
                    WHERE status = 'running'
                      AND lease_expires_at IS NOT NULL
                      AND lease_expires_at <= now()
                      AND attempts >= max_attempts
                      AND kind = ANY(:allowed_kinds)
                    ORDER BY lease_expires_at ASC, created_at ASC, id ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE background_jobs j
                SET
                    status = 'dead',
                    lease_expires_at = NULL,
                    claimed_by = NULL,
                    finished_at = now(),
                    error_code = 'E_WORKER_INTERRUPTED',
                    last_error = 'Worker lease expired after max attempts.',
                    updated_at = now()
                FROM candidate
                WHERE j.id = candidate.id
                RETURNING j.*
                """
            ),
            {"allowed_kinds": list(allowed_kinds)},
        )
        .mappings()
        .first()
    )

    if row is None:
        return None
    capacity = _lock_heavy_capacity_for_job(db, UUID(str(row["id"])))
    if capacity is not None:
        _clear_heavy_capacity(db, capacity)
    return _row_to_job(row)


def get_job(db: Session, job_id: UUID) -> JobRow | None:
    row = (
        db.execute(
            text("SELECT * FROM background_jobs WHERE id = :job_id"),
            {"job_id": job_id},
        )
        .mappings()
        .first()
    )
    return _row_to_job(row) if row is not None else None


def lock_job(db: Session, job_id: UUID) -> JobRow | None:
    """Lock one queue row for a composing domain mutation."""
    row = (
        db.execute(
            text("SELECT * FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": job_id},
        )
        .mappings()
        .first()
    )
    return _row_to_job(row) if row is not None else None


def promote_unclaimed_job(
    db: Session,
    *,
    job_id: UUID,
    kind: str,
    payload: Mapping[str, Any],
    dedupe_key: str,
    priority: int,
) -> bool:
    """Promote one exact pending queue operation without replacing a live claim.

    The queue row is locked even when it is already running so callers can
    compose this with a subsequent subscription-row fence in the canonical
    queue -> domain lock order.
    """
    row = (
        db.execute(
            text("SELECT * FROM background_jobs WHERE id = :job_id FOR UPDATE"),
            {"job_id": job_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise RuntimeError("Queue promotion target is missing")
    if (
        str(row["kind"]) != kind
        or dict(row["payload"] or {}) != dict(payload)
        or str(row["dedupe_key"] or "") != dedupe_key
    ):
        raise RuntimeError("Queue promotion target does not match the exact operation")
    status = str(row["status"])
    if status == RUNNING:
        return False
    if status not in {PENDING, FAILED} or row["claimed_by"] is not None:
        raise RuntimeError("Queue promotion target is not an active unclaimed operation")
    db.execute(
        text(
            """
            UPDATE background_jobs
            SET priority = :priority, available_at = now(), updated_at = now()
            WHERE id = :job_id
            """
        ),
        {"job_id": job_id, "priority": int(priority)},
    )
    db.execute(text("SELECT pg_notify('nexus_background_jobs', :kind)"), {"kind": kind})
    return True


def heartbeat_job(
    *,
    session_factory: Callable[[], Session],
    context: JobExecutionContext,
    lease_seconds: int,
) -> bool:
    """Atomically extend one exact running attempt and its Heavy capacity lease.

    This operation owns its Session so it cannot commit a caller's unrelated
    state. It follows the queue-wide job-before-capacity lock order: a heartbeat
    waiting behind publication holds no global capacity lock, while a completed
    Heavy renewal publishes one identical expiry for the job and its holder.
    Light work only performs an unlocked capacity verification read.
    """
    with session_factory() as db, db.begin():
        job = (
            db.execute(
                text(
                    """
                    SELECT attempts
                    FROM background_jobs
                    WHERE id = :job_id
                      AND status = 'running'
                      AND claimed_by = :worker_id
                      AND attempts = :attempt_no
                      AND lease_expires_at > clock_timestamp()
                    FOR UPDATE
                    """
                ),
                {
                    "job_id": context.job_id,
                    "worker_id": context.worker_id,
                    "attempt_no": context.attempt_no,
                },
            )
            .mappings()
            .first()
        )
        if job is None:
            return False
        capacity = (
            _lock_heavy_capacity_for_job(db, context.job_id)
            if context.resource_class == "Heavy"
            else _read_heavy_capacity(db)
        )
        if capacity is None or not _capacity_matches_running_job(
            capacity,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
            resource_class=context.resource_class,
        ):
            return False
        renewed = db.execute(
            text(
                """
                UPDATE background_jobs
                SET lease_expires_at =
                        clock_timestamp()
                        + (CAST(:lease_seconds AS integer) * interval '1 second'),
                    updated_at = clock_timestamp()
                WHERE id = :job_id
                RETURNING lease_expires_at
                """
            ),
            {
                "job_id": context.job_id,
                "lease_seconds": max(int(lease_seconds), 1),
            },
        ).scalar_one()
        if context.resource_class == "Heavy":
            updated = db.execute(
                text(
                    """
                    UPDATE background_job_capacity_leases
                    SET lease_expires_at = :lease_expires_at,
                        updated_at = clock_timestamp()
                    WHERE resource_class = 'Heavy'
                      AND job_id = :job_id
                      AND worker_id = :worker_id
                      AND attempt_no = :attempt_no
                    RETURNING resource_class
                    """
                ),
                {
                    "job_id": context.job_id,
                    "worker_id": context.worker_id,
                    "attempt_no": context.attempt_no,
                    "lease_expires_at": renewed,
                },
            ).first()
            # justify-defect: this transaction holds both the exact job and its
            # capacity row, so the verified holder cannot move underneath it.
            if updated is None:
                raise AssertionError("Heavy capacity holder changed while locked")
    return True


def lock_and_renew_running_job_claim(
    db: Session,
    *,
    context: JobExecutionContext,
    lease_seconds: int,
) -> JobRow | None:
    """Lock and renew the exact current worker attempt.

    The returned row stays locked through the caller's transaction. Callers
    must perform every authoritative mutation only after this succeeds and
    commit before the renewed lease expires.

    A Heavy publication locks and renews its exact capacity holder after the job
    lock, retaining both through commit. That prevents capacity expiry from
    admitting a second Heavy job while the heartbeat is blocked behind the
    publication's job lock. Light publication never touches Heavy capacity.
    """
    job = (
        db.execute(
            text(
                """
                SELECT *
                FROM background_jobs
                WHERE id = :job_id
                  AND status = 'running'
                  AND claimed_by = :worker_id
                  AND attempts = :attempt_no
                  AND lease_expires_at > clock_timestamp()
                FOR UPDATE
                """
            ),
            {
                "job_id": context.job_id,
                "worker_id": context.worker_id,
                "attempt_no": int(context.attempt_no),
            },
        )
        .mappings()
        .first()
    )
    if job is None:
        return None
    capacity: _HeavyCapacityLease | None = None
    if context.resource_class == "Heavy":
        capacity = _lock_heavy_capacity_for_job(db, context.job_id)
        if (
            capacity is None
            or capacity.worker_id != context.worker_id
            or capacity.attempt_no != context.attempt_no
            or capacity.lease_expires_at is None
            or capacity.lease_expires_at <= capacity.database_now
        ):
            return None
    row = (
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET lease_expires_at =
                        clock_timestamp()
                        + (CAST(:lease_seconds AS integer) * interval '1 second'),
                    updated_at = clock_timestamp()
                WHERE id = :job_id
                RETURNING *
                """
            ),
            {
                "job_id": context.job_id,
                "lease_seconds": max(int(lease_seconds), 1),
            },
        )
        .mappings()
        .one()
    )
    if capacity is not None:
        renewed = db.execute(
            text(
                """
                UPDATE background_job_capacity_leases
                SET lease_expires_at = :lease_expires_at,
                    updated_at = clock_timestamp()
                WHERE resource_class = 'Heavy'
                  AND job_id = :job_id
                  AND worker_id = :worker_id
                  AND attempt_no = :attempt_no
                RETURNING resource_class
                """
            ),
            {
                "job_id": context.job_id,
                "worker_id": context.worker_id,
                "attempt_no": int(context.attempt_no),
                "lease_expires_at": row["lease_expires_at"],
            },
        ).first()
        # justify-defect: this transaction still holds the exact job and
        # capacity rows, so the holder cannot change between validation/update.
        if renewed is None:
            raise AssertionError("Heavy capacity holder changed while locked")
    return _row_to_job(row)


def update_running_job_payload(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
    payload: Mapping[str, Any],
) -> bool:
    """Lease-fenced durable checkpoint write for a running job's payload.

    CAS: only updates when the row is status='running', claimed_by=worker_id,
    attempts=attempt_no, and the lease is unexpired. This is the only way a
    running task persists a durable checkpoint (for example a MediaTeardownJob
    or StorageObjectCleanupJob's discriminated checkpoint payload) without
    racing a concurrent reclaim of the same row.
    """
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET
                payload = CAST(:payload AS jsonb),
                updated_at = now()
            WHERE id = :job_id
              AND status = 'running'
              AND claimed_by = :worker_id
              AND attempts = :attempt_no
              AND lease_expires_at > now()
            RETURNING id
            """
        ),
        {
            "job_id": job_id,
            "worker_id": worker_id,
            "attempt_no": int(attempt_no),
            "payload": json.dumps(dict(payload)),
        },
    ).first()
    return updated is not None


def running_job_claim_is_current(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
) -> bool:
    """Whether this exact running attempt still owns an unexpired lease."""
    return bool(
        db.execute(
            text(
                """
                SELECT EXISTS(
                    SELECT 1
                    FROM background_jobs
                    WHERE id = :job_id
                      AND status = 'running'
                      AND claimed_by = :worker_id
                      AND attempts = :attempt_no
                      AND lease_expires_at > now()
                )
                """
            ),
            {
                "job_id": job_id,
                "worker_id": worker_id,
                "attempt_no": attempt_no,
            },
        ).scalar_one()
    )


def lock_running_job_attempt(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
) -> JobRow | None:
    """Lock and return one exact live attempt as terminal-write authority."""
    row = (
        db.execute(
            text(
                """
                SELECT *
                FROM background_jobs
                WHERE id = :job_id
                  AND status = 'running'
                  AND claimed_by = :worker_id
                  AND attempts = :attempt_no
                  AND lease_expires_at > clock_timestamp()
                FOR UPDATE
                """
            ),
            {
                "job_id": job_id,
                "worker_id": worker_id,
                "attempt_no": int(attempt_no),
            },
        )
        .mappings()
        .one_or_none()
    )
    return None if row is None else _row_to_job(row)


def lock_running_job_claim(db: Session, *, context: JobExecutionContext) -> bool:
    """Fence one effect transaction to the exact live running attempt.

    The row lock composes the ownership check with domain/event writes in the
    caller's current transaction. Reclaim, dead-letter, and heartbeat updates
    wait until that transaction commits or rolls back.
    """
    return (
        lock_running_job_attempt(
            db,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
        )
        is not None
    )


def revoke_jobs_by_dedupe_keys(
    db: Session,
    *,
    kind: str,
    dedupe_keys: Collection[str],
) -> None:
    """Delete owned queue rows and their payload-carried replay state.

    The caller must first invalidate the domain owner under its serialization
    lock. A running worker then loses both its queue lease and domain target.
    """
    if not dedupe_keys:
        return
    targets = (
        db.execute(
            text(
                """
            SELECT id
            FROM background_jobs
            WHERE kind = :kind
              AND dedupe_key = ANY(:dedupe_keys)
            ORDER BY id ASC
            FOR UPDATE
            """
            ),
            {"kind": kind, "dedupe_keys": list(dedupe_keys)},
        )
        .scalars()
        .all()
    )
    if not targets:
        return
    capacity = _lock_heavy_capacity_for_jobs(db, targets)
    if capacity is not None:
        _clear_heavy_capacity(db, capacity)
    db.execute(
        text("DELETE FROM background_jobs WHERE id = ANY(:job_ids)"),
        {"job_ids": list(targets)},
    )


def revoke_jobs_for_payload(
    db: Session,
    *,
    kind: str,
    expected_payload_match: Mapping[str, Any],
) -> None:
    """Delete queue rows selected by an owned exact JSON payload subset."""
    target_payload = json.dumps(dict(expected_payload_match))
    targets = (
        db.execute(
            text(
                """
            SELECT id
            FROM background_jobs
            WHERE kind = :kind
              AND payload @> CAST(:expected_payload_match AS jsonb)
            ORDER BY id ASC
            FOR UPDATE
            """
            ),
            {"kind": kind, "expected_payload_match": target_payload},
        )
        .scalars()
        .all()
    )
    if not targets:
        return
    capacity = _lock_heavy_capacity_for_jobs(db, targets)
    if capacity is not None:
        _clear_heavy_capacity(db, capacity)
    db.execute(
        text("DELETE FROM background_jobs WHERE id = ANY(:job_ids)"),
        {"job_ids": list(targets)},
    )


def reschedule_running_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
    schedule: RescheduleSchedule,
    payload: Mapping[str, Any] | None = None,
) -> bool:
    """Self-reschedule a running job back to pending without burning its retry budget.

    CAS-fenced exactly like update_running_job_payload (exact running attempt,
    claimant, and unexpired lease). Sets status='pending', optionally a new
    payload, and clears the claim/lease. `ScheduleAt` preserves its owned
    instant; `ScheduleAfter` is computed from PostgreSQL ``now()`` in the same
    statement that records ``updated_at``.

    attempts is compensated (attempts - 1, floored at 0) to undo the +1 that
    claim_next_job already applied when this attempt started, so time spent
    waiting on a self-reschedule does not consume the job's max_attempts
    budget. See RescheduleRequested for the worker-side contract: handlers
    request this by returning that marker, and the worker -- not the handler
    -- calls this function and skips complete_job/fail_job for that attempt.
    """
    match schedule:
        case ScheduleAt(instant=instant):
            available_at, delay_seconds = instant, None
        case ScheduleAfter(seconds=seconds):
            available_at, delay_seconds = None, seconds
        case _ as unreachable:
            assert_never(unreachable)

    owned = db.execute(
        text(
            """
            SELECT attempts
            FROM background_jobs
            WHERE id = :job_id
              AND status = 'running'
              AND claimed_by = :worker_id
              AND attempts = :attempt_no
              AND lease_expires_at > now()
            FOR UPDATE
            """
        ),
        {"job_id": job_id, "worker_id": worker_id, "attempt_no": int(attempt_no)},
    ).one_or_none()
    if owned is None:
        return False
    capacity = _lock_heavy_capacity_for_job(db, job_id)
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'pending',
                available_at = CASE
                    WHEN CAST(:delay_seconds AS integer) IS NULL
                    THEN CAST(:available_at AS timestamptz)
                    ELSE now() + (CAST(:delay_seconds AS integer) * interval '1 second')
                END,
                payload = COALESCE(CAST(:payload AS jsonb), payload),
                attempts = GREATEST(attempts - 1, 0),
                claimed_by = NULL,
                lease_expires_at = NULL,
                updated_at = now()
            WHERE id = :job_id
              AND status = 'running'
              AND claimed_by = :worker_id
              AND attempts = :attempt_no
              AND lease_expires_at > now()
            RETURNING id
            """
        ),
        {
            "job_id": job_id,
            "worker_id": worker_id,
            "attempt_no": int(attempt_no),
            "available_at": available_at,
            "delay_seconds": delay_seconds,
            "payload": json.dumps(dict(payload)) if payload is not None else None,
        },
    ).first()
    if updated is not None and capacity is not None:
        # justify-defect: the holder is written by the same claim that produced
        # this attempt, so a mismatched worker or attempt is impossible.
        if capacity.worker_id != worker_id or capacity.attempt_no != int(attempt_no):
            raise AssertionError("Heavy capacity holder does not match rescheduled attempt")
        _clear_heavy_capacity(db, capacity)
    return updated is not None


def replace_dead_job_payload(
    db: Session,
    *,
    job_id: UUID,
    payload: Mapping[str, Any],
) -> bool:
    """Replace one locked dead job's payload before its repair transition."""
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET payload = CAST(:payload AS jsonb),
                updated_at = now()
            WHERE id = :job_id
              AND status = 'dead'
            RETURNING id
            """
        ),
        {"job_id": job_id, "payload": json.dumps(dict(payload))},
    ).first()
    return updated is not None


def requeue_dead_job(db: Session, *, job_id: UUID) -> bool:
    """Operator/system repair transition: dead -> pending with a fresh full budget.

    Only transitions rows currently in 'dead' status. Resets attempts to 0 so
    the job's complete max_attempts budget is available again and sets
    available_at to now(); clears the stale claim/lease and the terminal
    finished_at (the row is no longer terminal). error_code and last_error are
    intentionally preserved as operator-visible history of why the job
    dead-lettered; the next failure, if any, overwrites them.
    """
    row = (
        db.execute(
            text(
                """
                SELECT status
                FROM background_jobs
                WHERE id = :job_id
                FOR UPDATE
                """
            ),
            {"job_id": job_id},
        )
        .mappings()
        .one_or_none()
    )
    if row is None or row["status"] != DEAD:
        return False
    capacity_held = db.scalar(
        text(
            """
            SELECT EXISTS (
                SELECT 1
                FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy'
                  AND job_id = :job_id
            )
            """
        ),
        {"job_id": job_id},
    )
    if capacity_held:
        # justify-defect: every transition to dead clears the exact Heavy holder.
        raise AssertionError("dead job still owns Heavy capacity")
    updated = (
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET
                    status = 'pending',
                    attempts = 0,
                    available_at = now(),
                    claimed_by = NULL,
                    lease_expires_at = NULL,
                    finished_at = NULL,
                    updated_at = now()
                WHERE id = :job_id
                  AND status = 'dead'
                RETURNING id, kind
                """
            ),
            {"job_id": job_id},
        )
        .mappings()
        .one()
    )
    db.execute(
        text("SELECT pg_notify('nexus_background_jobs', :kind)"),
        {"kind": str(updated["kind"])},
    )
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
    """Pre-claim CAS update for a future-dated, unclaimed pending job.

    For a job that is still pending and unclaimed only: updates when kind
    matches and every key in expected_payload_match equals the stored
    payload's value (jsonb containment), so a caller matches on job/media/path
    identity without a separate read. Used to renew an Armed cleanup job's
    deadline or mark it Retained before any worker ever claims it; the update
    fails once the row is claimed. Domain code never writes background_jobs
    raw -- this is one of the queue's doorway functions.
    """
    updated = db.execute(
        text(
            """
            UPDATE background_jobs
            SET
                payload = CAST(:payload AS jsonb),
                available_at = COALESCE(:available_at, available_at),
                updated_at = now()
            WHERE id = :job_id
              AND status = 'pending'
              AND claimed_by IS NULL
              AND kind = :kind
              AND payload @> CAST(:expected_payload_match AS jsonb)
            RETURNING id
            """
        ),
        {
            "job_id": job_id,
            "kind": kind,
            "expected_payload_match": json.dumps(dict(expected_payload_match)),
            "payload": json.dumps(dict(payload)),
            "available_at": available_at,
        },
    ).first()
    return updated is not None


def find_nonterminal_jobs_for_payload(
    db: Session,
    *,
    kind: str,
    expected_payload_match: Mapping[str, Any],
) -> list[JobRow]:
    """Return every not-yet-terminal job of ``kind`` whose payload contains the match.

    "Nonterminal" means status is neither ``succeeded`` nor ``dead`` (i.e. still
    ``pending``, ``running``, or ``failed``). Payload matching uses jsonb
    containment (``@>``), so a caller matches on stable identity keys
    (``mediaId``/``storagePath``) without decoding the checkpoint. This is the
    queue-owned lookup that lets a media-locked caller enforce "at most one
    nonterminal cleanup job per (mediaId, storagePath)" and lets media teardown
    enumerate the Armed storage-cleanup writers for one media. Domain code never
    reads ``background_jobs`` raw -- this is one of the queue's doorway functions.
    Serialization comes from the caller's own row lock (e.g. the media row held
    ``FOR UPDATE`` while reserving), not from this read.
    """
    rows = (
        db.execute(
            text(
                """
                SELECT *
                FROM background_jobs
                WHERE kind = :kind
                  AND status NOT IN ('succeeded', 'dead')
                  AND payload @> CAST(:expected_payload_match AS jsonb)
                ORDER BY created_at ASC, id ASC
                """
            ),
            {
                "kind": kind,
                "expected_payload_match": json.dumps(dict(expected_payload_match)),
            },
        )
        .mappings()
        .all()
    )
    return [_row_to_job(row) for row in rows]


def lock_jobs_for_payload(
    db: Session,
    *,
    kind: str,
    expected_payload_match: Mapping[str, Any],
) -> list[JobRow]:
    """Lock every queue row for one domain identity in stable order."""
    rows = (
        db.execute(
            text(
                """
                SELECT *
                FROM background_jobs
                WHERE kind = :kind
                  AND payload @> CAST(:expected_payload_match AS jsonb)
                ORDER BY id ASC
                FOR UPDATE
                """
            ),
            {
                "kind": kind,
                "expected_payload_match": json.dumps(dict(expected_payload_match)),
            },
        )
        .mappings()
        .all()
    )
    return [_row_to_job(row) for row in rows]


def reset_unclaimed_job_for_new_intent(
    db: Session,
    *,
    job_id: UUID,
    kind: str,
    payload: Mapping[str, Any],
    max_attempts: int,
) -> JobRow:
    """Replace one waiting job with a genuinely new intent and retry budget."""
    row = (
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET
                    payload = CAST(:payload AS jsonb),
                    status = 'pending',
                    attempts = 0,
                    max_attempts = :max_attempts,
                    available_at = now(),
                    lease_expires_at = NULL,
                    claimed_by = NULL,
                    error_code = NULL,
                    last_error = NULL,
                    result = NULL,
                    started_at = NULL,
                    finished_at = NULL,
                    updated_at = now()
                WHERE id = :job_id
                  AND kind = :kind
                  AND status IN ('pending', 'failed')
                  AND claimed_by IS NULL
                RETURNING *
                """
            ),
            {
                "job_id": job_id,
                "kind": kind,
                "payload": json.dumps(dict(payload)),
                "max_attempts": max(int(max_attempts), 1),
            },
        )
        .mappings()
        .one()
    )
    db.execute(text("SELECT pg_notify('nexus_background_jobs', :kind)"), {"kind": kind})
    return _row_to_job(row)


def supersede_unclaimed_job(
    db: Session,
    *,
    job_id: UUID,
    kind: str,
) -> None:
    """Complete one obsolete waiting operation without touching running/dead history.

    The guarded, non-blocking candidate select is the whole conditional. A row a
    concurrent transaction holds is left to that transaction: the X-post completion
    calls this under the quote media's ``FOR UPDATE`` while a worker settling that
    same queue row needs the media as ``KEY SHARE`` for the seam's history insert,
    so waiting on a foreign row lock here would close a wait cycle. A caller that
    already locked the row supersedes it -- ``SKIP LOCKED`` never skips a row the
    current transaction holds -- and owns whatever postcondition its coalescing
    invariant needs.
    """
    db.execute(
        text(
            """
            WITH waiting AS (
                SELECT id
                FROM background_jobs
                WHERE id = :job_id
                  AND kind = :kind
                  AND status IN ('pending', 'failed')
                  AND claimed_by IS NULL
                FOR UPDATE SKIP LOCKED
            )
            UPDATE background_jobs
            SET
                status = 'succeeded',
                result = '{"status":"superseded"}'::jsonb,
                lease_expires_at = NULL,
                claimed_by = NULL,
                finished_at = now(),
                updated_at = now()
            FROM waiting
            WHERE background_jobs.id = waiting.id
            """
        ),
        {"job_id": job_id, "kind": kind},
    )


def current_dead_job_for_payload(
    db: Session,
    *,
    kind: str,
    expected_payload_match: Mapping[str, Any],
) -> JobRow | None:
    """Lock and return the exact dead job for a current domain identity."""
    rows = (
        db.execute(
            text(
                """
                SELECT *
                FROM background_jobs
                WHERE kind = :kind
                  AND status = 'dead'
                  AND payload @> CAST(:expected_payload_match AS jsonb)
                ORDER BY id ASC
                FOR UPDATE
                """
            ),
            {
                "kind": kind,
                "expected_payload_match": json.dumps(dict(expected_payload_match)),
            },
        )
        .mappings()
        .all()
    )
    if len(rows) > 1:
        # justify-defect: one domain intent cannot own multiple dead executions.
        raise AssertionError(f"multiple dead {kind} jobs match one domain intent")
    return _row_to_job(rows[0]) if rows else None


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
                    WHERE attempt.id = :operation_id
                      AND job.kind = 'ingest_media_source'
                      AND job.payload @> jsonb_build_object(
                          'attempt_id', attempt.id::text,
                          'media_id', attempt.media_id::text
                      )
                      AND job.status IN ('pending', 'failed', 'running')
                    UNION ALL
                    SELECT 1
                    FROM background_jobs job
                    WHERE job.id = :operation_id
                      AND job.kind = 'media_content_reindex_job'
                      AND job.status IN ('pending', 'failed', 'running')
                )
                """
            ),
            {"operation_id": operation_id},
        ).scalar_one()
    )


def ingest_operation_health(
    db: Session,
    *,
    interactive_kinds: Sequence[str],
    background_kinds: Sequence[str],
) -> dict[str, Any]:
    """Return queue-owned ingest suspension, due-age, and reconciler facts."""
    row = (
        db.execute(
            text(
                """
                SELECT
                    (
                        SELECT count(*)
                        FROM media_source_attempts msa
                        JOIN background_jobs j ON j.id = msa.job_id
                        WHERE j.kind = 'ingest_media_source'
                          AND j.status = 'dead'
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
                    ) AS dead_source_count,
                    (
                        SELECT count(*)
                        FROM content_index_states cis
                        JOIN background_jobs j
                          ON j.kind = 'media_content_reindex_job'
                         AND j.status = 'dead'
                         AND j.payload->>'media_id' = cis.owner_id::text
                         AND (j.payload->>'revision')::bigint = cis.revision
                        WHERE cis.owner_kind = 'media'
                    ) AS dead_index_count,
                    (
                        SELECT extract(epoch FROM now() - min(j.available_at))
                        FROM background_jobs j
                        WHERE j.kind = ANY(:interactive_kinds)
                          AND j.status IN ('pending', 'failed')
                          AND j.available_at <= now()
                    ) AS oldest_due_interactive_age,
                    (
                        SELECT extract(epoch FROM now() - min(j.available_at))
                        FROM background_jobs j
                        WHERE j.kind = ANY(:background_kinds)
                          AND j.status IN ('pending', 'failed')
                          AND j.available_at <= now()
                    ) AS oldest_due_background_age
                """
            ),
            {
                "interactive_kinds": list(interactive_kinds),
                "background_kinds": list(background_kinds),
            },
        )
        .mappings()
        .one()
    )
    reconciler = (
        db.execute(
            text(
                """
                SELECT
                    latest_success.status AS successful_status,
                    latest_success.result AS successful_result,
                    latest_success.finished_at AS successful_finished_at,
                    latest_completed.status AS completed_status,
                    latest_completed.result AS completed_result,
                    latest_completed.finished_at AS completed_finished_at
                FROM (SELECT 1) AS anchor
                LEFT JOIN LATERAL (
                    SELECT status, result, finished_at
                    FROM background_jobs
                    WHERE kind = 'reconcile_stale_ingest_media_job'
                      AND status = 'succeeded'
                      AND finished_at IS NOT NULL
                    ORDER BY finished_at DESC, id DESC
                    LIMIT 1
                ) AS latest_success ON true
                LEFT JOIN LATERAL (
                    SELECT status, result, finished_at
                    FROM background_jobs
                    WHERE kind = 'reconcile_stale_ingest_media_job'
                      AND status IN ('succeeded', 'dead')
                      AND finished_at IS NOT NULL
                    ORDER BY finished_at DESC, id DESC
                    LIMIT 1
                ) AS latest_completed ON true
                """
            )
        )
        .mappings()
        .one()
    )
    latest_successful = (
        {
            "status": reconciler["successful_status"],
            "result": reconciler["successful_result"],
            "finished_at": reconciler["successful_finished_at"],
        }
        if reconciler["successful_status"] is not None
        else None
    )
    latest_completed = (
        {
            "status": reconciler["completed_status"],
            "result": reconciler["completed_result"],
            "finished_at": reconciler["completed_finished_at"],
        }
        if reconciler["completed_status"] is not None
        else None
    )
    return {
        "dead_source_count": int(row["dead_source_count"] or 0),
        "dead_index_count": int(row["dead_index_count"] or 0),
        "oldest_due_interactive_age_seconds": (
            int(row["oldest_due_interactive_age"])
            if row["oldest_due_interactive_age"] is not None
            else None
        ),
        "oldest_due_background_age_seconds": (
            int(row["oldest_due_background_age"])
            if row["oldest_due_background_age"] is not None
            else None
        ),
        "latest_successful_reconciler": latest_successful,
        "latest_completed_reconciler": latest_completed,
    }


def complete_job(
    db: Session,
    *,
    job_id: UUID,
    worker_id: str,
    attempt_no: int,
    result_payload: Mapping[str, Any] | None = None,
) -> bool:
    """Mark one exact, live running attempt as succeeded."""
    owned = lock_running_job_attempt(
        db,
        job_id=job_id,
        worker_id=worker_id,
        attempt_no=attempt_no,
    )
    if owned is None:
        return False
    capacity = _lock_heavy_capacity_for_job(db, job_id)
    db.execute(
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
    ).one()
    if capacity is not None:
        # justify-defect: the holder is written by the same claim that produced
        # this attempt, so a mismatched worker or attempt is impossible.
        if capacity.worker_id != worker_id or capacity.attempt_no != int(attempt_no):
            raise AssertionError("Heavy capacity holder does not match completed attempt")
        _clear_heavy_capacity(db, capacity)
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
) -> JobFailureTransition | None:
    """Apply retry/dead transition for one exact, live running attempt."""
    row = lock_running_job_attempt(
        db,
        job_id=job_id,
        worker_id=worker_id,
        attempt_no=attempt_no,
    )
    if row is None:
        return None
    capacity = _lock_heavy_capacity_for_job(db, job_id)

    attempts = row.attempts
    max_attempts = row.max_attempts
    should_dead_letter = attempts >= max_attempts

    new_status: JobFailureTransition
    if should_dead_letter:
        new_status = "dead"
        retry_delay_seconds = 0
    else:
        retry_delay_seconds = _retry_delay_for_attempt(attempts, retry_delays_seconds)
        new_status = "failed"

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
                result = CAST(:result_payload AS jsonb),
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
            "result_payload": (
                json.dumps(dict(result_payload)) if result_payload is not None else None
            ),
        },
    )
    if capacity is not None:
        # justify-defect: the holder is written by the same claim that produced
        # this attempt, so a mismatched worker or attempt is impossible.
        if capacity.worker_id != worker_id or capacity.attempt_no != attempts:
            raise AssertionError("Heavy capacity holder does not match failed attempt")
        _clear_heavy_capacity(db, capacity)
    if new_status == "failed":
        db.execute(
            text("SELECT pg_notify('nexus_background_jobs', :kind)"),
            {"kind": row.kind},
        )
    return new_status


def prune_terminal_jobs(
    db: Session,
    *,
    succeeded_after_days: int,
    dead_after_days: int,
    limit: int,
    excluded_dead_kinds: Collection[str] = (),
) -> int:
    """Delete old terminal queue rows from the hot background_jobs table.

    Dead rows whose kind is in excluded_dead_kinds are never deleted (they
    stay operator-discoverable, per requeue_dead_job as their repair
    transition); succeeded rows of those same kinds still prune normally.
    """
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
                        AND NOT (kind = ANY(CAST(:excluded_dead_kinds AS text[])))
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
                "excluded_dead_kinds": list(excluded_dead_kinds),
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
