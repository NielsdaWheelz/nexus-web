from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import signal
import stat
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest

from nexus.release_artifact import CandidateImages
from tests.testkit.host_release import (
    CURRENT_SHA,
    HostReleaseHarness,
    write_codex_capacity_qualification,
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
        "expected_database_revision": "0216",
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


def test_codex_host_is_required_only_after_its_immutable_schema_cutover() -> None:
    """Risk: a legacy predecessor is rejected for a host it never shipped."""

    release = _release_module()

    def manifest(revision: str):
        value = _candidate()
        images = value["images"]
        assert isinstance(images, dict)
        return release.CandidateManifest(
            **{
                **value,
                "images": CandidateImages(**images),
                "expected_database_revision": revision,
            }
        )

    predecessor = manifest("0215")
    cutover = manifest("0216")

    assert release._requires_codex_agent_host(predecessor) is False
    assert release._requires_codex_agent_host(cutover) is True


def test_existing_vps_capacity_uses_reservations_and_requires_qualification_before_0216(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a nominal 1.9 GiB VPS is rejected by summed hard caps or promoted unqualified."""

    harness = host_release_harness
    meminfo = harness.root / "proc/meminfo"
    meminfo.write_text(
        "MemTotal: 1945600 kB\nMemAvailable: 262144 kB\nSwapTotal: 1048576 kB\n",
        encoding="ascii",
    )
    (harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json").unlink()

    blocked = harness.run_apply()

    assert blocked.returncode != 0
    assert "Codex capacity qualification" in blocked.stderr
    state = harness.state()
    assert state["resource_mutations"] == []
    assert state["service_mutations"] == []


def test_existing_vps_capacity_qualification_writes_exact_immutable_candidate_evidence(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a hand-waved capacity check proves the client cgroup, not the host."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()

    qualified = harness.run_qualify_codex_capacity()

    assert qualified.returncode == 0, qualified.stderr
    assert evidence.stat().st_uid == 0
    assert evidence.stat().st_mode & 0o777 == 0o444
    payload = json.loads(evidence.read_text(encoding="utf-8"))
    assert payload["source_sha"] == SOURCE_SHA
    assert payload["worker_image_id"] == "sha256:" + "9" * 64
    assert payload["cgroup_memory_max"] == 384 * 1024 * 1024
    assert payload["cgroup_memory_peak"] == 64 * 1024 * 1024
    assert re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z",
        payload["measured_at"],
    ), "capacity evidence must record when the host was measured"
    assert [turn["phase"] for turn in payload["turns"]] == ["cold", "warm_1", "warm_2"]
    assert payload["services"] == [
        "postgres",
        "caddy",
        "api",
        "worker-interactive",
        "worker-background",
    ]
    state = harness.state()
    assert not any(
        command[:5] == ["compose", "run", "--rm", "--no-deps", "--user"]
        for command in state["commands"]
    )
    host_container_id = str(state["containers"]["nexus-codex-agent-host"]["id"])
    assert not any(
        command[:2] == ["exec", host_container_id] and command[2:3] == ["sh"]
        for command in state["commands"]
    ), "the sampler must never exec into the cgroup it measures"
    assert state["service_mutations"] == [
        {"operation": "up", "services": ["nexus-codex-agent-host"]},
        {"operation": "stop", "services": ["nexus-codex-agent-host"]},
    ], "qualification may start and stop only its isolated Codex host"

    # A fresh pass is final for its validity window: a rerun refuses to
    # remeasure over it instead of silently replacing the record.
    rerun = harness.run_qualify_codex_capacity()
    assert rerun.returncode != 0
    assert "Codex capacity qualification evidence already exists" in rerun.stderr
    assert json.loads(evidence.read_text(encoding="utf-8")) == payload


@pytest.mark.parametrize(
    ("admission_kind", "expected_error"),
    (
        ("plain_unmounted", "Codex credential state storage is not the dedicated encrypted mount"),
        ("wrong_mapper", "Codex credential state storage is not the dedicated encrypted mount"),
        ("luks1", "Codex credential state storage is not the dedicated encrypted mount"),
        (
            "wrong_mount_flags",
            "Codex credential state storage is not the dedicated encrypted mount",
        ),
        (
            "wrong_mount_source",
            "Codex credential state storage is not the dedicated encrypted mount",
        ),
        (
            "undersized_container",
            "Codex credential state storage is not the dedicated encrypted mount",
        ),
        ("forbidden_key", "Codex credential state storage is not the dedicated encrypted mount"),
        ("crypttab_entry", "Codex credential state storage is not the dedicated encrypted mount"),
        ("boot_guard_disabled", "Codex credential state boot guard differs from release contract"),
        ("boot_guard_tampered", "Codex credential state boot guard differs from release contract"),
    ),
)
def test_codex_capacity_requires_exact_encrypted_state_before_starting_runtime(
    host_release_harness: HostReleaseHarness,
    admission_kind: str,
    expected_error: str,
) -> None:
    """Risk: credentials start without the exact storage or locked-boot admission."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    if admission_kind == "undersized_container":
        subprocess.run(
            (
                "sudo",
                "--non-interactive",
                "truncate",
                "--size",
                "256M",
                str(harness.root / "var/lib/nexus/codex-state.luks"),
            ),
            check=True,
        )
    elif admission_kind == "forbidden_key":
        key = harness.root / "var/lib/nexus/codex-state.key"
        subprocess.run(
            ("sudo", "--non-interactive", "touch", str(key)),
            check=True,
        )
    elif admission_kind == "crypttab_entry":
        crypttab = harness.root / "etc/crypttab"
        subprocess.run(
            (
                "sudo",
                "--non-interactive",
                "sh",
                "-c",
                'printf "%s\\n" "nexus-codex-state /var/lib/nexus/codex-state.luks none luks" > "$1"',
                "nexus-test-crypttab",
                str(crypttab),
            ),
            check=True,
        )
    elif admission_kind == "boot_guard_disabled":
        harness.update_state(codex_state_boot_guard_enabled=False)
    elif admission_kind == "boot_guard_tampered":
        subprocess.run(
            (
                "sudo",
                "--non-interactive",
                "chmod",
                "0700",
                str(harness.root / "usr/local/sbin/nexus-codex-state-boot-guard"),
            ),
            check=True,
        )
    if admission_kind not in {"boot_guard_disabled", "boot_guard_tampered"}:
        harness.update_state(codex_state_storage_kind=admission_kind)

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0, "unencrypted Codex state reached runtime admission"
    assert expected_error in refused.stderr
    assert not evidence.exists()
    state = harness.state()
    assert state["service_mutations"] == []


def test_codex_boot_guard_install_is_exact_candidate_bound_and_public(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: an unbound/private setup seam can overwrite the locked-boot guard."""

    harness = host_release_harness
    guard = harness.root / "usr/local/sbin/nexus-codex-state-boot-guard"
    subprocess.run(
        ("sudo", "--non-interactive", "chmod", "0700", str(guard)),
        check=True,
    )
    harness.update_state(codex_state_boot_guard_enabled=False)

    refused = harness.run_install_codex_state_boot_guard(source_sha=CURRENT_SHA)

    assert refused.returncode != 0
    assert "candidate has no Codex agent host" in refused.stderr
    assert guard.stat().st_mode & 0o777 == 0o700
    assert harness.state()["codex_state_boot_guard_enabled"] is False

    installed = harness.run_install_codex_state_boot_guard()

    assert installed.returncode == 0, installed.stderr
    assert json.loads(installed.stdout) == {
        "schema_version": "nexus-codex-state-boot-guard.v1",
        "source_sha": SOURCE_SHA,
        "status": "installed",
    }
    assert guard.stat().st_uid == 0
    assert guard.stat().st_gid == 0
    assert guard.stat().st_mode & 0o777 == 0o755
    assert harness.state()["codex_state_boot_guard_enabled"] is True


@pytest.mark.parametrize("operation", ("qualification", "apply", "resume"))
@pytest.mark.parametrize("guard_fault", ("disabled", "tampered"))
def test_codex_boot_guard_rejects_every_host_start_owner_before_service_mutation(
    host_release_harness: HostReleaseHarness,
    operation: str,
    guard_fault: str,
) -> None:
    """Risk: an owner repairs or bypasses a disabled/tampered locked-boot guard."""

    harness = host_release_harness
    if operation == "qualification":
        (harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json").unlink()
    elif operation == "resume":
        applied = harness.run_apply()
        assert applied.returncode == 0, applied.stderr
        finalized = harness.run_finalize()
        assert finalized.returncode == 0, finalized.stderr
        state = harness.state()
        containers = state["containers"]
        assert isinstance(containers, dict)
        host = containers["nexus-codex-agent-host"]
        assert isinstance(host, dict)
        host["running"] = False
        harness.update_state(
            commands=[],
            containers=containers,
            public_requests=[],
            resource_mutations=[],
            service_mutations=[],
        )

    if guard_fault == "disabled":
        harness.update_state(codex_state_boot_guard_enabled=False)
    else:
        subprocess.run(
            (
                "sudo",
                "--non-interactive",
                "chmod",
                "0700",
                str(harness.root / "usr/local/sbin/nexus-codex-state-boot-guard"),
            ),
            check=True,
        )

    refused = (
        harness.run_qualify_codex_capacity()
        if operation == "qualification"
        else harness.run_apply()
        if operation == "apply"
        else harness.run_resume_codex_agent_host()
    )

    assert refused.returncode != 0
    assert "Codex credential state boot guard differs from release contract" in refused.stderr
    state = harness.state()
    assert state["service_mutations"] == []


def test_codex_state_requires_recovery_headroom_before_starting_runtime(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: auth/session state fills completely and cannot refresh or recover safely."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    harness.update_state(codex_state_free_bytes=128 * 1024 * 1024 - 1)

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0
    assert "Codex credential state has less than 128 MiB free" in refused.stderr
    assert not evidence.exists()
    assert harness.state()["service_mutations"] == []


def test_codex_capacity_uses_container_native_caddy_health_when_docker_health_is_absent(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: the fake supplies Docker health that the deployed Caddy does not expose."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    harness.update_state(caddy_docker_health_present=False)

    qualified = harness.run_qualify_codex_capacity()

    assert qualified.returncode == 0, qualified.stderr
    state = harness.state()
    assert any(
        command[-8:]
        == [
            "exec",
            "-T",
            "caddy",
            "wget",
            "-q",
            "-O",
            "/dev/null",
            "http://127.0.0.1:2019/config/",
        ]
        for command in state["commands"]
    ), "qualification must execute the canonical probe inside the live Caddy container"


def test_release_rechecks_caddy_before_any_candidate_or_writer_mutation(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a stale capacity pass lets a dead predecessor proxy cross commitment."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    original_evidence = evidence.read_bytes()
    harness.update_state(caddy_health_probe_failure=True)

    refused = harness.run_apply()

    assert refused.returncode != 0
    assert "Caddy is not ready before release mutation" in refused.stderr
    assert harness.state()["service_mutations"] == []
    assert not harness.attempt_path.exists()
    assert evidence.read_bytes() == original_evidence


def test_prepared_release_replay_rechecks_caddy_before_any_further_mutation(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a replay trusts an earlier proxy observation after Prepared commits."""

    release = _release_module()
    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    original_evidence = evidence.read_bytes()
    interrupted = harness.run_apply(interrupt_phase="Prepared")
    assert interrupted.returncode == -signal.SIGKILL, interrupted.stderr
    before = harness.state()
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.Prepared
    harness.update_state(caddy_health_probe_failure=True)

    refused = harness.run_apply()

    assert refused.returncode != 0
    assert "Caddy is not ready before release mutation" in refused.stderr
    after = harness.state()
    assert after["resource_mutations"] == before["resource_mutations"]
    assert after["service_mutations"] == before["service_mutations"]
    assert after["backup_dump_count"] == before["backup_dump_count"]
    assert after["migration_count"] == before["migration_count"]
    persisted = _stored_attempt(release, harness.root)
    assert persisted is not None
    assert persisted.phase is release.ReleasePhase.Prepared
    assert evidence.read_bytes() == original_evidence


@pytest.mark.parametrize(
    "service",
    (
        "postgres",
        "caddy",
        "api",
        "worker-interactive",
        "worker-background",
    ),
)
def test_codex_capacity_service_readiness_failure_follows_ownership(
    host_release_harness: HostReleaseHarness,
    service: str,
) -> None:
    """Risk: a predecessor service outage permanently poisons a new candidate SHA."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    if service == "caddy":
        harness.update_state(
            caddy_docker_health_present=False,
            caddy_health_probe_failure=True,
        )
    else:
        state = harness.state()
        containers = state["containers"]
        assert isinstance(containers, dict)
        container = containers[service]
        assert isinstance(container, dict)
        container["health_status_override"] = "unhealthy"
        harness.update_state(containers=containers)

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0
    assert not evidence.exists(), (
        f"unchanged {service} readiness is retriable operational state, "
        "not immutable candidate evidence"
    )


def test_capacity_cleanup_failure_writes_no_evidence_and_the_canary_is_reclaimed(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a transient cleanup failure permanently disqualifies a healthy candidate."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    harness.update_state(codex_capacity_canary_removal_failure=True)

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0
    assert "Codex capacity cleanup failed" in refused.stderr
    assert not evidence.exists(), (
        "a cleanup failure measured no breach and must not write blocking evidence"
    )
    state = harness.state()
    assert "capacity_canary" in state
    assert state["service_mutations"] == [
        {"operation": "up", "services": ["nexus-codex-agent-host"]},
        {"operation": "stop", "services": ["nexus-codex-agent-host"]},
    ]

    # The same unchanged candidate stays qualifiable: the retry reclaims the
    # leftover labeled canary and completes with passing evidence.
    harness.update_state(codex_capacity_canary_removal_failure=False)
    requalified = harness.run_qualify_codex_capacity()
    assert requalified.returncode == 0, requalified.stderr
    assert json.loads(evidence.read_text(encoding="utf-8"))["status"] == "passed"


def test_capacity_qualification_refuses_a_foreign_container_holding_the_canary_name(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: the fixed canary name alone authorizes removing someone else's container."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    harness.update_state(
        capacity_canary={
            "id": "b" * 64,
            "name": f"nexus-codex-capacity-{SOURCE_SHA}",
            "label": "f" * 40,
            "running": True,
        }
    )

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0
    assert "Codex capacity canary name is held by a foreign container" in refused.stderr
    assert not evidence.exists()
    state = harness.state()
    assert state["capacity_canary"]["id"] == "b" * 64, "the foreign container must never be removed"


def test_capacity_cleanup_preserves_foreign_canary_created_during_run_name_race(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: cleanup deletes a foreign container that wins the check/run name race."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    harness.update_state(codex_capacity_canary_run_name_race=True)

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0
    assert not evidence.exists(), "a failed Docker run must not produce qualification evidence"
    state = harness.state()
    foreign = state.get("capacity_canary")
    foreign_id = "d" * 64
    foreign_name = f"nexus-codex-capacity-{SOURCE_SHA}"
    assert foreign == {
        "id": foreign_id,
        "name": foreign_name,
        "label": "f" * 40,
        "running": True,
    }, "cleanup must preserve the foreign container that appeared during Docker run"
    assert not any(
        command[:2] == ["rm", "--force"] and command[-1] in {foreign_id, foreign_name}
        for command in state["commands"]
    ), "cleanup must not attempt removal until exact ownership is revalidated"


@pytest.mark.parametrize(
    ("status", "message"),
    [
        ("passed", "Codex capacity qualification evidence already exists"),
        ("failed", "Codex capacity qualification failed evidence is immutable"),
    ],
    ids=("fresh-passing", "failed"),
)
def test_decisive_capacity_evidence_blocks_before_host_or_canary_start(
    host_release_harness: HostReleaseHarness,
    status: str,
    message: str,
) -> None:
    """Risk: a decided candidate still incurs a provider turn and mutates host runtime."""

    harness = host_release_harness
    if status == "failed":
        write_codex_capacity_qualification(
            harness.root,
            source_sha=SOURCE_SHA,
            worker_image_id="sha256:" + "9" * 64,
            status="failed",
        )

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0
    assert message in refused.stderr
    state = harness.state()
    assert state["service_mutations"] == [], "decided evidence must block before host start"
    assert not any(command[:3] == ["run", "--detach", "--name"] for command in state["commands"]), (
        "decided evidence must block before canary creation"
    )
    assert not any(command[:2] == ["exec", "c" * 64] for command in state["commands"]), (
        "decided evidence must block before a subscription-authenticated canary turn"
    )


def test_invalid_expired_capacity_evidence_blocks_before_host_or_canary_start(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: expiry launders malformed or foreign evidence into permission to dispatch."""

    harness = host_release_harness
    write_codex_capacity_qualification(
        harness.root,
        source_sha=SOURCE_SHA,
        worker_image_id="sha256:" + "e" * 64,
        measured_at="2026-01-01T00:00:00Z",
    )

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0
    assert "Codex capacity qualification differs from candidate" in refused.stderr
    state = harness.state()
    assert state["service_mutations"] == [], "invalid expired evidence must block before host start"
    assert not any(command[:3] == ["run", "--detach", "--name"] for command in state["commands"]), (
        "only fully validated expired passing evidence may authorize canary creation"
    )


_HOST_CGROUP_RELATIVE = f"sys/fs/cgroup/system.slice/docker-{'a' * 64}.scope"
_LOW_HEADROOM_MEMINFO = "MemTotal: 4194304 kB\nMemAvailable: 102400 kB\nSwapTotal: 1048576 kB\n"
_FULL_PRESSURE = (
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n"
    "full avg10=0.01 avg60=0.00 avg300=0.00 total=1\n"
)


def _restore_healthy_capacity_host(harness: HostReleaseHarness) -> None:
    """Return the fake host and every breach knob to the healthy baseline."""

    (harness.root / "proc/meminfo").write_text(
        "MemTotal: 4194304 kB\nMemAvailable: 524288 kB\nSwapTotal: 1048576 kB\n",
        encoding="ascii",
    )
    (harness.root / "proc/pressure/memory").write_text(
        "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\n"
        "full avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
        encoding="ascii",
    )
    host_cgroup = harness.root / _HOST_CGROUP_RELATIVE
    (host_cgroup / "memory.current").write_text("33554432\n", encoding="ascii")
    (host_cgroup / "memory.peak").write_text("67108864\n", encoding="ascii")
    (host_cgroup / "memory.events").write_text(
        "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
        encoding="ascii",
    )
    containers = harness.state()["containers"]
    containers["worker-background"].pop("health_status_override", None)
    harness.update_state(
        containers=containers,
        codex_capacity_canary_status="passed",
        codex_capacity_canary_delay_seconds=0.0,
        codex_capacity_during_canary_host_writes={},
        codex_capacity_canary_isolation_drift=None,
    )


@pytest.mark.parametrize(
    ("scenario", "message"),
    [
        ("cgroup-peak", "Codex capacity qualification cgroup envelope differs"),
        ("cgroup-current", "Codex capacity cgroup counters exceed memory.max"),
        ("host-headroom", "Codex capacity qualification headroom is below 256 MiB"),
        ("sampler-observed-pressure", "Codex capacity qualification memory pressure"),
        ("oom-kill-delta", "Codex capacity qualification cgroup envelope differs"),
        ("canary-reported-failure", "Codex capacity canary failed"),
        ("client-isolation", "Codex capacity canary isolation"),
    ],
)
def test_each_enumerated_capacity_breach_writes_immutable_failed_evidence(
    host_release_harness: HostReleaseHarness,
    scenario: str,
    message: str,
) -> None:
    """Risk: a §11 breach class blocks once but never writes its immutable record."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    host_cgroup = harness.root / _HOST_CGROUP_RELATIVE
    if scenario == "cgroup-peak":
        (host_cgroup / "memory.peak").write_text(f"{336 * 1024 * 1024}\n", encoding="ascii")
    elif scenario == "cgroup-current":
        (host_cgroup / "memory.current").write_text(f"{384 * 1024 * 1024 + 1}\n", encoding="ascii")
    elif scenario == "host-headroom":
        harness.update_state(
            codex_capacity_during_canary_host_writes={"proc/meminfo": _LOW_HEADROOM_MEMINFO}
        )
    elif scenario == "sampler-observed-pressure":
        # The canary exec outlives one sampler interval so the background
        # sampler itself observes the mutated pressure during the turns.
        harness.update_state(
            codex_capacity_during_canary_host_writes={"proc/pressure/memory": _FULL_PRESSURE},
            codex_capacity_canary_delay_seconds=2.5,
        )
    elif scenario == "oom-kill-delta":
        harness.update_state(
            codex_capacity_during_canary_host_writes={
                f"{_HOST_CGROUP_RELATIVE}/memory.events": (
                    "low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\noom_group_kill 0\n"
                )
            }
        )
    elif scenario == "canary-reported-failure":
        harness.update_state(codex_capacity_canary_status="failed")
    else:
        harness.update_state(
            codex_capacity_canary_isolation_drift="credential_mount_and_network_peer"
        )

    refused = harness.run_qualify_codex_capacity()

    assert refused.returncode != 0
    assert message in refused.stderr
    metadata = evidence.stat()
    assert metadata.st_uid == 0 and metadata.st_mode & 0o777 == 0o444
    payload = json.loads(evidence.read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["turns"] == []

    # A measured breach is immutable: promotion stays blocked, and even after
    # the host is repaired to a fully healthy envelope a rerun refuses to
    # launder the failed record into a fresh pass.
    blocked = harness.run_apply()
    assert blocked.returncode != 0
    assert "Codex capacity qualification" in blocked.stderr
    _restore_healthy_capacity_host(harness)
    rerun = harness.run_qualify_codex_capacity()
    assert rerun.returncode != 0
    assert "Codex capacity qualification failed evidence is immutable" in rerun.stderr
    assert json.loads(evidence.read_text(encoding="utf-8")) == payload


@pytest.mark.parametrize(
    ("canary_status", "message"),
    [
        # Parse-first classification: a canary killed before stating its
        # contract leaves empty/unparseable stdout, whatever code it died with.
        ("crashed", "Codex capacity canary did not state its contract"),
        # A complete authored contract statement whose process was then killed
        # carries an exit code outside the contract table; only that shape may
        # be classified as "did not reach a terminal".
        ("killed_after_printing", "Codex capacity canary did not reach a terminal"),
    ],
    ids=("crash-empty-stdout", "killed-after-printing"),
)
def test_transient_canary_crash_writes_no_evidence_and_stays_requalifiable(
    host_release_harness: HostReleaseHarness,
    canary_status: str,
    message: str,
) -> None:
    """Risk: a canary that died before its contract exits disqualifies the SHA forever."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    harness.update_state(codex_capacity_canary_status=canary_status)

    failed = harness.run_qualify_codex_capacity()

    assert failed.returncode != 0
    assert message in failed.stderr
    assert not evidence.exists(), (
        "a crashed canary measured nothing and must not write blocking evidence"
    )

    harness.update_state(codex_capacity_canary_status="passed")
    requalified = harness.run_qualify_codex_capacity()
    assert requalified.returncode == 0, requalified.stderr
    assert json.loads(evidence.read_text(encoding="utf-8"))["status"] == "passed"


@pytest.mark.parametrize(
    "canary_status",
    ["transport_unavailable", "transport_ambiguous"],
    ids=("preaccept-unavailable", "postaccept-ambiguous"),
)
def test_transport_retriable_canary_terminal_writes_no_evidence_and_allows_retry(
    host_release_harness: HostReleaseHarness,
    canary_status: str,
) -> None:
    """Risk: a transport failure permanently disqualifies the unchanged candidate SHA."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    harness.update_state(codex_capacity_canary_status=canary_status)

    failed = harness.run_qualify_codex_capacity()

    assert failed.returncode != 0
    assert "Codex capacity qualification is transport_retriable" in failed.stderr
    assert not evidence.exists(), (
        "a retriable transport terminal measured no breach and must not write evidence"
    )

    harness.update_state(codex_capacity_canary_status="passed")
    requalified = harness.run_qualify_codex_capacity()
    assert requalified.returncode == 0, requalified.stderr
    assert json.loads(evidence.read_text(encoding="utf-8"))["status"] == "passed"


def test_stale_capacity_evidence_cannot_authorize_the_first_0216_promotion(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a weeks-old measurement authorizes promotion onto a drifted host."""

    harness = host_release_harness
    write_codex_capacity_qualification(
        harness.root,
        source_sha=SOURCE_SHA,
        worker_image_id="sha256:" + "9" * 64,
        measured_at="2026-01-01T00:00:00Z",
    )

    blocked = harness.run_apply()

    assert blocked.returncode != 0
    assert "Codex capacity qualification is stale" in blocked.stderr
    state = harness.state()
    assert state["resource_mutations"] == []
    assert state["service_mutations"] == []

    # Expiry is a block, not a breach: the unchanged SHA earns a fresh
    # measurement in place of the expired pass, and promotion then proceeds.
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    requalified = harness.run_qualify_codex_capacity()
    assert requalified.returncode == 0, requalified.stderr
    payload = json.loads(evidence.read_text(encoding="utf-8"))
    assert payload["status"] == "passed"
    assert payload["measured_at"] != "2026-01-01T00:00:00Z"
    applied = harness.run_apply()
    assert applied.returncode == 0, applied.stderr


def test_existing_vps_capacity_startup_failure_is_retriable_without_failed_evidence(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a device-auth startup failure is irreversibly misclassified as capacity."""

    harness = host_release_harness
    evidence = harness.root / "var/lib/nexus/releases/codex-capacity" / f"{SOURCE_SHA}.json"
    evidence.unlink()
    harness.update_state(codex_host_startup_failure=True)

    failed = harness.run_qualify_codex_capacity()

    assert failed.returncode != 0
    assert not evidence.exists()
    assert harness.state()["service_mutations"] == [
        {"operation": "up", "services": ["nexus-codex-agent-host"]},
        {"operation": "stop", "services": ["nexus-codex-agent-host"]},
    ]


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
    profile = tmp_path / "etc/apparmor.d/nexus-codex-agent-host"
    bundled_profile = (
        tmp_path / "opt/nexus/releases" / SOURCE_SHA / "nexus-codex-agent-host.apparmor"
    )
    assert profile.read_bytes() == bundled_profile.read_bytes()
    profile_metadata = profile.stat()
    assert (profile_metadata.st_uid, profile_metadata.st_gid) == (0, 0)
    assert stat.S_IMODE(profile_metadata.st_mode) == 0o644
    assert state["apparmor_profile_load_count"] == 1
    assert state["apparmor_profile_preflight_count"] == 1
    assert state["database_revision"] == "0216"
    assert state["backup_dump_count"] == 1
    assert state["backup_verify_count"] == 2
    assert state["migration_count"] == 1
    assert not any(
        command[:5] == ["compose", "run", "--rm", "--no-deps", "--user"]
        for command in state["commands"]
    )
    assert state["jobs"] == {}
    assert state["ancestry_proofs"] == [
        {
            "candidate_head": "0216",
            "current_revision": "0210",
            "heads": ["0216"],
            "is_ancestor": True,
        },
        {
            "candidate_head": "0216",
            "current_revision": "0210",
            "heads": ["0216"],
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
        # The Codex host starts and passes its health wait before any writer,
        # so the background lane can never claim a metadata job into the
        # terminal host-unavailable outcome during activation.
        {
            "operation": "up",
            "services": ["nexus-codex-agent-host"],
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
            "MemTotal: 4194304 kB\nMemAvailable: 262143 kB\nSwapTotal: 1048576 kB\n",
            "available memory",
        ),
        (
            "proc/meminfo",
            "MemTotal: 4194304 kB\nMemAvailable: 262144 kB\nSwapTotal: 1048575 kB\n",
            "swap",
        ),
        (
            "proc/meminfo",
            "MemTotal: 1945599 kB\nMemAvailable: 262144 kB\nSwapTotal: 1048576 kB\n",
            "committed 1900 MiB floor",
        ),
        (
            "proc/sys/kernel/apparmor_restrict_unprivileged_userns",
            "0\n",
            "AppArmor unprivileged-user-namespace restriction is not enabled",
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
    harness.update_state(containers=containers, database_revision="0216")
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
        "MemTotal: 4194304 kB\nMemAvailable: 524288 kB\nSwapTotal: 1048576 kB\n",
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


@pytest.mark.parametrize(
    ("drift", "message"),
    [
        ("security", "Codex agent host privilege isolation differs"),
        ("systempaths_missing", "Codex agent host privilege isolation differs"),
        ("systempaths_mutated", "Codex agent host privilege isolation differs"),
        ("nanocpus", "Codex agent host privilege isolation differs"),
        ("masked_paths", "Codex agent host privilege isolation differs"),
        ("readonly_paths", "Codex agent host privilege isolation differs"),
        ("network", "Codex agent host network isolation differs"),
        ("network_peer", "Codex agent host network peer isolation differs"),
    ],
)
def test_host_apply_rejects_codex_host_outer_sandbox_or_network_drift(
    host_release_harness: HostReleaseHarness,
    drift: str,
    message: str,
) -> None:
    release = _release_module()
    harness = host_release_harness
    harness.update_state(codex_host_isolation_drift=drift)

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert message in failed.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired


def test_host_apply_execs_the_codex_sandbox_and_health_probes_inside_the_host(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: the host-prove path silently stops running its in-container probes.

    The compose source text no longer names these probes anywhere the deploy
    tests grep, so the only proof they run is the fake Docker's recorded argv.
    """

    harness = host_release_harness

    completed = harness.run_apply()

    assert completed.returncode == 0, completed.stderr
    commands = [" ".join(command) for command in harness.state()["commands"]]
    sandbox_probes = [
        index
        for index, command in enumerate(commands)
        if command.startswith("compose")
        and command.endswith(
            "exec -T nexus-codex-agent-host python -m apps.codex_agent.sandbox_health"
        )
    ]
    health_probes = [
        index
        for index, command in enumerate(commands)
        if command.startswith("compose")
        and command.endswith("exec -T nexus-codex-agent-host python -m apps.codex_agent.health")
    ]
    assert len(sandbox_probes) == 1, commands
    assert len(health_probes) == 1, commands
    assert sandbox_probes[0] < health_probes[0], (
        "the kernel-boundary sandbox probe must run before the readiness probe"
    )


def test_host_apply_rejects_wrong_codex_host_health_identity(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a host that reports a foreign auth identity is promoted as ready."""

    release = _release_module()
    harness = host_release_harness
    harness.update_state(
        codex_agent_host_health_output_override=json.dumps(
            {
                "auth_profile": "codex-team",
                "backend": "codex",
                "schema_version": "nexus-agent-health.v1",
                "status": "ready",
                "transport": "sdk",
            },
            sort_keys=True,
        )
    )

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "Codex agent host is not ready with exact auth contract" in failed.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired


def test_host_apply_accepts_the_exact_compose_systempaths_security_option(
    host_release_harness: HostReleaseHarness,
) -> None:
    harness = host_release_harness

    completed = harness.run_apply()

    assert completed.returncode == 0, completed.stderr


@pytest.mark.parametrize(
    "mutation",
    [
        "environment_credential_residue",
        "mount_wrong_named_volume",
        "mount_wrong_source",
        "mount_readonly_docker_socket",
        "mount_readonly_host_home",
    ],
)
def test_host_apply_rejects_codex_host_environment_and_mount_contract_mutants(
    host_release_harness: HostReleaseHarness,
    mutation: str,
) -> None:
    """Risk: allow-list gaps expose credentials, Docker, or the host filesystem."""

    release = _release_module()
    harness = host_release_harness
    harness.update_state(codex_host_contract_mutation=mutation)

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "Codex agent host" in failed.stderr
    attempt = _stored_attempt(release, harness.root)
    assert attempt is not None
    assert attempt.phase is release.ReleasePhase.ForwardFixRequired


@pytest.mark.parametrize(
    "mutation",
    [
        "network_driver",
        "network_scope",
        "network_internal",
        "network_options",
        "network_ipam",
    ],
)
def test_host_apply_rejects_codex_egress_bridge_contract_mutants(
    host_release_harness: HostReleaseHarness,
    mutation: str,
) -> None:
    """Risk: a singleton network is not necessarily the local egress bridge we approved."""

    release = _release_module()
    harness = host_release_harness
    harness.update_state(codex_host_contract_mutation=mutation)

    failed = harness.run_apply()

    assert failed.returncode != 0
    assert "Codex agent host network" in failed.stderr
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


def test_current_release_resumes_only_the_codex_host_and_rejects_live_bind_drift(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: reboot recovery bypasses the release owner or starts on plaintext state."""

    harness = host_release_harness
    applied = harness.run_apply()
    assert applied.returncode == 0, applied.stderr
    finalized = harness.run_finalize()
    assert finalized.returncode == 0, finalized.stderr

    state = harness.state()
    containers = state["containers"]
    assert isinstance(containers, dict)
    host = containers["nexus-codex-agent-host"]
    assert isinstance(host, dict)
    host["running"] = False
    harness.update_state(
        commands=[],
        containers=containers,
        public_requests=[],
        service_mutations=[],
    )

    resumed = harness.run_resume_codex_agent_host()

    assert resumed.returncode == 0, resumed.stderr
    assert json.loads(resumed.stdout) == {
        "schema_version": "nexus-codex-agent-host-resume.v1",
        "source_sha": SOURCE_SHA,
        "status": "ready",
    }
    state = harness.state()
    assert state["service_mutations"] == [
        {"operation": "up", "services": ["nexus-codex-agent-host"]}
    ]
    assert state["public_requests"] == [
        {"host": host, "path": path}
        for host, path in (
            ("web.example.test", "/version"),
            ("api.example.test", "/version"),
            ("api.example.test", "/readyz"),
        )
    ]

    state = harness.state()
    containers = state["containers"]
    assert isinstance(containers, dict)
    host_container = containers["nexus-codex-agent-host"]
    assert isinstance(host_container, dict)
    host_container["running"] = False
    harness.update_state(
        codex_state_live_bind_kind="wrong_source",
        commands=[],
        containers=containers,
        public_requests=[],
        service_mutations=[],
    )

    refused = harness.run_resume_codex_agent_host()

    assert refused.returncode != 0
    assert "Codex agent host mounts differ from isolated contract" in refused.stderr
    state = harness.state()
    assert state["service_mutations"] == [
        {"operation": "up", "services": ["nexus-codex-agent-host"]},
        {"operation": "stop", "services": ["nexus-codex-agent-host"]},
    ]
    containers = state["containers"]
    assert isinstance(containers, dict)
    stopped_host = containers["nexus-codex-agent-host"]
    assert isinstance(stopped_host, dict)
    assert stopped_host["running"] is False


def test_resume_codex_agent_host_rejects_noncurrent_and_running_state(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: reboot recovery operates a foreign release or an already-live host."""

    harness = host_release_harness
    applied = harness.run_apply()
    assert applied.returncode == 0, applied.stderr
    finalized = harness.run_finalize()
    assert finalized.returncode == 0, finalized.stderr
    harness.update_state(public_requests=[], service_mutations=[])

    noncurrent = harness.run_resume_codex_agent_host(source_sha=CURRENT_SHA)

    assert noncurrent.returncode != 0
    assert noncurrent.stdout == ""
    assert f"release {CURRENT_SHA} is not current" in noncurrent.stderr
    assert harness.state()["service_mutations"] == []

    running = harness.run_resume_codex_agent_host()

    assert running.returncode != 0
    assert running.stdout == ""
    assert "Codex agent host is not stopped" in running.stderr
    assert harness.state()["service_mutations"] == []


def test_resume_codex_agent_host_startup_failure_stops_without_a_receipt(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: a failed Compose wait leaves an unaudited authenticated host running."""

    harness = host_release_harness
    applied = harness.run_apply()
    assert applied.returncode == 0, applied.stderr
    finalized = harness.run_finalize()
    assert finalized.returncode == 0, finalized.stderr
    state = harness.state()
    containers = state["containers"]
    assert isinstance(containers, dict)
    host = containers["nexus-codex-agent-host"]
    assert isinstance(host, dict)
    host["running"] = False
    harness.update_state(
        codex_host_startup_failure=True,
        containers=containers,
        public_requests=[],
        service_mutations=[],
    )

    refused = harness.run_resume_codex_agent_host()

    assert refused.returncode != 0
    assert refused.stdout == ""
    assert harness.state()["service_mutations"] == [
        {"operation": "up", "services": ["nexus-codex-agent-host"]},
        {"operation": "stop", "services": ["nexus-codex-agent-host"]},
    ]
    stopped = harness.state()["containers"]["nexus-codex-agent-host"]
    assert isinstance(stopped, dict)
    assert stopped["running"] is False


def test_resume_codex_agent_host_rejects_every_malformed_direct_bind_and_stops(
    host_release_harness: HostReleaseHarness,
) -> None:
    """Risk: Docker's live bind drifts from the immutable direct-bind declaration."""

    harness = host_release_harness
    applied = harness.run_apply()
    assert applied.returncode == 0, applied.stderr
    finalized = harness.run_finalize()
    assert finalized.returncode == 0, finalized.stderr

    for live_kind in ("wrong_source", "wrong_type", "readonly", "shared_propagation"):
        state = harness.state()
        containers = state["containers"]
        assert isinstance(containers, dict)
        host = containers["nexus-codex-agent-host"]
        assert isinstance(host, dict)
        host["running"] = False
        harness.update_state(
            codex_state_live_bind_kind=live_kind,
            containers=containers,
            public_requests=[],
            service_mutations=[],
        )

        refused = harness.run_resume_codex_agent_host()

        assert refused.returncode != 0, live_kind
        assert refused.stdout == "", live_kind
        assert "Codex agent host mounts differ from isolated contract" in refused.stderr, live_kind
        state = harness.state()
        assert state["service_mutations"] == [
            {"operation": "up", "services": ["nexus-codex-agent-host"]},
            {"operation": "stop", "services": ["nexus-codex-agent-host"]},
        ], live_kind
        stopped = state["containers"]["nexus-codex-agent-host"]
        assert isinstance(stopped, dict)
        assert stopped["running"] is False, live_kind


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
    harness.update_state(commands=[])

    replayed = harness.run_apply(interrupt_phase=phase)

    assert replayed.returncode == 0, replayed.stderr
    completed = _stored_attempt(release, tmp_path)
    assert completed is not None
    assert completed.phase is release.ReleasePhase.AwaitingFrontendPromotion
    state = harness.state()
    assert state["database_revision"] == "0216"
    assert state["migration_count"] == 1
    assert state["jobs"] == {}
    assert not tuple(release.ReleasePaths.under(tmp_path).state_root.rglob("*.partial"))
    if phase == "AwaitingFrontendPromotion":
        assert not any(command[:2] == ["image", "inspect"] for command in state["commands"])


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
    assert harness.state()["database_revision"] == "0216"

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
    harness.update_state(containers=containers, database_revision="0216")

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
