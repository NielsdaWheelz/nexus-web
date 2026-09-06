"""Shared production-worker process helpers for real-PostgreSQL proofs."""

from __future__ import annotations

import os
import signal
import struct
import sys
import time
from ctypes import (
    CDLL,
    POINTER,
    byref,
    c_int,
    c_size_t,
    c_uint,
    c_void_p,
    create_string_buffer,
)
from pathlib import Path
from uuid import UUID

from sqlalchemy import Engine, text

from nexus_test_control import services as test_services
from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    EndpointKind,
    forget_cleaned,
    process_resource_identity,
    runtime_endpoint,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]
_TEST_ENV = {"NEXUS_ENV": "test"}
_CTL_KERN = 1
_KERN_ARGMAX = 8
_KERN_PROCARGS2 = 49


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
        migration_database_url=os.environ.get("NEXUS_MIGRATION_DATABASE_URL"),
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
    # The ceiling covers a cold worker-process boot on a saturated CI runner:
    # 30s has been observed expiring with the job claimed, lease valid, and
    # still running. No caller treats expiry as an expected outcome.
    timeout_seconds: float = 120,
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
    command, environment = _process_invocation(process.process_group_id)
    assert command[-2:] == ("-m", "apps.worker.main"), (
        f"controller did not launch the production worker entrypoint: {command!r}"
    )
    assert environment.get("WORKER_LANE") == process.role.removeprefix("worker-")
    assert environment.get("DATABASE_URL") == run.database_url
    assert environment.get("NEXUS_TEST_RUN_ID") == run.run_id
    if process.role == "worker-interactive":
        mcp_endpoint = runtime_endpoint(_REPO_ROOT, _TEST_ENV, EndpointKind.AGENT_TOOLS_MCP)
        assert environment.get("NEXUS_AGENT_TOOLS_MCP_LISTEN") == mcp_endpoint.removeprefix(
            "http://"
        )
        assert environment.get("NEXUS_AGENT_TOOLS_MCP_ORIGIN") == (
            f"{mcp_endpoint}/internal/agent-tools/mcp"
        )


def _process_invocation(process_id: int) -> tuple[tuple[str, ...], dict[str, str]]:
    if sys.platform == "linux":
        process_root = Path("/proc") / str(process_id)
        command = tuple(
            part.decode("utf-8")
            for part in (process_root / "cmdline").read_bytes().split(b"\0")
            if part
        )
        environment_parts = (process_root / "environ").read_bytes().split(b"\0")
    elif sys.platform == "darwin":
        command, environment_parts = _darwin_process_invocation(process_id)
    else:
        raise AssertionError("production worker proof requires Linux or Darwin")
    environment = dict(
        part.decode("utf-8").split("=", 1) for part in environment_parts if b"=" in part
    )
    return command, environment


def _darwin_process_invocation(process_id: int) -> tuple[tuple[str, ...], tuple[bytes, ...]]:
    libc = CDLL(None, use_errno=True)
    sysctl = libc.sysctl
    sysctl.argtypes = (
        POINTER(c_int),
        c_uint,
        c_void_p,
        POINTER(c_size_t),
        c_void_p,
        c_size_t,
    )
    sysctl.restype = c_int

    argmax_name = (c_int * 2)(_CTL_KERN, _KERN_ARGMAX)
    argmax = c_int()
    argmax_size = c_size_t(struct.calcsize("i"))
    if sysctl(argmax_name, 2, byref(argmax), byref(argmax_size), None, 0) != 0:
        raise OSError("Darwin process argument limit could not be read")

    process_name = (c_int * 3)(_CTL_KERN, _KERN_PROCARGS2, process_id)
    process_buffer = create_string_buffer(argmax.value)
    process_size = c_size_t(argmax.value)
    if sysctl(process_name, 3, process_buffer, byref(process_size), None, 0) != 0:
        raise ProcessLookupError(process_id)

    raw = process_buffer.raw[: process_size.value]
    if len(raw) < struct.calcsize("i"):
        raise AssertionError("Darwin process invocation was incomplete")
    argument_count = struct.unpack_from("i", raw)[0]
    parts = raw[struct.calcsize("i") :].split(b"\0")
    while parts and not parts[0]:
        parts.pop(0)
    if not parts:
        raise AssertionError("Darwin process invocation omitted its executable")
    parts.pop(0)
    while parts and not parts[0]:
        parts.pop(0)
    command = tuple(part.decode("utf-8") for part in parts[:argument_count])
    environment = tuple(part for part in parts[argument_count:] if part)
    if len(command) != argument_count:
        raise AssertionError("Darwin process invocation omitted arguments")
    return command, environment


def kill_and_forget_process(process: test_services.StartedProcess) -> None:
    """Inject process death and release its exact controller ledger entry."""
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
