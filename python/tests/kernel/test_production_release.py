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

import pytest

from tests.testkit.host_release import (
    CURRENT_SHA,
    HostReleaseHarness,
)

REPO_ROOT = Path(__file__).parents[3]
SOURCE_SHA = "1" * 40
NEXT_SHA = "2" * 40
IMAGE_DIGEST = "a" * 64
WORKER_DIGEST = "b" * 64
ORACLE_DIGEST = "c" * 64


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
        "expected_database_revision": "0215",
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
    predecessor_sha: str | None = CURRENT_SHA,
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


def _set_owner(path: Path, uid: int, gid: int) -> None:
    if os.geteuid() == 0:
        os.chown(path, uid, gid)
        return
    subprocess.run(
        ("sudo", "--non-interactive", "chown", f"{uid}:{gid}", "--", str(path)),
        check=True,
        capture_output=True,
    )


def _set_mode(path: Path, mode: int) -> None:
    if os.geteuid() == 0:
        path.chmod(mode)
        return
    subprocess.run(
        ("sudo", "--non-interactive", "chmod", f"{mode:o}", "--", str(path)),
        check=True,
        capture_output=True,
    )


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
    assert state["database_revision"] == "0215"
    assert state["backup_dump_count"] == 1
    assert state["backup_verify_count"] == 2
    assert state["migration_count"] == 1
    assert state["jobs"] == {}
    assert state["ancestry_proofs"] == [
        {
            "candidate_head": "0215",
            "current_revision": "0210",
            "heads": ["0215"],
            "is_ancestor": True,
        },
        {
            "candidate_head": "0215",
            "current_revision": "0210",
            "heads": ["0215"],
            "is_ancestor": True,
        },
    ]
    assert state["service_mutations"] == [
        {
            "operation": "stop",
            "services": ["worker-background"],
        },
        {
            "operation": "stop",
            "services": ["worker-interactive", "api"],
        },
        {
            "operation": "up",
            "services": ["api", "worker-interactive", "worker-background"],
        },
    ]
    assert not any("apps.worker.health" in " ".join(command) for command in state["commands"]), (
        "release proof must consume Docker's health receipt without forking another probe"
    )
    migration = next(
        command
        for command in state["commands"]
        if "run" in command and f"nexus-release-{SOURCE_SHA}-migration" in command
    )
    run = migration[migration.index("run") :]
    assert run[:6] == [
        "run",
        "--name",
        f"nexus-release-{SOURCE_SHA}-migration",
        "--no-deps",
        "--no-TTY",
        "migration",
    ]
    assert not tuple(release.ReleasePaths.under(tmp_path).state_root.rglob("*.partial"))


def test_host_apply_rejects_wrong_worker_health_identity_before_mutation(
    host_release_harness: HostReleaseHarness,
) -> None:
    harness = host_release_harness
    state = harness.state()
    state["containers"]["worker-interactive"]["health_output_override"] = json.dumps(
        {
            "expected_database_revision": "0210",
            "expected_oracle_manifest_digest": "sha256:" + "d" * 64,
            "lane": "interactive",
            "source_sha": "0" * 40,
            "status": "ready",
            "task_contract_digest": "f" * 64,
        },
        sort_keys=True,
    )
    harness.update_state(containers=state["containers"])

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "interactive worker runtime identity differs" in failed.stderr
    state = harness.state()
    assert state["resource_mutations"] == []
    assert state["service_mutations"] == []
    assert state["database_revision"] == "0210"
    assert state["backup_dump_count"] == 0
    assert state["backup_verify_count"] == 0
    assert state["migration_count"] == 0
    assert state["jobs"] == {}
    assert not harness.attempt_path.exists()


def test_host_apply_rejects_stale_worker_health_receipt_before_mutation(
    host_release_harness: HostReleaseHarness,
) -> None:
    harness = host_release_harness
    state = harness.state()
    state["containers"]["worker-interactive"]["health_end_override"] = (
        "2000-01-01T00:00:00.000000000Z"
    )
    harness.update_state(containers=state["containers"])

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "interactive worker health is not exact" in failed.stderr
    state = harness.state()
    assert state["database_revision"] == "0210"
    assert state["backup_dump_count"] == 0
    assert state["migration_count"] == 0
    assert state["resource_mutations"] == []
    assert state["service_mutations"] == []
    assert not harness.attempt_path.exists()


def test_docker_health_timestamp_accepts_rfc3339_numeric_offset() -> None:
    release = _release_module()

    with_offset = release._docker_timestamp_seconds(
        "2026-08-13T14:29:43.895095772-07:00",
        "worker health receipt end",
    )
    as_utc = release._docker_timestamp_seconds(
        "2026-08-13T21:29:43.895095772Z",
        "worker health receipt end",
    )

    assert with_offset == pytest.approx(as_utc)


