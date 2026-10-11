"""How a handler runs: in the worker's own process, or in one fresh bounded child.

The background supervisor keeps the claim, heartbeat and settlement and never
imports a parser, provider or storage graph; the child imports the handler. A
child dies with its supervisor by any death (the liveness pipe, PDEATHSIG, the
container's pid namespace under ``init: true``) and is the kernel's OOM victim
of choice. Both ends of the request and result files are this module, so the
wire format is owned here.
"""

from __future__ import annotations

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
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from nexus.config import BACKGROUND_WORKER_MEMORY_LIMIT_BYTES, Settings
from nexus.errors import ApiError, ResourceFailureDimension, ResourceLimitError
from nexus.jobs.queue import JobExecutionContext, JobResult, RescheduleRequested, TerminalJobFailure
from nexus.jobs.registry import resolve
from nexus.logging import configure_logging, get_logger

logger = get_logger(__name__)


@dataclass(frozen=True)
class Failed:
    """An attempt that ended without a handler result."""

    code: str
    message: str
    # Set for a resource failure, which is dead at once.
    dimension: ResourceFailureDimension | None = None


class Lost:
    """The claim went while the child ran: the child was killed and nothing settles."""


class Released:
    """Shutdown killed the child: the job goes back to pending, its attempt refunded."""


type Outcome = JobResult | Failed | Lost | Released


def failure_of(exc: Exception) -> Failed:
    """A raised exception as a failure: an owned API code, else a handler defect."""
    if isinstance(exc, ApiError):
        dimension = exc.dimension if isinstance(exc, ResourceLimitError) else None
        return Failed(exc.code.value, exc.message, dimension)
    return Failed("E_WORKER_HANDLER_FAILED", f"{type(exc).__name__}: {exc}")


def run_in_process(
    handler: str, payload: Mapping[str, Any], context: JobExecutionContext
) -> Outcome:
    """The interactive lane: the same codec as a child, without the process."""
    try:
        return _decode(_encode(resolve(handler)(payload=payload, context=context)))
    except Exception as exc:
        logger.exception("worker_handler_failed", job_id=str(context.job_id))
        return failure_of(exc)


@dataclass(frozen=True)
class ChildExecutor:
    cgroup: Path
    wall_seconds: float
    term_grace_seconds: float
    result_max_bytes: int
    oom_score_adj: int
    parser_temp_root: Path

    @classmethod
    def open(cls, settings: Settings) -> ChildExecutor:
        """This process's cgroup v2, proven to bound it and to kill one child on OOM."""
        (membership,) = [
            line[3:]
            for line in Path("/proc/self/cgroup").read_text().splitlines()
            if line.startswith("0::/")
        ]
        cgroup = settings.background_process_cgroup_root / membership.lstrip("/")
        if (
            "memory" not in (cgroup / "cgroup.controllers").read_text().split()
            or (cgroup / "memory.max").read_text().strip()
            != str(BACKGROUND_WORKER_MEMORY_LIMIT_BYTES)
            or (cgroup / "memory.oom.group").read_text().strip() != "0"
        ):
            raise RuntimeError(f"background cgroup {cgroup} breaks the memory contract")
        _oom_kills(cgroup)
        return cls(
            cgroup=cgroup,
            wall_seconds=settings.background_process_wall_timeout_seconds,
            term_grace_seconds=settings.background_process_term_grace_seconds,
            result_max_bytes=settings.background_process_result_max_bytes,
            oom_score_adj=settings.background_process_oom_score_adj,
            parser_temp_root=settings.parser_temp_root,
        )

    def run(
        self,
        handler: str,
        payload: Mapping[str, Any],
        context: JobExecutionContext | None,
        *,
        shutdown: threading.Event,
        lost: threading.Event,
        wall_seconds: float | None = None,
        parser_temp: str | None = None,
    ) -> Outcome:
        """Run one handler in a fresh child and say how it ended."""
        identity = context and [str(context.job_id), str(context.execution_id), context.attempt_no]
        request = {
            "handler": handler,
            "payload": dict(payload),
            "context": identity,
            "oom": self.oom_score_adj,
        }
        oom_before = _oom_kills(self.cgroup)
        alive_r, alive_w = os.pipe()  # the supervisor alone holds the write end
        try:
            with tempfile.TemporaryFile() as request_file, tempfile.TemporaryFile() as result:
                request_file.write(json.dumps(request).encode())
                request_file.seek(0)
                fds = (request_file.fileno(), result.fileno(), alive_r)
                try:
                    process = subprocess.Popen(
                        [sys.executable, "-m", __name__, *map(str, fds), str(os.getpid())],
                        stdin=subprocess.DEVNULL,
                        start_new_session=True,
                        pass_fds=fds,
                    )
                except OSError as exc:
                    return Failed("E_WORKER_INTERRUPTED", f"Background child did not start: {exc}")
                stopped = self._await(process, shutdown, lost, wall_seconds or self.wall_seconds)
                if stopped is not None:
                    return stopped
                if _oom_kills(self.cgroup) > oom_before:
                    message = "Background job exceeded its memory limit."
                    return Failed("E_RESOURCE_LIMIT", message, "Memory")
                result.seek(0)
                encoded = result.read(self.result_max_bytes + 1)
                if process.returncode or not encoded or len(encoded) > self.result_max_bytes:
                    detail = f"exit {process.returncode}, {len(encoded)} result bytes"
                    return Failed("E_WORKER_INTERRUPTED", f"Background child failed: {detail}.")
                return _decode(encoded)
        finally:
            os.close(alive_r)
            os.close(alive_w)
            if parser_temp is not None:
                # justify-ignore-error: the startup prune removes what this misses.
                shutil.rmtree(self.parser_temp_root / parser_temp, ignore_errors=True)

    def _await(
        self,
        process: subprocess.Popen[bytes],
        shutdown: threading.Event,
        lost: threading.Event,
        wall_seconds: float,
    ) -> Failed | Lost | Released | None:
        """Wait for the child, its wall clock or an interrupt; then kill its whole group."""
        deadline = time.monotonic() + wall_seconds
        stopped: Failed | Lost | Released | None = None
        while process.poll() is None:
            if lost.is_set():
                stopped = Lost()
            elif shutdown.is_set():
                stopped = Released()
            elif time.monotonic() >= deadline:
                stopped = Failed(
                    "E_RESOURCE_LIMIT", "Background job exceeded its time limit.", "Time"
                )
            else:
                # justify-polling: neither an Event nor a child exit is selectable.
                time.sleep(0.25)
                continue
            _killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(self.term_grace_seconds)
            except subprocess.TimeoutExpired:
                pass
            break
        _killpg(process.pid, signal.SIGKILL)  # and any grandchild the job left behind
        process.wait()
        return stopped


