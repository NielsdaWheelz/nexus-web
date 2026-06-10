"""Postgres queue worker entrypoint."""

from __future__ import annotations

import os
import signal
import socket
import threading

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.jobs.registry import get_default_registry, get_task_contract_version
from nexus.jobs.worker import JobWorker
from nexus.logging import configure_logging, get_logger
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


def create_worker() -> JobWorker:
    settings = get_settings()
    registry = get_default_registry()
    allowed_kinds = {
        value.strip() for value in settings.worker_allowed_job_kinds.split(",") if value.strip()
    }

    unknown_kinds = allowed_kinds - set(registry)
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
    )


def main() -> None:
    configure_logging()
    stop_event = threading.Event()
    _register_signal_handlers(stop_event)

    worker = create_worker()
    logger.info(
        "postgres_worker_started",
        worker_id=worker.worker_id,
        task_contract_version=get_task_contract_version(),
        allowed_job_kinds=list(worker.allowed_kinds or ()),
    )
    worker.run_forever(stop_event=stop_event)
    logger.info("postgres_worker_stopped", worker_id=worker.worker_id)


if __name__ == "__main__":
    main()