@pytest.mark.parametrize(
    ("relative_path", "contents", "message"),
    [
        (
            "proc/meminfo",
            "MemTotal: 2097152 kB\nMemAvailable: 262143 kB\nSwapTotal: 1048576 kB\n",
            "available memory",
        ),
        (
            "proc/meminfo",
            "MemTotal: 2097152 kB\nMemAvailable: 262144 kB\nSwapTotal: 1048575 kB\n",
            "swap",
        ),
        (
            "proc/meminfo",
            "MemTotal: 1916927 kB\nMemAvailable: 262144 kB\nSwapTotal: 1048576 kB\n",
            "host memory reserve",
        ),
        ("sys/fs/cgroup/cgroup.controllers", "cpu io pids\n", "cgroup v2 memory controller"),
        (
            "proc/pressure/memory",
            "some avg10=5.01 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
            "memory pressure",
        ),
        (
            "proc/pressure/memory",
            "some avg10=5.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.01 avg60=0.00 avg300=0.00 total=1\n",
            "memory pressure",
        ),
    ],
)
def test_host_apply_blocks_host_pressure_before_stopping_a_writer(
    host_release_harness: HostReleaseHarness,
    relative_path: str,
    contents: str,
    message: str,
) -> None:
    harness = host_release_harness
    path = harness.root / relative_path
    path.write_text(contents, encoding="utf-8")

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert message in failed.stderr
    assert not harness.attempt_path.exists()
    assert harness.state()["service_mutations"] == []


def test_host_apply_blocks_an_unknown_running_container_before_stopping_a_writer(
    host_release_harness: HostReleaseHarness,
) -> None:
    harness = host_release_harness
    containers = harness.state()["containers"]
    containers["stale-test"] = {
        "config": {
            "Env": [],
            "Image": "example.invalid/stale@sha256:" + "a" * 64,
            "Labels": {
                "com.docker.compose.project": "nexus-test",
                "com.docker.compose.service": "api",
            },
        },
        "host_config": {"Memory": 1, "MemoryReservation": 1, "PidsLimit": 1},
        "id": "b" * 64,
        "image_id": "sha256:" + "b" * 64,
        "oom_killed": False,
        "restart_count": 0,
        "running": True,
    }
    harness.update_state(containers=containers)

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "unknown running container" in failed.stderr
    assert "nexus-test" in failed.stderr
    assert not harness.attempt_path.exists()
    assert harness.state()["service_mutations"] == []


def test_host_apply_converges_predecessor_resource_limits_before_stopping_a_writer(
    host_release_harness: HostReleaseHarness,
) -> None:
    harness = host_release_harness
    containers = harness.state()["containers"]
    for container in containers.values():
        container["host_config"] = {
            "Memory": 0,
            "MemoryReservation": 0,
            "PidsLimit": 0,
        }
    harness.update_state(containers=containers)

    completed = harness.run_apply()

    assert completed.returncode == 0, completed.stderr
    state = harness.state()
    assert [mutation["service"] for mutation in state["resource_mutations"]] == [
        "postgres",
        "caddy",
        "api",
        "worker-interactive",
        "worker-background",
    ]
    assert state["service_mutations"][:2] == [
        {"operation": "stop", "services": ["worker-background"]},
        {"operation": "stop", "services": ["worker-interactive", "api"]},
    ]


def test_host_apply_converges_memoryswap_only_drift(
    host_release_harness: HostReleaseHarness,
) -> None:
    harness = host_release_harness
    containers = harness.state()["containers"]
    interactive = containers["worker-interactive"]
    interactive["host_config"]["MemorySwap"] = 224 * 1024 * 1024
    harness.update_state(containers=containers)

    completed = harness.run_apply()

    assert completed.returncode == 0, completed.stderr
    assert harness.state()["resource_mutations"] == [
        {
            "memory": 256 * 1024 * 1024,
            "pids": 256,
            "reservation": 128 * 1024 * 1024,
            "service": "worker-interactive",
        }
    ]