def _encode(result: JobResult | Failed) -> bytes:
    match result:
        case Failed(code=code, message=message, dimension=dimension):
            value = {
                "kind": "Failed",
                "code": code,
                "message": message[:3000],
                "dimension": dimension,
            }
        case TerminalJobFailure():
            value = {
                "kind": "Terminal",
                "result": dict(result.result_payload),
                "code": result.error_code,
                "message": result.error_message,
            }
        case RescheduleRequested():
            payload = None if result.payload is None else dict(result.payload)
            value = {"kind": "Reschedule", "at": result.at.isoformat(), "payload": payload}
        case _:
            value = {"kind": "Succeeded", "result": dict(result or {})}
    return json.dumps(value).encode()


def _decode(encoded: bytes) -> Outcome:
    value = json.loads(encoded)
    match value["kind"]:
        case "Succeeded":
            return value["result"]
        case "Reschedule":
            return RescheduleRequested(datetime.fromisoformat(value["at"]), value["payload"])
        case "Terminal":
            return TerminalJobFailure(value["result"], value["code"], value["message"])
        case _:
            return Failed(value["code"], value["message"], value["dimension"])


def _child(request_fd: int, result_fd: int, alive_fd: int, supervisor_pid: int) -> None:
    """The child: become mortal and the OOM victim, run the handler, write one result."""
    prctl = ctypes.CDLL(None, use_errno=True).prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    if prctl(1, signal.SIGKILL, 0, 0, 0):  # PR_SET_PDEATHSIG
        raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG")
    if os.getppid() != supervisor_pid:  # the supervisor died before the prctl
        os.killpg(0, signal.SIGKILL)
    threading.Thread(target=_die_with_supervisor, args=(alive_fd,), daemon=True).start()
    with os.fdopen(request_fd, "rb") as stream:
        request = json.load(stream)
    score = Path("/proc/self/oom_score_adj")
    score.write_text(str(max(int(score.read_text()), request["oom"])))
    configure_logging()
    context = None
    if request["context"] is not None:
        job_id, execution_id, attempt_no = request["context"]
        context = JobExecutionContext(UUID(job_id), UUID(execution_id), attempt_no)
    try:
        encoded = _encode(resolve(request["handler"])(payload=request["payload"], context=context))
    except Exception as exc:
        traceback.print_exc()
        encoded = _encode(failure_of(exc))
    with os.fdopen(result_fd, "wb") as stream:
        stream.write(encoded)


def _die_with_supervisor(alive_fd: int) -> None:
    try:
        while os.read(alive_fd, 1):  # the supervisor never writes: this ends at its death
            pass
    finally:
        os.killpg(0, signal.SIGKILL)


def _killpg(pgid: int, sig: signal.Signals) -> None:
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:  # justify-ignore-error: the group already exited
        pass


def _oom_kills(cgroup: Path) -> int:
    events = dict(line.split() for line in (cgroup / "memory.events").read_text().splitlines())
    return int(events["oom_kill"])


if __name__ == "__main__":
    _child(*map(int, sys.argv[1:5]))
