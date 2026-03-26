"""Postgres queue worker entrypoint."""

from __future__ import annotations

import os
import signal
import socket
import threading
from collections.abc import Callable

from nexus.db.session import get_session_factory
from nexus.jobs.registry import get_task_contract_version
from nexus.jobs.worker import JobWorker
from nexus.logging import configure_logging, get_logger

logger = get_logger(__name__)


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


def _register_signal_handlers(stop_event: threading.Event) -> None:
    def _handle_signal(signum: int, _frame: object) -> None:
        logger.info("postgres_worker_shutdown_signal", signal=signum)
        stop_event.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)


def _float_env(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        logger.warning("postgres_worker_invalid_env_float", name=name, raw=raw, default=default)
        return default
    if value <= 0:
        logger.warning(
            "postgres_worker_non_positive_env_float",
            name=name,
            raw=raw,
            default=default,
        )
        return default
    return value


def create_worker() -> JobWorker:
    session_factory: Callable = get_session_factory()
    return JobWorker(
        session_factory=session_factory,
        worker_id=_worker_id(),
        poll_interval_seconds=_float_env("WORKER_POLL_INTERVAL_SECONDS", 2.0),
        scheduler_interval_seconds=_float_env("WORKER_SCHEDULER_INTERVAL_SECONDS", 30.0),
        heartbeat_interval_seconds=_float_env("WORKER_HEARTBEAT_INTERVAL_SECONDS", 60.0),
        default_lease_seconds=int(_float_env("WORKER_LEASE_SECONDS", 300.0)),
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
    )
    worker.run_forever(stop_event=stop_event)
    logger.info("postgres_worker_stopped", worker_id=worker.worker_id)


if __name__ == "__main__":
    main()

