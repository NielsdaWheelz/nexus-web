"""Lane-owned worker progress heartbeat and its strict health command.

Run as ``python -S -m apps.worker.health --lane <lane>`` by the container
healthcheck, so this module imports stdlib and the static lane topology only --
never the database, ORM, registry or task graph.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal, cast

from nexus.job_topology import BACKGROUND_WORKER_JOB_KINDS, INTERACTIVE_WORKER_JOB_KINDS

WorkerLane = Literal["interactive", "background"]
WORKER_HEALTH_PROGRESS_INTERVAL_SECONDS = 5.0
WORKER_HEARTBEAT_MAX_AGE_SECONDS = 20.0
WORKER_HEARTBEAT_PATHS: dict[WorkerLane, Path] = {
    "interactive": Path("/tmp/nexus-worker-interactive.json"),
    "background": Path("/tmp/nexus-worker-background.json"),
}


class WorkerHeartbeatError(RuntimeError):
    """A worker heartbeat failed its closed health contract."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def lane_job_kinds(lane: WorkerLane) -> list[str]:
    """The sorted kinds this lane must be running, as published and checked."""
    kinds = INTERACTIVE_WORKER_JOB_KINDS if lane == "interactive" else BACKGROUND_WORKER_JOB_KINDS
    return sorted(kinds)


class WorkerHeartbeatPublisher:
    """Atomically publish one lane's successful database-backed progress."""

    def __init__(
        self,
        *,
        lane: WorkerLane,
        source_sha: str,
        expected_database_revision: str,
        expected_oracle_manifest_digest: str,
        task_contract_digest: str,
        readiness_check: Callable[[], bool],
    ) -> None:
        self._path = WORKER_HEARTBEAT_PATHS[lane]
        self._readiness_check = readiness_check
        self._write_lock = threading.Lock()
        self._record: dict[str, Any] = {
            "pid": os.getpid(),
            "lane": lane,
            "allowed_job_kinds": lane_job_kinds(lane),
            "source_sha": source_sha,
            "expected_database_revision": expected_database_revision,
            "expected_oracle_manifest_digest": expected_oracle_manifest_digest,
            "task_contract_digest": task_contract_digest,
        }

    def clear(self) -> None:
        """Make this lane immediately unhealthy at startup or shutdown."""
        with self._write_lock:
            self._path.unlink(missing_ok=True)

    def publish(self) -> None:
        """Publish one complete successful-cycle record via atomic rename."""
        if not self._readiness_check():
            self.clear()
            return
        payload = json.dumps(
            self._record | {"successful_cycle_monotonic_seconds": time.monotonic()},
            sort_keys=True,
        ).encode("utf-8")
        with self._write_lock:
            # Ephemeral by design: close + rename gives readers atomic bytes,
            # and the freshness and PID checks invalidate it after a crash.
            descriptor, temp_name = tempfile.mkstemp(
                dir=self._path.parent, prefix=f".{self._path.name}.", suffix=".tmp"
            )
            with os.fdopen(descriptor, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(payload)
            os.replace(temp_name, self._path)


def check_worker_health(lane: WorkerLane) -> dict[str, Any]:
    """Read this lane's record and prove it is fresh, this lane's, and alive.

    Freshness is measured with CLOCK_MONOTONIC, which is system-wide on Linux
    and therefore comparable across the publishing and reading processes.
    """
    try:
        record = json.loads(WORKER_HEARTBEAT_PATHS[lane].read_bytes())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkerHeartbeatError("heartbeat_invalid") from exc
    if not isinstance(record, dict):
        raise WorkerHeartbeatError("heartbeat_invalid")
    published = record.get("successful_cycle_monotonic_seconds")
    pid = record.get("pid")
    if not isinstance(published, (int, float)) or not isinstance(pid, int):
        raise WorkerHeartbeatError("heartbeat_invalid")
    if record.get("lane") != lane or record.get("allowed_job_kinds") != lane_job_kinds(lane):
        raise WorkerHeartbeatError("identity_mismatch")
    if not 0 <= time.monotonic() - published <= WORKER_HEARTBEAT_MAX_AGE_SECONDS:
        raise WorkerHeartbeatError("heartbeat_stale")
    try:
        os.kill(pid, 0)
    except OSError as exc:
        raise WorkerHeartbeatError("process_dead") from exc
    return cast(dict[str, Any], record)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lane", choices=("interactive", "background"), required=True)
    lane = cast(WorkerLane, parser.parse_args(argv).lane)
    try:
        record = check_worker_health(lane)
    except WorkerHeartbeatError as exc:
        print(
            json.dumps({"status": "unavailable", "reason": exc.code}, sort_keys=True),
            file=sys.stderr,
        )
        return 1
    print(
        json.dumps(
            {
                "status": "ready",
                "lane": record["lane"],
                "source_sha": record["source_sha"],
                "expected_database_revision": record["expected_database_revision"],
                "expected_oracle_manifest_digest": record["expected_oracle_manifest_digest"],
                "task_contract_digest": record["task_contract_digest"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
