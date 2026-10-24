"""The durable job queue: one table, one function per transition.

A claim mints a fresh ``execution_id``. Every write on behalf of a running attempt
locks the row and requires that id, so nothing an attempt does commits after the
job was reclaimed. The lease is liveness only: the worker's heartbeat renews it
every few seconds, and only an expired lease lets a worker reclaim the job (or,
with its budget spent, dead-letter it). A late but unreclaimed attempt still
writes. Lock order everywhere: the job row, then the Heavy capacity row.
"""

from __future__ import annotations

import json
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.retries import integrity_constraint_name
from nexus.db.session import get_session_factory
from nexus.jobs.registry import registry, resolve

LEASE_SECONDS = 30

_HEAVY_BUSY = """EXISTS (SELECT 1 FROM background_job_capacity_leases
    WHERE resource_class = 'Heavy' AND lease_expires_at > clock_timestamp())"""
# Claimable: a due waiting row, or an expired claim with budget left. Each branch
# matches a partial index; the order uses the instant each became claimable.
_DUE = """((status IN ('pending', 'failed') AND available_at <= clock_timestamp())
    OR (status = 'running' AND lease_expires_at <= clock_timestamp()
        AND attempts < max_attempts))"""
_DUE_AT = "CASE WHEN status = 'running' THEN lease_expires_at ELSE available_at END"
_LEASE = f"clock_timestamp() + make_interval(secs => {LEASE_SECONDS})"
# The one fence: this attempt's row, still running under its own execution.
_OWNED = "id = :job_id AND status = 'running' AND execution_id = :execution_id"
_RELEASED = "claimed_by = NULL, lease_expires_at = NULL"


@dataclass(frozen=True)
class JobRow:
    """One ``background_jobs`` row, every column."""

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
    execution_id: UUID | None


@dataclass(frozen=True)
class JobExecutionContext:
    """One running attempt. ``execution_id`` is minted per claim and never reused."""

    job_id: UUID
    execution_id: UUID
    attempt_no: int


@dataclass(frozen=True)
class RescheduleRequested:
    """A handler's request to run again at ``at``, refunding this attempt."""

    at: datetime
    payload: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class TerminalJobFailure:
    """An unsuccessful domain terminal: the job goes dead at once, no retry."""

    result_payload: Mapping[str, Any]
    error_code: str
    error_message: str


type JobResult = Mapping[str, Any] | RescheduleRequested | TerminalJobFailure | None


class DurableExecutionPhase(StrEnum):
    """Advisory liveness projected from one live queue job."""

    Queued = "Queued"
    Running = "Running"
    Recovering = "Recovering"
    Suspended = "Suspended"


def project_execution_phase(
    *, job_status: str, attempts: int, error_code: str | None
) -> DurableExecutionPhase:
    """One unfinished job; ``Suspended`` is a dead job its owner did not end."""
    if job_status == "dead":
        return DurableExecutionPhase.Suspended
    if job_status == "failed" or error_code is not None:
        return DurableExecutionPhase.Recovering
    if job_status == "pending":
        return DurableExecutionPhase.Queued
    if job_status == "running":
        return DurableExecutionPhase.Running if attempts == 1 else DurableExecutionPhase.Recovering
    raise AssertionError(f"job status {job_status!r} has no execution phase")


# Producers.


def enqueue_job(
    db: Session,
    *,
    kind: str,
    payload: Mapping[str, Any],
    priority: int = 100,
    available_at: datetime | None = None,
    dedupe_key: str | None = None,
    created_at: datetime | None = None,
) -> JobRow:
    """Insert one pending job with its kind's attempt budget; commits nothing."""
    (row,) = _rows(
        db,
        """INSERT INTO background_jobs
           (kind, payload, priority, max_attempts, available_at, dedupe_key, created_at)
           VALUES (:kind, CAST(:payload AS jsonb), :priority, :max_attempts,
                   COALESCE(:available_at, now()), :dedupe_key, COALESCE(:created_at, now()))
           RETURNING *""",
        kind=kind,
        payload=json.dumps(dict(payload)),
        priority=priority,
        max_attempts=registry()[kind].max_attempts,
        available_at=available_at,
        dedupe_key=dedupe_key,
        created_at=created_at,
    )
    _notify(db, kind)
    return row


