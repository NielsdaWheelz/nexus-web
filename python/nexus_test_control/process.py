from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from types import FrameType


class CommandInterrupted(RuntimeError):
    """The test controller received an interrupt while owning a child group."""


_ACTIVE_LOCK = threading.Lock()
_ACTIVE_PROCESS: subprocess.Popen[str] | None = None
_UNBLOCK_AND_EXEC = (
    "import os, signal, sys; "
    "signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT, signal.SIGTERM}); "
    "os.execvpe(sys.argv[1], sys.argv[1:], os.environ)"
)


def run_command(
    command: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    capture_output: bool = False,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run one fixed command in an owned process group that cannot outlive the caller."""
    if not command or any(not isinstance(part, str) or not part for part in command):
        raise ValueError("child command must be a fixed non-empty argv")
    stdout = subprocess.PIPE if capture_output else None
    stderr = subprocess.PIPE if capture_output else None
    blocked = {signal.SIGINT, signal.SIGTERM}
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
    try:
        process = subprocess.Popen(
            unblock_and_exec_command(command),
            cwd=cwd,
            env=dict(env),
            stdout=stdout,
            stderr=stderr,
            text=True,
            start_new_session=True,
        )
        _claim_process(process)
    except BaseException:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        raise
    try:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        captured_stdout, captured_stderr = process.communicate()
    except BaseException:
        _terminate_process_group(process)
        raise
    finally:
        _release_process(process)
    completed = subprocess.CompletedProcess(
        tuple(command),
        process.returncode,
        captured_stdout,
        captured_stderr,
    )
    if check and completed.returncode != 0:
        raise subprocess.CalledProcessError(
            completed.returncode,
            completed.args,
            output=completed.stdout,
            stderr=completed.stderr,
        )
    return completed


def unblock_and_exec_command(command: Sequence[str]) -> tuple[str, ...]:
    """Return a tiny launcher that clears inherited controller signal masks before exec."""
    if not command or any(not isinstance(part, str) or not part for part in command):
        raise ValueError("child command must be a fixed non-empty argv")
    return (sys.executable, "-c", _UNBLOCK_AND_EXEC, *command)


@contextmanager
def controller_signal_handlers() -> Iterator[None]:
    """Translate controller SIGINT/SIGTERM into owned-child teardown and normal cleanup."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    previous = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)}

    def interrupt(signum: int, _frame: FrameType | None) -> None:
        name = signal.Signals(signum).name
        raise CommandInterrupted(f"test control interrupted by {name}")

    try:
        for signum in previous:
            signal.signal(signum, interrupt)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _claim_process(process: subprocess.Popen[str]) -> None:
    global _ACTIVE_PROCESS
    with _ACTIVE_LOCK:
        if _ACTIVE_PROCESS is not None:
            _terminate_process_group(process)
            raise RuntimeError("test control attempted overlapping owned commands")
        _ACTIVE_PROCESS = process


def _release_process(process: subprocess.Popen[str]) -> None:
    global _ACTIVE_PROCESS
    with _ACTIVE_LOCK:
        if _ACTIVE_PROCESS is process:
            _ACTIVE_PROCESS = None


def _terminate_process_group(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=3)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
