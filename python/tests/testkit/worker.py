"""Shared production-worker process helpers for real-PostgreSQL proofs."""

from __future__ import annotations

import os
import signal
import time
from pathlib import Path
from uuid import UUID

from sqlalchemy import Engine, text

from nexus_test_control import services as test_services
from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import forget_cleaned, process_resource_identity

_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEST_ENV = {"NEXUS_ENV": "test"}


def controller_run() -> test_services.TestRun:
    run_id = os.environ.get("NEXUS_TEST_RUN_ID")
    database_url = os.environ.get("DATABASE_URL")
    bucket = os.environ.get("R2_BUCKET")
    assert run_id and database_url and bucket, (
        "worker-process proof requires its controller-owned service run"
    )
    return test_services.TestRun(
        run_id=run_id,
        database_url=database_url,
        migration_database_url=None,
        bucket=bucket,
        supabase=test_services.ensure_services(_REPO_ROOT, _TEST_ENV),
    )


def wait_for_job(
    engine: Engine,
    job_id: UUID,
    *,
    status: str,
    attempts: int,
    minimum_lease_seconds: float | None = None,
    timeout_seconds: float = 30,
) -> tuple[object, ...]:
    deadline = time.monotonic() + timeout_seconds
    observed: tuple[object, ...] | None = None
    while time.monotonic() < deadline:
        with engine.connect() as oracle:
            row = oracle.execute(
                text(
                    """
                    SELECT status,
                           attempts,
                           claimed_by,
                           lease_expires_at,
                           result,
                           EXTRACT(EPOCH FROM lease_expires_at - now()) AS lease_seconds
                    FROM background_jobs
                    WHERE id = :job_id
                    """
                ),
                {"job_id": job_id},
            ).one()
        observed = tuple(row[:5])
        if (
            row.status == status
            and row.attempts == attempts
            and (
                minimum_lease_seconds is None
                or float(row.lease_seconds or 0) >= minimum_lease_seconds
            )
        ):
            return observed
    raise AssertionError(
        f"job {job_id} did not reach {status=} and {attempts=}; last row: {observed!r}"
    )


def assert_production_worker(
    process: test_services.StartedProcess,
    run: test_services.TestRun,
) -> None:
    process_root = Path("/proc") / str(process.process_group_id)
    command = tuple(
        part.decode("utf-8")
        for part in (process_root / "cmdline").read_bytes().split(b"\0")
        if part
    )
    environment = dict(
        part.decode("utf-8").split("=", 1)
        for part in (process_root / "environ").read_bytes().split(b"\0")
        if b"=" in part
    )
    assert command[-2:] == ("-m", "apps.worker.main"), (
        f"controller did not launch the production worker entrypoint: {command!r}"
    )
    assert environment.get("WORKER_LANE") == process.role.removeprefix("worker-")
    assert environment.get("DATABASE_URL") == run.database_url
    assert environment.get("NEXUS_TEST_RUN_ID") == run.run_id


def kill_and_forget_worker(process: test_services.StartedProcess) -> None:
    os.killpg(process.process_group_id, signal.SIGKILL)
    waited_pid, wait_status = os.waitpid(process.process_group_id, 0)
    assert waited_pid == process.process_group_id
    assert os.waitstatus_to_exitcode(wait_status) == -signal.SIGKILL
    forget_cleaned(
        _REPO_ROOT,
        _TEST_ENV,
        process.run_id,
        Resource(
            ResourceKind.PROCESS,
            process_resource_identity(process.run_id, process.role),
        ),
    )
