"""Postgres-backed worker: claim one job, execute it, settle it, schedule periodics."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from typing import Any, Literal, assert_never
from uuid import UUID

import psycopg
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.errors import ApiError, ApiErrorCode, ResourceFailureDimension
from nexus.jobs.dead_letter_projections import apply_dead_letter_projection
from nexus.jobs.history_projections import (
    Dead,
    HistoryOutcome,
    Interrupted,
    Rescheduled,
    RetryScheduled,
    apply_history_projection,
)
from nexus.jobs.process_executor import (
    BackgroundProcessExecutor,
    ChildClaimLost,
    ChildDefect,
    ChildInterrupted,
    ChildModeledFailure,
    ChildReschedule,
    ChildResourceFailure,
    ChildShutdownInterrupted,
    ChildSucceeded,
)
from nexus.jobs.queue import (
    HEAVY_CAPACITY_OCCUPIED_SQL,
    ClaimedJob,
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    RescheduleSchedule,
    ScheduleAfter,
    claim_job,
    claim_next_job,
    complete_job,
    dead_letter_expired_job,
    enqueue_unique_job,
    fail_job,
    get_job,
    heartbeat_job,
    lock_running_job_attempt,
    reschedule_running_job,
)
from nexus.jobs.registry import (
    JobDefinition,
    get_default_registry,
    periodic_dedupe_key,
    periodic_slot_start,
    resolve_job_handler,
)
from nexus.logging import get_logger
from nexus.schemas.presence import present
from nexus.services.source_attempt_failures import (
    ResourceLimitedSourceAttempt,
    publish_resource_limited_source_attempt,
)

logger = get_logger(__name__)

# Time allowed for the heartbeat thread to observe its stop flag and finish a
# renewal it may already be inside, before the worker settles the job itself.
_HEARTBEAT_DRAIN_TIMEOUT_SECONDS = 5.0

_RESOURCE_LIMIT_MESSAGES: Mapping[ResourceFailureDimension, str] = {
    "Memory": "Background job exceeded its memory resource limit.",
    "Time": "Background job exceeded its time resource limit.",
    "Structure": "Background job structure exceeded its processing resource limit.",
    "Output": "Background job output exceeded its processing resource limit.",
}

# The idle wait asks two questions of one claimable set: is anything due now (and
# not blocked by the Heavy lease), and when does the next row become due.
_WAIT_SQL = f"""
WITH claimable AS (
    SELECT kind, available_at AS ready_at FROM background_jobs
    WHERE status IN ('pending', 'failed') AND kind = ANY(CAST(:allowed_kinds AS text[]))
    UNION ALL
    SELECT kind, lease_expires_at FROM background_jobs
    WHERE status = 'running' AND lease_expires_at IS NOT NULL
      AND kind = ANY(CAST(:allowed_kinds AS text[]))
)
SELECT
    EXISTS (
        SELECT 1 FROM claimable
        WHERE ready_at <= now()
          AND (NOT (kind = ANY(CAST(:heavy_kinds AS text[])))
               OR NOT {HEAVY_CAPACITY_OCCUPIED_SQL})
    ) AS has_due_job,
    (SELECT EXTRACT(EPOCH FROM (MIN(ready_at) - now())) FROM claimable WHERE ready_at > now())
        AS seconds_until_next_job