def enqueue_unique_job(
    db: Session,
    *,
    kind: str,
    payload: Mapping[str, Any],
    dedupe_key: str,
    priority: int = 100,
    available_at: datetime | None = None,
) -> tuple[JobRow, bool]:
    """Insert unless a row holds ``dedupe_key``; the row and whether this call inserted it."""
    by_key = "SELECT * FROM background_jobs WHERE dedupe_key = :key"
    if existing := _rows(db, by_key, key=dedupe_key):
        return existing[0], False
    try:
        with db.begin_nested():
            row = enqueue_job(
                db,
                kind=kind,
                payload=payload,
                priority=priority,
                available_at=available_at,
                dedupe_key=dedupe_key,
            )
        return row, True
    except IntegrityError as exc:
        raced = _rows(db, by_key, key=dedupe_key)
        if integrity_constraint_name(exc) != "idx_background_jobs_dedupe_key_unique" or not raced:
            raise
        return raced[0], False


# The worker's transitions.


@dataclass(frozen=True)
class Claim:
    job: JobRow
    context: JobExecutionContext


def claim_next_job(
    db: Session, *, worker_id: str, kinds: Sequence[str], heavy_kinds: Sequence[str]
) -> Claim | None:
    """Claim the first due job in queue order, taking the Heavy lease when it needs it."""
    candidate = _rows(
        db,
        f"""SELECT * FROM background_jobs
            WHERE {_DUE} AND kind = ANY(:kinds)
              AND (NOT kind = ANY(:heavy) OR NOT {_HEAVY_BUSY})
            ORDER BY priority, {_DUE_AT}, created_at, id
            LIMIT 1 FOR UPDATE SKIP LOCKED""",
        kinds=list(kinds),
        heavy=list(heavy_kinds),
    )
    if not candidate:
        return None
    heavy = candidate[0].kind in heavy_kinds
    # Locked whatever it holds: a concurrent Heavy claim waits here, then sees ours.
    busy = "SELECT lease_expires_at > clock_timestamp() FROM background_job_capacity_leases"
    if heavy and db.scalar(text(f"{busy} WHERE resource_class = 'Heavy' FOR UPDATE")):
        return None
    reclaimed = candidate[0].status == "running"
    (job,) = _rows(
        db,
        f"""UPDATE background_jobs
            SET status = 'running', attempts = attempts + 1, claimed_by = :worker_id,
                execution_id = gen_random_uuid(), lease_expires_at = {_LEASE},
                started_at = COALESCE(started_at, clock_timestamp()),
                error_code = CASE WHEN :reclaimed THEN 'E_WORKER_INTERRUPTED' ELSE error_code END,
                last_error = CASE WHEN :reclaimed THEN 'Worker lease expired; job reclaimed.'
                                  ELSE last_error END,
                updated_at = clock_timestamp()
            WHERE id = :job_id RETURNING *""",
        job_id=candidate[0].id,
        worker_id=worker_id,
        reclaimed=reclaimed,
    )
    if heavy:
        db.execute(
            text(
                "UPDATE background_job_capacity_leases SET job_id = :job_id,"
                " lease_expires_at = :expires, updated_at = clock_timestamp()"
                " WHERE resource_class = 'Heavy'"
            ),
            {"job_id": job.id, "expires": job.lease_expires_at},
        )
    assert job.execution_id is not None
    context = JobExecutionContext(job.id, job.execution_id, job.attempts)
    if reclaimed:
        _react(db, job, candidate[0].execution_id)
    return Claim(job, context)


def seconds_until_due(
    db: Session, *, kinds: Sequence[str], heavy_kinds: Sequence[str]
) -> float | None:
    """Seconds until this lane's next row is due or its claim expires (<= 0: now)."""
    return db.execute(
        text(f"""SELECT EXTRACT(EPOCH FROM MIN(due) - clock_timestamp())::float8 FROM (
                SELECT kind, available_at AS due FROM background_jobs
                WHERE status IN ('pending', 'failed') AND kind = ANY(:kinds)
                UNION ALL
                SELECT kind, lease_expires_at FROM background_jobs
                WHERE status = 'running' AND lease_expires_at IS NOT NULL AND kind = ANY(:kinds)
            ) waiting
            WHERE NOT kind = ANY(:heavy) OR NOT {_HEAVY_BUSY}"""),
        {"kinds": list(kinds), "heavy": list(heavy_kinds)},
    ).scalar()


