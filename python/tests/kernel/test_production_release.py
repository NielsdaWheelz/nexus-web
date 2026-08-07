from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import signal
import stat
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from tests.testkit.host_release import (
    GENESIS_DEPLOYMENT_ID,
    HostReleaseHarness,
    record_genesis_vercel_deployment,
)

REPO_ROOT = Path(__file__).parents[3]
SOURCE_SHA = "1" * 40
NEXT_SHA = "2" * 40
IMAGE_DIGEST = "a" * 64
WORKER_DIGEST = "b" * 64
ORACLE_DIGEST = "c" * 64


def _decode_infrastructure_adoption_as_root(root: Path) -> subprocess.CompletedProcess[str]:
    release_path = str(REPO_ROOT / "deploy/hetzner/release.py")
    code = (
        "import importlib.util, sys; "
        "from pathlib import Path; "
        "spec = importlib.util.spec_from_file_location('nexus_release_decoder', "
        f"{release_path!r}); "
        "module = importlib.util.module_from_spec(spec); "
        "sys.modules[spec.name] = module; "
        "spec.loader.exec_module(module); "
        "module.ReleaseStore(module.ReleasePaths.under(Path(sys.argv[1])))."
        "completed_infrastructure_adoption(verify_backup=True)"
    )
    command = ("python3", "-B", "-c", code, str(root))
    environment = {"PYTHONPATH": str(REPO_ROOT / "python")}
    if os.geteuid() != 0:
        command = (
            "sudo",
            "--non-interactive",
            "env",
            *[f"{key}={value}" for key, value in environment.items()],
            *command,
        )
        return subprocess.run(command, capture_output=True, text=True)
    return subprocess.run(command, env=environment, capture_output=True, text=True)


def _release_module() -> ModuleType:
    path = REPO_ROOT / "deploy/hetzner/release.py"
    spec = importlib.util.spec_from_file_location("nexus_production_release", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _candidate(source_sha: str = SOURCE_SHA) -> dict[str, object]:
    return {
        "schema_version": 1,
        "source_sha": source_sha,
        "repository": "NielsdaWheelz/nexus-web",
        "source_ci_run_id": 17,
        "source_ci_run_attempt": 1,
        "source_ci_workflow_id": 16,
        "publisher_run_id": 18,
        "publisher_run_attempt": 1,
        "images": {
            "api": f"ghcr.io/nielsdawheelz/nexus-api@sha256:{IMAGE_DIGEST}",
            "worker": f"ghcr.io/nielsdawheelz/nexus-worker@sha256:{WORKER_DIGEST}",
        },
        "expected_database_revision": "0211",
        "expected_oracle_manifest_digest": f"sha256:{ORACLE_DIGEST}",
    }


def _write_candidate(path: Path, value: dict[str, object] | None = None) -> Path:
    path.write_text(
        json.dumps(value or _candidate(), ensure_ascii=True, separators=(",", ":"), sort_keys=True)
        + "\n",
        encoding="utf-8",
    )
    return path


def _prepared(
    module: ModuleType,
    source_sha: str = SOURCE_SHA,
    *,
    deployment_id: str = "dpl_1234567890",
    forward_fix_of: str | None = None,
    now: str = "2026-08-06T12:00:00Z",
    predecessor_sha: str | None = None,
):
    return module.ReleaseAttempt.prepared(
        source_sha=source_sha,
        manifest_sha256="d" * 64,
        candidate_api_image_id="sha256:" + "8" * 64,
        candidate_worker_image_id="sha256:" + "9" * 64,
        predecessor_sha=predecessor_sha,
        forward_fix_of=forward_fix_of,
        containers={
            service: module.ContainerEvidence(
                container_id=character * 64,
                image=f"example.invalid/{service}@sha256:{character * 64}",
                config_sha256=character * 64,
            )
            for service, character in (
                ("postgres", "3"),
                ("caddy", "4"),
                ("api", "5"),
                ("worker-interactive", "6"),
                ("worker-background", "7"),
            )
        },
        config_path="/etc/nexus/config/" + "e" * 64 + ".env",
        config_sha256="e" * 64,
        vercel_deployment_id=deployment_id,
        production_host="nexus.example.test",
        now=now,
    )


def _host_harness(tmp_path: Path) -> HostReleaseHarness:
    return HostReleaseHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        candidate=_candidate(),
    )


def _stored_attempt(module: ModuleType, tmp_path: Path):
    return module.ReleaseStore(module.ReleasePaths.under(tmp_path)).load_attempt(SOURCE_SHA)


@pytest.fixture
def host_release_harness(tmp_path: Path) -> Iterator[HostReleaseHarness]:
    with _host_harness(tmp_path) as harness:
        yield harness


