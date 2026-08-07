"""Lane-owned worker progress heartbeat and strict health command."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from nexus.config import (
    BACKGROUND_WORKER_JOB_KINDS,
    INTERACTIVE_WORKER_JOB_KINDS,
    get_settings,
)
from nexus.jobs.registry import get_task_contract_digest
from nexus.release_artifact import RuntimeIdentity
from nexus.runtime_health import get_runtime_identity, is_database_ready

WorkerLane = Literal["interactive", "background"]
WORKER_HEALTH_PROGRESS_INTERVAL_SECONDS = 5.0
WORKER_HEARTBEAT_MAX_AGE_SECONDS = 20.0
WORKER_HEARTBEAT_PATHS: Mapping[WorkerLane, Path] = {
    "interactive": Path("/tmp/nexus-worker-interactive.json"),
    "background": Path("/tmp/nexus-worker-background.json"),
}
_HEARTBEAT_KEYS = frozenset(
    {
        "pid",
        "lane",
        "allowed_job_kinds",
        "source_sha",
        "expected_database_revision",
        "expected_oracle_manifest_digest",
        "task_contract_digest",
        "successful_cycle_monotonic_seconds",
    }
)
_MAX_HEARTBEAT_BYTES = 16_384


class WorkerHeartbeatError(RuntimeError):
    """A worker heartbeat failed its closed health contract."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class WorkerHeartbeat:
    pid: int
    lane: WorkerLane
    allowed_job_kinds: tuple[str, ...]
    source_sha: str
    expected_database_revision: str
    expected_oracle_manifest_digest: str
    task_contract_digest: str
    successful_cycle_monotonic_seconds: float

    def as_json(self) -> dict[str, object]:
        return {
            "pid": self.pid,
            "lane": self.lane,
            "allowed_job_kinds": list(self.allowed_job_kinds),
            "source_sha": self.source_sha,
            "expected_database_revision": self.expected_database_revision,
            "expected_oracle_manifest_digest": self.expected_oracle_manifest_digest,
            "task_contract_digest": self.task_contract_digest,
            "successful_cycle_monotonic_seconds": self.successful_cycle_monotonic_seconds,
        }


