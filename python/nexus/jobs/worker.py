"""Small Postgres-backed worker loop with lease heartbeat + periodic scheduler."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import (
    claim_next_job,
    complete_job,
    enqueue_unique_job,
    fail_job,
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
        scheduler_interval_seconds: float = 30.0,
        heartbeat_interval_seconds: float = 60.0,
        default_lease_seconds: int = 300,
    ) -> None:
        self.session_factory = session_factory
        self.worker_id = worker_id
        self.registry = dict(registry or get_default_registry())
        self.poll_interval_seconds = float(max(poll_interval_seconds, 0.1))
        self.scheduler_interval_seconds = float(max(scheduler_interval_seconds, 1.0))
        self.heartbeat_interval_seconds = float(max(heartbeat_interval_seconds, 1.0))
        self.default_lease_seconds = int(max(default_lease_seconds, 1))

    def run_once(self) -> bool:
        """Claim and execute exactly one due job row."""
        with self.session_factory() as db:
            claimed = claim_next_job(
                db,
                worker_id=self.worker_id,
                lease_seconds=self.default_lease_seconds,
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
            heartbeat_job(
                db,
                job_id=claimed.id,
                worker_id=self.worker_id,
                lease_seconds=definition.lease_seconds,
            )
            db.commit()

        stop_event, heartbeat_thread = self._start_heartbeat_thread(
            job_id=claimed.id,
            lease_seconds=definition.lease_seconds,
        )

        try:
            handler_result = definition.handler(payload=claimed.payload)
            with self.session_factory() as db:
                completed = complete_job(
                    db,
                    job_id=claimed.id,
                    worker_id=self.worker_id,
                    result_payload=_normalize_result_payload(handler_result),
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

    def run_scheduler_once(self, *, now: datetime | None = None) -> int:
        """Enqueue due periodic jobs with deterministic per-slot dedupe."""
        now_value = now or datetime.now(UTC)
        inserted = 0

        with self.session_factory() as db:
            for definition in self.registry.values():
                interval_seconds = definition.periodic_interval_seconds
                if interval_seconds is None:
                    continue

                slot_start = periodic_slot_start(now=now_value, interval_seconds=interval_seconds)
                dedupe_key = periodic_dedupe_key(kind=definition.kind, slot_start=slot_start)

                before_count = _count_dedupe_key(db, dedupe_key=dedupe_key)
                enqueue_unique_job(
                    db,
                    kind=definition.kind,
                    payload={
                        "request_id": f"periodic:{definition.kind}:{slot_start.isoformat()}",
                        "scheduler_identity": self.worker_id,
                    },
                    dedupe_key=dedupe_key,
                    priority=100,
                    max_attempts=definition.max_attempts,
                    available_at=slot_start,
                )
                after_count = _count_dedupe_key(db, dedupe_key=dedupe_key)
                if after_count > before_count:
                    inserted += 1

            db.commit()

        return inserted

    def run_forever(self, *, stop_event: threading.Event | None = None) -> None:
        """Run polling + scheduler loops until stop_event is set."""
        stop = stop_event or threading.Event()
        next_scheduler_at = time.monotonic()

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
                except Exception:
                    logger.exception("worker_scheduler_failed", worker_id=self.worker_id)
                next_scheduler_at = now_monotonic + self.scheduler_interval_seconds

            processed = self.run_once()
            if processed:
                continue

            stop.wait(self.poll_interval_seconds)

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
                except Exception:
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


def _count_dedupe_key(db: Session, *, dedupe_key: str) -> int:
    count = db.execute(
        text("SELECT COUNT(*) FROM background_jobs WHERE dedupe_key = :dedupe_key"),
        {"dedupe_key": dedupe_key},
    ).scalar_one()
    return int(count)
