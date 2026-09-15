"""Priority proof: a killed supervisor's child dies before it can write anything."""

from __future__ import annotations

import os
import signal
import subprocess
from pathlib import Path

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from nexus.db.models import ProcessingStatus
from tests.testkit.background_process_containment_probe import WORKER_ID
from tests.testkit.background_worker_supervisor import (
    GATED_WALL_TIMEOUT_SECONDS,
    PYTHON_ROOT,
    SHUTDOWN_TIMEOUT_SECONDS,
    await_process_exit,
    clean_containment_jobs,  # noqa: F401 - pytest binds this autouse fixture to the module.
    forget_containment_probe_rows,
    read_when_present,
    seed_gated_probe,
    supervisor_command,
    supervisor_environment,
)


def test_supervisor_death_kills_its_gated_child_before_any_stale_write(
    engine: Engine,
    tmp_path: Path,
) -> None:
    """Risk: a SIGKILLed supervisor must not leave an orphan holding a live claim."""
    parser_temp_root = tmp_path / "parser-temp"
    parser_temp_root.mkdir()
    supervisor_pid_path = tmp_path / "supervisor.pid"
    supervisor_state_path = tmp_path / "supervisor.json"
    job_id, attempt_id, media_id, pid_path, gate_path, marker_path = seed_gated_probe(
        engine,
        tmp_path=tmp_path,
        parser_temp_root=parser_temp_root,
    )

    supervisor = subprocess.Popen(
        supervisor_command(
            supervisor_pid_path=supervisor_pid_path,
            supervisor_state_path=supervisor_state_path,
            parser_temp_root=parser_temp_root,
            wall_timeout_seconds=GATED_WALL_TIMEOUT_SECONDS,
            lifetime=("--exact-jobs", "1"),
        ),
        cwd=PYTHON_ROOT,
        env=supervisor_environment(),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        supervisor_pid = int(read_when_present(supervisor_pid_path, what="supervisor pid"))
        child_pid = int(read_when_present(pid_path, what="gated child pid"))
        os.kill(supervisor_pid, signal.SIGKILL)

        await_process_exit(child_pid, what="the gated child")
        gate_path.write_text("open", encoding="ascii")
        assert not marker_path.exists(), (
            "a child whose supervisor is dead still committed its gated write"
        )
        await_process_exit(supervisor_pid, what="the SIGKILLed supervisor")
        assert not supervisor_state_path.exists(), (
            "the supervisor finished its run instead of dying mid-child"
        )

        with Session(engine) as oracle:
            job = oracle.execute(
                text(
                    """
                    SELECT status, attempts, claimed_by, error_code, result
                    FROM background_jobs
                    WHERE id = :job_id
                    """
                ),
                {"job_id": job_id},
            ).one()
            attempt_status = oracle.scalar(
                text("SELECT status FROM media_source_attempts WHERE id = :attempt_id"),
                {"attempt_id": attempt_id},
            )
            media_status = oracle.scalar(
                text("SELECT processing_status FROM media WHERE id = :media_id"),
                {"media_id": media_id},
            )
        assert tuple(job) == ("running", 1, WORKER_ID, None, None), (
            f"the orphaned child mutated its own queue row: {tuple(job)!r}"
        )
        assert attempt_status == "running"
        assert media_status == ProcessingStatus.extracting.value
    finally:
        supervisor.kill()
        supervisor.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
        forget_containment_probe_rows(engine)