def test_host_apply_can_raise_the_exact_unhealthy_predecessor_limit_but_requires_recovery(
    host_release_harness: HostReleaseHarness,
) -> None:
    harness = host_release_harness
    containers = harness.state()["containers"]
    interactive = containers["worker-interactive"]
    interactive["host_config"] = {
        "Memory": 224 * 1024 * 1024,
        "MemoryReservation": 128 * 1024 * 1024,
        "MemorySwap": 224 * 1024 * 1024,
        "PidsLimit": 256,
    }
    interactive["health_status_override"] = "unhealthy"
    harness.update_state(containers=containers)

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "interactive worker health is not exact" in failed.stderr
    state = harness.state()
    assert state["resource_mutations"] == [
        {
            "memory": 256 * 1024 * 1024,
            "pids": 256,
            "reservation": 128 * 1024 * 1024,
            "service": "worker-interactive",
        }
    ]
    assert state["service_mutations"] == []
    assert state["database_revision"] == "0210"
    assert state["backup_dump_count"] == 0
    assert state["migration_count"] == 0
    assert state["jobs"] == {}
    assert not harness.attempt_path.exists()


def test_forward_fix_converges_stopped_writer_limits_without_requesting_live_stats(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness
    store = release.ReleaseStore(release.ReleasePaths.under(harness.root))
    failed_attempt = _prepared(release)
    store.create_attempt(failed_attempt)
    for phase in (
        release.ReleasePhase.WritersStopped,
        release.ReleasePhase.BackendActivationStarted,
        release.ReleasePhase.ForwardFixPending,
        release.ReleasePhase.ForwardFixRequired,
    ):
        failed_attempt = failed_attempt.advance(
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
        store.replace_attempt(failed_attempt)
    store.set_forward_fix(SOURCE_SHA)
    state = harness.state()
    containers = state["containers"]
    for service in ("api", "worker-interactive", "worker-background"):
        container = containers[service]
        container["running"] = False
        container["host_config"] = {
            "Memory": 0,
            "MemoryReservation": 0,
            "PidsLimit": 0,
        }
        if service == "api":
            container["image_id"] = state["api_image_id"]
            container["config"]["Image"] = state["api_image"]
        else:
            container["image_id"] = state["worker_image_id"]
            container["config"]["Image"] = state["worker_image"]
    harness.update_state(containers=containers, database_revision="0215")
    successor_sha = harness.install_candidate(_candidate(NEXT_SHA))

    completed = harness.run_apply(source_sha=successor_sha)

    assert completed.returncode == 0, completed.stderr
    assert [item["service"] for item in harness.state()["resource_mutations"]] == [
        "api",
        "worker-interactive",
        "worker-background",
    ]


def test_host_apply_blocks_unsafe_resource_convergence_before_any_mutation(
    host_release_harness: HostReleaseHarness,
) -> None:
    harness = host_release_harness
    containers = harness.state()["containers"]
    containers["worker-background"]["host_config"]["Memory"] = 0
    containers["worker-background"]["memory_usage"] = 448 * 1024 * 1024
    harness.update_state(containers=containers)

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "worker-background current memory is not below its hard limit" in failed.stderr
    state = harness.state()
    assert state["resource_mutations"] == []
    assert state["service_mutations"] == []


def test_host_preflight_blocks_low_parser_temp_disk(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    paths.cgroup_controllers.parent.mkdir(parents=True)
    paths.cgroup_controllers.write_text("cpu io memory pids\n", encoding="ascii")
    paths.meminfo.parent.mkdir(parents=True)
    paths.meminfo.write_text(
        "MemTotal: 2097152 kB\nMemAvailable: 524288 kB\nSwapTotal: 1048576 kB\n",
        encoding="ascii",
    )
    paths.memory_pressure.parent.mkdir(parents=True)
    paths.memory_pressure.write_text(
        "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n"
        "full avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
        encoding="ascii",
    )
    paths.parser_temp_root.mkdir(parents=True, mode=0o700)
    _set_owner(paths.parser_temp_root, 10001, 10001)
    monkeypatch.setattr(
        release.shutil,
        "disk_usage",
        lambda _path: release.shutil._ntuple_diskusage(1, 1, 512 * 1024 * 1024 - 1),
    )

    try:
        with pytest.raises(release.ReleaseBlocked, match="less than 512 MiB"):
            release.HostRelease(paths)._preflight_host_capacity({}, writers_running=True)
    finally:
        _set_owner(paths.parser_temp_root, os.getuid(), os.getgid())


@pytest.mark.parametrize("invalid_metadata", ("mode", "owner", "symlink"))
def test_host_apply_rejects_unsafe_parser_temp_metadata_before_mutation(
    host_release_harness: HostReleaseHarness,
    invalid_metadata: str,
) -> None:
    harness = host_release_harness
    parser_temp_root = harness.root / "var/lib/nexus/parser-tmp"
    if invalid_metadata == "mode":
        _set_mode(parser_temp_root, 0o755)
    elif invalid_metadata == "owner":
        _set_owner(parser_temp_root, 0, 0)
    else:
        parser_temp_root.rmdir()
        replacement = harness.root / "var/lib/nexus/parser-tmp-target"
        replacement.mkdir(mode=0o700)
        _set_owner(replacement, 10001, 10001)
        parser_temp_root.symlink_to(replacement, target_is_directory=True)

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "parser temporary root metadata is not exact" in failed.stderr
    assert not harness.attempt_path.exists()
    assert harness.state()["resource_mutations"] == []
    assert harness.state()["service_mutations"] == []


def test_host_apply_rejects_writable_caddy_input(tmp_path: Path) -> None:
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


def test_current_verification_allows_a_successor_caddy_configuration_transition(
    tmp_path: Path,
) -> None:
    with _host_harness(tmp_path) as harness:
        replacement = tmp_path / "successor-caddy"
        replacement.write_text("successor-caddy\n", encoding="utf-8")
        subprocess.run(
            (
                "sudo",
                "--non-interactive",
                "install",
                "-o",
                "0",
                "-g",
                "0",
                "-m",
                "0444",
                str(replacement),
                str(harness.root / "etc/nexus/Caddyfile"),
            ),
            check=True,
            capture_output=True,
        )

        verified = harness.run_verify_current()

        assert verified.returncode == 0, verified.stderr


def test_candidate_still_requires_exact_live_caddy_configuration(
    tmp_path: Path,
) -> None:
    with _host_harness(tmp_path) as harness:
        replacement = tmp_path / "successor-caddy"
        replacement.write_text("successor-caddy\n", encoding="utf-8")
        subprocess.run(
            (
                "sudo",
                "--non-interactive",
                "install",
                "-o",
                "0",
                "-g",
                "0",
                "-m",
                "0444",
                str(replacement),
                str(harness.root / "etc/nexus/Caddyfile"),
            ),
            check=True,
            capture_output=True,
        )

        failed = harness.run_apply()

        assert failed.returncode != 0
        assert "installed Caddy configuration differs" in failed.stderr
        assert not harness.attempt_path.exists()


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
    assert "database revision is ()" in failed.stderr
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
        for _proof in range(3)
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
    assert state["database_revision"] == "0215"
    assert state["migration_count"] == 1
    assert state["jobs"] == {}
    assert not tuple(release.ReleasePaths.under(tmp_path).state_root.rglob("*.partial"))


@pytest.mark.parametrize(
    "phase",
    ("Prepared", "WritersStopped", "BackupVerified", "DataMutationStarted"),
)
def test_host_apply_revalidates_volatile_capacity_before_replay_mutation(
    host_release_harness: HostReleaseHarness,
    phase: str,
) -> None:
    harness = host_release_harness
    interrupted = harness.run_apply(interrupt_phase=phase)
    assert interrupted.returncode == -signal.SIGKILL, interrupted.stderr
    before = harness.state()
    (harness.root / "proc/pressure/memory").write_text(
        "some avg10=5.01 avg60=0.00 avg300=0.00 total=1\n"
        "full avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
        encoding="ascii",
    )

    blocked = harness.run_apply()

    assert blocked.returncode != 0
    assert "memory pressure" in blocked.stderr
    after = harness.state()
    assert after["service_mutations"] == before["service_mutations"]
    assert after["backup_dump_count"] == before["backup_dump_count"]
    assert after["migration_count"] == before["migration_count"]


@pytest.mark.parametrize(
    "identity_drift",
    (
        "project",
        "service",
        "oneoff",
        "config_hash",
        "image_reference",
        "image_id",
        "command",
    ),
)
def test_migration_recovery_rejects_and_preserves_a_foreign_stopped_name_collision(
    host_release_harness: HostReleaseHarness,
    identity_drift: str,
) -> None:
    harness = host_release_harness
    interrupted = harness.run_apply(interrupt_phase="DataMutationStarted")
    assert interrupted.returncode == -signal.SIGKILL, interrupted.stderr
    state = harness.state()
    name = f"nexus-release-{SOURCE_SHA}-migration"
    job = {
        "config": {
            "Cmd": [
                "sh",
                "-c",
                "cd /app/migrations && /app/.venv/bin/alembic upgrade head",
            ],
            "Image": state["candidate_api_image"],
            "Labels": {
                "com.docker.compose.config-hash": state["migration_config_hash"],
                "com.docker.compose.oneoff": "True",
                "com.docker.compose.project": "nexus",
                "com.docker.compose.service": "migration",
            },
        },
        "exit_code": 0,
        "host_config": {
            "MemoryReservation": 256 * 1024 * 1024,
            "Memory": 512 * 1024 * 1024,
            "PidsLimit": 256,
        },
        "id": "8" * 64,
        "image_id": state["candidate_api_image_id"],
        "logs": "foreign collision\n",
        "name": f"/{name}",
        "running": False,
    }
    if identity_drift in {"project", "service", "oneoff", "config_hash"}:
        label = {
            "project": "com.docker.compose.project",
            "service": "com.docker.compose.service",
            "oneoff": "com.docker.compose.oneoff",
            "config_hash": "com.docker.compose.config-hash",
        }[identity_drift]
        job["config"]["Labels"][label] = "foreign"
    elif identity_drift == "image_reference":
        job["config"]["Image"] = "example.invalid/foreign@sha256:" + "d" * 64
    elif identity_drift == "image_id":
        job["image_id"] = "sha256:" + "d" * 64
    else:
        job["config"]["Cmd"] = ["sh", "-c", "true"]
    state["jobs"] = {name: job}
    harness.update_state(jobs=state["jobs"])

    blocked = harness.run_apply()

    assert blocked.returncode != 0
    assert "durable Compose job identity differs" in blocked.stderr
    assert name in harness.state()["jobs"]
    assert harness.state()["migration_count"] == 0


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


def test_auth_smoke_failure_has_a_distinct_forward_fix_reason(
    host_release_harness: HostReleaseHarness,
) -> None:
    release = _release_module()
    harness = host_release_harness

    interrupted = harness.run_apply(interrupt_phase="BackendActivationStarted")
    assert interrupted.returncode == -signal.SIGKILL

    settled = harness.run_fail_auth_smoke()

    assert settled.returncode == 0, settled.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired
    assert attempt.failure_code == "post-alias-auth-smoke-failed"
    assert (
        release.ReleaseStore(release.ReleasePaths.under(harness.root)).forward_fix_sha()
        == SOURCE_SHA
    )


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
    assert harness.state()["database_revision"] == "0215"

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


def test_forward_fix_accepts_advanced_schema_and_stopped_writers(
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
    harness.update_state(containers=containers, database_revision="0215")

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
    baseline = release.ReleaseRecord(
        schema_version=1,
        source_sha=CURRENT_SHA,
        manifest_sha256="b" * 64,
        api_image="ghcr.io/nielsdawheelz/nexus-api@sha256:" + "1" * 64,
        worker_image="ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "2" * 64,
        api_image_id="sha256:" + "3" * 64,
        worker_image_id="sha256:" + "4" * 64,
        predecessor_sha=None,
        config_path="/etc/nexus/config/" + "5" * 64 + ".env",
        config_sha256="5" * 64,
        database_revision="0210",
        expected_oracle_manifest_digest="sha256:" + "6" * 64,
        vercel_deployment_id="dpl_Baseline123",
        production_host="nexus.example.test",
        verified_at="2026-08-06T12:04:00Z",
    )
    store.create_record(baseline)
    paths.current.parent.mkdir(parents=True, exist_ok=True)
    paths.current.write_text(f"{CURRENT_SHA}\n", encoding="utf-8")
    paths.current.chmod(0o440)
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
    assert store.current_sha() == CURRENT_SHA
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


def test_config_publication_creates_an_immutable_content_addressed_snapshot(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = _release_module()
    with _host_harness(tmp_path) as harness:
        paths = release.ReleasePaths.under(harness.root)
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


def test_inspect_resumes_when_current_publication_prefix_is_not_terminal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    release = _release_module()
    paths = release.ReleasePaths.under(tmp_path)
    store = release.ReleaseStore(paths)
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
    paths.current.parent.mkdir(parents=True, exist_ok=True)
    paths.current.write_text(f"{SOURCE_SHA}\n", encoding="utf-8")
    paths.current.chmod(0o440)
    monkeypatch.setattr(release, "ReleasePaths", lambda: paths)

    assert release.main(["inspect", "--source-sha", SOURCE_SHA]) == 0

    assert json.loads(capfd.readouterr().out) == {
        "current_sha": SOURCE_SHA,
        "current_vercel_deployment_id": "dpl_1234567890",
        "forward_fix_sha": None,
        "failed_vercel_deployment_ids": [],
        "phase": "FrontendPromoted",
        "predecessor_sha": CURRENT_SHA,
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
    paths.current.parent.mkdir(parents=True, exist_ok=True)
    paths.current.write_text(f"{historical_repair_sha}\n", encoding="utf-8")
    paths.current.chmod(0o440)
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
        "failed_vercel_deployment_ids": [
            failed_deployment_id,
            successor_deployment_id,
        ],
        "forward_fix_sha": SOURCE_SHA,
        "phase": None,
        "predecessor_sha": historical_repair_sha,
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