"""


class _ChildFailure(RuntimeError):
    """A child outcome the common failure path must settle."""

    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code


class JobWorker:
    """Single-concurrency worker process around the Postgres queue."""

    def __init__(
        self,
        *,
        session_factory: Callable[[], Session],
        worker_id: str,
        registry: Mapping[str, JobDefinition] | None = None,
        poll_interval_seconds: float = 2.0,
        idle_backoff_max_seconds: float = 300.0,
        scheduler_interval_seconds: float = 30.0,
        heartbeat_interval_seconds: float = 60.0,
        default_lease_seconds: int = 300,
        db_failure_backoff_seconds: float = 60.0,
        db_failure_backoff_max_seconds: float = 900.0,
        allowed_kinds: tuple[str, ...],
        successful_cycle_callback: Callable[[], None] | None = None,
        successful_cycle_interval_seconds: float | None = None,
        process_executor: BackgroundProcessExecutor | None = None,
        stop_event: threading.Event | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.worker_id = worker_id
        self.registry = dict(get_default_registry() if registry is None else registry)
        self.heavy_kinds = tuple(
            sorted(d.kind for d in self.registry.values() if d.resource_class == "Heavy")
        )
        self.poll_interval_seconds = poll_interval_seconds
        self.idle_backoff_max_seconds = idle_backoff_max_seconds
        self.scheduler_interval_seconds = scheduler_interval_seconds
        self.heartbeat_interval_seconds = heartbeat_interval_seconds
        self.default_lease_seconds = default_lease_seconds
        self.db_failure_backoff_seconds = db_failure_backoff_seconds
        self.db_failure_backoff_max_seconds = db_failure_backoff_max_seconds
        self.allowed_kinds = allowed_kinds
        self.process_executor = process_executor
        # One shutdown signal per worker: the loop observes it between jobs and
        # the process executor observes it while a child is running.
        self._shutdown = threading.Event() if stop_event is None else stop_event
        self._successful_cycle_callback = successful_cycle_callback
        self._successful_cycle_interval_seconds = successful_cycle_interval_seconds

    def run_once(self) -> bool:
        """Dead-letter one expired job, or claim and execute the next due one."""
        with self.session_factory() as db:
            expired = dead_letter_expired_job(db, allowed_kinds=self.allowed_kinds)
            if expired is not None:
                definition = self.registry[expired.kind]
                self._apply_dead_letter(db, definition, expired)
                self._record(db, definition, expired, Interrupted(expired.execution_id, True))
                db.commit()
                return True
            claimed = claim_next_job(
                db,
                worker_id=self.worker_id,
                lease_seconds=self.default_lease_seconds,
                heavy_kinds=self.heavy_kinds,
                allowed_kinds=self.allowed_kinds,
            )
            self._record_reclaim(db, claimed)
            db.commit()
        if claimed is None:
            return False
        self._execute_claimed(claimed)
        return True

    def run_exact(self, job_id: UUID) -> bool | None:
        """Claim and execute only one exact due job, with no scan or scheduling."""
        with self.session_factory() as db:
            claimed = claim_job(
                db,
                job_id=job_id,
                worker_id=self.worker_id,
                lease_seconds=self.default_lease_seconds,
                heavy_kinds=self.heavy_kinds,
                allowed_kinds=self.allowed_kinds,
            )
            self._record_reclaim(db, claimed)
            db.commit()
        if claimed is None:
            return None
        self._execute_claimed(claimed)
        return True

    def _execute_claimed(self, claimed: ClaimedJob) -> None:
        job, context = claimed.job, claimed.context
        definition = self.registry[job.kind]
        if not heartbeat_job(
            session_factory=self.session_factory,
            context=context,
            lease_seconds=definition.lease_seconds,
        ):
            self._warn("worker_job_start_rejected_lost_ownership", job)
            return
        self._advance_successful_cycle()
        claim_lost = threading.Event()
        stop_heartbeat, heartbeat = self._start_heartbeat_thread(context, definition, claim_lost)

        def drain() -> None:
            stop_heartbeat.set()
            heartbeat.join(timeout=_HEARTBEAT_DRAIN_TIMEOUT_SECONDS)

        try:
            handler_result: Mapping[str, Any] | RescheduleRequested | None
            if self.process_executor is None:
                # Interactive and maintenance lanes keep their in-process boundary.
                handler = resolve_job_handler(definition.handler_path)
                handler_result = handler(payload=job.payload, context=context)
            else:
                child = self.process_executor.execute(
                    handler_path=definition.handler_path,
                    payload=job.payload,
                    context=context,
                    runtime=definition.child_runtime,
                    cleanup_attempt_id=_parser_temp_attempt_id(definition, job),
                    shutdown=self._shutdown,
                    claim_lost=claim_lost,
                )
                match child:
                    case ChildSucceeded(payload=payload):
                        handler_result = payload
                    case ChildReschedule(schedule=schedule, payload=payload):
                        handler_result = RescheduleRequested(schedule=schedule, payload=payload)
                    case ChildClaimLost():
                        # The claim is already someone else's; settling it here
                        # would overwrite the current owner's attempt.
                        self._warn("worker_child_terminated_after_lost_claim", job)
                        drain()
                        return
                    case ChildShutdownInterrupted():
                        drain()
                        self._reschedule(definition, job, ScheduleAfter(0), reason="shutdown")
                        return
                    case ChildResourceFailure(dimension=dimension):
                        drain()
                        self._settle_abnormal_child(definition, job, context, dimension)
                        return
                    case ChildModeledFailure(
                        error_code=code, message=message, resource_dimension=d
                    ):
                        if code == "E_RESOURCE_LIMIT" and d is not None:
                            drain()
                            self._settle_abnormal_child(definition, job, context, d)
                            return
                        raise _ChildFailure(code, message)
                    case ChildInterrupted(message=message):
                        drain()
                        if self._settle_abnormal_child(definition, job, context, None):
                            return
                        raise _ChildFailure("E_WORKER_INTERRUPTED", message)
                    case ChildDefect(error_type=error_type, message=message):
                        self._warn("worker_child_defect", job, defect=error_type, detail=message)
                        drain()
                        if self._settle_abnormal_child(definition, job, context, None):
                            return
                        raise _ChildFailure(
                            "E_WORKER_CHILD_DEFECT", f"{error_type} at background child boundary."
                        )
                    case _ as unreachable:
                        assert_never(unreachable)

            if isinstance(handler_result, RescheduleRequested):
                self._reschedule(
                    definition,
                    job,
                    handler_result.schedule,
                    reason="handler",
                    payload=handler_result.payload,
                )
                return
            result = dict(handler_result or {})
            if str(result.get("status") or "") in definition.failed_result_statuses:
                self._fail_attempt(
                    definition,
                    job,
                    error_code=str(result.get("error_code") or "E_WORKER_TASK_FAILED"),
                    message=str(result.get("reason") or "task returned failed status"),
                    result_payload=result,
                )
                return
            with self.session_factory() as db:
                completed = complete_job(
                    db,
                    job_id=job.id,
                    worker_id=self.worker_id,
                    attempt_no=job.attempts,
                    result_payload=result,
                )
                db.commit()
            if not completed:
                self._warn("worker_job_complete_rejected_lost_ownership", job)
        except Exception as exc:
            logger.exception(
                "worker_job_failed",
                worker_id=self.worker_id,
                job_id=str(job.id),
                kind=job.kind,
                error=str(exc),
            )
            self._fail_attempt(
                definition, job, error_code=_derive_error_code(exc), message=str(exc)
            )
        finally:
            drain()

    def _record_reclaim(self, db: Session, claimed: ClaimedJob | None) -> None:
        """Record the interruption of the execution a reclaiming claim displaced."""
        if claimed is None or not claimed.reclaimed:
            return
        definition = self.registry[claimed.job.kind]
        outcome = Interrupted(claimed.displaced_execution_id, terminal=False)
        self._record(db, definition, claimed.job, outcome)

    def _record(
        self, db: Session, definition: JobDefinition, job: JobRow, outcome: HistoryOutcome
    ) -> None:
        apply_history_projection(
            db, projection=definition.history_projection, job=job, outcome=outcome
        )

    def _apply_dead_letter(self, db: Session, definition: JobDefinition, job: JobRow) -> None:
        """Apply the kind's closed dead-letter repair inside the queue transition."""
        apply_dead_letter_projection(db, projection=definition.dead_letter_projection, job=job)
        self._warn("worker_job_dead_letter_handled", job, error_code=job.error_code)

    def _reschedule(
        self,
        definition: JobDefinition,
        job: JobRow,
        schedule: RescheduleSchedule,
        *,
        reason: Literal["handler", "shutdown"],
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        """Return the attempt to pending at a new time without burning retry budget."""
        with self.session_factory() as db:
            rescheduled = reschedule_running_job(
                db,
                job_id=job.id,
                worker_id=self.worker_id,
                attempt_no=job.attempts,
                schedule=schedule,
                payload=payload,
            )
            waiting = get_job(db, job.id) if rescheduled else None
            if waiting is not None:
                self._record(db, definition, waiting, Rescheduled(waiting.available_at))
            db.commit()
        if not rescheduled:
            self._warn("worker_job_reschedule_rejected_lost_ownership", job, reason=reason)

    def _fail_attempt(
        self,
        definition: JobDefinition,
        job: JobRow,
        *,
        error_code: str,
        message: str,
        result_payload: Mapping[str, Any] | None = None,
    ) -> None:
        """Apply the retry/dead transition with its repair and history, in one transaction."""
        with self.session_factory() as db:
            failed = fail_job(
                db,
                job_id=job.id,
                worker_id=self.worker_id,
                attempt_no=job.attempts,
                error_code=error_code,
                error_message=message,
                retry_delays_seconds=definition.retry_delays_seconds,
                result_payload=result_payload,
            )
            if failed is None:
                self._warn("worker_job_fail_rejected_lost_ownership", job)
                return
            if failed.status == "dead":
                self._apply_dead_letter(db, definition, failed)
                self._record(db, definition, failed, Dead(error_code))
            else:
                self._record(
                    db, definition, failed, RetryScheduled(failed.available_at, error_code)
                )
            db.commit()
        self._warn("worker_job_attempt_failed", job, status=failed.status, error_code=error_code)

    def _settle_abnormal_child(
        self,
        definition: JobDefinition,
        job: JobRow,
        context: JobExecutionContext,
        dimension: ResourceFailureDimension | None,
    ) -> bool:
        """Settle a child that died abnormally; a committed source success wins.

        True when the job reached a terminal state here, False when the caller
        must fail the attempt through the normal retry path.
        """
        projects_source = definition.resource_failure_projection == "SourceAttemptMedia"
        if dimension is None and not projects_source:
            return False
        with self.session_factory() as db:
            if (
                lock_running_job_attempt(
                    db, job_id=job.id, worker_id=self.worker_id, attempt_no=job.attempts
                )
                is None
            ):
                self._warn("worker_child_settlement_rejected_lost_ownership", job)
                return True
            if projects_source and _committed_source_success(db, job):
                result: dict[str, Any] = {"kind": "SourceProjectionSucceeded"}
                if dimension is not None:
                    result["child_exit"] = {"kind": "ResourceFailure", "dimension": dimension}
                complete_job(
                    db,
                    job_id=job.id,
                    worker_id=self.worker_id,
                    attempt_no=job.attempts,
                    result_payload=result,
                )
                db.commit()
                return True
            if dimension is None:
                return False
            message = _RESOURCE_LIMIT_MESSAGES[dimension]
            if projects_source:
                message = publish_resource_limited_source_attempt(
                    db,
                    ResourceLimitedSourceAttempt(
                        media_id=UUID(str(job.payload["media_id"])),
                        attempt_id=UUID(str(job.payload["attempt_id"])),
                        dimension=dimension,
                        execution_id=present(context.execution_id),
                    ),
                )
            dead = fail_job(
                db,
                job_id=job.id,
                worker_id=self.worker_id,
                attempt_no=job.attempts,
                error_code="E_RESOURCE_LIMIT",
                error_message=message,
                retry_delays_seconds=definition.retry_delays_seconds,
                result_payload={"kind": "ResourceFailure", "dimension": dimension},
                force_dead=True,
            )
            if dead is not None:
                self._apply_dead_letter(db, definition, dead)
                if not projects_source:
                    # The source owner records its own terminal domain failure.
                    self._record(db, definition, dead, Dead("E_RESOURCE_LIMIT"))
            db.commit()
        self._warn("worker_child_resource_limited", job, dimension=dimension)
        return True

    def run_scheduler_once(self) -> int:
        """Enqueue every due periodic slot once, cluster-wide, by deterministic key."""
        definitions = [
            definition
            for definition in self.registry.values()
            if definition.periodic_interval_seconds and definition.kind in self.allowed_kinds
        ]
        if not definitions:
            return 0
        with self.session_factory() as db:

            def op() -> int:
                now = db.execute(text("SELECT now()")).scalar_one()
                inserted = 0
                for definition in definitions:
                    slot_start = periodic_slot_start(
                        now=now, interval_seconds=definition.periodic_interval_seconds or 0
                    )
                    dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=slot_start)
                    _row, was_inserted = enqueue_unique_job(
                        db,
                        kind=definition.kind,
                        payload={"request_id": dedupe_key, "scheduler_identity": self.worker_id},
                        priority=definition.periodic_priority,
                        max_attempts=definition.max_attempts,
                        available_at=slot_start,
                        dedupe_key=dedupe_key,
                    )
                    inserted += int(was_inserted)
                db.commit()
                return inserted

            return retry_serializable(db, "worker_scheduler", op)

    def run_forever(self) -> None:
        """Run the scheduler and claim loops until this worker's shutdown signal is set."""
        stop = self._shutdown
        next_scheduler_at = time.monotonic()
        idle_wait_seconds = self.poll_interval_seconds
        db_failure_wait_seconds = self.db_failure_backoff_seconds

        while not stop.is_set():
            now_monotonic = time.monotonic()
            if now_monotonic >= next_scheduler_at:
                try:
                    self.run_scheduler_once()
                    db_failure_wait_seconds = self.db_failure_backoff_seconds
                except SQLAlchemyError:
                    db_failure_wait_seconds = self._back_off(
                        "worker_scheduler_db_failed", stop, db_failure_wait_seconds
                    )
                    next_scheduler_at = time.monotonic() + self.scheduler_interval_seconds
                    continue
                next_scheduler_at = now_monotonic + self.scheduler_interval_seconds

            try:
                processed = self.run_once()
                self._advance_successful_cycle()
                db_failure_wait_seconds = self.db_failure_backoff_seconds
            except SQLAlchemyError:
                db_failure_wait_seconds = self._back_off(
                    "worker_claim_db_failed", stop, db_failure_wait_seconds
                )
                idle_wait_seconds = self.poll_interval_seconds
                continue

            if processed:
                idle_wait_seconds = self.poll_interval_seconds
                continue
            wait_timeout = min(idle_wait_seconds, max(next_scheduler_at - time.monotonic(), 0.0))
            if self._successful_cycle_interval_seconds is not None:
                wait_timeout = min(wait_timeout, self._successful_cycle_interval_seconds)
            self._wait_for_job_notification(wait_timeout)
            idle_wait_seconds = min(idle_wait_seconds * 2, self.idle_backoff_max_seconds)

    def _back_off(self, event: str, stop: threading.Event, wait_seconds: float) -> float:
        """Sleep out one database failure and widen the next wait."""
        logger.exception(event, worker_id=self.worker_id, sleep_seconds=wait_seconds)
        stop.wait(wait_seconds)
        return min(wait_seconds * 2, self.db_failure_backoff_max_seconds)

    def _wait_for_job_notification(self, timeout: float) -> None:
        """Sleep until an enqueue notification, the next due instant, or the timeout."""
        stop = self._shutdown
        if timeout <= 0 or stop.is_set():
            return
        try:
            with self.session_factory() as db:
                connection = db.connection(execution_options={"isolation_level": "AUTOCOMMIT"})
                driver_connection = connection.connection.driver_connection
                if driver_connection is None:
                    raise RuntimeError("Database driver connection is unavailable for LISTEN.")
                db.execute(text("LISTEN nexus_background_jobs"))
                try:
                    wait_state = (
                        db.execute(
                            text(_WAIT_SQL),
                            {
                                "allowed_kinds": list(self.allowed_kinds),
                                "heavy_kinds": list(self.heavy_kinds),
                            },
                        )
                        .mappings()
                        .one()
                    )
                    if wait_state["has_due_job"]:
                        return
                    next_job_seconds = wait_state["seconds_until_next_job"]
                    if next_job_seconds is not None:
                        timeout = min(timeout, max(float(next_job_seconds), 0.1))
                    deadline = time.monotonic() + timeout
                    while not stop.is_set():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            return
                        for notification in driver_connection.notifies(
                            timeout=min(remaining, 1.0), stop_after=1
                        ):
                            if notification.payload in self.allowed_kinds:
                                return
                finally:
                    db.execute(text("UNLISTEN nexus_background_jobs"))
        except (SQLAlchemyError, psycopg.Error, OSError, RuntimeError) as exc:
            # LISTEN/NOTIFY can fail during a transient database or driver
            # disconnect; the bounded sleep keeps the claim loop making progress.
            logger.exception(
                "worker_job_notification_wait_failed",
                worker_id=self.worker_id,
                sleep_seconds=timeout,
                error=str(exc),
            )
            stop.wait(timeout)

    def _start_heartbeat_thread(
        self, context: JobExecutionContext, definition: JobDefinition, claim_lost: threading.Event
    ) -> tuple[threading.Event, threading.Thread]:
        """Renew this attempt's lease until stopped, flagging a lost claim."""
        stop_event = threading.Event()
        lease_seconds = definition.lease_seconds
        every = min(self.heartbeat_interval_seconds, max(lease_seconds / 2.0, 1.0))
        if self._successful_cycle_interval_seconds is not None:
            every = min(every, self._successful_cycle_interval_seconds)

        def _loop() -> None:
            while not stop_event.wait(every):
                try:
                    renewed = heartbeat_job(
                        session_factory=self.session_factory,
                        context=context,
                        lease_seconds=lease_seconds,
                    )
                except SQLAlchemyError:
                    logger.exception(
                        "worker_heartbeat_failed",
                        worker_id=self.worker_id,
                        job_id=str(context.job_id),
                    )
                    continue
                if not renewed:
                    # Settling now would overwrite the new owner's attempt, so the
                    # executor kills the child and the worker leaves the row alone.
                    logger.warning(
                        "worker_heartbeat_lost_ownership",
                        worker_id=self.worker_id,
                        job_id=str(context.job_id),
                    )
                    claim_lost.set()
                    return
                self._advance_successful_cycle()

        thread = threading.Thread(target=_loop, daemon=True, name=f"job-heartbeat-{context.job_id}")
        thread.start()
        return stop_event, thread

    def _advance_successful_cycle(self) -> None:
        if self._successful_cycle_callback is None:
            return
        try:
            self._successful_cycle_callback()
        except OSError:
            # Health stays stale until the next cycle; a telemetry-file failure
            # must never alter a queue transition.
            logger.exception("worker_runtime_heartbeat_publish_failed", worker_id=self.worker_id)

    def _warn(self, event: str, job: JobRow, **fields: Any) -> None:
        logger.warning(event, worker_id=self.worker_id, job_id=str(job.id), kind=job.kind, **fields)


