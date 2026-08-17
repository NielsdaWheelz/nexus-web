from __future__ import annotations

import os
import threading
from collections.abc import Callable, Generator
from pathlib import Path

import apps.worker.health as worker_health
import apps.worker.main as worker_main
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

from nexus.config import clear_settings_cache, get_settings
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


def test_worker_publishes_health_only_for_the_exact_database_revision(
    runtime_identity_file: tuple[Path, str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    identity_path, revision = runtime_identity_file
    heartbeat_path = tmp_path / "interactive-heartbeat.json"
    monkeypatch.setenv("WORKER_LANE", "interactive")
    monkeypatch.setattr(
        worker_health,
        "WORKER_HEARTBEAT_PATHS",
        {
            "interactive": heartbeat_path,
            "background": tmp_path / "background-heartbeat.json",
        },
    )
    monkeypatch.setattr(worker_main, "configure_logging", lambda: None)
    monkeypatch.setattr(worker_main, "_register_signal_handlers", lambda _stop: None)
    expected_ready = [True]
    observations: list[str] = []

    class OneCycleWorker:
        worker_id = "entrypoint-health-proof"
        allowed_kinds = expected_job_kinds("interactive")

        def __init__(self, callback: Callable[[], None]) -> None:
            self._callback = callback

        def run_forever(self, *, stop_event: threading.Event) -> None:
            del stop_event
            self._callback()
            if expected_ready[0]:
                heartbeat = check_worker_health(lane="interactive", heartbeat_path=heartbeat_path)
                observations.append(heartbeat.expected_database_revision)
            else:
                with pytest.raises(WorkerHeartbeatError) as caught:
                    check_worker_health(lane="interactive", heartbeat_path=heartbeat_path)
                observations.append(caught.value.code)

    def create_one_cycle_worker(
        *, successful_cycle_callback: Callable[[], None] | None = None
    ) -> OneCycleWorker:
        assert successful_cycle_callback is not None
        return OneCycleWorker(successful_cycle_callback)

    monkeypatch.setattr(worker_main, "create_worker", create_one_cycle_worker)
    clear_settings_cache()
    try:
        worker_main.main()

        write_runtime_identity_value(
            RuntimeIdentity(
                source_sha=SOURCE_SHA,
                expected_database_revision="0000",
                expected_oracle_manifest_digest=ORACLE_DIGEST,
            ),
            identity_path,
        )
        clear_runtime_identity_cache()
        expected_ready[0] = False
        worker_main.main()
    finally:
        clear_settings_cache()
        clear_runtime_identity_cache()

    assert observations == [revision, "heartbeat_invalid"]
    assert not heartbeat_path.exists()


def test_worker_health_binds_live_process_release_contract(
    runtime_identity_file: tuple[Path, str],
    tmp_path: Path,
) -> None:
    _identity_path, _revision = runtime_identity_file
    heartbeat_path = tmp_path / "interactive-heartbeat.json"
    identity = get_runtime_identity()
    publisher = WorkerHeartbeatPublisher(
        lane="interactive",
        allowed_job_kinds=expected_job_kinds("interactive"),
        source_sha=identity.source_sha,
        expected_database_revision=identity.expected_database_revision,
        expected_oracle_manifest_digest=identity.expected_oracle_manifest_digest,
        task_contract_digest=get_task_contract_digest(),
        readiness_check=lambda: True,
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


def test_background_worker_refuses_to_publish_health_without_the_live_cgroup_contract(
    runtime_identity_file: tuple[Path, str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    del runtime_identity_file
    heartbeat_path = tmp_path / "background-heartbeat.json"
    identity = get_runtime_identity()
    memberships = [
        line.removeprefix("0::")
        for line in Path("/proc/self/cgroup").read_text(encoding="ascii").splitlines()
        if line.startswith("0::/")
    ]
    assert len(memberships) == 1
    cgroup_root = tmp_path / "cgroup"
    cgroup_directory = cgroup_root / memberships[0].lstrip("/")
    cgroup_directory.mkdir(parents=True)
    (cgroup_directory / "cgroup.controllers").write_text("memory\n", encoding="ascii")
    (cgroup_directory / "memory.max").write_text("1\n", encoding="ascii")
    (cgroup_directory / "memory.oom.group").write_text("0\n", encoding="ascii")
    (cgroup_directory / "memory.events").write_text("oom_kill 0\n", encoding="ascii")
    monkeypatch.setenv("BACKGROUND_PROCESS_CGROUP_ROOT", str(cgroup_root))
    clear_settings_cache()
    try:
        settings = get_settings()

        assert not worker_main._worker_readiness_check(
            lane="background",
            settings=settings,
            expected_database_revision=identity.expected_database_revision,
        )

        WorkerHeartbeatPublisher(
            lane="background",
            allowed_job_kinds=expected_job_kinds("background"),
            source_sha=identity.source_sha,
            expected_database_revision=identity.expected_database_revision,
            expected_oracle_manifest_digest=identity.expected_oracle_manifest_digest,
            task_contract_digest=get_task_contract_digest(),
            readiness_check=lambda: worker_main._worker_readiness_check(
                lane="background",
                settings=settings,
                expected_database_revision=identity.expected_database_revision,
            ),
            heartbeat_path=heartbeat_path,
            pid=os.getpid(),
        ).publish()

        assert not heartbeat_path.exists()
        with pytest.raises(WorkerHeartbeatError) as caught:
            check_worker_health(lane="background", heartbeat_path=heartbeat_path)
        assert caught.value.code == "heartbeat_invalid"
    finally:
        clear_settings_cache()
