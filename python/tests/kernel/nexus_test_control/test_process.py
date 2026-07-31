from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

import pytest


def test_sigterm_to_controller_terminates_its_current_child_process_group(
    tmp_path: Path,
) -> None:
    child_pid_path = tmp_path / "child.pid"
    child = (
        "import os, pathlib, signal, sys; "
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); "
        "signal.pause()"
    )
    controller = (
        "import sys; "
        "from pathlib import Path; "
        "from nexus_test_control.process import controller_signal_handlers, run_command; "
        "path = Path(sys.argv[1]); "
        "child = sys.argv[2]; "
        "ctx = controller_signal_handlers(); "
        "ctx.__enter__(); "
        "run_command((sys.executable, '-c', child, str(path)), cwd=Path.cwd(), env={})"
    )
    process = subprocess.Popen(
        (sys.executable, "-c", controller, str(child_pid_path), child),
        cwd=Path.cwd(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    for _attempt in range(500):
        if child_pid_path.is_file():
            break
        if process.poll() is not None:
            break
        threading.Event().wait(0.01)
    assert child_pid_path.is_file()
    child_pid = int(child_pid_path.read_text(encoding="utf-8"))

    try:
        os.kill(process.pid, signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=10)

        assert process.returncode != 0, (stdout, stderr)
        with pytest.raises(ProcessLookupError):
            os.kill(child_pid, 0)
    except BaseException:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        try:
            os.killpg(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        raise