def _parser_temp_attempt_id(definition: JobDefinition, job: JobRow) -> UUID | None:
    """Source ingest is the one kind whose child writes a parser-temp directory."""
    if definition.resource_failure_projection != "SourceAttemptMedia":
        return None
    return UUID(str(job.payload["attempt_id"]))


def _committed_source_success(db: Session, job: JobRow) -> bool:
    """Whether this job's own, still-latest source attempt already committed success.

    The API can publish a newer attempt for the same media while this job runs,
    so a settlement that does not own the latest attempt must not proceed.
    """
    media_id = UUID(str(job.payload["media_id"]))
    attempt_id = UUID(str(job.payload["attempt_id"]))
    attempt = (
        db.execute(
            text(
                "SELECT job_id, status FROM media_source_attempts"
                " WHERE id = :attempt_id AND media_id = :media_id FOR UPDATE"
            ),
            {"attempt_id": attempt_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    latest_attempt_id = db.scalar(
        text(
            "SELECT id FROM media_source_attempts WHERE media_id = :media_id"
            " ORDER BY attempt_no DESC, created_at DESC, id DESC LIMIT 1"
        ),
        {"media_id": media_id},
    )
    if (
        attempt is None
        or str(attempt["job_id"]) != str(job.id)
        or str(latest_attempt_id) != str(attempt_id)
    ):
        raise RuntimeError("source attempt identity does not match the settling job")
    return str(attempt["status"]) == "succeeded"


def _derive_error_code(exc: Exception) -> str:
    if isinstance(exc, ApiError) and isinstance(exc.code, ApiErrorCode):
        return exc.code.value
    candidate = getattr(exc, "error_code", None)
    if candidate is None:
        return "E_WORKER_HANDLER_FAILED"
    return str(getattr(candidate, "value", candidate))
