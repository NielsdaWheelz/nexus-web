"""Business child target imported only after the containment process boundary."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from uuid import UUID

from nexus.db.session import get_session_factory
from nexus.errors import ApiErrorCode
from nexus.jobs.queue import JobExecutionContext
from tests.testkit.unreachable_state import publish_source_probe_success


class _ModeledResourceLimit(RuntimeError):
    def __init__(self, *, dimension: str) -> None:
        super().__init__(f"modeled {dimension.lower()} limit")
        self.error_code = ApiErrorCode.E_RESOURCE_LIMIT.value
        self.resource_dimension = dimension


def run_containment_probe(
    *, payload: Mapping[str, object], context: JobExecutionContext
) -> Mapping[str, object]:
    """Hang, allocate until kernel OOM, or identify one fresh success child."""
    mode = payload["mode"]
    attempt_id = str(payload["attempt_id"])
    parser_temp_root = Path(str(payload["parser_temp_root"]))
    residue = parser_temp_root / attempt_id / "probe-run" / "source.bin"
    residue.parent.mkdir(parents=True, exist_ok=True)
    residue.write_bytes(b"bounded-residue")
    if mode in {
        "Timeout",
        "Memory",
        "PublishThenTimeout",
        "PublishThenMemory",
        "PublishThenExit",
    }:
        pid_path = Path(str(payload["pid_path"]))
        pid_path.write_text(str(os.getpid()), encoding="ascii")
    if mode == "Timeout":
        descendant_pid_path = Path(str(payload["descendant_pid_path"]))
        subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import os,signal,time,pathlib;"
                    f"pathlib.Path({str(descendant_pid_path)!r}).write_text(str(os.getpid()));"
                    "signal.signal(signal.SIGTERM, signal.SIG_IGN);"
                    "time.sleep(60)"
                ),
            ]
        )
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            signal.pause()
    if mode in {"PublishThenTimeout", "PublishThenMemory", "PublishThenExit"}:
        with get_session_factory()() as db:
            publish_source_probe_success(
                db,
                attempt_id=UUID(attempt_id),
                media_id=UUID(str(payload["media_id"])),
                job_id=context.job_id,
            )
            db.commit()
        Path(str(payload["published_path"])).write_text("published", encoding="ascii")
    if mode == "PublishThenExit":
        os._exit(17)
    if mode in {"Timeout", "PublishThenTimeout"}:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True:
            signal.pause()
    if mode in {"Memory", "PublishThenMemory"}:
        allocations: list[bytearray] = []
        while True:
            allocation = bytearray(16 * 1024 * 1024)
            for offset in range(0, len(allocation), 4096):
                allocation[offset] = 1
            allocations.append(allocation)
    if mode in {"ModeledStructure", "ModeledOutput"}:
        dimension = "Structure" if mode == "ModeledStructure" else "Output"
        raise _ModeledResourceLimit(dimension=dimension)
    if mode == "Succeed":
        return {"kind": "ProbeSucceeded", "child_pid": os.getpid()}
    raise AssertionError(f"unsupported containment probe mode: {mode!r}")
