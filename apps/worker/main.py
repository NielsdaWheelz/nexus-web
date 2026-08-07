"""Postgres queue worker entrypoint."""

from __future__ import annotations

import os
import signal
import socket
import threading
from collections.abc import Callable
from typing import cast

from apps.worker.health import (
    WORKER_HEALTH_PROGRESS_INTERVAL_SECONDS,
    WorkerHeartbeatPublisher,
    WorkerLane,
)

from nexus.config import (
    BACKGROUND_WORKER_JOB_KINDS,
    INTERACTIVE_WORKER_JOB_KINDS,
    MAINTENANCE_JOB_KINDS,
    PRODUCTION_ENABLED_JOB_KINDS,
    get_settings,
)
from nexus.db.session import get_session_factory
from nexus.jobs.registry import get_default_registry, get_task_contract_digest
from nexus.jobs.worker import JobWorker
from nexus.logging import configure_logging, get_logger
from nexus.runtime_health import get_runtime_identity
from nexus.services.rate_limit import RateLimiter, set_rate_limiter

logger = get_logger(__name__)


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


def _register_signal_handlers(stop_event: threading.Event) -> None:
    def _handle_signal(signum: int, _frame: object) -> None:
        logger.info("postgres_worker_shutdown_signal", signal=signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)


def create_worker(*, successful_cycle_callback: Callable[[], None] | None = None) -> JobWorker:
    settings = get_settings()
    registry = get_default_registry()
    if settings.worker_lane == "interactive":
        allowed_kinds = INTERACTIVE_WORKER_JOB_KINDS
    elif settings.worker_lane == "background":
        allowed_kinds = BACKGROUND_WORKER_JOB_KINDS
    elif settings.worker_lane == "maintenance":
        allowed_kinds = tuple(
            value.strip()
            for value in (settings.worker_allowed_job_kinds or "").split(",")
            if value.strip()
        )
    else:
        raise RuntimeError(
            "WORKER_LANE must be interactive, background, or an explicitly gated maintenance."
        )

    registered_kinds = set(registry)
    declared_kinds = set(PRODUCTION_ENABLED_JOB_KINDS) | set(MAINTENANCE_JOB_KINDS)
    if registered_kinds != declared_kinds:
        missing = declared_kinds - registered_kinds
        undeclared = registered_kinds - declared_kinds
        raise RuntimeError(
            "Worker topology must cover the registry exactly; "
            f"missing={sorted(missing)}, undeclared={sorted(undeclared)}"
        )

    unknown_kinds = set(allowed_kinds) - registered_kinds
    if unknown_kinds:
        raise RuntimeError(f"Unknown worker job kinds: {', '.join(sorted(unknown_kinds))}")

    session_factory = get_session_factory()
    # Install the process-global rate limiter at startup (same construction as
    # the API lifespan in nexus/app.py) so the first job of any kind — not just
    # chat — has a working limiter instead of failing E_RATE_LIMITER_UNAVAILABLE.
    set_rate_limiter(
        RateLimiter(
            session_factory=session_factory,
            rpm_limit=settings.rate_limit_rpm,
            concurrent_limit=settings.rate_limit_concurrent,
        )
    )
    return JobWorker(
        session_factory=session_factory,
        worker_id=_worker_id(),
        registry=registry,
        poll_interval_seconds=settings.worker_poll_interval_seconds,
        idle_backoff_max_seconds=settings.worker_idle_backoff_max_seconds,
        scheduler_interval_seconds=settings.worker_scheduler_interval_seconds,
        heartbeat_interval_seconds=settings.worker_heartbeat_interval_seconds,
        default_lease_seconds=settings.worker_lease_seconds,
        db_failure_backoff_seconds=settings.worker_db_failure_backoff_seconds,
        db_failure_backoff_max_seconds=settings.worker_db_failure_backoff_max_seconds,
        allowed_kinds=tuple(sorted(allowed_kinds)),
        successful_cycle_callback=successful_cycle_callback,
        successful_cycle_interval_seconds=(
            WORKER_HEALTH_PROGRESS_INTERVAL_SECONDS
            if successful_cycle_callback is not None
            else None
        ),
    )


def main() -> None:
    configure_logging()
    stop_event = threading.Event()
    _register_signal_handlers(stop_event)

    settings = get_settings()
    identity = get_runtime_identity()
    publisher: WorkerHeartbeatPublisher | None = None
    if settings.worker_lane in ("interactive", "background"):
        lane = cast(WorkerLane, settings.worker_lane)
        allowed_job_kinds = (
            INTERACTIVE_WORKER_JOB_KINDS if lane == "interactive" else BACKGROUND_WORKER_JOB_KINDS
        )
        publisher = WorkerHeartbeatPublisher(
            lane=lane,
            allowed_job_kinds=tuple(sorted(allowed_job_kinds)),
            identity=identity,
            task_contract_digest=get_task_contract_digest(),
        )
        if publisher is not None:
            publisher.clear()

    worker = create_worker(
        successful_cycle_callback=publisher.publish if publisher is not None else None
    )
    logger.info(
        "postgres_worker_started",
        worker_id=worker.worker_id,
        lane=settings.worker_lane,
        source_sha=identity.source_sha,
        task_contract_digest=get_task_contract_digest(),
        allowed_job_kinds=list(worker.allowed_kinds or ()),
    )
    try:
        worker.run_forever(stop_event=stop_event)
    finally:
        if publisher is not None:
            publisher.clear()
        logger.info("postgres_worker_stopped", worker_id=worker.worker_id)


if __name__ == "__main__":
    main()