def test_host_apply_uses_verified_backup_and_migration_then_activates_only_apps(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    tmp_path = harness.root

    completed = harness.run_apply()

    assert completed.returncode == 0, completed.stderr
    attempt = _stored_attempt(release, tmp_path)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.AwaitingFrontendPromotion
    assert attempt.backup is not None
    backup = Path(attempt.backup.path)
    backup_bytes = subprocess.run(
        ("sudo", "--non-interactive", "cat", "--", str(backup)),
        check=True,
        capture_output=True,
    ).stdout
    metadata = subprocess.run(
        ("sudo", "--non-interactive", "stat", "--format=%u:%g:%a:%s", "--", str(backup)),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert backup_bytes == b"fake-postgres-custom-backup\n"
    assert metadata == f"0:0:400:{len(backup_bytes)}"
    assert attempt.backup.byte_count == len(backup_bytes)
    assert attempt.backup.sha256 == hashlib.sha256(backup_bytes).hexdigest()

    state = harness.state()
    assert state["database_revision"] == "0211"
    assert state["backup_dump_count"] == 1
    assert state["backup_verify_count"] == 2
    assert state["migration_count"] == 1
    assert state["jobs"] == {}
    assert state["ancestry_proofs"] == [
        {
            "candidate_head": "0211",
            "current_revision": "0210",
            "heads": ["0211"],
            "is_ancestor": True,
        },
        {
            "candidate_head": "0211",
            "current_revision": "0210",
            "heads": ["0211"],
            "is_ancestor": True,
        },
    ]
    assert state["service_mutations"] == [
        {
            "operation": "stop",
            "services": ["api", "worker-interactive", "worker-background"],
        },
        {
            "operation": "up",
            "services": ["api", "worker-interactive", "worker-background"],
        },
    ]
    assert not tuple(release.ReleasePaths.under(tmp_path).state_root.rglob("*.partial"))


def test_host_apply_treats_the_adoption_source_as_provenance(
    tmp_path: Path,
) -> None:
    with HostReleaseHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        candidate=_candidate(),
        adoption_source_sha=NEXT_SHA,
    ) as harness:
        completed = harness.run_apply()

        assert completed.returncode == 0, completed.stderr
        release = _release_module()
        attempt = _stored_attempt(release, tmp_path)
        assert attempt is not None
        assert attempt.phase is release.ReleasePhase.AwaitingFrontendPromotion


def test_host_apply_rejects_different_adopted_inputs(tmp_path: Path) -> None:
    with HostReleaseHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        candidate=_candidate(),
        adoption_compose_bytes=b"name: different\n",
    ) as harness:
        failed = harness.run_apply()

        assert failed.returncode != 0
        assert "differs from the adopted infrastructure" in failed.stderr
        assert not harness.attempt_path.exists()
        assert harness.state()["service_mutations"] == []


def test_host_apply_rejects_a_nonterminal_infrastructure_adoption(
    tmp_path: Path,
) -> None:
    with HostReleaseHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        candidate=_candidate(),
        infrastructure_adoption_complete=False,
    ) as harness:
        failed = harness.run_apply()

        assert failed.returncode != 0
        assert "infrastructure adoption is nonterminal" in failed.stderr
        assert not harness.attempt_path.exists()
        assert harness.state()["service_mutations"] == []


def test_host_apply_rejects_writable_adopted_caddy_input(tmp_path: Path) -> None:
    with _host_harness(tmp_path) as harness:
        caddy = harness.root / "etc/nexus/Caddyfile"
        subprocess.run(
            ("sudo", "--non-interactive", "chmod", "0644", str(caddy)),
            check=True,
            capture_output=True,
        )

        failed = harness.run_apply()

        assert failed.returncode != 0
        assert "installed Caddy configuration differs" in failed.stderr
        assert not harness.attempt_path.exists()
        assert harness.state()["service_mutations"] == []


@pytest.mark.parametrize(
    ("table_exists", "database_revision"),
    [(False, "0210"), (True, None)],
    ids=("absent-table", "zero-row-table"),
)
def test_host_apply_rejects_unversioned_database_before_creating_an_attempt(
    host_release_harness: HostReleaseHarness,
    table_exists: bool,
    database_revision: str | None,
) -> None:
    harness = host_release_harness
    harness.update_state(
        alembic_table_exists=table_exists,
        database_revision=database_revision,
    )

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "database must expose one Alembic revision" in failed.stderr
    assert not harness.attempt_path.exists()
    state = harness.state()
    assert state["ancestry_proofs"] == []
    assert state["backup_dump_count"] == 0
    assert state["migration_count"] == 0
    assert state["service_mutations"] == []


