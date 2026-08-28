"""Small Postgres-backed worker loop with lease heartbeat + periodic scheduler."""

from __future__ import annotations

import json
import math
import threading
import time
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, assert_never
from uuid import UUID

import psycopg
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.errors import ResourceFailureDimension
from nexus.jobs.dead_letter_projections import apply_dead_letter_projection
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
    JobExecutionContext,
    JobRow,
    RescheduleRequested,
    ScheduleAfter,
    ScheduleAt,
    claim_job,
    claim_next_job,
    complete_job,
    dead_letter_expired_job,
    enqueue_unique_job,
    fail_job,
    get_job,
    heartbeat_job,
    reconcile_periodic_job_priority,
    reschedule_running_job,
)
from nexus.jobs.registry import (
    JobDefinition,
    ResourceFailureProjection,
    get_default_registry,
    periodic_dedupe_key,
    periodic_slot_start,
    resolve_job_handler,
)
from nexus.logging import get_logger
from nexus.services.source_attempt_failures import (
    ResourceLimitedSourceAttempt,
    publish_resource_limited_source_attempt,
)

logger = get_logger(__name__)

# Time allowed for the heartbeat thread to observe its stop flag and finish the
# renewal it may already be inside, before the worker settles the job itself.
_HEARTBEAT_DRAIN_TIMEOUT_SECONDS = 5.0


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
        allowed_kinds: tuple[str, ...] | None = None,
        successful_cycle_callback: Callable[[], None] | None = None,
        successful_cycle_interval_seconds: float | None = None,
        process_executor: BackgroundProcessExecutor | None = None,
        stop_event: threading.Event | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.worker_id = worker_id
        self.registry = dict(get_default_registry() if registry is None else registry)
        self.heavy_kinds = tuple(
            sorted(
                definition.kind
                for definition in self.registry.values()
                if definition.resource_class == "Heavy"
            )
        )
        self.poll_interval_seconds = float(max(poll_interval_seconds, 0.1))
        self.idle_backoff_max_seconds = float(
            max(idle_backoff_max_seconds, self.poll_interval_seconds)
        )
        self.scheduler_interval_seconds = float(max(scheduler_interval_seconds, 1.0))
        self.heartbeat_interval_seconds = float(max(heartbeat_interval_seconds, 1.0))
        self.default_lease_seconds = int(max(default_lease_seconds, 1))
        self.db_failure_backoff_seconds = float(max(db_failure_backoff_seconds, 0.1))
        self.db_failure_backoff_max_seconds = float(
            max(db_failure_backoff_max_seconds, self.db_failure_backoff_seconds)
        )
        self.allowed_kinds = allowed_kinds
        self.process_executor = process_executor
        # One shutdown signal per worker: the loop observes it between jobs and the
        # process executor observes it while a child is running.
        self._shutdown = threading.Event() if stop_event is None else stop_event
        if (successful_cycle_callback is None) != (successful_cycle_interval_seconds is None):
            raise ValueError("successful cycle callback and interval must be configured together")
        if successful_cycle_callback is not None and allowed_kinds == ():
            raise ValueError("successful cycle health requires a database-backed lane")
        self._successful_cycle_callback = successful_cycle_callback
        if successful_cycle_interval_seconds is None:
            self._successful_cycle_interval_seconds = None
        else:
            interval = float(successful_cycle_interval_seconds)
            if not math.isfinite(interval) or interval <= 0:
                raise ValueError("successful cycle interval must be finite and positive")
            self._successful_cycle_interval_seconds = interval

    def run_once(self) -> bool:
        """Claim and execute exactly one due job row."""
        with self.session_factory() as db:
            dead_job = dead_letter_expired_job(db, allowed_kinds=self.allowed_kinds)
            if dead_job is not None:
                definition = self.registry.get(dead_job.kind)
                if definition is None:
                    logger.error(
                        "worker_unknown_dead_letter_job_kind",
                        worker_id=self.worker_id,
                        job_id=str(dead_job.id),
                        kind=dead_job.kind,
                    )
                else:
                    self._handle_dead_letter(db, definition, dead_job)
                db.commit()
                return True

            claimed = claim_next_job(
                db,
                worker_id=self.worker_id,
                lease_seconds=self.default_lease_seconds,
                heavy_kinds=self.heavy_kinds,
                allowed_kinds=self.allowed_kinds,
            )
            db.commit()

        if claimed is None:
            return False

        return self._execute_claimed(claimed)

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
            db.commit()
        if claimed is None:
            return None
        return self._execute_claimed(claimed)

    def _execute_claimed(self, claimed: JobRow) -> bool:
        definition = self.registry.get(claimed.kind)
        if definition is None:
            logger.error(
                "worker_unknown_job_kind",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
            )
            with self.session_factory() as db:
                fail_job(
                    db,
                    job_id=claimed.id,
                    worker_id=self.worker_id,
                    error_code="E_JOB_KIND_UNKNOWN",
                    error_message=f"Unsupported job kind: {claimed.kind}",
                    retry_delays_seconds=(),
                )
                db.commit()
            return True

        context = JobExecutionContext(
            job_id=claimed.id,
            worker_id=self.worker_id,
            attempt_no=claimed.attempts,
            resource_class=definition.resource_class,
        )
        still_owned = heartbeat_job(
            session_factory=self.session_factory,
            context=context,
            lease_seconds=definition.lease_seconds,
        )
        if not still_owned:
            logger.warning(
                "worker_job_start_rejected_lost_ownership",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
            )
            return True

        self._advance_successful_cycle()

        claim_lost = threading.Event()
        stop_event, heartbeat_thread = self._start_heartbeat_thread(
            context=context,
            lease_seconds=definition.lease_seconds,
            claim_lost=claim_lost,
        )

        try:
            # The background lane installs a process executor and dispatches every
            # handler through it. Resource class owns queue capacity only; it must
            # not let Light imports accumulate in the supervisor memory reserved
            # for a later Heavy child. Interactive/maintenance workers install no
            # executor and retain their deliberate in-process boundary.
            if self.process_executor is None:
                handler_result = resolve_job_handler(definition.handler_path)(
                    payload=claimed.payload,
                    context=context,
                )
            else:
                child_result = self.process_executor.execute(
                    handler_path=definition.handler_path,
                    payload=claimed.payload,
                    context=context,
                    wall_timeout_seconds=definition.wall_timeout_seconds,
                    runtime=definition.child_runtime,
                    child_exit_cleanup=definition.child_exit_cleanup,
                    shutdown=self._shutdown,
                    claim_lost=claim_lost,
                )
                if isinstance(child_result, ChildClaimLost):
                    # The claim is already someone else's; settling it here would
                    # overwrite the current owner's attempt.
                    logger.warning(
                        "worker_child_terminated_after_lost_claim",
                        worker_id=self.worker_id,
                        job_id=str(claimed.id),
                        kind=claimed.kind,
                    )
                    stop_event.set()
                    heartbeat_thread.join(timeout=_HEARTBEAT_DRAIN_TIMEOUT_SECONDS)
                    return True
                if isinstance(child_result, ChildShutdownInterrupted):
                    stop_event.set()
                    heartbeat_thread.join(timeout=_HEARTBEAT_DRAIN_TIMEOUT_SECONDS)
                    self._release_shutdown_interrupted_job(claimed=claimed)
                    return True
                if isinstance(child_result, ChildResourceFailure):
                    stop_event.set()
                    heartbeat_thread.join(timeout=_HEARTBEAT_DRAIN_TIMEOUT_SECONDS)
                    self._settle_resource_failure(
                        claimed=claimed,
                        definition=definition,
                        dimension=child_result.dimension,
                    )
                    return True
                if isinstance(child_result, ChildModeledFailure):
                    if (
                        child_result.error_code == "E_RESOURCE_LIMIT"
                        and child_result.resource_dimension is not None
                    ):
                        stop_event.set()
                        heartbeat_thread.join(timeout=_HEARTBEAT_DRAIN_TIMEOUT_SECONDS)
                        self._settle_resource_failure(
                            claimed=claimed,
                            definition=definition,
                            dimension=child_result.resource_dimension,
                        )
                        return True
                    raise _ChildFailure(child_result.error_code, child_result.message)
                if isinstance(child_result, ChildInterrupted):
                    stop_event.set()
                    heartbeat_thread.join(timeout=_HEARTBEAT_DRAIN_TIMEOUT_SECONDS)
                    if self._settle_succeeded_source_after_abnormal_child(
                        claimed=claimed,
                        definition=definition,
                        outcome="Interrupted",
                    ):
                        return True
                    raise _ChildFailure("E_WORKER_INTERRUPTED", child_result.message)
                if isinstance(child_result, ChildDefect):
                    logger.error(
                        "worker_child_defect",
                        worker_id=self.worker_id,
                        job_id=str(claimed.id),
                        kind=claimed.kind,
                        child_error_type=child_result.error_type,
                        child_error=child_result.message,
                    )
                    stop_event.set()
                    heartbeat_thread.join(timeout=_HEARTBEAT_DRAIN_TIMEOUT_SECONDS)
                    if self._settle_succeeded_source_after_abnormal_child(
                        claimed=claimed,
                        definition=definition,
                        outcome="Defect",
                    ):
                        return True
                    raise _ChildFailure(
                        "E_WORKER_CHILD_DEFECT",
                        f"{child_result.error_type} at background child boundary.",
                    )
                if isinstance(child_result, ChildReschedule):
                    handler_result = RescheduleRequested(
                        schedule=child_result.schedule,
                        payload=child_result.payload,
                    )
                elif isinstance(child_result, ChildSucceeded):
                    handler_result = child_result.payload
                else:
                    # justify-defect: the executor owns one closed result union.
                    raise AssertionError("background child result was not exhaustively handled")

            if isinstance(handler_result, RescheduleRequested):
                with self.session_factory() as db:
                    rescheduled = reschedule_running_job(
                        db,
                        job_id=claimed.id,
                        worker_id=self.worker_id,
                        attempt_no=claimed.attempts,
                        schedule=handler_result.schedule,
                        payload=handler_result.payload,
                    )
                    db.commit()
                if rescheduled:
                    match handler_result.schedule:
                        case ScheduleAt(instant=instant):
                            schedule_fact = {"available_at": instant.isoformat()}
                        case ScheduleAfter(seconds=seconds):
                            schedule_fact = {"delay_seconds": seconds}
                        case _ as unreachable:
                            assert_never(unreachable)
                    logger.info(
                        "worker_job_rescheduled",
                        worker_id=self.worker_id,
                        job_id=str(claimed.id),
                        kind=claimed.kind,
                        **schedule_fact,
                    )
                else:
                    logger.warning(
                        "worker_job_reschedule_rejected_lost_ownership",
                        worker_id=self.worker_id,
                        job_id=str(claimed.id),
                        kind=claimed.kind,
                    )
                return True

            result_payload = _normalize_result_payload(handler_result)
            failed_result_statuses = set(definition.failed_result_statuses)
            if str(result_payload.get("status") or "") in failed_result_statuses:
                error_code = str(result_payload.get("error_code") or "E_WORKER_TASK_FAILED")
                reason = str(result_payload.get("reason") or "task returned failed status")
                with self.session_factory() as db:
                    transition = fail_job(
                        db,
                        job_id=claimed.id,
                        worker_id=self.worker_id,
                        error_code=error_code,
                        error_message=reason,
                        retry_delays_seconds=definition.retry_delays_seconds,
                        result_payload=result_payload,
                    )
                    if transition == "dead":
                        dead_job = get_job(db, claimed.id)
                        if dead_job is not None:
                            self._handle_dead_letter(db, definition, dead_job)
                    db.commit()
                if transition is None:
                    logger.warning(
                        "worker_job_fail_rejected_lost_ownership",
                        worker_id=self.worker_id,
                        job_id=str(claimed.id),
                        kind=claimed.kind,
                    )
                else:
                    logger.warning(
                        "worker_job_task_failed",
                        worker_id=self.worker_id,
                        job_id=str(claimed.id),
                        kind=claimed.kind,
                        status=transition,
                        error_code=error_code,
                    )
                return True

            with self.session_factory() as db:
                completed = complete_job(
                    db,
                    job_id=claimed.id,
                    worker_id=self.worker_id,
                    result_payload=result_payload,
                )
                db.commit()
            if completed:
                logger.info(
                    "worker_job_completed",
                    worker_id=self.worker_id,
                    job_id=str(claimed.id),
                    kind=claimed.kind,
                    result_kind=result_payload.get("kind"),
                )
            else:
                logger.warning(
                    "worker_job_complete_rejected_lost_ownership",
                    worker_id=self.worker_id,
                    job_id=str(claimed.id),
                    kind=claimed.kind,
                )
        # justify-ignore-error: worker task boundary records failure and applies
        # retry/dead-letter policy.
        except Exception as exc:
            logger.exception(
                "worker_job_failed",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
                error=str(exc),
            )
            with self.session_factory() as db:
                transition = fail_job(
                    db,
                    job_id=claimed.id,
                    worker_id=self.worker_id,
                    error_code=_derive_error_code(exc),
                    error_message=str(exc),
                    retry_delays_seconds=definition.retry_delays_seconds,
                )
                if transition == "dead":
                    dead_job = get_job(db, claimed.id)
                    if dead_job is not None:
                        self._handle_dead_letter(db, definition, dead_job)
                db.commit()
                if transition is None:
                    logger.warning(
                        "worker_job_fail_rejected_lost_ownership",
                        worker_id=self.worker_id,
                        job_id=str(claimed.id),
                        kind=claimed.kind,
                    )
        finally:
            stop_event.set()
            heartbeat_thread.join(timeout=_HEARTBEAT_DRAIN_TIMEOUT_SECONDS)

        return True

    def _handle_dead_letter(
        self,
        db: Session,
        definition: JobDefinition,
        job: JobRow,
    ) -> None:
        """Apply the kind's closed dead-letter projection inside the queue transition."""
        if definition.dead_letter_projection == "None":
            return
        apply_dead_letter_projection(db, projection=definition.dead_letter_projection, job=job)
        logger.warning(
            "worker_job_dead_letter_handled",
            worker_id=self.worker_id,
            job_id=str(job.id),
            kind=job.kind,
            error_code=job.error_code,
        )

    def _release_shutdown_interrupted_job(self, *, claimed: JobRow) -> None:
        """Return a shutdown-interrupted job to pending without burning an attempt.

        The interruption is explained by our own shutdown, not by the job, so it
        must not consume retry budget. ``reschedule_running_job`` compensates the
        attempt the claim already charged and releases the Heavy capacity lease in
        the same fenced transaction.
        """
        with self.session_factory() as db:
            released = reschedule_running_job(
                db,
                job_id=claimed.id,
                worker_id=self.worker_id,
                attempt_no=claimed.attempts,
                schedule=ScheduleAfter(0),
            )
            db.commit()
        if released:
            logger.info(
                "worker_job_released_on_shutdown",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
            )
        else:
            logger.warning(
                "worker_job_release_rejected_lost_ownership",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
            )

    def _settle_resource_failure(
        self,
        *,
        claimed: JobRow,
        definition: JobDefinition,
        dimension: ResourceFailureDimension,
    ) -> None:
        """Publish one terminal resource failure under the exact live claim."""
        with self.session_factory() as db:
            settlement = _terminal_resource_failure(
                db,
                claimed=claimed,
                worker_id=self.worker_id,
                projection=definition.resource_failure_projection,
                dimension=dimension,
            )
            if settlement == "ResourceFailed":
                dead_job = get_job(db, claimed.id)
                if dead_job is not None:
                    self._handle_dead_letter(db, definition, dead_job)
            db.commit()
        if settlement == "ResourceFailed":
            logger.warning(
                "worker_child_resource_limited",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
                dimension=dimension,
            )
        elif settlement == "SourceProjectionSucceeded":
            logger.info(
                "worker_child_resource_arrived_after_source_success",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
                dimension=dimension,
            )
        else:
            logger.warning(
                "worker_child_resource_settlement_rejected_lost_ownership",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
                dimension=dimension,
            )

    def _settle_succeeded_source_after_abnormal_child(
        self,
        *,
        claimed: JobRow,
        definition: JobDefinition,
        outcome: str,
    ) -> bool:
        """Let an exact committed source success win over a later child failure."""
        if definition.resource_failure_projection != "SourceAttemptMedia":
            return False
        with self.session_factory() as db:
            settlement = _settle_abnormal_child_outcome(
                db,
                claimed=claimed,
                worker_id=self.worker_id,
                projection=definition.resource_failure_projection,
                dimension=None,
            )
            db.commit()
        if settlement != "SourceProjectionSucceeded":
            return False
        logger.info(
            "worker_abnormal_child_arrived_after_source_success",
            worker_id=self.worker_id,
            job_id=str(claimed.id),
            kind=claimed.kind,
            outcome=outcome,
        )
        return True

    def run_scheduler_once(self, *, now: datetime | None = None) -> int:
        """Enqueue due periodic jobs with deterministic per-slot dedupe."""
        definitions = []
        for definition in self.registry.values():
            interval_seconds = definition.periodic_interval_seconds
            if interval_seconds is None or interval_seconds <= 0:
                continue
            if self.allowed_kinds is not None and definition.kind not in self.allowed_kinds:
                continue
            definitions.append(definition)

        if not definitions:
            return 0

        with self.session_factory() as db:

            def op() -> int:
                now_value = now or db.execute(text("SELECT now()")).scalar_one()
                inserted = 0
                for definition in definitions:
                    slot_start = periodic_slot_start(
                        now=now_value,
                        interval_seconds=int(definition.periodic_interval_seconds or 0),
                    )
                    dedupe_key = periodic_dedupe_key(
                        kind=definition.kind,
                        slot_start=slot_start,
                    )

                    scheduled, was_inserted = enqueue_unique_job(
                        db,
                        kind=definition.kind,
                        payload={
                            "request_id": (f"periodic:{definition.kind}:{slot_start.isoformat()}"),
                            "scheduler_identity": self.worker_id,
                        },
                        priority=definition.periodic_priority,
                        max_attempts=definition.max_attempts,
                        available_at=slot_start,
                        dedupe_key=dedupe_key,
                    )
                    if was_inserted:
                        inserted += 1
                    else:
                        reconcile_periodic_job_priority(
                            db,
                            job_id=scheduled.id,
                            kind=definition.kind,
                            dedupe_key=dedupe_key,
                            priority=definition.periodic_priority,
                        )

                db.commit()
                return inserted

            return retry_serializable(db, "worker_scheduler", op)

    def run_forever(self) -> None:
        """Run polling + scheduler loops until this worker's shutdown signal is set."""
        stop = self._shutdown
        next_scheduler_at = time.monotonic()
        idle_wait_seconds = self.poll_interval_seconds
        db_failure_wait_seconds = self.db_failure_backoff_seconds

        while not stop.is_set():
            now_monotonic = time.monotonic()
            if now_monotonic >= next_scheduler_at:
                try:
                    inserted = self.run_scheduler_once()
                    if inserted:
                        logger.info(
                            "worker_scheduler_enqueued",
                            worker_id=self.worker_id,
                            inserted=inserted,
                        )
                    db_failure_wait_seconds = self.db_failure_backoff_seconds
                except SQLAlchemyError:
                    logger.exception(
                        "worker_scheduler_db_failed",
                        worker_id=self.worker_id,
                        sleep_seconds=db_failure_wait_seconds,
                    )
                    stop.wait(db_failure_wait_seconds)
                    db_failure_wait_seconds = min(
                        db_failure_wait_seconds * 2,
                        self.db_failure_backoff_max_seconds,
                    )
                    next_scheduler_at = time.monotonic() + self.scheduler_interval_seconds
                    continue
                next_scheduler_at = now_monotonic + self.scheduler_interval_seconds

            try:
                processed = self.run_once()
                self._advance_successful_cycle()
                db_failure_wait_seconds = self.db_failure_backoff_seconds
            except SQLAlchemyError:
                logger.exception(
                    "worker_claim_or_transition_db_failed",
                    worker_id=self.worker_id,
                    sleep_seconds=db_failure_wait_seconds,
                )
                stop.wait(db_failure_wait_seconds)
                db_failure_wait_seconds = min(
                    db_failure_wait_seconds * 2,
                    self.db_failure_backoff_max_seconds,
                )
                idle_wait_seconds = self.poll_interval_seconds
                continue

            if processed:
                idle_wait_seconds = self.poll_interval_seconds
                continue

            wait_timeout = min(
                idle_wait_seconds,
                max(next_scheduler_at - time.monotonic(), 0.0),
            )
            if self._successful_cycle_interval_seconds is not None:
                wait_timeout = min(wait_timeout, self._successful_cycle_interval_seconds)
            self._wait_for_job_notification(
                stop_event=stop,
                timeout=wait_timeout,
            )
            idle_wait_seconds = min(idle_wait_seconds * 2, self.idle_backoff_max_seconds)

    def _wait_for_job_notification(self, *, stop_event: threading.Event, timeout: float) -> None:
        """Wait for a transactional enqueue notification with polling as fallback."""
        if timeout <= 0 or stop_event.is_set():
            return

        try:
            with self.session_factory() as db:
                connection = db.connection(execution_options={"isolation_level": "AUTOCOMMIT"})
                driver_connection = connection.connection.driver_connection
                if driver_connection is None:
                    raise RuntimeError("Database driver connection is unavailable for LISTEN.")
                db.execute(text("LISTEN nexus_background_jobs"))

                try:
                    if self.allowed_kinds is None:
                        wait_state = (
                            db.execute(
                                text(
                                    f"""
                                    WITH next_wait AS (
                                        SELECT
                                            (
                                                SELECT available_at
                                                FROM background_jobs
                                                WHERE status IN ('pending', 'failed')
                                                  AND available_at > now()
                                                ORDER BY available_at ASC, id ASC
                                                LIMIT 1
                                            ) AS next_available_at,
                                            (
                                                SELECT lease_expires_at
                                                FROM background_jobs
                                                WHERE status = 'running'
                                                  AND lease_expires_at IS NOT NULL
                                                  AND lease_expires_at > now()
                                                ORDER BY lease_expires_at ASC, id ASC
                                                LIMIT 1
                                            ) AS next_lease_expires_at
                                    )
                                    SELECT
                                        (
                                            EXISTS (
                                                SELECT 1
                                                FROM background_jobs
                                                WHERE status IN ('pending', 'failed')
                                                  AND available_at <= now()
                                                  AND (
                                                      NOT kind = ANY(
                                                          CAST(:heavy_kinds AS text[])
                                                      )
                                                      OR NOT {HEAVY_CAPACITY_OCCUPIED_SQL}
                                                  )
                                            )
                                            OR EXISTS (
                                                SELECT 1
                                                FROM background_jobs
                                                WHERE status = 'running'
                                                  AND lease_expires_at IS NOT NULL
                                                  AND lease_expires_at <= now()
                                                  AND (
                                                      NOT kind = ANY(
                                                          CAST(:heavy_kinds AS text[])
                                                      )
                                                      OR NOT {HEAVY_CAPACITY_OCCUPIED_SQL}
                                                  )
                                            )
                                        ) AS has_due_job,
                                        CASE
                                            WHEN next_available_at IS NULL
                                              AND next_lease_expires_at IS NULL
                                            THEN NULL
                                            WHEN next_available_at IS NULL
                                            THEN EXTRACT(EPOCH FROM (next_lease_expires_at - now()))
                                            WHEN next_lease_expires_at IS NULL
                                            THEN EXTRACT(EPOCH FROM (next_available_at - now()))
                                            WHEN next_available_at <= next_lease_expires_at
                                            THEN EXTRACT(EPOCH FROM (next_available_at - now()))
                                            ELSE EXTRACT(EPOCH FROM (next_lease_expires_at - now()))
                                        END AS seconds_until_next_job
                                    FROM next_wait
                                    """
                                ),
                                {"heavy_kinds": list(self.heavy_kinds)},
                            )
                            .mappings()
                            .one()
                        )
                    else:
                        wait_state = (
                            db.execute(
                                text(
                                    f"""
                                    WITH next_wait AS (
                                        SELECT
                                            (
                                                SELECT available_at
                                                FROM background_jobs
                                                WHERE status IN ('pending', 'failed')
                                                  AND kind = ANY(:allowed_kinds)
                                                  AND available_at > now()
                                                ORDER BY available_at ASC, id ASC
                                                LIMIT 1
                                            ) AS next_available_at,
                                            (
                                                SELECT lease_expires_at
                                                FROM background_jobs
                                                WHERE status = 'running'
                                                  AND lease_expires_at IS NOT NULL
                                                  AND kind = ANY(:allowed_kinds)
                                                  AND lease_expires_at > now()
                                                ORDER BY lease_expires_at ASC, id ASC
                                                LIMIT 1
                                            ) AS next_lease_expires_at
                                    )
                                    SELECT
                                        (
                                            EXISTS (
                                                SELECT 1
                                                FROM background_jobs
                                                WHERE status IN ('pending', 'failed')
                                                  AND kind = ANY(:allowed_kinds)
                                                  AND available_at <= now()
                                                  AND (
                                                      NOT kind = ANY(
                                                          CAST(:heavy_kinds AS text[])
                                                      )
                                                      OR NOT {HEAVY_CAPACITY_OCCUPIED_SQL}
                                                  )
                                            )
                                            OR EXISTS (
                                                SELECT 1
                                                FROM background_jobs
                                                WHERE status = 'running'
                                                  AND lease_expires_at IS NOT NULL
                                                  AND kind = ANY(:allowed_kinds)
                                                  AND lease_expires_at <= now()
                                                  AND (
                                                      NOT kind = ANY(
                                                          CAST(:heavy_kinds AS text[])
                                                      )
                                                      OR NOT {HEAVY_CAPACITY_OCCUPIED_SQL}
                                                  )
                                            )
                                        ) AS has_due_job,
                                        CASE
                                            WHEN next_available_at IS NULL
                                              AND next_lease_expires_at IS NULL
                                            THEN NULL
                                            WHEN next_available_at IS NULL
                                            THEN EXTRACT(EPOCH FROM (next_lease_expires_at - now()))
                                            WHEN next_lease_expires_at IS NULL
                                            THEN EXTRACT(EPOCH FROM (next_available_at - now()))
                                            WHEN next_available_at <= next_lease_expires_at
                                            THEN EXTRACT(EPOCH FROM (next_available_at - now()))
                                            ELSE EXTRACT(EPOCH FROM (next_lease_expires_at - now()))
                                        END AS seconds_until_next_job
                                    FROM next_wait
                                    """
                                ),
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

                    wait_timeout = timeout
                    seconds_until_next_job = wait_state["seconds_until_next_job"]
                    if seconds_until_next_job is not None:
                        wait_timeout = min(wait_timeout, max(float(seconds_until_next_job), 0.1))

                    deadline = time.monotonic() + wait_timeout
                    while not stop_event.is_set():
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            return
                        for notification in driver_connection.notifies(
                            timeout=min(remaining, 1.0),
                            stop_after=1,
                        ):
                            if (
                                self.allowed_kinds is not None
                                and notification.payload not in self.allowed_kinds
                            ):
                                continue
                            return
                finally:
                    db.execute(text("UNLISTEN nexus_background_jobs"))
        except (SQLAlchemyError, psycopg.Error, OSError, RuntimeError) as exc:
            logger.exception(
                "worker_job_notification_wait_failed",
                worker_id=self.worker_id,
                sleep_seconds=timeout,
                error=str(exc),
            )
            # justify-polling: LISTEN/NOTIFY can fail during transient DB or driver
            # disconnects. The bounded idle timeout preserves progress until the
            # main claim loop retries the database path.
            stop_event.wait(timeout)

    def _start_heartbeat_thread(
        self,
        *,
        context: JobExecutionContext,
        lease_seconds: int,
        claim_lost: threading.Event,
    ) -> tuple[threading.Event, threading.Thread]:
        stop_event = threading.Event()
        heartbeat_every = min(self.heartbeat_interval_seconds, max(float(lease_seconds) / 2.0, 1.0))
        if self._successful_cycle_interval_seconds is not None:
            heartbeat_every = min(heartbeat_every, self._successful_cycle_interval_seconds)

        def _loop() -> None:
            while not stop_event.wait(heartbeat_every):
                try:
                    updated = heartbeat_job(
                        session_factory=self.session_factory,
                        context=context,
                        lease_seconds=lease_seconds,
                    )
                    if not updated:
                        logger.warning(
                            "worker_heartbeat_lost_ownership",
                            worker_id=self.worker_id,
                            job_id=str(context.job_id),
                        )
                        claim_lost.set()
                        return
                    self._advance_successful_cycle()
                except SQLAlchemyError:
                    logger.exception(
                        "worker_heartbeat_failed",
                        worker_id=self.worker_id,
                        job_id=str(context.job_id),
                    )

        thread = threading.Thread(
            target=_loop,
            daemon=True,
            name=f"job-heartbeat-{context.job_id}",
        )
        thread.start()
        return stop_event, thread

    def _advance_successful_cycle(self) -> None:
        callback = self._successful_cycle_callback
        if callback is None:
            return
        try:
            callback()
        except OSError:
            # justify-ignore-error: health remains stale/unready, but an
            # ephemeral telemetry-file failure must not alter queue transitions.
            logger.exception(
                "worker_runtime_heartbeat_publish_failed",
                worker_id=self.worker_id,
            )


class _ChildFailure(RuntimeError):
    def __init__(self, error_code: str, message: str) -> None:
        super().__init__(message)
        self.error_code = error_code


def _terminal_resource_failure(
    db: Session,
    *,
    claimed: JobRow,
    worker_id: str,
    projection: ResourceFailureProjection,
    dimension: ResourceFailureDimension,
) -> str | None:
    """Atomically fail the exact child-owned domain projection and queue row."""
    return _settle_abnormal_child_outcome(
        db,
        claimed=claimed,
        worker_id=worker_id,
        projection=projection,
        dimension=dimension,
    )


def _settle_abnormal_child_outcome(
    db: Session,
    *,
    claimed: JobRow,
    worker_id: str,
    projection: ResourceFailureProjection,
    dimension: ResourceFailureDimension | None,
) -> str | None:
    """Fence one abnormal child outcome; durable source success is authoritative."""
    job = db.execute(
        text(
            """
                SELECT id
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
            "job_id": claimed.id,
            "worker_id": worker_id,
            "attempt_no": claimed.attempts,
        },
    ).one_or_none()
    if job is None:
        return None
    capacity = (
        db.execute(
            text(
                """
                SELECT job_id, worker_id, attempt_no
                FROM background_job_capacity_leases
                WHERE resource_class = 'Heavy'
                  AND job_id = :job_id
                FOR UPDATE
                """
            ),
            {"job_id": claimed.id},
        )
        .mappings()
        .one_or_none()
    )
    if capacity is None:
        # Heavy admission is the only execution class currently eligible for a
        # source resource projection. Job-only Light children need no capacity row.
        if projection == "SourceAttemptMedia":
            raise AssertionError("source resource projection has no Heavy capacity holder")
    elif str(capacity["worker_id"]) != worker_id or int(capacity["attempt_no"]) != claimed.attempts:
        raise AssertionError("resource-limited Heavy capacity holder is inconsistent")
    media_id: UUID | None = None
    attempt_id: UUID | None = None
    source_attempt_status: str | None = None
    if projection == "SourceAttemptMedia":
        try:
            media_id = UUID(str(claimed.payload["media_id"]))
            attempt_id = UUID(str(claimed.payload["attempt_id"]))
        except (KeyError, TypeError, ValueError) as exc:
            # justify-defect: the source-job publisher owns this closed payload.
            raise AssertionError("source resource projection payload is malformed") from exc
        media = (
            db.execute(
                text(
                    """
                    SELECT id, processing_status, processing_completed_at
                    FROM media
                    WHERE id = :media_id
                    FOR UPDATE
                    """
                ),
                {"media_id": media_id},
            )
            .mappings()
            .one_or_none()
        )
        attempt = (
            db.execute(
                text(
                    """
                    SELECT id, media_id, job_id, status
                    FROM media_source_attempts
                    WHERE id = :attempt_id
                    FOR UPDATE
                    """
                ),
                {"attempt_id": attempt_id},
            )
            .mappings()
            .one_or_none()
        )
        latest_attempt_id = db.scalar(
            text(
                """
                SELECT id
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no DESC, created_at DESC, id DESC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        )
        if (
            media is None
            or attempt is None
            or UUID(str(attempt["media_id"])) != media_id
            or UUID(str(attempt["job_id"])) != claimed.id
            or UUID(str(attempt["id"])) != latest_attempt_id
        ):
            # justify-defect: the source attempt and queue payload are one exact
            # published identity and no newer attempt may be overwritten.
            raise AssertionError("source resource projection identity is inconsistent")
        source_attempt_status = str(attempt["status"])
        if source_attempt_status == "succeeded":
            if (
                str(media["processing_status"]) != "ready_for_reading"
                or media["processing_completed_at"] is None
            ):
                raise AssertionError("succeeded source media projection is inconsistent")
            result: dict[str, object] = {"kind": "SourceProjectionSucceeded"}
            if dimension is not None:
                result["child_exit"] = {
                    "kind": "ResourceFailure",
                    "dimension": dimension,
                }
            succeeded = db.execute(
                text(
                    """
                    UPDATE background_jobs
                    SET status = 'succeeded',
                        claimed_by = NULL,
                        lease_expires_at = NULL,
                        error_code = NULL,
                        last_error = NULL,
                        result = CAST(:result AS jsonb),
                        finished_at = clock_timestamp(),
                        updated_at = clock_timestamp()
                    WHERE id = :job_id
                      AND status = 'running'
                      AND claimed_by = :worker_id
                      AND attempts = :attempt_no
                    RETURNING id
                    """
                ),
                {
                    "job_id": claimed.id,
                    "worker_id": worker_id,
                    "attempt_no": claimed.attempts,
                    "result": json.dumps(result),
                },
            ).one_or_none()
            if succeeded is None:
                raise AssertionError("succeeded source queue claim changed while locked")
            _clear_resource_failure_capacity(
                db,
                capacity=capacity,
                claimed=claimed,
                worker_id=worker_id,
            )
            return "SourceProjectionSucceeded"
        if source_attempt_status not in {"accepted", "queued", "running"}:
            raise AssertionError("source resource projection identity is inconsistent")

    if dimension is None:
        return "SourceProjectionNotSucceeded"

    message = {
        "Memory": "Background job exceeded its memory resource limit.",
        "Time": "Background job exceeded its time resource limit.",
        "Structure": "Background job structure exceeded its processing resource limit.",
        "Output": "Background job output exceeded its processing resource limit.",
    }[dimension]
    if projection == "SourceAttemptMedia":
        if media_id is None or attempt_id is None:
            # justify-defect: the projection branch above parsed both identities.
            raise AssertionError("source resource projection identities are absent")
        message = publish_resource_limited_source_attempt(
            db,
            ResourceLimitedSourceAttempt(
                media_id=media_id,
                attempt_id=attempt_id,
                dimension=dimension,
            ),
        )

    terminal = db.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'dead',
                claimed_by = NULL,
                lease_expires_at = NULL,
                error_code = 'E_RESOURCE_LIMIT',
                last_error = :message,
                result = CAST(:result AS jsonb),
                finished_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE id = :job_id
              AND status = 'running'
              AND claimed_by = :worker_id
              AND attempts = :attempt_no
            RETURNING id
            """
        ),
        {
            "job_id": claimed.id,
            "worker_id": worker_id,
            "attempt_no": claimed.attempts,
            "message": message,
            "result": json.dumps({"kind": "ResourceFailure", "dimension": dimension}),
        },
    ).one_or_none()
    if terminal is None:
        raise AssertionError("resource-limited queue claim changed while locked")
    _clear_resource_failure_capacity(
        db,
        capacity=capacity,
        claimed=claimed,
        worker_id=worker_id,
    )
    return "ResourceFailed"


def _clear_resource_failure_capacity(
    db: Session,
    *,
    capacity: Mapping[Any, Any] | None,
    claimed: JobRow,
    worker_id: str,
) -> None:
    if capacity is None:
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
            RETURNING resource_class
            """
        ),
        {
            "job_id": claimed.id,
            "worker_id": worker_id,
            "attempt_no": claimed.attempts,
        },
    ).one_or_none()
    if cleared is None:
        raise AssertionError("resource-limited Heavy capacity holder changed while locked")


def _derive_error_code(exc: Exception) -> str:
    candidate = getattr(exc, "error_code", None)
    if candidate is None:
        return "E_WORKER_HANDLER_FAILED"
    value = getattr(candidate, "value", candidate)
    return str(value)


def _normalize_result_payload(result: Mapping[str, Any] | None) -> dict[str, Any]:
    if result is None:
        return {}
    return dict(result)