def renew_running_job_claim(db: Session, *, context: JobExecutionContext, heavy: bool) -> bool:
    """Extend this attempt's lease (and its Heavy lease); False once either is lost."""
    if lock_running_job_claim(db, context=context) is None:
        return False
    if (
        heavy
        and not db.execute(
            text(
                "SELECT 1 FROM background_job_capacity_leases"
                " WHERE resource_class = 'Heavy' AND job_id = :job_id FOR UPDATE"
            ),
            {"job_id": context.job_id},
        ).first()
    ):
        return False
    db.execute(
        text(
            f"UPDATE background_jobs SET lease_expires_at = {_LEASE},"
            " updated_at = clock_timestamp() WHERE id = :job_id"
        ),
        {"job_id": context.job_id},
    )
    if heavy:
        db.execute(
            text(
                f"UPDATE background_job_capacity_leases SET lease_expires_at = {_LEASE},"
                " updated_at = clock_timestamp() WHERE resource_class = 'Heavy'"
            )
        )
    return True


def finish_job(
    db: Session,
    *,
    context: JobExecutionContext,
    result: Mapping[str, Any] | TerminalJobFailure | None,
) -> JobRow | None:
    """Finish the exact execution with its reactions; the caller owns the commit."""
    if isinstance(result, TerminalJobFailure):
        return fail_job(
            db,
            context=context,
            error_code=result.error_code,
            message=result.error_message,
            result=result.result_payload,
            dead=True,
        )
    return _settle(
        db,
        context,
        f"""status = 'succeeded', {_RELEASED}, result = CAST(:result AS jsonb),
            error_code = NULL, last_error = NULL, finished_at = clock_timestamp()""",
        result=_json(result),
    )


def reschedule_running_job(
    db: Session,
    *,
    context: JobExecutionContext,
    at: datetime | None,
    payload: Mapping[str, Any] | None = None,
) -> JobRow | None:
    """Back to pending at ``at`` (None: now), refunding the attempt."""
    row = _settle(
        db,
        context,
        f"""status = 'pending', {_RELEASED}, attempts = attempts - 1,
            available_at = COALESCE(CAST(:at AS timestamptz), clock_timestamp()),
            payload = COALESCE(CAST(:payload AS jsonb), payload)""",
        at=at,
        payload=_json(payload),
    )
    if row is not None:
        _react(db, row, context.execution_id)
    return row


def fail_job(
    db: Session,
    *,
    context: JobExecutionContext,
    error_code: str,
    message: str,
    result: Mapping[str, Any] | None = None,
    dead: bool = False,
) -> JobRow | None:
    """Retry after the kind's delay, or dead when ``dead`` or the budget is spent."""
    owned = lock_running_job_claim(db, context=context)
    if owned is None:
        return None
    delays = registry()[owned.kind].retry_delays
    dead = dead or owned.attempts >= owned.max_attempts
    failed = _settle(
        db,
        context,
        f"""status = :status, {_RELEASED}, error_code = :code, last_error = :message,
            result = CAST(:result AS jsonb),
            available_at = clock_timestamp() + make_interval(secs => :delay),
            finished_at = CASE WHEN :dead THEN clock_timestamp() END""",
        status="dead" if dead else "failed",
        code=error_code,
        message=message[:1000],
        result=_json(result),
        delay=0 if dead else delays[min(owned.attempts, len(delays)) - 1],
        dead=dead,
    )
    if not dead:
        _notify(db, owned.kind)
    if failed is not None:
        _react(db, failed, context.execution_id)
    return failed


def dead_letter_expired_job(db: Session, *, kinds: Sequence[str]) -> JobRow | None:
    """Make one expired running job whose budget is spent dead."""
    expired = _rows(
        db,
        """UPDATE background_jobs
           SET status = 'dead', claimed_by = NULL, lease_expires_at = NULL,
               error_code = 'E_WORKER_INTERRUPTED',
               last_error = 'Worker lease expired after max attempts.',
               finished_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE id = (SELECT id FROM background_jobs
                       WHERE status = 'running' AND lease_expires_at <= clock_timestamp()
                         AND attempts >= max_attempts AND kind = ANY(:kinds)
                       ORDER BY lease_expires_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING *""",
        kinds=list(kinds),
    )
    if not expired:
        return None
    _release_heavy(db, [expired[0].id])
    _react(db, expired[0], expired[0].execution_id)
    return expired[0]


# Fences for an attempt's own effect transactions.


