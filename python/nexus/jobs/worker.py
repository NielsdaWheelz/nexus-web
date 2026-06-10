"""Small Postgres-backed worker loop with lease heartbeat + periodic scheduler."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any
from uuid import UUID

import psycopg
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.jobs.queue import (
    claim_next_job,
    complete_job,
    dead_letter_expired_job,
    enqueue_unique_job,
    fail_job,
    get_job,
    heartbeat_job,
)
from nexus.jobs.registry import (
    JobDefinition,
    get_default_registry,
    periodic_dedupe_key,
    periodic_slot_start,
)
from nexus.logging import get_logger

logger = get_logger(__name__)


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
    ) -> None:
        self.session_factory = session_factory
        self.worker_id = worker_id
        self.registry = dict(get_default_registry() if registry is None else registry)
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
                allowed_kinds=self.allowed_kinds,
            )
            db.commit()

        if claimed is None:
            return False

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

        with self.session_factory() as db:
            still_owned = heartbeat_job(
                db,
                job_id=claimed.id,
                worker_id=self.worker_id,
                lease_seconds=definition.lease_seconds,
            )
            db.commit()
        if not still_owned:
            logger.warning(
                "worker_job_start_rejected_lost_ownership",
                worker_id=self.worker_id,
                job_id=str(claimed.id),
                kind=claimed.kind,
            )
            return True

        stop_event, heartbeat_thread = self._start_heartbeat_thread(
            job_id=claimed.id,
            lease_seconds=definition.lease_seconds,
        )

        try:
            handler_result = definition.handler(payload=claimed.payload)
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
                    "worker_job_succeeded",
                    worker_id=self.worker_id,
                    job_id=str(claimed.id),
                    kind=claimed.kind,
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
            heartbeat_thread.join(timeout=5)

        return True

    def _handle_dead_letter(
        self,
        db: Session,
        definition: JobDefinition,
        job: Any,
    ) -> None:
        """Run the kind-specific dead-letter hook inside the queue transition."""
        handler = definition.dead_letter_handler
        if handler is None:
            return
        handler(db, job)
        logger.warning(
            "worker_job_dead_letter_handled",
            worker_id=self.worker_id,
            job_id=str(job.id),
            kind=job.kind,
            error_code=job.error_code,
        )

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

                    _, was_inserted = enqueue_unique_job(
                        db,
                        kind=definition.kind,
                        payload={
                            "request_id": (f"periodic:{definition.kind}:{slot_start.isoformat()}"),
                            "scheduler_identity": self.worker_id,
                        },
                        priority=100,
                        max_attempts=definition.max_attempts,
                        available_at=slot_start,
                        dedupe_key=dedupe_key,
                    )
                    if was_inserted:
                        inserted += 1

                db.commit()
                return inserted

            return retry_serializable(db, "worker_scheduler", op)

    def run_forever(self, *, stop_event: threading.Event | None = None) -> None:
        """Run polling + scheduler loops until stop_event is set."""
        stop = stop_event or threading.Event()
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

            self._wait_for_job_notification(
                stop_event=stop,
                timeout=min(
                    idle_wait_seconds,
                    max(next_scheduler_at - time.monotonic(), 0.0),
                ),
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
                                    """
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
                                            )
                                            OR EXISTS (
                                                SELECT 1
                                                FROM background_jobs
                                                WHERE status = 'running'
                                                  AND lease_expires_at IS NOT NULL
                                                  AND lease_expires_at <= now()
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
                                )
                            )
                            .mappings()
                            .one()
                        )
                    else:
                        wait_state = (
                            db.execute(
                                text(
                                    """
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
                                            )
                                            OR EXISTS (
                                                SELECT 1
                                                FROM background_jobs
                                                WHERE status = 'running'
                                                  AND lease_expires_at IS NOT NULL
                                                  AND kind = ANY(:allowed_kinds)
                                                  AND lease_expires_at <= now()
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
                                {"allowed_kinds": list(self.allowed_kinds)},
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
        self, *, job_id: UUID, lease_seconds: int
    ) -> tuple[threading.Event, threading.Thread]:
        stop_event = threading.Event()
        heartbeat_every = min(self.heartbeat_interval_seconds, max(float(lease_seconds) / 2.0, 1.0))

        def _loop() -> None:
            while not stop_event.wait(heartbeat_every):
                try:
                    with self.session_factory() as db:
                        updated = heartbeat_job(
                            db,
                            job_id=job_id,
                            worker_id=self.worker_id,
                            lease_seconds=lease_seconds,
                        )
                        db.commit()
                        if not updated:
                            return
                except SQLAlchemyError:
                    logger.exception(
                        "worker_heartbeat_failed",
                        worker_id=self.worker_id,
                        job_id=str(job_id),
                    )

        thread = threading.Thread(target=_loop, daemon=True, name=f"job-heartbeat-{job_id}")
        thread.start()
        return stop_event, thread


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
