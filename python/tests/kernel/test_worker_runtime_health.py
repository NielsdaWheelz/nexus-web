from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from apps.worker.health import (
    WorkerHeartbeatError,
    WorkerHeartbeatPublisher,
    validate_worker_heartbeat,
)

from nexus.release_artifact import RuntimeIdentity

SOURCE_SHA = "a" * 40
ORACLE_DIGEST = f"sha256:{'b' * 64}"
TASK_CONTRACT_DIGEST = "c" * 64


def _identity() -> RuntimeIdentity:
    return RuntimeIdentity(
        source_sha=SOURCE_SHA,
        expected_database_revision="0210",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
    )


def test_worker_heartbeat_is_atomic_and_binds_runtime_contract(tmp_path: Path) -> None:
    heartbeat_path = tmp_path / "interactive.json"
    publisher = WorkerHeartbeatPublisher(
        lane="interactive",
        allowed_job_kinds=("chat_run", "ingest_media_source"),
        identity=_identity(),
        task_contract_digest=TASK_CONTRACT_DIGEST,
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
        expected_identity=_identity(),
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
        identity=_identity(),
        task_contract_digest=TASK_CONTRACT_DIGEST,
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
            expected_identity=_identity(),
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
        identity=_identity(),
        task_contract_digest=TASK_CONTRACT_DIGEST,
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
            expected_identity=_identity(),
            expected_task_contract_digest=TASK_CONTRACT_DIGEST,
            now_monotonic=100.0,
            process_is_alive=lambda _pid: False,
        )
    assert caught.value.code == "process_dead"