def lock_running_job_claim(db: Session, *, context: JobExecutionContext) -> JobRow | None:
    """Lock this exact attempt's row until commit; None once the job was reclaimed."""
    rows = _rows(
        db,
        f"SELECT * FROM background_jobs WHERE {_OWNED} FOR UPDATE",
        job_id=context.job_id,
        execution_id=context.execution_id,
    )
    return rows[0] if rows else None


def running_job_claim_is_current(db: Session, *, context: JobExecutionContext) -> bool:
    """An unlocked read of the same fence, for polls between effects."""
    return bool(
        db.execute(
            text(f"SELECT EXISTS (SELECT 1 FROM background_jobs WHERE {_OWNED})"),
            {"job_id": context.job_id, "execution_id": context.execution_id},
        ).scalar_one()
    )


def update_running_job_payload(
    db: Session, *, context: JobExecutionContext, payload: Mapping[str, Any]
) -> bool:
    """Checkpoint this attempt's whole payload."""
    return (
        _settle(db, context, "payload = CAST(:payload AS jsonb)", payload=_json(payload))
        is not None
    )


# Mutations of jobs no worker holds; each names its callers.


def requeue_dead_job(db: Session, *, job_id: UUID) -> bool:
    """Repair (source import, search index): dead -> pending with a fresh budget."""
    kind = db.execute(
        text(
            "UPDATE background_jobs SET status = 'pending', attempts = 0, available_at = now(),"
            " finished_at = NULL, updated_at = now()"
            " WHERE id = :job_id AND status = 'dead' RETURNING kind"
        ),
        {"job_id": job_id},
    ).scalar_one_or_none()
    if kind is not None:
        _notify(db, kind)
    return kind is not None


def reset_unclaimed_job(
    db: Session, *, job_id: UUID, kind: str, payload: Mapping[str, Any]
) -> JobRow:
    """Content index: give a waiting job a new intent and a fresh budget."""
    rows = _rows(
        db,
        """UPDATE background_jobs
           SET payload = CAST(:payload AS jsonb), status = 'pending', attempts = 0,
               max_attempts = :max_attempts, available_at = now(), error_code = NULL,
               last_error = NULL, result = NULL, started_at = NULL, finished_at = NULL,
               updated_at = now()
           WHERE id = :job_id AND kind = :kind AND status IN ('pending', 'failed')
           RETURNING *""",
        job_id=job_id,
        kind=kind,
        payload=json.dumps(dict(payload)),
        max_attempts=registry()[kind].max_attempts,
    )
    if not rows:
        raise RuntimeError(f"job {job_id} is not a waiting {kind}")
    _notify(db, kind)
    return rows[0]


def supersede_unclaimed_job(db: Session, *, job_id: UUID, kind: str) -> None:
    """Content index, source ingest: complete an obsolete waiting job.

    SKIP LOCKED: waiting on a row another writer holds would close a cycle with the
    worker's settlement; this transaction's own locks are never skipped.
    """
    db.execute(
        text("""UPDATE background_jobs
            SET status = 'succeeded', result = '{"status": "superseded"}',
                finished_at = now(), updated_at = now()
            WHERE id = (SELECT id FROM background_jobs
                        WHERE id = :job_id AND kind = :kind AND status IN ('pending', 'failed')
                        FOR UPDATE SKIP LOCKED)"""),
        {"job_id": job_id, "kind": kind},
    )


def revoke_jobs_by_dedupe_keys(db: Session, *, kind: str, dedupe_keys: Collection[str]) -> None:
    """Chat and media units: delete owned rows, closing their open generations.

    The caller has invalidated the domain owner under its own lock. Generations
    close first: the tool fence locks a generation before its job.
    """
    from nexus.services.generation.ledger import interrupt_job_generations

    params = {"kind": kind, "keys": list(dedupe_keys)}
    by_key = "SELECT id FROM background_jobs WHERE kind = :kind AND dedupe_key = ANY(:keys)"
    for job_id in db.scalars(text(by_key), params).all():
        interrupt_job_generations(db, job_id=job_id, detail="its job was revoked")
    ids = list(db.scalars(text(f"{by_key} ORDER BY created_at, id FOR UPDATE"), params).all())
    _release_heavy(db, ids)
    db.execute(text("DELETE FROM background_jobs WHERE id = ANY(:ids)"), {"ids": ids})


# Reads.


