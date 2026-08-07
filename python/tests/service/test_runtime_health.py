from __future__ import annotations

import os
import threading
from collections.abc import Generator
from pathlib import Path

import pytest
from apps.worker.health import (
    WorkerHeartbeatError,
    WorkerHeartbeatPublisher,
    check_worker_health,
    expected_job_kinds,
)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from nexus.config import get_settings
from nexus.db.session import create_session_factory
from nexus.jobs.registry import get_task_contract_digest
from nexus.jobs.worker import JobWorker
from nexus.release_artifact import RuntimeIdentity, write_runtime_identity_value
from nexus.runtime_health import (
    NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV,
    clear_runtime_identity_cache,
    get_runtime_identity,
    is_database_ready,
)

SOURCE_SHA = "a" * 40
ORACLE_DIGEST = f"sha256:{'b' * 64}"


@pytest.fixture
def runtime_identity_file(
    engine: Engine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Generator[tuple[Path, str], None, None]:
    with engine.connect() as connection:
        revision = str(
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
        )
    path = tmp_path / "runtime-identity.json"
    write_runtime_identity_value(
        RuntimeIdentity(
            source_sha=SOURCE_SHA,
            expected_database_revision=revision,
            expected_oracle_manifest_digest=ORACLE_DIGEST,
        ),
        path,
    )
    monkeypatch.setenv(NONPRODUCTION_RUNTIME_IDENTITY_FILE_ENV, str(path))
    clear_runtime_identity_cache()
    yield path, revision
    clear_runtime_identity_cache()


@pytest.fixture
def operational_client(
    runtime_identity_file: tuple[Path, str], nexus_app: FastAPI
) -> Generator[TestClient, None, None]:
    del runtime_identity_file
    with TestClient(nexus_app) as client:
        yield client


def test_operational_routes_are_public_exact_and_uncacheable(
    operational_client: TestClient,
    runtime_identity_file: tuple[Path, str],
    nexus_app: FastAPI,
) -> None:
    _path, revision = runtime_identity_file

    live = operational_client.get("/livez")
    assert live.status_code == 200
    assert live.json() == {"data": {"status": "alive"}}
    assert live.headers["cache-control"] == "no-store"

    version = operational_client.get("/version")
    assert version.status_code == 200
    assert version.headers["cache-control"] == "no-store"
    assert version.json()["data"] == {
        "source_sha": SOURCE_SHA,
        "expected_database_revision": revision,
        "expected_oracle_manifest_digest": ORACLE_DIGEST,
        "task_contract_digest": version.json()["data"]["task_contract_digest"],
    }
    assert len(version.json()["data"]["task_contract_digest"]) == 64

    ready = operational_client.get("/readyz")
    assert ready.status_code == 200
    assert ready.json() == {"data": {"status": "ready"}}
    assert ready.headers["cache-control"] == "no-store"


def test_readiness_fails_closed_without_leaking_the_observed_revision(
    operational_client: TestClient,
    runtime_identity_file: tuple[Path, str],
) -> None:
    path, observed_revision = runtime_identity_file
    write_runtime_identity_value(
        RuntimeIdentity(
            source_sha=SOURCE_SHA,
            expected_database_revision="0000",
            expected_oracle_manifest_digest=ORACLE_DIGEST,
        ),
        path,
    )
    clear_runtime_identity_cache()

    response = operational_client.get("/readyz")

    assert response.status_code == 503
    assert response.json() == {"data": {"status": "unavailable"}}
    assert response.headers["cache-control"] == "no-store"
    assert observed_revision not in response.text


def test_database_readiness_returns_within_its_budget_when_schema_read_blocks(
    engine: Engine,
    runtime_identity_file: tuple[Path, str],
) -> None:
    _identity_path, revision = runtime_identity_file
    outcomes: list[bool] = []

    def probe() -> None:
        outcomes.append(
            is_database_ready(
                database_url=get_settings().database_url,
                expected_revision=revision,
            )
        )

    blocker = engine.connect()
    transaction = blocker.begin()
    thread = threading.Thread(target=probe)
    thread_started = False
    try:
        blocker.execute(text("LOCK TABLE alembic_version IN ACCESS EXCLUSIVE MODE"))
        thread.start()
        thread_started = True
        thread.join(timeout=4)
        completed_within_budget = not thread.is_alive()
    finally:
        transaction.rollback()
        blocker.close()
        if thread_started:
            thread.join(timeout=2)

    assert completed_within_budget
    assert outcomes == [False]


def test_worker_loop_publishes_only_after_a_real_database_cycle(engine: Engine) -> None:
    stop_event = threading.Event()
    successful_cycles: list[str] = []

    def record_successful_cycle() -> None:
        successful_cycles.append("database_cycle")
        stop_event.set()

    worker = JobWorker(
        session_factory=create_session_factory(engine),
        worker_id="runtime-health-proof",
        registry={},
        allowed_kinds=("runtime_health_probe_test",),
        successful_cycle_callback=record_successful_cycle,
        successful_cycle_interval_seconds=5.0,
    )

    worker.run_forever(stop_event=stop_event)

    assert successful_cycles == ["database_cycle"]


def test_worker_heartbeat_file_failure_does_not_change_queue_progress(engine: Engine) -> None:
    stop_event = threading.Event()
    attempted_cycles: list[str] = []

    def fail_heartbeat_publication() -> None:
        attempted_cycles.append("database_cycle")
        stop_event.set()
        raise OSError("synthetic heartbeat file failure")

    worker = JobWorker(
        session_factory=create_session_factory(engine),
        worker_id="runtime-health-file-failure-proof",
        registry={},
        allowed_kinds=("runtime_health_probe_test",),
        successful_cycle_callback=fail_heartbeat_publication,
        successful_cycle_interval_seconds=5.0,
    )

    worker.run_forever(stop_event=stop_event)

    assert attempted_cycles == ["database_cycle"]


def test_worker_health_binds_live_process_release_contract_and_database(
    runtime_identity_file: tuple[Path, str],
    tmp_path: Path,
) -> None:
    identity_path, _revision = runtime_identity_file
    heartbeat_path = tmp_path / "interactive-heartbeat.json"
    identity = get_runtime_identity()
    publisher = WorkerHeartbeatPublisher(
        lane="interactive",
        allowed_job_kinds=expected_job_kinds("interactive"),
        identity=identity,
        task_contract_digest=get_task_contract_digest(),
        heartbeat_path=heartbeat_path,
        pid=os.getpid(),
    )
    publisher.publish()

    heartbeat = check_worker_health(lane="interactive", heartbeat_path=heartbeat_path)
    assert heartbeat.source_sha == SOURCE_SHA

    heartbeat_path.write_bytes(b" " + heartbeat_path.read_bytes())
    with pytest.raises(WorkerHeartbeatError) as noncanonical:
        check_worker_health(lane="interactive", heartbeat_path=heartbeat_path)
    assert noncanonical.value.code == "heartbeat_invalid"

    mismatched_identity = RuntimeIdentity(
        source_sha=SOURCE_SHA,
        expected_database_revision="0000",
        expected_oracle_manifest_digest=ORACLE_DIGEST,
    )
    write_runtime_identity_value(mismatched_identity, identity_path)
    clear_runtime_identity_cache()
    WorkerHeartbeatPublisher(
        lane="interactive",
        allowed_job_kinds=expected_job_kinds("interactive"),
        identity=mismatched_identity,
        task_contract_digest=get_task_contract_digest(),
        heartbeat_path=heartbeat_path,
        pid=os.getpid(),
    ).publish()

    with pytest.raises(WorkerHeartbeatError) as caught:
        check_worker_health(lane="interactive", heartbeat_path=heartbeat_path)
    assert caught.value.code == "database_not_ready"
