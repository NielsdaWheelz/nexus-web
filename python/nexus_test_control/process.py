from __future__ import annotations

import mmap
import os
import signal
import subprocess
import sys
import tempfile
import threading
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from types import FrameType
from typing import BinaryIO


class CommandInterrupted(RuntimeError):
    """The test controller received an interrupt while owning a child group."""


_ACTIVE_LOCK = threading.Lock()
_ACTIVE_PROCESS: subprocess.Popen[str] | None = None
_CAPTURED_OUTPUT_TAIL_BYTES = 64 * 1024
_CAPTURED_MARKER_LINES_BYTES = 16 * 1024
_RUNNER_PROCESS_TRACKING_ENV = "RUNNER_TRACKING_ID"
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
    retain_stdout_markers: Sequence[str] = (),
) -> subprocess.CompletedProcess[str]:
    """Run one fixed command in an owned process group that cannot outlive the caller."""
    if not command or any(not isinstance(part, str) or not part for part in command):
        raise ValueError("child command must be a fixed non-empty argv")
    if retain_stdout_markers and not capture_output:
        raise ValueError("stdout markers require captured output")
    if any(not isinstance(marker, str) or not marker for marker in retain_stdout_markers):
        raise ValueError("stdout markers must be non-empty strings")
    stdout_file: BinaryIO | None = tempfile.TemporaryFile() if capture_output else None
    stderr_file: BinaryIO | None = tempfile.TemporaryFile() if capture_output else None
    blocked = {signal.SIGINT, signal.SIGTERM}
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
    try:
        child_environment = dict(env)
        # GitHub's final cancellation sweep identifies descendants by this
        # inherited value. Keep the real supervisor identity across the
        # controller's isolation boundary, but never accept a replacement.
        runner_tracking_id = os.environ.get(_RUNNER_PROCESS_TRACKING_ENV)
        if runner_tracking_id:
            child_environment[_RUNNER_PROCESS_TRACKING_ENV] = runner_tracking_id
        else:
            child_environment.pop(_RUNNER_PROCESS_TRACKING_ENV, None)
        process = subprocess.Popen(
            unblock_and_exec_command(command),
            cwd=cwd,
            env=child_environment,
            stdout=stdout_file,
            stderr=stderr_file,
            text=True,
            start_new_session=True,
        )
        _claim_process(process)
    except BaseException:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        if stdout_file is not None:
            stdout_file.close()
        if stderr_file is not None:
            stderr_file.close()
        raise
    try:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
        process.wait()
        captured_stdout = _output_tail(stdout_file, retain_stdout_markers)
        captured_stderr = _output_tail(stderr_file)
    except BaseException:
        _terminate_process_group(process)
        raise
    finally:
        _release_process(process)
        if stdout_file is not None:
            stdout_file.close()
        if stderr_file is not None:
            stderr_file.close()
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


def _output_tail(output: BinaryIO | None, markers: Sequence[str] = ()) -> str | None:
    if output is None:
        return None
    output.flush()
    length = output.seek(0, os.SEEK_END)
    output.seek(max(0, length - _CAPTURED_OUTPUT_TAIL_BYTES))
    tail = output.read()
    retained = _retained_marker_lines(output, markers, length)
    if not retained or all(line in tail for line in retained):
        return tail.decode("utf-8", errors="replace")
    heading = b"[retained marked output]\n"
    marked = b"\n".join(retained) + b"\n[final output tail]\n"
    tail_budget = max(0, _CAPTURED_OUTPUT_TAIL_BYTES - len(heading) - len(marked))
    combined = heading + marked + tail[-tail_budget:] if tail_budget else heading + marked
    return combined[:_CAPTURED_OUTPUT_TAIL_BYTES].decode("utf-8", errors="replace")


def _retained_marker_lines(
    output: BinaryIO,
    markers: Sequence[str],
    length: int,
) -> tuple[bytes, ...]:
    if not markers or length == 0:
        return ()
    encoded_markers = tuple(marker.encode("utf-8") for marker in markers)
    retained: list[bytes] = []
    retained_bytes = 0
    with mmap.mmap(output.fileno(), 0, access=mmap.ACCESS_READ) as contents:
        for marker in encoded_markers:
            start = 0
            while (position := contents.find(marker, start)) >= 0:
                line_start = contents.rfind(b"\n", 0, position) + 1
                line_end = contents.find(b"\n", position)
                if line_end < 0:
                    line_end = length
                remaining = _CAPTURED_MARKER_LINES_BYTES - retained_bytes
                if remaining <= 0:
                    return tuple(retained)
                capture_start = line_start if position - line_start < remaining else position
                line = bytes(contents[capture_start : min(line_end, capture_start + remaining)])
                if line not in retained:
                    retained.append(line)
                    retained_bytes += len(line)
                start = line_end + 1
    return tuple(retained)


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