class WorkerHeartbeatPublisher:
    """Atomically publish successful database-backed progress for one lane."""

    def __init__(
        self,
        *,
        lane: WorkerLane,
        allowed_job_kinds: Sequence[str],
        identity: RuntimeIdentity,
        task_contract_digest: str,
        heartbeat_path: Path | None = None,
        pid: int | None = None,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._lane: WorkerLane = lane
        self._allowed_job_kinds = _closed_job_kinds(allowed_job_kinds)
        self._identity = identity
        self._task_contract_digest = _require_digest(task_contract_digest)
        self._heartbeat_path = heartbeat_path or WORKER_HEARTBEAT_PATHS[lane]
        self._pid = os.getpid() if pid is None else _require_pid(pid)
        self._monotonic = monotonic
        self._write_lock = threading.Lock()

    @property
    def path(self) -> Path:
        return self._heartbeat_path

    def clear(self) -> None:
        """Make this lane immediately unhealthy at startup or shutdown."""
        with self._write_lock:
            self._heartbeat_path.unlink(missing_ok=True)

    def publish(self) -> None:
        """Publish one complete successful-cycle record via atomic rename."""
        heartbeat = WorkerHeartbeat(
            pid=self._pid,
            lane=self._lane,
            allowed_job_kinds=self._allowed_job_kinds,
            source_sha=self._identity.source_sha,
            expected_database_revision=self._identity.expected_database_revision,
            expected_oracle_manifest_digest=self._identity.expected_oracle_manifest_digest,
            task_contract_digest=self._task_contract_digest,
            successful_cycle_monotonic_seconds=float(self._monotonic()),
        )
        payload = _canonical_json_bytes(heartbeat.as_json())
        with self._write_lock:
            _atomic_write(self._heartbeat_path, payload)


def expected_job_kinds(lane: WorkerLane) -> tuple[str, ...]:
    if lane == "interactive":
        return tuple(sorted(INTERACTIVE_WORKER_JOB_KINDS))
    return tuple(sorted(BACKGROUND_WORKER_JOB_KINDS))


def validate_worker_heartbeat(
    payload: object,
    *,
    expected_lane: WorkerLane,
    expected_allowed_job_kinds: Sequence[str],
    expected_identity: RuntimeIdentity,
    expected_task_contract_digest: str,
    now_monotonic: float,
    process_is_alive: Callable[[int], bool],
) -> WorkerHeartbeat:
    """Validate freshness, process identity, lane, kinds, and release identity."""
    heartbeat = _parse_worker_heartbeat(payload)
    expected_kinds = _closed_job_kinds(expected_allowed_job_kinds)
    expected_digest = _require_digest(expected_task_contract_digest)
    if (
        heartbeat.lane != expected_lane
        or heartbeat.allowed_job_kinds != expected_kinds
        or heartbeat.source_sha != expected_identity.source_sha
        or heartbeat.expected_database_revision != expected_identity.expected_database_revision
        or heartbeat.expected_oracle_manifest_digest
        != expected_identity.expected_oracle_manifest_digest
        or heartbeat.task_contract_digest != expected_digest
    ):
        raise WorkerHeartbeatError("identity_mismatch")

    now = float(now_monotonic)
    if not math.isfinite(now) or now < 0:
        raise WorkerHeartbeatError("heartbeat_invalid")
    age = now - heartbeat.successful_cycle_monotonic_seconds
    if age < 0 or age > WORKER_HEARTBEAT_MAX_AGE_SECONDS:
        raise WorkerHeartbeatError("heartbeat_stale")
    if not process_is_alive(heartbeat.pid):
        raise WorkerHeartbeatError("process_dead")
    return heartbeat


def check_worker_health(*, lane: WorkerLane, heartbeat_path: Path | None = None) -> WorkerHeartbeat:
    """Run the full worker health contract, including bounded DB/schema readiness."""
    path = heartbeat_path or WORKER_HEARTBEAT_PATHS[lane]
    try:
        encoded = path.read_bytes()
        if len(encoded) > _MAX_HEARTBEAT_BYTES:
            raise WorkerHeartbeatError("heartbeat_invalid")
        payload = json.loads(
            encoded,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
        if encoded != _canonical_json_bytes(payload):
            raise WorkerHeartbeatError("heartbeat_invalid")
    except (
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        WorkerHeartbeatError,
    ) as exc:
        raise WorkerHeartbeatError("heartbeat_invalid") from exc

    identity = get_runtime_identity()
    heartbeat = validate_worker_heartbeat(
        payload,
        expected_lane=lane,
        expected_allowed_job_kinds=expected_job_kinds(lane),
        expected_identity=identity,
        expected_task_contract_digest=get_task_contract_digest(),
        now_monotonic=time.monotonic(),
        process_is_alive=_process_is_alive,
    )
    settings = get_settings()
    if not is_database_ready(
        database_url=settings.database_url,
        expected_revision=identity.expected_database_revision,
    ):
        raise WorkerHeartbeatError("database_not_ready")
    return heartbeat


def _parse_worker_heartbeat(payload: object) -> WorkerHeartbeat:
    if not isinstance(payload, dict) or payload.keys() != _HEARTBEAT_KEYS:
        raise WorkerHeartbeatError("heartbeat_invalid")
    value = cast(dict[str, Any], payload)
    try:
        pid = _require_pid(value["pid"])
        lane = _require_lane(value["lane"])
        allowed_job_kinds = _closed_job_kinds(value["allowed_job_kinds"])
        identity = RuntimeIdentity(
            source_sha=value["source_sha"],
            expected_database_revision=value["expected_database_revision"],
            expected_oracle_manifest_digest=value["expected_oracle_manifest_digest"],
        )
        task_contract_digest = _require_digest(value["task_contract_digest"])
        successful_cycle = value["successful_cycle_monotonic_seconds"]
        if (
            type(successful_cycle) not in (int, float)
            or not math.isfinite(successful_cycle)
            or successful_cycle < 0
        ):
            raise ValueError("invalid successful cycle timestamp")
    except (KeyError, TypeError, ValueError, RuntimeError) as exc:
        raise WorkerHeartbeatError("heartbeat_invalid") from exc
    return WorkerHeartbeat(
        pid=pid,
        lane=lane,
        allowed_job_kinds=allowed_job_kinds,
        source_sha=identity.source_sha,
        expected_database_revision=identity.expected_database_revision,
        expected_oracle_manifest_digest=identity.expected_oracle_manifest_digest,
        task_contract_digest=task_contract_digest,
        successful_cycle_monotonic_seconds=float(successful_cycle),
    )


def _closed_job_kinds(value: object) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)):
        raise ValueError("allowed job kinds must be a sequence")
    kinds = tuple(value)
    if any(not isinstance(kind, str) or not kind for kind in kinds) or kinds != tuple(
        sorted(set(kinds))
    ):
        raise ValueError("allowed job kinds must be sorted unique names")
    return kinds


def _require_lane(value: object) -> WorkerLane:
    if value not in ("interactive", "background"):
        raise ValueError("unsupported worker lane")
    return cast(WorkerLane, value)


def _require_pid(value: object) -> int:
    if type(value) is not int or value < 1:
        raise ValueError("pid must be a positive integer")
    return value


def _require_digest(value: object) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError("task contract digest is malformed")
    return value


def _process_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise WorkerHeartbeatError("heartbeat_invalid")
        value[key] = item
    return value


def _reject_json_constant(_value: str) -> None:
    raise WorkerHeartbeatError("heartbeat_invalid")


def _canonical_json_bytes(value: object) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _atomic_write(path: Path, payload: bytes) -> None:
    # This /tmp signal is intentionally ephemeral: close + rename gives readers
    # atomic bytes, while freshness/PID checks invalidate it after a crash.
    descriptor, temp_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temp_path = Path(temp_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(payload)
        os.replace(temp_path, path)
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        temp_path.unlink(missing_ok=True)
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lane", choices=("interactive", "background"), required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    lane = cast(WorkerLane, args.lane)
    try:
        heartbeat = check_worker_health(lane=lane)
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
                "lane": heartbeat.lane,
                "source_sha": heartbeat.source_sha,
                "expected_database_revision": heartbeat.expected_database_revision,
                "expected_oracle_manifest_digest": heartbeat.expected_oracle_manifest_digest,
                "task_contract_digest": heartbeat.task_contract_digest,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
