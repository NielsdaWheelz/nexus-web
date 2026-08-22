"""Supervisor-side harness for the real-cgroup background containment proofs.

The probe target and its child handler stay free of pytest so production registry
code can import them; every pytest-only supervisor helper that the containment and
supervisor-liveness proofs share lives here.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from collections.abc import Generator, Sequence
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import Media, MediaKind, MediaSourceAttempt, ProcessingStatus
from nexus.jobs.queue import enqueue_job
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.testkit.background_process_containment_probe import (
    MEMORY_LIMIT_BYTES,
    PROBE_KIND,
)
from tests.testkit.unreachable_state import (
    delete_jobs_of_kinds,
    delete_source_probe_owners_by_job_kind,
    release_heavy_capacity_row,
)

PYTHON_ROOT = Path(__file__).resolve().parents[2]
_REPO_ROOT = PYTHON_ROOT.parent
# The gated scenarios must outlive the deliberate supervisor kill, so their wall
# limit is far wider than the fast resource-failure scenarios' three seconds.
GATED_WALL_TIMEOUT_SECONDS = 60.0
# Parent-death propagation is a pipe EOF plus a kernel signal; a whole second is
# already several orders of magnitude of slack.
_CHILD_DEATH_TIMEOUT_SECONDS = 10.0
# Must exceed the executor TERM grace plus one queue settlement, and stay inside
# the `stop_grace_period: 30s` the deployed service declares.
SHUTDOWN_TIMEOUT_SECONDS = 20.0
_OBSERVABLE_FILE_TIMEOUT_SECONDS = 30.0


def supervisor_environment() -> dict[str, str]:
    """Give the spawned supervisor this repository and the live user systemd bus."""
    environment = dict(os.environ)
    prior_pythonpath = environment.get("PYTHONPATH")
    roots = os.pathsep.join((str(PYTHON_ROOT), str(_REPO_ROOT)))
    environment["PYTHONPATH"] = (
        roots if not prior_pythonpath else f"{roots}{os.pathsep}{prior_pythonpath}"
    )
    user_runtime_directory = Path(f"/run/user/{os.getuid()}")
    user_bus = user_runtime_directory / "bus"
    assert user_bus.exists(), (
        f"cgroup containment proof requires a live user systemd bus at {user_bus}"
    )
    environment["XDG_RUNTIME_DIR"] = str(user_runtime_directory)
    environment["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={user_bus}"
    return environment


def supervisor_command(
    *,
    supervisor_pid_path: Path,
    supervisor_state_path: Path,
    parser_temp_root: Path,
    wall_timeout_seconds: float,
    lifetime: Sequence[str],
) -> list[str]:
    """Build the systemd-run scope command that owns one memory-limited supervisor."""
    systemd_run = shutil.which("systemd-run")
    assert systemd_run is not None, "cgroup containment proof requires systemd-run"
    return [
        systemd_run,
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        f"--unit=nexus-containment-{uuid4().hex[:16]}",
        "-p",
        f"MemoryMax={MEMORY_LIMIT_BYTES}",
        "-p",
        "MemorySwapMax=0",
        "-p",
        "OOMPolicy=continue",
        sys.executable,
        "-m",
        "tests.testkit.background_process_containment_probe",
        "--supervisor-pid-path",
        str(supervisor_pid_path),
        "--supervisor-state-path",
        str(supervisor_state_path),
        "--parser-temp-root",
        str(parser_temp_root),
        "--wall-timeout-seconds",
        str(wall_timeout_seconds),
        *lifetime,
    ]


def read_when_present(path: Path, *, what: str) -> str:
    """Return the first non-empty content another process writes to `path`."""
    deadline = time.monotonic() + _OBSERVABLE_FILE_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        try:
            value = path.read_text(encoding="ascii").strip()
        except OSError:
            value = ""
        if value:
            return value
    raise AssertionError(f"{what} was never observable at {path}")


def _process_is_live(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    try:
        status = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except OSError:
        return False
    # An unreaped zombie is a dead process that still answers signal 0.
    return status.rpartition(")")[2].split()[0] != "Z"


def await_process_exit(pid: int, *, what: str) -> None:
    """Fail unless the process dies inside the parent-death propagation budget."""
    deadline = time.monotonic() + _CHILD_DEATH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if not _process_is_live(pid):
            return
    raise AssertionError(
        f"{what} (pid {pid}) was still alive {_CHILD_DEATH_TIMEOUT_SECONDS}s after its "
        "supervisor died; the child is not bound to supervisor liveness"
    )


def forget_containment_probe_rows(engine: Engine) -> None:
    """Return the Heavy capacity row and this probe kind's queue rows to base state."""
    with Session(engine) as db:
        release_heavy_capacity_row(db)
        delete_source_probe_owners_by_job_kind(db, kind=PROBE_KIND)
        delete_jobs_of_kinds(db, kinds=(PROBE_KIND,))
        db.commit()


