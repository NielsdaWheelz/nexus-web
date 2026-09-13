from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from apps.worker.health import (
    WorkerHeartbeatError,
    WorkerHeartbeatPublisher,
    validate_worker_heartbeat,
)

SOURCE_SHA = "a" * 40
ORACLE_DIGEST = f"sha256:{'b' * 64}"
TASK_CONTRACT_DIGEST = "c" * 64
REPO_ROOT = Path(__file__).resolve().parents[3]


def test_worker_health_probe_does_not_load_the_worker_runtime_graph() -> None:
    """The recurring probe shares the interactive worker's hard cgroup."""
    script = """
import json
import sys

import apps.worker.health

blocked_roots = (
    "llm_tools",
    "provider_runtime",
    "psycopg",
    "pydantic",
    "sqlalchemy",
    "nexus.config",
    "nexus.jobs",
    "nexus.runtime_health",
)
loaded = sorted(
    name
    for name in sys.modules
    if any(name == root or name.startswith(f"{root}.") for root in blocked_roots)
)
print(json.dumps(loaded))
"""

    completed = subprocess.run(
        [sys.executable, "-S", "-c", script],
        cwd=REPO_ROOT,
        env={**os.environ, "PYTHONPATH": str(REPO_ROOT / "python")},
        check=True,
        capture_output=True,
        text=True,
    )

    loaded = json.loads(completed.stdout)
    assert loaded == [], (
        f"the cgroup-local worker health probe loaded the full worker/runtime graph: {loaded!r}"
    )


def test_worker_entrypoint_import_does_not_load_provider_execution_sdks() -> None:
    """The idle worker retains contracts, not every provider HTTP client."""
    script = """
import json
import sys

import apps.worker.main

blocked_roots = (
    "anthropic",
    "google.genai",
    "openai",
    "provider_runtime.engines",
    "provider_runtime.runtime",
)
loaded = sorted(
    name
    for name in sys.modules
    if any(name == root or name.startswith(f"{root}.") for root in blocked_roots)
)
print(json.dumps(loaded))
"""

    completed = subprocess.run(
        [sys.executable, "-B", "-c", script],
        cwd=REPO_ROOT,
        env={**os.environ, "PYTHONPATH": str(REPO_ROOT / "python")},
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )

    loaded = json.loads(completed.stdout)
    if loaded:
        raise AssertionError(f"the idle worker loaded provider execution modules: {loaded!r}")


def test_worker_heartbeat_is_atomic_and_binds_runtime_contract(tmp_path: Path) -> None:
    heartbeat_path = tmp_path / "interactive.json"
    publisher = WorkerHeartbeatPublisher(
        lane="interactive",
        allowed_job_kinds=("chat_run", "ingest_media_source"),
        source_sha=SOURCE_SHA,
        expected_database_revision="0210",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
        task_contract_digest=TASK_CONTRACT_DIGEST,
        readiness_check=lambda: True,
        heartbeat_path=heartbeat_path,
        pid=os.getpid(),
        monotonic=lambda: 100.0,
    )

    publisher.publish()

    payload = json.loads(heartbeat_path.read_text(encoding="utf-8"))
    heartbeat = validate_worker_heartbeat(
        payload,
        expected_lane="interactive",
        expected_allowed_job_kinds=("chat_run", "ingest_media_source"),
        expected_source_sha=SOURCE_SHA,
        expected_database_revision="0210",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
        expected_task_contract_digest=TASK_CONTRACT_DIGEST,
        now_monotonic=120.0,
        process_is_alive=lambda pid: pid == os.getpid(),
    )
    assert heartbeat.successful_cycle_monotonic_seconds == 100.0
    assert not [path for path in tmp_path.iterdir() if path.suffix == ".tmp"]
    publisher.clear()
    assert not heartbeat_path.exists()


@pytest.mark.parametrize(
    ("mutation", "error_code"),
    [
        ({"lane": "background"}, "identity_mismatch"),
        ({"source_sha": "d" * 40}, "identity_mismatch"),
        ({"expected_database_revision": "0209"}, "identity_mismatch"),
        (
            {"expected_oracle_manifest_digest": f"sha256:{'f' * 64}"},
            "identity_mismatch",
        ),
        ({"allowed_job_kinds": ["chat_run"]}, "identity_mismatch"),
        ({"task_contract_digest": "e" * 64}, "identity_mismatch"),
        ({"successful_cycle_monotonic_seconds": 79.999}, "heartbeat_stale"),
        ({"successful_cycle_monotonic_seconds": 101.0}, "heartbeat_stale"),
        ({"pid": False}, "heartbeat_invalid"),
        ({"unexpected": True}, "heartbeat_invalid"),
    ],
)
def test_worker_heartbeat_rejects_stale_partial_or_mismatched_records(
    tmp_path: Path, mutation: dict[str, object], error_code: str
) -> None:
    heartbeat_path = tmp_path / "interactive.json"
    publisher = WorkerHeartbeatPublisher(
        lane="interactive",
        allowed_job_kinds=("chat_run", "ingest_media_source"),
        source_sha=SOURCE_SHA,
        expected_database_revision="0210",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
        task_contract_digest=TASK_CONTRACT_DIGEST,
        readiness_check=lambda: True,
        heartbeat_path=heartbeat_path,
        pid=os.getpid(),
        monotonic=lambda: 100.0,
    )
    publisher.publish()
    payload = json.loads(heartbeat_path.read_text(encoding="utf-8"))
    payload.update(mutation)

    with pytest.raises(WorkerHeartbeatError) as caught:
        validate_worker_heartbeat(
            payload,
            expected_lane="interactive",
            expected_allowed_job_kinds=("chat_run", "ingest_media_source"),
            expected_source_sha=SOURCE_SHA,
            expected_database_revision="0210",
            expected_oracle_manifest_digest=ORACLE_DIGEST,
            expected_task_contract_digest=TASK_CONTRACT_DIGEST,
            now_monotonic=100.0,
            process_is_alive=lambda _pid: True,
        )
    assert caught.value.code == error_code


def test_worker_heartbeat_requires_the_recorded_process_to_be_alive(tmp_path: Path) -> None:
    heartbeat_path = tmp_path / "interactive.json"
    publisher = WorkerHeartbeatPublisher(
        lane="interactive",
        allowed_job_kinds=("chat_run",),
        source_sha=SOURCE_SHA,
        expected_database_revision="0210",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
        task_contract_digest=TASK_CONTRACT_DIGEST,
        readiness_check=lambda: True,
        heartbeat_path=heartbeat_path,
        pid=os.getpid(),
        monotonic=lambda: 100.0,
    )
    publisher.publish()
    payload = json.loads(heartbeat_path.read_text(encoding="utf-8"))

    with pytest.raises(WorkerHeartbeatError) as caught:
        validate_worker_heartbeat(
            payload,
            expected_lane="interactive",
            expected_allowed_job_kinds=("chat_run",),
            expected_source_sha=SOURCE_SHA,
            expected_database_revision="0210",
            expected_oracle_manifest_digest=ORACLE_DIGEST,
            expected_task_contract_digest=TASK_CONTRACT_DIGEST,
            now_monotonic=100.0,
            process_is_alive=lambda _pid: False,
        )
    assert caught.value.code == "process_dead"