def get_job(db: Session, job_id: UUID, *, lock: bool = False) -> JobRow | None:
    sql = "SELECT * FROM background_jobs WHERE id = :job_id" + (" FOR UPDATE" if lock else "")
    rows = _rows(db, sql, job_id=job_id)
    return rows[0] if rows else None


def jobs_for_payload(
    db: Session,
    *,
    kind: str,
    match: Mapping[str, Any],
    statuses: Collection[str] = ("pending", "failed", "running", "succeeded", "dead"),
    lock: bool = False,
) -> list[JobRow]:
    """Every ``kind`` job whose payload contains ``match``, oldest first (and lock order)."""
    return _rows(
        db,
        "SELECT * FROM background_jobs WHERE kind = :kind AND status = ANY(:statuses)"
        " AND payload @> CAST(:match AS jsonb) ORDER BY created_at, id"
        + (" FOR UPDATE" if lock else ""),
        kind=kind,
        statuses=list(statuses),
        match=json.dumps(dict(match)),
    )


def list_jobs_for_payload_values(
    db: Session, *, kind: str, payload_key: str, values: Sequence[str]
) -> list[JobRow]:
    """Metadata operations: one unlocked batch read, newest first."""
    return _rows(
        db,
        "SELECT * FROM background_jobs WHERE kind = :kind"
        " AND payload ->> :key = ANY(:values) ORDER BY created_at DESC, id DESC",
        kind=kind,
        key=payload_key,
        values=list(values),
    )


def prune_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    """Hourly: delete old terminal rows, except the kinds that keep theirs."""
    s = get_settings()
    kept = registry().items()
    with get_session_factory()() as db:
        deleted = db.execute(
            text("""DELETE FROM background_jobs WHERE id IN (
                SELECT id FROM background_jobs
                WHERE (status = 'succeeded' AND NOT kind = ANY(:keep_succeeded)
                       AND finished_at < now() - make_interval(days => :succeeded_days))
                   OR (status = 'dead' AND NOT kind = ANY(:keep_dead)
                       AND finished_at < now() - make_interval(days => :dead_days))
                ORDER BY finished_at, id LIMIT :limit FOR UPDATE SKIP LOCKED)
                RETURNING id"""),
            {
                "keep_succeeded": [kind for kind, d in kept if d.keep_succeeded],
                "keep_dead": [kind for kind, d in kept if d.keep_dead],
                "succeeded_days": s.background_job_prune_succeeded_after_days,
                "dead_days": s.background_job_prune_dead_after_days,
                "limit": s.background_job_prune_batch_size,
            },
        ).all()
        db.commit()
    return {"deleted_count": len(deleted)}


def _settle(
    db: Session, context: JobExecutionContext, assignments: str, **params: Any
) -> JobRow | None:
    """One fenced transition of this attempt; leaving 'running' frees its Heavy lease."""
    rows = _rows(
        db,
        f"UPDATE background_jobs SET {assignments}, updated_at = clock_timestamp()"
        f" WHERE {_OWNED} RETURNING *",
        job_id=context.job_id,
        execution_id=context.execution_id,
        **params,
    )
    if rows and rows[0].status != "running":
        _release_heavy(db, [context.job_id])
    return rows[0] if rows else None


def _release_heavy(db: Session, job_ids: list[UUID]) -> None:
    db.execute(
        text(
            "UPDATE background_job_capacity_leases SET job_id = NULL, lease_expires_at = NULL,"
            " updated_at = clock_timestamp() WHERE job_id = ANY(:job_ids)"
        ),
        {"job_ids": job_ids},
    )


def _react(db: Session, job: JobRow, execution_id: UUID | None) -> None:
    """Run the owner's reactions at the transition, including displaced attempts."""
    assert execution_id is not None
    definition = registry()[job.kind]
    if job.status == "dead" and definition.on_dead:
        resolve(definition.on_dead)(db, job)
    if definition.on_history:
        resolve(definition.on_history)(db, job, execution_id)


def _notify(db: Session, kind: str) -> None:
    db.execute(text("SELECT pg_notify('nexus_background_jobs', :kind)"), {"kind": kind})


def _json(value: Mapping[str, Any] | None) -> str | None:
    return None if value is None else json.dumps(dict(value))


def _rows(db: Session, sql: str, /, **params: Any) -> list[JobRow]:
    return [JobRow(**row) for row in db.execute(text(sql), params).mappings()]