@pytest.fixture(scope="module", autouse=True)
def clean_containment_jobs(engine: Engine) -> Generator[None, None, None]:
    """Forget probe rows even when a supervisor scenario dies before its own cleanup."""
    try:
        yield
    finally:
        forget_containment_probe_rows(engine)


def enqueue_source_probe(
    db: Session,
    *,
    viewer_id: UUID,
    mode: str,
    priority: int,
    pid_path: Path | None,
    parser_temp_root: Path,
    descendant_pid_path: Path | None = None,
    published_path: Path | None = None,
    gate_path: Path | None = None,
    marker_path: Path | None = None,
    note_block_id: UUID | None = None,
) -> tuple[UUID, UUID, UUID]:
    """Queue one extracting source attempt whose child runs the named probe mode."""
    media_id = uuid4()
    attempt_id = uuid4()
    db.add(
        Media(
            id=media_id,
            kind=MediaKind.pdf.value,
            title=f"{mode} containment probe",
            processing_status=ProcessingStatus.extracting,
            created_by_user_id=viewer_id,
        )
    )
    attempt = MediaSourceAttempt(
        id=attempt_id,
        media_id=media_id,
        created_by_user_id=viewer_id,
        source_type="uploaded_pdf_file",
        attempt_no=1,
        run_count=1,
        status="running",
        intent_key=f"containment:{attempt_id}",
        processing_stage="Extract",
    )
    db.add(attempt)
    payload: dict[str, object] = {
        "mode": mode,
        "media_id": str(media_id),
        "attempt_id": str(attempt_id),
        "parser_temp_root": str(parser_temp_root),
    }
    if pid_path is not None:
        payload["pid_path"] = str(pid_path)
    if descendant_pid_path is not None:
        payload["descendant_pid_path"] = str(descendant_pid_path)
    if published_path is not None:
        payload["published_path"] = str(published_path)
    if gate_path is not None:
        payload["gate_path"] = str(gate_path)
    if marker_path is not None:
        payload["marker_path"] = str(marker_path)
    if note_block_id is not None:
        payload["note_block_id"] = str(note_block_id)
    job = enqueue_job(
        db,
        kind=PROBE_KIND,
        payload=payload,
        priority=priority,
        max_attempts=3,
    )
    attempt.job_id = job.id
    db.flush()
    return job.id, attempt_id, media_id


def seed_gated_probe(
    engine: Engine,
    *,
    tmp_path: Path,
    parser_temp_root: Path,
) -> tuple[UUID, UUID, UUID, Path, Path, Path]:
    """Publish one probe job whose child blocks on a gate file until released."""
    viewer_id = uuid4()
    pid_path = tmp_path / "gated-child.pid"
    gate_path = tmp_path / "gate"
    marker_path = tmp_path / "gate-released"
    with Session(engine) as db:
        ensure_user_and_default_library(
            db,
            viewer_id,
            f"containment-{viewer_id}@example.invalid",
        )
        job_id, attempt_id, media_id = enqueue_source_probe(
            db,
            viewer_id=viewer_id,
            mode="Gate",
            priority=0,
            pid_path=pid_path,
            parser_temp_root=parser_temp_root,
            gate_path=gate_path,
            marker_path=marker_path,
        )
        db.commit()
    return job_id, attempt_id, media_id, pid_path, gate_path, marker_path
