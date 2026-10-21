"""Worker entrypoint: one lane per process, ``WORKER_LANE=interactive|background``."""

from __future__ import annotations

import os
import signal
import socket
import sys
import threading

from apps.worker.health import Heartbeat

from nexus.config import get_settings
from nexus.db.session import get_session_factory
from nexus.jobs.process_executor import ChildExecutor
from nexus.jobs.registry import resolve
from nexus.jobs.worker import JobWorker
from nexus.logging import configure_logging, get_logger
from nexus.runtime_health import get_runtime_identity, is_database_ready

logger = get_logger(__name__)

# What a background supervisor must never import: the storage, provider and parser
# graphs live in its children, inside the 448 MiB the supervisor shares with them.
_CHILD_ONLY_MODULES = frozenset({"boto3", "httpx", "lxml"})


def main() -> None:
    configure_logging()
    settings = get_settings()
    identity = get_runtime_identity()
    lane = settings.worker_lane
    if lane is None:
        raise SystemExit("WORKER_LANE must be interactive or background")
    stop = threading.Event()
    for signum in (signal.SIGINT, signal.SIGTERM):
        # Seen between jobs and by a running child, so a release frees the claim.
        signal.signal(signum, lambda *_: stop.set())
    heartbeat = Heartbeat(lane, identity.source_sha, identity.expected_database_revision)
    heartbeat.clear()
    executor = ChildExecutor.open(settings) if lane == "background" else None
    worker = JobWorker(
        lane=lane,
        worker_id=f"{socket.gethostname()}:{os.getpid()}",
        session_factory=get_session_factory(),
        stop=stop,
        publish_health=heartbeat.publish,
        executor=executor,
    )
    # Hooks run in this process: import them now, and keep a supervisor lean.
    for d in worker.definitions.values():
        for hook in (d.on_failure, d.on_dead, d.on_history):
            if hook is not None:
                resolve(hook)
    if executor is not None and (loaded := _CHILD_ONLY_MODULES & sys.modules.keys()):
        raise RuntimeError(f"the background supervisor imported {sorted(loaded)}")
    # Readiness, proven once. justify-polling: no event says the schema reached this revision.
    while not is_database_ready(
        database_url=settings.database_url, expected_revision=identity.expected_database_revision
    ):
        if stop.wait(5):
            return
    if executor is not None:
        outcome = executor.run(
            "nexus.services.parser_temp:prune_job",
            {"root": str(settings.parser_temp_root)},
            None,
            shutdown=stop,
            lost=threading.Event(),
            wall_seconds=60,
        )
        logger.info("worker_parser_temp_pruned", outcome=repr(outcome))
    logger.info("worker_started", worker_id=worker.worker_id, lane=lane, kinds=worker.kinds)
    try:
        worker.run_forever()
    finally:
        heartbeat.clear()
        logger.info("worker_stopped", worker_id=worker.worker_id)


if __name__ == "__main__":
    main()
