"""One lane's worker: schedule periodic slots, claim one job, run it, settle it."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any

import psycopg
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.jobs import queue
from nexus.jobs.process_executor import (
    ChildExecutor,
    Failed,
    Lost,
    Outcome,
    Released,
    run_in_process,
)
from nexus.jobs.registry import JobDefinition, Lane, registry, resolve
from nexus.logging import get_logger

logger = get_logger(__name__)

# The heartbeat renews leases and publishes health this often: well inside
# queue.LEASE_SECONDS and the healthcheck's 20 s window.
HEARTBEAT_SECONDS = 5.0


class JobWorker:
    def __init__(
        self,
        *,
        lane: Lane,
        worker_id: str,
        session_factory: Callable[[], Session],
        stop: threading.Event,
        publish_health: Callable[[], None],
        executor: ChildExecutor | None,
    ) -> None:
        self.definitions = {kind: d for kind, d in registry().items() if d.lane == lane}
        self.kinds = sorted(self.definitions)
        self.heavy_kinds = [kind for kind, d in self.definitions.items() if d.heavy]
        self.worker_id = worker_id
        self.session_factory = session_factory
        self.stop = stop
        self.publish_health = publish_health
        self.executor = executor

    def run_forever(self) -> None:
        while not self.stop.is_set():
            try:
                self.schedule_periodic()
                worked = self.run_once()
            except SQLAlchemyError:
                # justify-retry-schedule: an outage retries at the heartbeat cadence;
                # health goes stale meanwhile, which is the operator's signal.
                logger.exception("worker_database_failed", worker_id=self.worker_id)
                self.stop.wait(HEARTBEAT_SECONDS)
                continue
            self._publish_health()
            if not worked:
                self._wait_for_work()

    def schedule_periodic(self) -> None:
        """Enqueue each periodic kind's current UTC slot, once cluster-wide."""
        periodic = [(kind, d) for kind, d in self.definitions.items() if d.periodic_seconds]
        if not periodic:
            return
        with self.session_factory() as db:
            epoch = int(db.execute(text("SELECT extract(epoch FROM now())")).scalar_one())
            for kind, d in periodic:
                start = datetime.fromtimestamp(epoch - epoch % (d.periodic_seconds or 1), UTC)
                key = f"periodic:{kind}:{start.isoformat()}"
                queue.enqueue_unique_job(
                    db,
                    kind=kind,
                    payload={"request_id": key},
                    dedupe_key=key,
                    priority=d.periodic_priority,
                    available_at=start,
                )
            db.commit()

    def run_once(self) -> bool:
        """Dead-letter one expired job whose budget is spent, else claim and run one."""
        with self.session_factory() as db:
            if expired := queue.dead_letter_expired_job(db, kinds=self.kinds):
                db.commit()
                logger.warning(
                    "worker_job_dead_lettered", job_id=str(expired.id), kind=expired.kind
                )
                return True
            claim = queue.claim_next_job(
                db, worker_id=self.worker_id, kinds=self.kinds, heavy_kinds=self.heavy_kinds
            )
            db.commit()
        if claim is None:
            return False
        self._run(claim)
        return True

    def _run(self, claim: queue.Claim) -> None:
        job, context = claim.job, claim.context
        d = self.definitions[job.kind]
        lost, done = threading.Event(), threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat, args=(context, d.heavy, lost, done), daemon=True
        )
        heartbeat.start()
        try:
            if self.executor is None:
                outcome = run_in_process(d.handler, job.payload, context)
            else:
                temp = None if d.parser_temp_key is None else str(job.payload[d.parser_temp_key])
                outcome = self.executor.run(
                    d.handler, job.payload, context, shutdown=self.stop, lost=lost, parser_temp=temp
                )
        finally:
            done.set()
            heartbeat.join()  # no renewal races the settlement
        self._settle(d, job, context, outcome)

    def _heartbeat(
        self,
        context: queue.JobExecutionContext,
        heavy: bool,
        lost: threading.Event,
        done: threading.Event,
    ) -> None:
        while not done.wait(HEARTBEAT_SECONDS):
            try:
                with self.session_factory() as db, db.begin():
                    renewed = queue.renew_running_job_claim(db, context=context, heavy=heavy)
                    stored = None if renewed else queue.get_job(db, context.job_id)
            except SQLAlchemyError:
                logger.exception("worker_heartbeat_failed", job_id=str(context.job_id))
                continue
            if not renewed:
                if not (
                    stored is not None
                    and stored.execution_id == context.execution_id
                    and stored.status in {"succeeded", "dead"}
                ):
                    logger.warning("worker_claim_lost", job_id=str(context.job_id))
                lost.set()
                return
            self._publish_health()

    def _settle(
        self,
        d: JobDefinition,
        job: queue.JobRow,
        context: queue.JobExecutionContext,
        outcome: Outcome,
    ) -> None:
        """Commit how one attempt ended, and its hooks, in one transaction."""
        with self.session_factory() as db:
            stored = queue.get_job(db, context.job_id)
            if (
                stored is not None
                and stored.execution_id == context.execution_id
                and stored.status in {"succeeded", "dead"}
            ):
                return
            if isinstance(outcome, Lost):
                return
            if (
                isinstance(outcome, Failed)
                and d.on_failure
                and queue.lock_running_job_claim(db, context=context)
            ):
                finished: Mapping[str, Any] | None = resolve(d.on_failure)(db, job)
                if finished is not None:
                    logger.info("worker_failure_finished", job_id=str(job.id), failure=outcome)
                    outcome = finished
            match outcome:
                case Released():
                    row = queue.reschedule_running_job(db, context=context, at=None)
                case queue.RescheduleRequested(at=at, payload=payload):
                    row = queue.reschedule_running_job(db, context=context, at=at, payload=payload)
                case queue.TerminalJobFailure():
                    row = queue.finish_job(db, context=context, result=outcome)
                case Failed(code=code, message=message, dimension=dimension):
                    resource = {"kind": "ResourceFailure", "dimension": dimension}
                    row = queue.fail_job(
                        db,
                        context=context,
                        error_code=code,
                        message=message,
                        result=resource if dimension else None,
                        dead=dimension is not None,
                    )
                case _:
                    row = queue.finish_job(db, context=context, result=outcome)
            if row is None:
                logger.warning("worker_settle_lost", job_id=str(job.id), kind=job.kind)
                return
            db.commit()
        logger.info(
            "worker_job_settled",
            job_id=str(job.id),
            kind=job.kind,
            status=row.status,
            error_code=row.error_code,
        )

    def _wait_for_work(self) -> None:
        """Sleep until a notification for this lane, its next due row, or a heartbeat."""
        try:
            with self.session_factory() as db:
                connection = db.connection(execution_options={"isolation_level": "AUTOCOMMIT"})
                db.execute(text("LISTEN nexus_background_jobs"))
                try:
                    due = queue.seconds_until_due(
                        db, kinds=self.kinds, heavy_kinds=self.heavy_kinds
                    )
                    wait = HEARTBEAT_SECONDS if due is None else min(HEARTBEAT_SECONDS, due)
                    deadline = time.monotonic() + max(wait, 0.1)
                    driver = connection.connection.driver_connection
                    assert driver is not None
                    # justify-polling: one-second notify slices let a stop request
                    # end the wait; the deadline is the next due row or heartbeat.
                    while not self.stop.is_set() and (left := deadline - time.monotonic()) > 0:
                        for note in driver.notifies(timeout=min(left, 1.0), stop_after=1):
                            if note.payload in self.definitions:
                                return
                finally:
                    db.execute(text("UNLISTEN nexus_background_jobs"))
        except (SQLAlchemyError, psycopg.Error):
            logger.exception("worker_wait_failed", worker_id=self.worker_id)
            self.stop.wait(HEARTBEAT_SECONDS)

    def _publish_health(self) -> None:
        try:
            self.publish_health()
        except OSError:  # justify-ignore-error: health goes stale; no transition needs it
            logger.exception("worker_health_publish_failed", worker_id=self.worker_id)