def test_host_apply_stabilizes_candidate_health_beyond_the_outer_retry_delay(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    harness.update_state(
        candidate_health_failure_delay_seconds=0.75,
        candidate_health_failures_remaining=3,
    )

    completed = harness.run_apply()

    assert completed.returncode == 0, completed.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.AwaitingFrontendPromotion
    state = harness.state()
    assert state["candidate_health_probe_count"] >= 4
    assert state["candidate_health_failures_remaining"] == 0
    assert state["candidate_health_wait_seconds"] > 2


def test_host_apply_bounds_candidate_health_stabilization_and_requires_forward_fix(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    harness.update_state(candidate_health_failures_remaining=-1)

    failed = harness.run_apply()

    assert failed.returncode != 0
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired
    assert attempt.failure_code == "external-exhausted"
    assert (
        release.ReleaseStore(release.ReleasePaths.under(harness.root)).forward_fix_sha()
        == SOURCE_SHA
    )
    assert 2 <= harness.state()["candidate_health_probe_count"] <= 30


def test_host_apply_keeps_independent_retry_budgets_for_distinct_operations(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    harness.update_state(
        operation_failures_remaining={
            "backend-api-version": 1,
            "backend-compose-up": 1,
        }
    )

    completed = harness.run_apply()

    assert completed.returncode == 0, completed.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.AwaitingFrontendPromotion
    assert harness.state()["operation_failure_count"] == {
        "backend-api-version": 1,
        "backend-compose-up": 1,
    }


def test_host_apply_rejects_a_runtime_identical_but_different_activated_image(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    harness.update_state(activation_api_image_id="sha256:" + "c" * 64)

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "API container image differs from candidate digest" in failed.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired


def test_host_apply_exhausts_retry_budget_for_the_same_semantic_operation(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    harness.update_state(
        operation_failures_remaining={"backend-api-version": 2},
    )

    failed = harness.run_apply()

    assert failed.returncode != 0
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired
    assert attempt.failure_code == "external-exhausted"
    assert harness.state()["operation_failure_count"] == {"backend-api-version": 2}


def test_host_finalize_proves_public_tls_and_publishes_record_and_current(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    applied = harness.run_apply()
    assert applied.returncode == 0, applied.stderr

    finalized = harness.run_finalize()

    assert finalized.returncode == 0, finalized.stderr
    store = release.ReleaseStore(release.ReleasePaths.under(harness.root))
    attempt = store.load_attempt(SOURCE_SHA)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.Succeeded
    assert store.current_sha() == SOURCE_SHA
    record = store.load_record(SOURCE_SHA)
    assert record is not None
    assert record.vercel_deployment_id == "dpl_Test123"
    assert harness.state()["public_requests"] == [
        {"host": host, "path": path}
        for _proof in range(2)
        for host, path in (
            ("web.example.test", "/version"),
            ("api.example.test", "/version"),
            ("api.example.test", "/readyz"),
        )
    ]


@pytest.mark.parametrize(
    ("mode", "message"),
    [
        (
            "different-task-digest",
            "public API identity differs from candidate",
        ),
        (
            "extra-outer-key",
            "public API version fields are not closed",
        ),
        (
            "extra-inner-key",
            "public API version data fields are not closed",
        ),
        ("redirect", "public proof redirected"),
        ("cacheable", "API version response is cacheable"),
    ],
)
def test_host_finalize_rejects_public_api_contract_drift(
    host_release_harness: HostReleaseHarness,
    mode: str,
    message: str,
) -> None:
    release = _release_module()
    harness = host_release_harness
    applied = harness.run_apply()
    assert applied.returncode == 0, applied.stderr
    harness.update_state(public_api_mode=mode)

    failed = harness.run_finalize()

    assert failed.returncode != 0
    assert message in failed.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired
    assert attempt.failure_code == "candidate-invariant"
    store = release.ReleaseStore(release.ReleasePaths.under(harness.root))
    assert store.forward_fix_sha() == SOURCE_SHA
    assert store.assert_candidate_admissible(NEXT_SHA) is None
    for service in ("api", "worker-interactive", "worker-background"):
        assert harness.state()["containers"][service]["running"] is False
    assert harness.state()["public_requests"][:2] == [
        {"host": "web.example.test", "path": "/version"},
        {"host": "api.example.test", "path": "/version"},
    ]


@pytest.mark.parametrize(
    "phase",
    [
        "Prepared",
        "WritersStopped",
        "BackupVerified",
        "DataMutationStarted",
        "BackendActivationStarted",
        "AwaitingFrontendPromotion",
    ],
)
def test_host_apply_replays_every_durable_phase_after_process_death(
    host_release_harness: HostReleaseHarness,
    phase: str,
) -> None:
    release = _release_module()
    harness = host_release_harness
    tmp_path = harness.root

    interrupted = harness.run_apply(interrupt_phase=phase)

    assert interrupted.returncode == -signal.SIGKILL, (
        f"expected process death at {phase}; stdout={interrupted.stdout!r}; "
        f"stderr={interrupted.stderr!r}"
    )
    persisted = _stored_attempt(release, tmp_path)
    assert persisted is not None
    assert persisted.phase.value == phase

    replayed = harness.run_apply(interrupt_phase=phase)

    assert replayed.returncode == 0, replayed.stderr
    completed = _stored_attempt(release, tmp_path)
    assert completed is not None
    assert completed.phase is release.ReleasePhase.AwaitingFrontendPromotion
    state = harness.state()
    assert state["database_revision"] == "0211"
    assert state["migration_count"] == 1
    assert state["jobs"] == {}
    assert not tuple(release.ReleasePaths.under(tmp_path).state_root.rglob("*.partial"))


@pytest.mark.parametrize("missing_service", ("api", "worker-interactive", "worker-background"))
def test_bound_frontend_failure_settles_partial_activation_with_a_missing_writer(
    host_release_harness: HostReleaseHarness,
    missing_service: str,
) -> None:
    release = _release_module()
    harness = host_release_harness
    interrupted = harness.run_apply(interrupt_phase="BackendActivationStarted")
    assert interrupted.returncode == -signal.SIGKILL
    persisted = _stored_attempt(release, harness.root)
    assert persisted is not None
    assert persisted.phase is release.ReleasePhase.BackendActivationStarted
    harness.update_state(missing_services=[missing_service])

    settled = harness.run_fail_bound_frontend()

    assert settled.returncode == 0, settled.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired
    assert attempt.failure_code == "bound-frontend-unavailable"
    store = release.ReleaseStore(release.ReleasePaths.under(harness.root))
    assert store.forward_fix_sha() == SOURCE_SHA
    assert store.assert_candidate_admissible(NEXT_SHA) is None
    state = harness.state()
    for service in ("api", "worker-interactive", "worker-background"):
        if service != missing_service:
            assert state["containers"][service]["running"] is False


def test_host_apply_recovers_a_completed_migration_side_effect_without_reapplying_it(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    tmp_path = harness.root

    interrupted = harness.run_apply(interrupt_after_migration=True)

    assert interrupted.returncode == -signal.SIGKILL
    persisted = _stored_attempt(release, tmp_path)
    assert persisted is not None
    assert persisted.phase is release.ReleasePhase.DataMutationStarted
    assert harness.state()["database_revision"] == "0211"

    replayed = harness.run_apply(interrupt_after_migration=True)

    assert replayed.returncode == 0, replayed.stderr
    completed = _stored_attempt(release, tmp_path)
    assert completed is not None
    assert completed.phase is release.ReleasePhase.AwaitingFrontendPromotion
    state = harness.state()
    assert state["migration_count"] == 1
    assert state["jobs"] == {}


@pytest.mark.parametrize(
    ("failure_phase", "terminal_phase", "writers_running", "has_forward_fix"),
    [
        ("BackupVerified", "RolledBack", True, False),
        ("DataMutationStarted", "ForwardFixRequired", False, True),
    ],
)
def test_host_apply_exhausted_external_failure_rolls_back_only_before_commitment(
    host_release_harness: HostReleaseHarness,
    failure_phase: str,
    terminal_phase: str,
    writers_running: bool,
    has_forward_fix: bool,
) -> None:
    release = _release_module()
    harness = host_release_harness
    tmp_path = harness.root

    failed = harness.run_apply(failure_phase=failure_phase)

    assert failed.returncode != 0
    attempt = _stored_attempt(release, tmp_path)
    assert attempt is not None
    assert attempt.phase.value == terminal_phase
    assert attempt.failure_code == "external-exhausted"
    store = release.ReleaseStore(release.ReleasePaths.under(tmp_path))
    assert (store.forward_fix_sha() == SOURCE_SHA) is has_forward_fix
    state = harness.state()
    assert state["failure_count"] == 2
    for service in ("api", "worker-interactive", "worker-background"):
        assert state["containers"][service]["running"] is writers_running


def test_first_release_successor_after_rollback_reproves_adoption_invariants(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    failed = harness.run_apply(failure_phase="BackupVerified")
    assert failed.returncode != 0
    first = _stored_attempt(release, harness.root)
    assert first is not None and first.phase is release.ReleasePhase.RolledBack

    successor_sha = harness.install_candidate(_candidate(NEXT_SHA))
    state = harness.state()
    containers = state["containers"]
    assert isinstance(containers, dict)
    api = containers["api"]
    assert isinstance(api, dict)
    adopted_container_id = api["id"]
    api["id"] = "f" * 64
    harness.update_state(containers=containers)

    rejected = harness.run_apply(source_sha=successor_sha)

    assert rejected.returncode != 0
    assert "differs from infrastructure adoption" in rejected.stderr
    successor_attempt = release.ReleasePaths.under(harness.root).attempts / f"{successor_sha}.json"
    assert not successor_attempt.exists()

    api["id"] = adopted_container_id
    harness.update_state(containers=containers)
    completed = harness.run_apply(source_sha=successor_sha)

    assert completed.returncode == 0, completed.stderr
    successor = release.ReleaseStore(release.ReleasePaths.under(harness.root)).load_attempt(
        successor_sha
    )
    assert successor is not None
    assert successor.phase is release.ReleasePhase.AwaitingFrontendPromotion
    assert successor.forward_fix_of is None


def test_first_release_forward_fix_accepts_advanced_schema_and_stopped_writers(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    store = release.ReleaseStore(release.ReleasePaths.under(harness.root))
    first = _prepared(release)
    store.create_attempt(first)
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
        release.ReleasePhase.ForwardFixPending,
        release.ReleasePhase.ForwardFixRequired,
    ):
        first = first.advance(
            phase,
            now="2026-08-06T12:01:00Z",
            failure_code=(
                "candidate-invariant"
                if phase
                in {
                    release.ReleasePhase.ForwardFixPending,
                    release.ReleasePhase.ForwardFixRequired,
                }
                else None
            ),
        )
        store.replace_attempt(first)
    store.set_forward_fix(SOURCE_SHA)
    state = harness.state()
    containers = state["containers"]
    assert isinstance(containers, dict)
    for service in ("api", "worker-interactive", "worker-background"):
        container = containers[service]
        assert isinstance(container, dict)
        container["running"] = False
        if service == "api":
            container["image_id"] = state["api_image_id"]
            container["config"]["Image"] = state["api_image"]
        else:
            container["image_id"] = state["worker_image_id"]
            container["config"]["Image"] = state["worker_image"]
    harness.update_state(containers=containers, database_revision="0211")

    successor_sha = harness.install_candidate(_candidate(NEXT_SHA))
    completed = harness.run_apply(source_sha=successor_sha)

    assert completed.returncode == 0, completed.stderr
    successor = store.load_attempt(successor_sha)
    assert successor is not None
    assert successor.phase is release.ReleasePhase.AwaitingFrontendPromotion
    assert successor.forward_fix_of == SOURCE_SHA


def test_host_apply_replays_durable_rollback_intent_after_process_death(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness

    interrupted = harness.run_apply(
        failure_phase="BackupVerified",
        interrupt_phase="RollbackRequired",
    )

    assert interrupted.returncode == -signal.SIGKILL
    persisted = _stored_attempt(release, harness.root)
    assert persisted is not None
    assert persisted.phase is release.ReleasePhase.RollbackRequired
    assert persisted.failure_code == "external-exhausted"

    replayed = harness.run_apply(
        failure_phase="BackupVerified",
        interrupt_phase="RollbackRequired",
    )

    assert replayed.returncode != 0
    completed = _stored_attempt(release, harness.root)
    assert completed is not None
    assert completed.phase is release.ReleasePhase.RolledBack
    assert completed.failure_code == "external-exhausted"
    for service in ("api", "worker-interactive", "worker-background"):
        assert harness.state()["containers"][service]["running"] is True


def test_host_apply_publishes_forward_fix_intent_before_stopping_writers(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness

    interrupted = harness.run_apply(
        failure_phase="DataMutationStarted",
        interrupt_during_forward_fix_stop=True,
    )

    assert interrupted.returncode == -signal.SIGKILL
    persisted = _stored_attempt(release, harness.root)
    assert persisted is not None
    assert persisted.phase is release.ReleasePhase.ForwardFixPending
    assert persisted.failure_code == "external-exhausted"
    store = release.ReleaseStore(release.ReleasePaths.under(harness.root))
    assert store.forward_fix_sha() == SOURCE_SHA

    replayed = harness.run_apply(
        failure_phase="DataMutationStarted",
        interrupt_during_forward_fix_stop=True,
    )

    assert replayed.returncode != 0
    completed = _stored_attempt(release, harness.root)
    assert completed is not None
    assert completed.phase is release.ReleasePhase.ForwardFixRequired
    state = harness.state()
    for service in ("api", "worker-interactive", "worker-background"):
        assert state["containers"][service]["running"] is False


def test_candidate_manifest_accepts_only_the_exact_digest_contract(tmp_path: Path) -> None:
    release = _release_module()
    path = _write_candidate(tmp_path / "candidate.json")

    candidate = release.load_candidate_manifest(path)

    assert candidate.source_sha == SOURCE_SHA
    assert candidate.images.api.endswith("@sha256:" + IMAGE_DIGEST)
    assert candidate.images.worker.endswith("@sha256:" + WORKER_DIGEST)

    malformed = _candidate()
    malformed["unexpected"] = True
    _write_candidate(path, malformed)
    with pytest.raises(release.ReleaseDefect, match="candidate manifest fields"):
        release.load_candidate_manifest(path)

    mutable = _candidate()
    images = dict(mutable["images"])
    images["api"] = "ghcr.io/nielsdawheelz/nexus-api:latest"
    mutable["images"] = images
    _write_candidate(path, mutable)
    with pytest.raises(release.ReleaseDefect, match="api image"):
        release.load_candidate_manifest(path)


def test_attempt_union_rejects_skips_and_closes_rollback_at_either_commitment() -> None:
    release = _release_module()
    prepared = _prepared(release)

    with pytest.raises(release.ReleaseDefect, match="transition"):
        prepared.advance(release.ReleasePhase.AwaitingFrontendPromotion, now="2026-08-06T12:01:00Z")

    writers_stopped = prepared.advance(
        release.ReleasePhase.WritersStopped,
        now="2026-08-06T12:01:00Z",
    )
    backup_verified = writers_stopped.with_backup(
        path="/var/backups/nexus/1.dump",
        sha256="8" * 64,
        byte_count=42,
        database_identity="nexus-prod",
        starting_revision="0210",
        now="2026-08-06T12:02:00Z",
    )
    data_mutating = backup_verified.advance(
        release.ReleasePhase.DataMutationStarted,
        now="2026-08-06T12:03:00Z",
    )
    direct_activation = writers_stopped.advance(
        release.ReleasePhase.BackendActivationStarted,
        now="2026-08-06T12:02:00Z",
    )

    assert (
        release.permanent_failure_phase(writers_stopped.phase, forward_fix=False)
        is release.ReleasePhase.RollbackRequired
    )
    assert (
        release.permanent_failure_phase(data_mutating.phase, forward_fix=False)
        is release.ReleasePhase.ForwardFixPending
    )
    assert (
        release.permanent_failure_phase(direct_activation.phase, forward_fix=False)
        is release.ReleasePhase.ForwardFixPending
    )

    forward_fix_pending = prepared.advance(
        release.ReleasePhase.ForwardFixPending,
        now="2026-08-06T12:04:00Z",
        failure_code="candidate-invariant",
    )
    forward_fix_failure = forward_fix_pending.advance(
        release.ReleasePhase.ForwardFixRequired,
        now="2026-08-06T12:05:00Z",
        failure_code="candidate-invariant",
    )
    assert forward_fix_failure.phase is release.ReleasePhase.ForwardFixRequired
    assert (
        release.permanent_failure_phase(prepared.phase, forward_fix=True)
        is release.ReleasePhase.ForwardFixPending
    )


def test_store_serializes_active_attempts_and_recovers_publication_prefix(tmp_path: Path) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    store = release.ReleaseStore(paths)
    prepared = _prepared(release)
    store.create_attempt(prepared)

    with pytest.raises(release.ReleaseBlocked, match=SOURCE_SHA):
        store.assert_candidate_admissible(NEXT_SHA)

    attempt = prepared
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
        release.ReleasePhase.AwaitingFrontendPromotion,
        release.ReleasePhase.FrontendPromoted,
    ):
        attempt = attempt.advance(phase, now="2026-08-06T12:05:00Z")
        store.replace_attempt(attempt)

    record = release.ReleaseRecord.from_attempt(
        attempt=attempt,
        candidate=release.load_candidate_manifest(_write_candidate(tmp_path / "candidate.json")),
        api_image_id="sha256:" + "9" * 64,
        worker_image_id="sha256:" + "a" * 64,
        verified_at="2026-08-06T12:06:00Z",
    )
    store.create_record(record)
    store = release.ReleaseStore(paths)
    assert store.current_sha() is None
    assert store.load_record(SOURCE_SHA) == record
    store.create_record(record)
    store.set_current(SOURCE_SHA)

    store = release.ReleaseStore(paths)
    assert store.current_sha() == SOURCE_SHA
    assert store.load_attempt(SOURCE_SHA) == attempt

    recovered = store.complete_published_attempt(SOURCE_SHA, now="2026-08-06T12:07:00Z")

    assert recovered.phase is release.ReleasePhase.Succeeded
    assert store.current_sha() == SOURCE_SHA
    assert store.load_record(SOURCE_SHA) == record
    assert not tuple(store.paths.state_root.rglob("*.partial"))


def test_first_release_requires_completed_infrastructure_adoption(
    tmp_path: Path,
) -> None:
    release = _release_module()
    store = release.ReleaseStore(release.ReleasePaths.under(tmp_path))

    with pytest.raises(release.ReleaseBlocked, match="infrastructure adoption is not complete"):
        store.require_infrastructure_adoption()


@pytest.mark.parametrize(
    "mutation",
    (
        "unknown-field",
        "missing-writer-evidence",
        "missing-replacement",
        "mutable-infrastructure-image",
        "unordered-mounts",
        "noninteger-table-count",
        "different-backup-hash",
    ),
)
def test_infrastructure_adoption_decoder_rejects_closed_schema_drift(
    tmp_path: Path,
    mutation: str,
) -> None:
    def mutate(attempt: dict[str, Any]) -> None:
        if mutation == "unknown-field":
            attempt["unsupported"] = True
        elif mutation == "missing-writer-evidence":
            del attempt["containers"]["api"]["image_id"]
        elif mutation == "missing-replacement":
            del attempt["replacement_containers"]["caddy"]
        elif mutation == "mutable-infrastructure-image":
            attempt["infra_image_references"]["postgres"] = "postgres:latest"
        elif mutation == "unordered-mounts":
            attempt["named_mounts"]["caddy"].reverse()
        elif mutation == "noninteger-table-count":
            attempt["database"]["table_counts"]["users"] = True
        else:
            attempt["backup"]["sha256"] = "0" * 64

    with HostReleaseHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        candidate=_candidate(),
        adoption_mutation=mutate,
    ) as harness:
        completed = _decode_infrastructure_adoption_as_root(harness.root)

        assert completed.returncode != 0
        assert "infrastructure adoption" in completed.stderr


@pytest.mark.parametrize(
    ("relative", "mode"),
    (
        (
            f"var/lib/nexus/infra-adoption/{SOURCE_SHA}/inputs/docker-compose.yml",
            "0644",
        ),
        (f"var/backups/nexus/infra-adoption/{SOURCE_SHA}.dump", "0440"),
    ),
)
def test_infrastructure_adoption_decoder_rejects_mutable_retained_evidence(
    tmp_path: Path,
    relative: str,
    mode: str,
) -> None:
    with _host_harness(tmp_path) as harness:
        subprocess.run(
            ("sudo", "--non-interactive", "chmod", mode, str(harness.root / relative)),
            check=True,
            capture_output=True,
        )
        completed = _decode_infrastructure_adoption_as_root(harness.root)

        assert completed.returncode != 0
        assert "infrastructure adoption" in completed.stderr


def test_nonterminal_infrastructure_adoption_blocks_config_publication(
    tmp_path: Path,
) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    attempt = paths.infrastructure_adoption_root / SOURCE_SHA / "attempt.json"
    attempt.parent.mkdir(parents=True)
    attempt.write_text("{}\n", encoding="utf-8")
    source = tmp_path / "source.env"
    source.write_text("NEXUS_ENV=prod\n", encoding="utf-8")

    with pytest.raises(release.ReleaseBlocked, match="infrastructure adoption is nonterminal"):
        release.publish_config(source, release.ReleaseStore(paths), next_source_sha=SOURCE_SHA)

    assert not paths.current_config.exists()


def test_config_publication_creates_an_immutable_content_addressed_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    source = tmp_path / "source.env"
    source.write_text("ZETA=last\nALPHA=first\n", encoding="utf-8")

    digest = release.publish_config(
        source,
        release.ReleaseStore(paths),
        next_source_sha=SOURCE_SHA,
    )

    snapshot = paths.config_root / f"{digest}.env"
    assert snapshot.read_bytes() == b"ALPHA=first\nZETA=last\n"
    assert stat.S_IMODE(snapshot.stat().st_mode) == 0o440
    assert paths.current_config.resolve(strict=True) == snapshot.resolve(strict=True)

    snapshot.chmod(0o640)
    with pytest.raises(release.ReleaseDefect, match="not exact immutable input"):
        release.publish_config(
            source,
            release.ReleaseStore(paths),
            next_source_sha=SOURCE_SHA,
        )

    snapshot.chmod(0o440)
    with monkeypatch.context() as context:
        context.setattr(release.os, "geteuid", lambda: snapshot.stat().st_uid + 1)
        with pytest.raises(release.ReleaseDefect, match="not exact immutable input"):
            release.publish_config(
                source,
                release.ReleaseStore(paths),
                next_source_sha=SOURCE_SHA,
            )


def test_completed_adoption_freezes_config_until_the_first_release(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    store = release.ReleaseStore(paths)
    source = tmp_path / "source.env"
    source.write_text("NEXUS_ENV=prod\n", encoding="utf-8")
    monkeypatch.setattr(store, "infrastructure_adoption_source", lambda: SOURCE_SHA)
    monkeypatch.setattr(store, "current_sha", lambda: None)

    with pytest.raises(release.ReleaseBlocked, match="first-release config is immutable"):
        release.publish_config(source, store, next_source_sha=SOURCE_SHA)

    assert not paths.current_config.exists()


def test_missing_adoption_blocks_config_when_release_history_exists(tmp_path: Path) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    paths.records.mkdir(parents=True)
    (paths.records / f"{SOURCE_SHA}.json").write_text("{}\n", encoding="utf-8")
    source = tmp_path / "source.env"
    source.write_text("NEXUS_ENV=prod\n", encoding="utf-8")

    with pytest.raises(release.ReleaseBlocked, match="adoption evidence is missing"):
        release.publish_config(source, release.ReleaseStore(paths), next_source_sha=NEXT_SHA)

    assert not paths.current_config.exists()


def test_inspect_resumes_when_current_publication_prefix_is_not_terminal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    store = release.ReleaseStore(paths)
    record_genesis_vercel_deployment(tmp_path, GENESIS_DEPLOYMENT_ID)
    attempt = _prepared(release)
    store.create_attempt(attempt)
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
        release.ReleasePhase.AwaitingFrontendPromotion,
        release.ReleasePhase.FrontendPromoted,
    ):
        attempt = attempt.advance(phase, now="2026-08-06T12:05:00Z")
        store.replace_attempt(attempt)
    record = release.ReleaseRecord.from_attempt(
        attempt=attempt,
        candidate=release.load_candidate_manifest(_write_candidate(tmp_path / "candidate.json")),
        api_image_id="sha256:" + "9" * 64,
        worker_image_id="sha256:" + "a" * 64,
        verified_at="2026-08-06T12:06:00Z",
    )
    store.create_record(record)
    store.set_current(SOURCE_SHA)
    monkeypatch.setattr(release, "ReleasePaths", lambda: paths)
    monkeypatch.setattr(
        release.ReleaseStore,
        "require_infrastructure_adoption",
        lambda _store: {},
    )

    assert release.main(["inspect", "--source-sha", SOURCE_SHA]) == 0

    assert json.loads(capfd.readouterr().out) == {
        "current_sha": SOURCE_SHA,
        "current_vercel_deployment_id": "dpl_1234567890",
        "genesis_vercel_deployment_id": GENESIS_DEPLOYMENT_ID,
        "forward_fix_sha": None,
        "failed_vercel_deployment_ids": [],
        "phase": "FrontendPromoted",
        "predecessor_sha": None,
        "status": "resume",
        "vercel_deployment_id": "dpl_1234567890",
    }


def test_release_attempt_and_record_files_must_remain_canonical(tmp_path: Path) -> None:
    release = _release_module()
    store = release.ReleaseStore(release.ReleasePaths.under(tmp_path))
    attempt = _prepared(release)
    store.create_attempt(attempt)
    attempt_path = store.paths.attempts / f"{SOURCE_SHA}.json"
    attempt_path.write_text(json.dumps(attempt.as_json()), encoding="utf-8")

    with pytest.raises(release.ReleaseDefect, match="canonical JSON"):
        store.load_attempt(SOURCE_SHA)


def test_forward_fix_pointer_survives_failed_successor_and_clears_only_on_success(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    store = release.ReleaseStore(paths)
    record_genesis_vercel_deployment(tmp_path, GENESIS_DEPLOYMENT_ID)
    monkeypatch.setattr(
        release.ReleaseStore,
        "require_infrastructure_adoption",
        lambda _store: {},
    )

    historical_sha = "0" * 40
    historical = _prepared(
        release,
        historical_sha,
        deployment_id="dpl_AAAAAAAAAA",
        now="2026-08-06T11:00:00Z",
    )
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
        release.ReleasePhase.ForwardFixPending,
    ):
        historical = historical.advance(
            phase,
            now="2026-08-06T11:01:00Z",
            failure_code=(
                "candidate-invariant" if phase is release.ReleasePhase.ForwardFixPending else None
            ),
        )
    historical = historical.advance(
        release.ReleasePhase.ForwardFixRequired,
        now="2026-08-06T11:01:01Z",
        failure_code="candidate-invariant",
    )
    store.create_attempt(historical)
    store.set_forward_fix(historical_sha)

    historical_repair_sha = "f" * 40
    historical_repair = _prepared(
        release,
        historical_repair_sha,
        deployment_id="dpl_ARepair0000",
        forward_fix_of=historical_sha,
        now="2026-08-06T11:02:00Z",
    )
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
        release.ReleasePhase.AwaitingFrontendPromotion,
        release.ReleasePhase.FrontendPromoted,
        release.ReleasePhase.Succeeded,
    ):
        historical_repair = historical_repair.advance(
            phase,
            now="2026-08-06T11:03:00Z",
        )
    store.create_attempt(historical_repair)
    historical_repair_record = release.ReleaseRecord.from_attempt(
        attempt=historical_repair,
        candidate=release.load_candidate_manifest(
            _write_candidate(
                tmp_path / "historical-repair-candidate.json",
                _candidate(historical_repair_sha),
            )
        ),
        api_image_id="sha256:" + "9" * 64,
        worker_image_id="sha256:" + "a" * 64,
        verified_at="2026-08-06T11:03:01Z",
    )
    store.create_record(historical_repair_record)
    store.set_current(historical_repair_sha)
    store.clear_forward_fix_after_success(historical_repair_sha)

    failed_deployment_id = "dpl_BBBBBBBBBB"
    failed = _prepared(
        release,
        deployment_id=failed_deployment_id,
        predecessor_sha=historical_repair_sha,
    )
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
    ):
        failed = failed.advance(phase, now="2026-08-06T12:01:00Z")
    failed = failed.advance(
        release.ReleasePhase.ForwardFixPending,
        now="2026-08-06T12:01:00Z",
        failure_code="candidate-invariant",
    )
    failed = failed.advance(
        release.ReleasePhase.ForwardFixRequired,
        now="2026-08-06T12:01:01Z",
        failure_code="candidate-invariant",
    )
    store.create_attempt(failed)
    store.set_forward_fix(SOURCE_SHA)

    assert store.forward_fix_sha() == SOURCE_SHA
    store.clear_forward_fix_after_success(historical_repair_sha)
    assert store.forward_fix_sha() == SOURCE_SHA
    assert store.assert_candidate_admissible(NEXT_SHA) is None

    successor_deployment_id = "dpl_CCCCCCCCCC"
    successor = _prepared(
        release,
        NEXT_SHA,
        deployment_id=successor_deployment_id,
        forward_fix_of=SOURCE_SHA,
        predecessor_sha=historical_repair_sha,
    )
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
        release.ReleasePhase.AwaitingFrontendPromotion,
        release.ReleasePhase.FrontendPromoted,
        release.ReleasePhase.ForwardFixPending,
    ):
        successor = successor.advance(
            phase,
            now="2026-08-06T12:02:00Z",
            failure_code=(
                "candidate-invariant" if phase is release.ReleasePhase.ForwardFixPending else None
            ),
        )
    successor = successor.advance(
        release.ReleasePhase.ForwardFixRequired,
        now="2026-08-06T12:02:00Z",
        failure_code="candidate-invariant",
    )
    store.create_attempt(successor)

    assert store.forward_fix_sha() == SOURCE_SHA

    final_sha = "3" * 40
    assert store.assert_candidate_admissible(final_sha) is None
    monkeypatch.setattr(release, "ReleasePaths", lambda: paths)
    assert release.main(["inspect", "--source-sha", final_sha]) == 0
    assert json.loads(capfd.readouterr().out) == {
        "current_sha": historical_repair_sha,
        "current_vercel_deployment_id": historical_repair.vercel_deployment_id,
        "genesis_vercel_deployment_id": GENESIS_DEPLOYMENT_ID,
        "failed_vercel_deployment_ids": [
            failed_deployment_id,
            successor_deployment_id,
        ],
        "forward_fix_sha": SOURCE_SHA,
        "phase": None,
        "predecessor_sha": None,
        "status": "new",
        "vercel_deployment_id": None,
    }

    final = _prepared(
        release,
        final_sha,
        deployment_id="dpl_DDDDDDDDDD",
        forward_fix_of=SOURCE_SHA,
        predecessor_sha=historical_repair_sha,
    )
    store.create_attempt(final)
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
        release.ReleasePhase.AwaitingFrontendPromotion,
        release.ReleasePhase.FrontendPromoted,
        release.ReleasePhase.Succeeded,
    ):
        final = final.advance(phase, now="2026-08-06T12:03:00Z")
        store.replace_attempt(final)
    final_record = release.ReleaseRecord.from_attempt(
        attempt=final,
        candidate=release.load_candidate_manifest(
            _write_candidate(
                tmp_path / "final-candidate.json",
                _candidate(final_sha),
            )
        ),
        api_image_id="sha256:" + "9" * 64,
        worker_image_id="sha256:" + "a" * 64,
        verified_at="2026-08-06T12:03:01Z",
    )
    store.create_record(final_record)
    store.set_current(final_sha)
    store.clear_forward_fix_after_success(final.source_sha)

    assert store.forward_fix_sha() is None
    store.clear_forward_fix_after_success(final.source_sha)
    assert store.forward_fix_sha() is None
    next_sha = "4" * 40
    assert store.assert_candidate_admissible(next_sha) is None
    assert release.main(["inspect", "--source-sha", next_sha]) == 0
    assert json.loads(capfd.readouterr().out)["failed_vercel_deployment_ids"] == []
