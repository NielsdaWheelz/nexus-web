"""Fresh-child execution boundary for the background Postgres worker.

The supervisor forks one short-lived child per job so a parser can neither leak
into the lean supervisor nor survive it. Both ends of the private request/result
pipe are this module inside one image, so the wire format is owned here.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from nexus.errors import ApiError, ApiErrorCode, ResourceFailureDimension, ResourceLimitError
from nexus.jobs.queue import (
    JobExecutionContext,
    RescheduleRequested,
    RescheduleSchedule,
    ScheduleAfter,
    ScheduleAt,
)
from nexus.logging import get_logger

logger = get_logger(__name__)

_MESSAGE_MAX_LENGTH = 3000
_READ_CHUNK_BYTES = 64 * 1024
# A threading.Event has no selectable descriptor and neither has a child exit, so
# the supervisor rechecks both interrupts between bounded waits.
_CHILD_WAIT_POLL_SECONDS = 0.25
_PARSER_TEMP_PRUNE_WALL_TIMEOUT_SECONDS = 60.0
_PROCESS_GROUP_EXIT_POLL_SECONDS = 0.01
_PR_SET_PDEATHSIG = 1

type _ChildExitReason = Literal["Exited", "Timeout", "Shutdown", "ClaimLost"]
type ChildRuntime = Literal["Base", "Llm"]


class BackgroundProcessProtocolDefect(RuntimeError):
    """The owned child or its configured containment boundary is invalid."""


@dataclass(frozen=True, slots=True)
class ValidatedCgroup:
    """Cgroup v2 facts required for safe child OOM selection."""

    directory: Path

    @classmethod
    def open(cls, directory: Path, *, expected_memory_limit_bytes: int) -> ValidatedCgroup:
        """Assert the memory controller, exact limit and per-process OOM kill mode."""
        try:
            controllers = frozenset(
                (directory / "cgroup.controllers").read_text(encoding="ascii").split()
            )
            memory_max = (directory / "memory.max").read_text(encoding="ascii").strip()
            oom_group = (directory / "memory.oom.group").read_text(encoding="ascii").strip()
            _read_oom_kill_count(directory / "memory.events")
        except OSError as exc:
            raise BackgroundProcessProtocolDefect(
                f"background cgroup v2 contract is unreadable at {directory}"
            ) from exc
        if "memory" not in controllers:
            raise BackgroundProcessProtocolDefect("background cgroup has no memory controller")
        if not memory_max.isdecimal() or int(memory_max) != expected_memory_limit_bytes:
            raise BackgroundProcessProtocolDefect(
                "background cgroup memory.max does not match the configured limit"
            )
        if oom_group != "0":
            raise BackgroundProcessProtocolDefect(
                "background cgroup memory.oom.group must be 0 so one child is killable"
            )
        return cls(directory=directory)

    @classmethod
    def for_current_process(
        cls, cgroup_root: Path, *, expected_memory_limit_bytes: int
    ) -> ValidatedCgroup:
        """Open the cgroup this process belongs to, under the configured root."""
        try:
            lines = Path("/proc/self/cgroup").read_text(encoding="ascii").splitlines()
        except OSError as exc:
            raise BackgroundProcessProtocolDefect(
                "current cgroup membership is unreadable"
            ) from exc
        memberships = [line.removeprefix("0::") for line in lines if line.startswith("0::/")]
        if len(memberships) != 1:
            raise BackgroundProcessProtocolDefect(
                "current process is not in one cgroup v2 hierarchy"
            )
        relative = memberships[0].lstrip("/")
        return cls.open(
            cgroup_root / relative if relative else cgroup_root,
            expected_memory_limit_bytes=expected_memory_limit_bytes,
        )

    def oom_kill_count(self) -> int:
        """Current cumulative oom_kill counter for this cgroup."""
        return _read_oom_kill_count(self.directory / "memory.events")


@dataclass(frozen=True, slots=True)
class ChildSucceeded:
    payload: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ChildReschedule:
    schedule: RescheduleSchedule
    payload: Mapping[str, Any] | None


@dataclass(frozen=True, slots=True)
class ChildModeledFailure:
    error_code: str
    message: str
    resource_dimension: ResourceFailureDimension | None


@dataclass(frozen=True, slots=True)
class ChildDefect:
    error_type: str
    message: str


@dataclass(frozen=True, slots=True)
class ChildResourceFailure:
    dimension: ResourceFailureDimension


@dataclass(frozen=True, slots=True)
class ChildInterrupted:
    message: str


@dataclass(frozen=True, slots=True)
class ChildShutdownInterrupted:
    """The supervisor was asked to stop, so the child was terminated mid-execution.

    An operator-owned interruption, not a job failure: the claim is released
    without consuming a retry attempt.
    """


@dataclass(frozen=True, slots=True)
class ChildClaimLost:
    """The heartbeat observed the claim is gone, so the child was terminated.

    The worker no longer owns this job and must not settle it.
    """


type ChildExecutionResult = (
    ChildSucceeded
    | ChildReschedule
    | ChildModeledFailure
    | ChildDefect
    | ChildResourceFailure
    | ChildInterrupted
    | ChildShutdownInterrupted
    | ChildClaimLost
)


@dataclass(frozen=True, slots=True)
class BackgroundProcessExecutor:
    """Execute one declaratively named handler in a fresh process group."""

    cgroup: ValidatedCgroup
    result_max_bytes: int
    wall_timeout_seconds: float
    term_grace_seconds: float
    child_oom_score_adj: int
    parser_temp_root: Path

    def execute(
        self,
        *,
        handler_path: str,
        payload: Mapping[str, Any],
        context: JobExecutionContext,
        runtime: ChildRuntime,
        shutdown: threading.Event,
        claim_lost: threading.Event,
        cleanup_attempt_id: UUID | None = None,
    ) -> ChildExecutionResult:
        """Run one handler in a child and classify how that child ended."""
        request = _encode(
            {
                "handler_path": handler_path,
                "payload": dict(payload),
                "context": {
                    "job_id": str(context.job_id),
                    "worker_id": context.worker_id,
                    "attempt_no": context.attempt_no,
                    "resource_class": context.resource_class,
                    "execution_id": str(context.execution_id),
                },
                "oom_score_adj": self.child_oom_score_adj,
                "result_max_bytes": self.result_max_bytes,
                "runtime": runtime,
            }
        )
        try:
            oom_kills_before = self.cgroup.oom_kill_count()
            with (
                tempfile.TemporaryFile() as request_file,
                tempfile.TemporaryFile() as result_file,
            ):
                request_file.write(request)
                request_file.seek(0)
                request_fd = request_file.fileno()
                result_fd = result_file.fileno()
                # Termination propagation: the supervisor holds the write end of
                # this pipe for exactly as long as the child may run, so any
                # supervisor death -- SIGKILL included, which runs no supervisor
                # code -- closes it and the child's watchdog kills its own group.
                liveness_read_fd, liveness_write_fd = os.pipe()
                try:
                    try:
                        process = subprocess.Popen(
                            [
                                sys.executable,
                                "-m",
                                "nexus.jobs.process_executor",
                                "--child-request-fd",
                                str(request_fd),
                                "--child-result-fd",
                                str(result_fd),
                                "--supervisor-liveness-fd",
                                str(liveness_read_fd),
                                "--supervisor-pid",
                                str(os.getpid()),
                            ],
                            stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL,
                            start_new_session=True,
                            pass_fds=(request_fd, result_fd, liveness_read_fd),
                        )
                    except OSError as exc:
                        return ChildDefect(
                            error_type=type(exc).__name__,
                            message="Background child process could not be started.",
                        )
                    try:
                        exit_reason = _await_child_exit(
                            process,
                            wall_timeout_seconds=self.wall_timeout_seconds,
                            term_grace_seconds=self.term_grace_seconds,
                            shutdown=shutdown,
                            claim_lost=claim_lost,
                        )
                    finally:
                        _terminate_child_process_group(
                            process,
                            term_grace_seconds=self.term_grace_seconds,
                            job_id=context.job_id,
                        )
                    if exit_reason == "ClaimLost":
                        return ChildClaimLost()
                    if exit_reason == "Shutdown":
                        return ChildShutdownInterrupted()
                    if exit_reason == "Timeout":
                        return ChildResourceFailure("Time")
                    # An OOM-killed child is otherwise an unexplained non-zero
                    # exit that would burn every retry on an impossible job.
                    if self.cgroup.oom_kill_count() > oom_kills_before:
                        return ChildResourceFailure("Memory")
                    if process.returncode != 0:
                        return ChildInterrupted(
                            f"Background child exited unexpectedly with code {process.returncode}."
                        )
                    result_file.seek(0)
                    encoded = result_file.read(self.result_max_bytes + 1)
                    if len(encoded) > self.result_max_bytes:
                        return ChildDefect(
                            error_type="ResultTooLarge",
                            message="Background child result exceeded its closed protocol limit.",
                        )
                    try:
                        return _decode_result(encoded)
                    except BackgroundProcessProtocolDefect as exc:
                        return ChildDefect(error_type=type(exc).__name__, message=str(exc))
                finally:
                    os.close(liveness_write_fd)
                    os.close(liveness_read_fd)
        finally:
            if cleanup_attempt_id is not None:
                _remove_parser_attempt_directory(
                    self.parser_temp_root / str(cleanup_attempt_id), job_id=context.job_id
                )

    def prune_stale_parser_temp(
        self, root: Path, *, worker_id: str, shutdown: threading.Event
    ) -> None:
        """Run the storage-heavy startup cleanup in a child, not in the supervisor.

        Bounded well below a job's wall clock: a prune that hangs must not hold
        the lane out of its healthcheck window.
        """
        result = replace(
            self, wall_timeout_seconds=_PARSER_TEMP_PRUNE_WALL_TIMEOUT_SECONDS
        ).execute(
            handler_path="nexus.jobs.process_executor:_prune_stale_parser_temp",
            payload={"root": str(root)},
            context=JobExecutionContext(
                job_id=UUID(int=0),
                worker_id=worker_id,
                attempt_no=0,
                resource_class="Light",
                execution_id=UUID(int=0),
            ),
            runtime="Base",
            shutdown=shutdown,
            claim_lost=threading.Event(),
        )
        if not isinstance(result, ChildSucceeded):
            logger.warning(
                "parser_temp_startup_prune_incomplete",
                worker_id=worker_id,
                child_result=type(result).__name__,
            )


def _await_child_exit(
    process: subprocess.Popen[bytes],
    *,
    wall_timeout_seconds: float,
    term_grace_seconds: float,
    shutdown: threading.Event,
    claim_lost: threading.Event,
) -> _ChildExitReason:
    """Wait for one child, observing its wall limit and both supervisor interrupts."""
    deadline = time.monotonic() + wall_timeout_seconds
    reason: _ChildExitReason = "Timeout"
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            process.wait(timeout=min(_CHILD_WAIT_POLL_SECONDS, remaining))
        except subprocess.TimeoutExpired:
            if claim_lost.is_set():
                reason = "ClaimLost"
                break
            if shutdown.is_set():
                reason = "Shutdown"
                break
            continue
        return "Exited"
    _signal_process_group(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=term_grace_seconds)
    except subprocess.TimeoutExpired:
        _signal_process_group(process.pid, signal.SIGKILL)
        process.wait()
    return reason


def _decode_result(encoded: bytes) -> ChildExecutionResult:
    """Decode the child's tagged result; unreadable bytes are a child defect."""
    try:
        value = json.loads(encoded.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackgroundProcessProtocolDefect("background child result is malformed JSON") from exc
    match value.get("kind"):
        case "Succeeded":
            return ChildSucceeded(payload=dict(value["payload"]))
        case "Reschedule":
            schedule = value["schedule"]
            return ChildReschedule(
                schedule=(
                    ScheduleAt(datetime.fromisoformat(schedule["instant"]))
                    if schedule["kind"] == "At"
                    else ScheduleAfter(int(schedule["seconds"]))
                ),
                payload=value["payload"],
            )
        case "ModeledFailure":
            return ChildModeledFailure(
                error_code=str(value["error_code"]),
                message=str(value["message"]),
                resource_dimension=value["resource_dimension"],
            )
        case "Defect":
            return ChildDefect(error_type=str(value["error_type"]), message=str(value["message"]))
    raise BackgroundProcessProtocolDefect("background child returned an unknown result kind")


def _encode_handler_result(
    result: Mapping[str, Any] | RescheduleRequested | None,
) -> dict[str, Any]:
    """Encode one handler return value for the result channel."""
    if isinstance(result, RescheduleRequested):
        schedule = result.schedule
        return {
            "kind": "Reschedule",
            "schedule": (
                {"kind": "At", "instant": schedule.instant.isoformat()}
                if isinstance(schedule, ScheduleAt)
                else {"kind": "After", "seconds": schedule.seconds}
            ),
            "payload": None if result.payload is None else dict(result.payload),
        }
    if result is not None and not isinstance(result, Mapping):
        return {
            "kind": "Defect",
            "error_type": "InvalidHandlerResult",
            "message": "Background job handler returned a non-object result.",
        }
    return {"kind": "Succeeded", "payload": dict(result or {})}


def _modeled_failure(exc: Exception) -> dict[str, Any] | None:
    """Project only an owned, closed-code domain failure across the child boundary.

    Anything else is a defect, so ``background_jobs.error_code`` can only ever
    hold a member of the closed ``ApiErrorCode`` space.
    """
    if not isinstance(exc, ApiError) or not isinstance(exc.code, ApiErrorCode):
        return None
    return {
        "kind": "ModeledFailure",
        "error_code": exc.code.value,
        "message": exc.message[:_MESSAGE_MAX_LENGTH],
        "resource_dimension": exc.dimension if isinstance(exc, ResourceLimitError) else None,
    }


def _prune_stale_parser_temp(
    *, payload: Mapping[str, Any], context: JobExecutionContext
) -> Mapping[str, Any]:
    """Clean abandoned parser directories in a short-lived bounded child."""
    del context
    from nexus.db.session import get_session_factory
    from nexus.jobs.queue import parser_operation_has_live_job
    from nexus.services.parser_temp import prune_stale_parser_temp

    with get_session_factory()() as db:
        removed = prune_stale_parser_temp(
            Path(str(payload["root"])),
            operation_is_live=lambda operation_id: parser_operation_has_live_job(
                db, operation_id=operation_id
            ),
        )
    return {"removed_directories": removed}


def _initialize_child_runtime(runtime: str) -> None:
    """Install the dependencies a background handler previously inherited."""
    if runtime == "Base":
        return
    from nexus.config import get_settings
    from nexus.db.session import get_session_factory
    from nexus.services.generation_policy import validate_policy
    from nexus.services.rate_limit import RateLimiter, set_rate_limiter

    validate_policy()
    set_rate_limiter(
        RateLimiter(session_factory=get_session_factory(), rpm_limit=get_settings().rate_limit_rpm)
    )


def _child_result(request: dict[str, Any]) -> dict[str, Any]:
    """Run the requested handler in this child and encode its outcome."""
    from nexus.jobs.registry import resolve_job_handler

    _raise_oom_score_adj(int(request["oom_score_adj"]))
    _initialize_child_runtime(str(request["runtime"]))
    identity = request["context"]
    context = JobExecutionContext(
        job_id=UUID(identity["job_id"]),
        worker_id=identity["worker_id"],
        attempt_no=identity["attempt_no"],
        resource_class=identity["resource_class"],
        execution_id=UUID(identity["execution_id"]),
    )
    handler = resolve_job_handler(str(request["handler_path"]))
    try:
        result = handler(payload=request["payload"], context=context)
    except Exception as exc:
        traceback.print_exc()
        return _modeled_failure(exc) or {
            "kind": "Defect",
            "error_type": type(exc).__name__,
            "message": str(exc)[:_MESSAGE_MAX_LENGTH],
        }
    return _encode_handler_result(result)


def _run_child(*, request_fd: int, result_fd: int, liveness_fd: int, supervisor_pid: int) -> int:
    """Child entrypoint: bind mortality, run the handler, write one bounded result."""
    result_max_bytes = 1024
    try:
        _bind_child_to_supervisor_liveness(liveness_fd=liveness_fd, supervisor_pid=supervisor_pid)
        request = json.loads(_read_all(request_fd).decode("utf-8"))
        result_max_bytes = int(request["result_max_bytes"])
        result_bytes = _bounded_result_bytes(
            _child_result(request), result_max_bytes=result_max_bytes
        )
    except Exception as exc:
        traceback.print_exc()
        result_bytes = _bounded_result_bytes(
            {
                "kind": "Defect",
                "error_type": type(exc).__name__,
                "message": str(exc)[:_MESSAGE_MAX_LENGTH],
            },
            result_max_bytes=result_max_bytes,
        )
    try:
        _write_all(result_fd, result_bytes)
    finally:
        os.close(result_fd)
    return 0


def _encode(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, allow_nan=False, ensure_ascii=True, separators=(",", ":")).encode(
        "utf-8"
    )


def _bounded_result_bytes(result: Mapping[str, Any], *, result_max_bytes: int) -> bytes:
    """Encode a result, replacing an unserializable or oversized one with a defect."""
    try:
        encoded = _encode(result)
    except (TypeError, ValueError):
        error_type = "ResultSerializationDefect"
        message = "Background job result was not JSON serializable."
    else:
        if len(encoded) <= result_max_bytes:
            return encoded
        error_type = "ResultTooLarge"
        message = "Background child result exceeded its closed protocol limit."
    return _encode({"kind": "Defect", "error_type": error_type, "message": message})


def _bind_child_to_supervisor_liveness(*, liveness_fd: int, supervisor_pid: int) -> None:
    """Make this child mortal before it imports or runs any handler.

    Three mechanisms bind the child's lifetime to its supervisor's: the liveness
    pipe, whose write end only the supervisor holds, so reading it unblocks when
    the supervisor dies by any means; ``PR_SET_PDEATHSIG`` on Linux, armed here
    rather than in an unsafe multithreaded ``preexec_fn``, with a ``getppid``
    recheck for a supervisor that died between fork and exec; and, in the
    deployed container, PID-namespace teardown under ``init: true``.
    """
    _arm_parent_death_signal()
    if os.getppid() != supervisor_pid:
        _kill_own_process_group()
    threading.Thread(
        target=_kill_process_group_when_supervisor_exits,
        args=(liveness_fd,),
        name="supervisor-liveness-watchdog",
        daemon=True,
    ).start()


def _kill_process_group_when_supervisor_exits(liveness_fd: int) -> None:
    try:
        # The supervisor never writes, so this blocks until its write end closes.
        while os.read(liveness_fd, 1):
            pass
    except OSError:
        # An unreadable liveness channel is indistinguishable from a dead
        # supervisor, and both mean this child must not outlive it.
        pass
    _kill_own_process_group()


def _kill_own_process_group() -> None:
    """SIGKILL this child and every descendant it started."""
    os.killpg(os.getpgid(0), signal.SIGKILL)


def _arm_parent_death_signal() -> None:
    if sys.platform != "linux":
        # The liveness pipe is the portable mechanism; darwin is a dev host only.
        return
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    if prctl(_PR_SET_PDEATHSIG, ctypes.c_ulong(signal.SIGKILL), 0, 0, 0) != 0:
        raise BackgroundProcessProtocolDefect("child parent-death signal could not be armed")


def _raise_oom_score_adj(configured: int) -> None:
    """Make the child, not the supervisor, the kernel's OOM victim of choice."""
    path = Path("/proc/self/oom_score_adj")
    try:
        target = max(int(path.read_text(encoding="ascii").strip()), configured)
        path.write_text(f"{target}\n", encoding="ascii")
        observed = int(path.read_text(encoding="ascii").strip())
    except (OSError, ValueError) as exc:
        raise BackgroundProcessProtocolDefect("child oom_score_adj could not be raised") from exc
    if observed < target:
        raise BackgroundProcessProtocolDefect(
            "child oom_score_adj did not reach its configured value"
        )


def _read_oom_kill_count(path: Path) -> int:
    try:
        for line in path.read_text(encoding="ascii").splitlines():
            name, _, count = line.partition(" ")
            if name == "oom_kill":
                return int(count)
    except (OSError, ValueError) as exc:
        raise BackgroundProcessProtocolDefect(
            "background cgroup memory.events is malformed"
        ) from exc
    raise BackgroundProcessProtocolDefect("background cgroup memory.events has no oom_kill row")


def _remove_parser_attempt_directory(directory: Path, *, job_id: UUID) -> None:
    try:
        if directory.is_symlink() or not directory.is_dir():
            directory.unlink(missing_ok=True)
            return
        shutil.rmtree(directory)
    except FileNotFoundError:
        pass
    except OSError as exc:
        # The startup prune and the parser-temp reconciler own eventual removal;
        # masking a decoded child result here would re-run durable work.
        logger.error(
            "background_child_parser_temp_cleanup_failed",
            job_id=str(job_id),
            error_type=type(exc).__name__,
        )


def _terminate_child_process_group(
    process: subprocess.Popen[bytes], *, term_grace_seconds: float, job_id: UUID
) -> None:
    """Kill the child's whole process group without masking its decoded result."""
    if process.poll() is None:
        _signal_process_group(process.pid, signal.SIGKILL)
        process.wait()
    _signal_process_group(process.pid, signal.SIGKILL)
    if _process_group_exited(process.pid, timeout_seconds=term_grace_seconds):
        return
    logger.error(
        "background_child_process_group_survived_kill",
        job_id=str(job_id),
        process_group_id=process.pid,
    )


def _process_group_exited(process_group_id: int, *, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            os.killpg(process_group_id, 0)
        except ProcessLookupError:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(_PROCESS_GROUP_EXIT_POLL_SECONDS)


def _signal_process_group(process_group_id: int, signal_number: signal.Signals) -> None:
    try:
        os.killpg(process_group_id, signal_number)
    except ProcessLookupError:
        pass


def _read_all(file_descriptor: int) -> bytes:
    chunks: list[bytes] = []
    while True:
        chunk = os.read(file_descriptor, _READ_CHUNK_BYTES)
        if not chunk:
            return b"".join(chunks)
        chunks.append(chunk)


def _write_all(file_descriptor: int, payload: bytes) -> None:
    written = 0
    while written < len(payload):
        written += os.write(file_descriptor, payload[written:])


def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--child-request-fd", type=int, required=True)
    parser.add_argument("--child-result-fd", type=int, required=True)
    parser.add_argument("--supervisor-liveness-fd", type=int, required=True)
    parser.add_argument("--supervisor-pid", type=int, required=True)
    arguments = parser.parse_args()
    return _run_child(
        request_fd=arguments.child_request_fd,
        result_fd=arguments.child_result_fd,
        liveness_fd=arguments.supervisor_liveness_fd,
        supervisor_pid=arguments.supervisor_pid,
    )


if __name__ == "__main__":
    raise SystemExit(_main())
