from __future__ import annotations

import fcntl
import hashlib
import json
import os
import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

from tests.testkit.host_infrastructure_adoption import (
    SOURCE_SHA,
    InfrastructureAdoptionHarness,
    LocalInfrastructureAdoptionHarness,
)

REPO_ROOT = Path(__file__).parents[3]


def _run_privileged(*command: str) -> None:
    arguments = command
    if os.geteuid() != 0:
        arguments = ("sudo", "--non-interactive", *command)
    subprocess.run(arguments, check=True, capture_output=True)


@pytest.fixture
def adoption(tmp_path: Path) -> Iterator[InfrastructureAdoptionHarness]:
    with InfrastructureAdoptionHarness.create(tmp_path, repo_root=REPO_ROOT) as harness:
        yield harness


def test_same_image_adoption_backs_up_before_scoped_infrastructure_mutation(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    torn_inputs = adoption.root / "var/lib/nexus/infra-adoption" / SOURCE_SHA / "inputs"
    torn_inputs.mkdir(parents=True)
    (torn_inputs / ".docker-compose.yml.partial").write_bytes(b"torn")
    (torn_inputs.parent / ".attempt.json.partial").write_bytes(b"torn")
    torn_backups = adoption.root / "var/backups/nexus/infra-adoption"
    torn_backups.mkdir(parents=True)
    (torn_backups / f".{SOURCE_SHA}.partial").write_bytes(b"torn")

    completed = adoption.run()

    assert completed.returncode == 0, completed.stderr
    attempt = adoption.attempt()
    assert attempt["phase"] == "Succeeded"
    replacements = attempt["replacement_containers"]
    assert set(replacements) == {"postgres", "caddy"}
    for service, container_id in {"postgres": "a" * 64, "caddy": "b" * 64}.items():
        evidence = replacements[service]
        assert set(evidence) == {"container_id", "image_id", "config_sha256"}
        assert evidence["container_id"] == container_id
        assert len(evidence["config_sha256"]) == 64
    state = adoption.state()
    order = state["semantic_order"]
    assert order.index("compose-config") < order.index("stop-writers")
    assert order.index("stop-writers") < order.index("database-identity")
    assert order.index("pg-dump") < order.index("pg-restore-list")
    assert order.index("pg-restore-list") < order.index("check-rehearsal-absent")
    assert order.index("check-rehearsal-absent") < order.index("create-rehearsal")
    assert order.index("create-rehearsal") < order.index("pg-restore")
    assert order.index("pg-restore") < order.index("drop-rehearsal")
    assert order.index("drop-rehearsal") < order.index("compose-up:postgres,caddy")
    psql_commands = [
        command[-1] for command in state["commands"] if command[0] == "exec" and "psql" in command
    ]
    assert not any(command.startswith("DROP DATABASE IF EXISTS") for command in psql_commands)
    assert any(command.startswith("CREATE DATABASE") for command in psql_commands)
    assert any(command.startswith("DROP DATABASE") for command in psql_commands)
    assert all(
        not ("DROP DATABASE" in command and "CREATE DATABASE" in command)
        for command in psql_commands
    )
    assert state["active"] == {
        "postgres": "a" * 64,
        "caddy": "b" * 64,
        "api": "5" * 64,
        "worker-interactive": "6" * 64,
        "worker-background": "7" * 64,
    }
    assert all(container["running"] for container in state["containers"].values())
    assert set(state["databases"]) == {"nexus"}
    backup = Path(attempt["backup"]["path"])
    assert backup.stat().st_size == attempt["backup"]["byte_count"]
    completion = json.loads(
        (adoption.root / "var/lib/nexus/infra-adoption/completed.json").read_text(encoding="utf-8")
    )
    assert completion["source_sha"] == SOURCE_SHA
    retained_compose = (
        adoption.root / "var/lib/nexus/infra-adoption" / SOURCE_SHA / "inputs/docker-compose.yml"
    )
    assert retained_compose.read_bytes() == adoption.compose_source.read_bytes()
    assert (
        adoption.root / "etc/nexus/Caddyfile"
    ).read_bytes() == adoption.caddy_source.read_bytes()
    assert (
        adoption.root / "var/lib/nexus/infra-adoption" / SOURCE_SHA / "rehearsal-database"
    ).read_text(encoding="utf-8") == f"nexus_adopt_{SOURCE_SHA}\n"
    assert not tuple(adoption.root.rglob("*.partial"))

    mutating_commands = [
        command
        for command in state["commands"]
        if command[0] in {"stop", "start", "compose"}
        and not (command[0] == "compose" and "config" in command)
    ]
    assert all("down" not in command for command in state["commands"])
    assert all("volume" not in command for command in state["commands"])
    assert [command[0] for command in mutating_commands] == [
        "stop",
        "stop",
        "compose",
        "start",
    ]
    compose_mutation = mutating_commands[2]
    assert compose_mutation[-9:] == [
        "up",
        "--detach",
        "--no-deps",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "90",
        "postgres",
        "caddy",
    ]


def test_completed_same_source_replay_is_verify_only(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    first = adoption.run()
    assert first.returncode == 0, first.stderr
    prior_order = list(adoption.state()["semantic_order"])

    replay = adoption.run()

    assert replay.returncode == 0, replay.stderr
    assert adoption.state()["semantic_order"] == [
        *prior_order,
        "start-writers",
        "database-identity",
    ]


def test_completion_publication_prefix_restarts_exact_writers_on_replay(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    failed = adoption.run(fail_after_completion_publication=True)

    assert failed.returncode != 0
    assert adoption.attempt()["phase"] == "Succeeded"
    assert (adoption.root / "var/lib/nexus/infra-adoption/completed.json").exists()
    failed_state = adoption.state()
    assert not any(
        failed_state["containers"][failed_state["active"][service]]["running"]
        for service in ("api", "worker-interactive", "worker-background")
    )
    compose_mutations = sum(
        item.startswith("compose-up") for item in failed_state["semantic_order"]
    )

    replay = adoption.run()

    assert replay.returncode == 0, replay.stderr
    final = adoption.state()
    assert all(
        final["containers"][final["active"][service]]["running"]
        for service in ("api", "worker-interactive", "worker-background")
    )
    assert (
        sum(item.startswith("compose-up") for item in final["semantic_order"]) == compose_mutations
    )


@pytest.mark.parametrize("drift", ["writable-attempt", "symlinked-completion"])
def test_terminal_replay_rejects_non_immutable_evidence_before_docker_access(
    adoption: InfrastructureAdoptionHarness,
    drift: str,
) -> None:
    completed = adoption.run()
    assert completed.returncode == 0, completed.stderr
    prior_order = list(adoption.state()["semantic_order"])
    state_root = adoption.root / "var/lib/nexus/infra-adoption"
    if drift == "writable-attempt":
        _run_privileged(
            "chmod",
            "0640",
            str(state_root / SOURCE_SHA / "attempt.json"),
        )
    else:
        completion = state_root / "completed.json"
        retained = state_root / ".completed.real"
        _run_privileged("mv", "--", str(completion), str(retained))
        _run_privileged("ln", "--symbolic", "--", retained.name, str(completion))

    replay = adoption.run()

    assert replay.returncode != 0
    assert adoption.state()["semantic_order"] == prior_order


def test_pre_mutation_backup_failure_restores_exact_writers_then_replays(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    adoption.set_failure("backup-list")

    failed = adoption.run()

    assert failed.returncode != 0
    assert adoption.attempt()["phase"] == "DatabaseCaptured"
    state = adoption.state()
    assert all(
        state["containers"][state["active"][service]]["running"]
        for service in ("api", "worker-interactive", "worker-background")
    )
    assert not any(item.startswith("compose-up") for item in state["semantic_order"])

    replay = adoption.run()

    assert replay.returncode == 0, replay.stderr
    assert adoption.attempt()["phase"] == "Succeeded"


def test_unowned_rehearsal_database_is_never_deleted(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    rehearsal = f"nexus_adopt_{SOURCE_SHA}"
    state = adoption.state()
    state["databases"][rehearsal] = {
        "revision": "external",
        "system_identifier": "external-system-id",
        "tables": {"valuable": 1},
    }
    from tests.testkit.host_infrastructure_adoption import _save

    _save(adoption.state_path, state)

    failed = adoption.run()

    assert failed.returncode != 0
    final = adoption.state()
    assert final["databases"][rehearsal]["tables"] == {"valuable": 1}
    assert "drop-owned-rehearsal" not in final["semantic_order"]
    assert not (
        adoption.root / "var/lib/nexus/infra-adoption" / SOURCE_SHA / "rehearsal-database"
    ).exists()


def test_claimed_rehearsal_database_is_recovered_after_restore_failure(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    rehearsal = f"nexus_adopt_{SOURCE_SHA}"
    adoption.set_failure("backup-restore")

    failed = adoption.run()

    assert failed.returncode != 0
    assert adoption.attempt()["phase"] == "DatabaseCaptured"
    assert rehearsal in adoption.state()["databases"]

    replay = adoption.run()

    assert replay.returncode == 0, replay.stderr
    state = adoption.state()
    assert set(state["databases"]) == {"nexus"}
    assert "drop-owned-rehearsal" in state["semantic_order"]


def test_post_boundary_partial_recreation_stays_stopped_and_resumes_remaining_target(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    adoption.set_failure("compose-after-postgres")

    failed = adoption.run()

    assert failed.returncode != 0
    assert adoption.attempt()["phase"] == "InfrastructureMutationStarted"
    assert not (adoption.root / "var/lib/nexus/infra-adoption/completed.json").exists()
    state = adoption.state()
    assert state["active"]["postgres"] == "a" * 64
    assert state["active"]["caddy"] == "4" * 64
    assert not any(
        state["containers"][state["active"][service]]["running"]
        for service in ("api", "worker-interactive", "worker-background")
    )

    replay = adoption.run()

    assert replay.returncode == 0, replay.stderr
    assert adoption.state()["semantic_order"].count("compose-up:postgres,caddy") == 1
    assert adoption.state()["semantic_order"].count("compose-up:caddy") == 1


@pytest.mark.parametrize(
    "phase",
    [
        "Prepared",
        "WritersStopped",
        "DatabaseCaptured",
        "BackupVerified",
        "FilesInstalled",
        "InfrastructureMutationStarted",
        "InfrastructureRecreated",
        "WritersRestored",
    ],
)
def test_every_durable_phase_crash_replays_the_same_bound_adoption(
    adoption: InfrastructureAdoptionHarness,
    phase: str,
) -> None:
    interrupted = adoption.run(interrupt_phase=phase)

    assert interrupted.returncode != 0
    assert adoption.attempt()["phase"] == phase
    assert not (adoption.root / "var/lib/nexus/infra-adoption/completed.json").exists()
    if phase == "InfrastructureMutationStarted":
        adoption.restart_writer_out_of_band("api")
        replay_start = len(adoption.state()["semantic_order"])
    else:
        replay_start = 0

    replay = adoption.run()

    assert replay.returncode == 0, replay.stderr
    assert adoption.attempt()["phase"] == "Succeeded"
    if phase == "InfrastructureMutationStarted":
        replay_order = adoption.state()["semantic_order"][replay_start:]
        assert replay_order.index("stop-writers") < replay_order.index("compose-up:postgres,caddy")


def test_writer_restart_crash_replays_exact_ids_without_recreating_infrastructure(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    adoption.set_failure("start-after-one")

    failed = adoption.run()

    assert failed.returncode != 0
    assert adoption.attempt()["phase"] == "InfrastructureRecreated"
    failed_state = adoption.state()
    assert failed_state["semantic_order"].count("compose-up:postgres,caddy") == 1
    assert failed_state["containers"][failed_state["active"]["api"]]["running"] is True
    assert (
        failed_state["containers"][failed_state["active"]["worker-interactive"]]["running"] is False
    )

    replay = adoption.run()

    assert replay.returncode == 0, replay.stderr
    assert adoption.state()["semantic_order"].count("compose-up:postgres,caddy") == 1
    assert adoption.attempt()["phase"] == "Succeeded"


def test_shared_release_lock_rejects_concurrent_adoption(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    lock_path = adoption.root / "run/lock/nexus-release.lock"
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

        failed = adoption.run()

    assert failed.returncode != 0
    assert adoption.state()["commands"] == []


def test_existing_application_release_state_blocks_before_docker_mutation(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    records = adoption.root / "var/lib/nexus/releases/records"
    records.mkdir(parents=True)
    (records / f"{SOURCE_SHA}.json").write_text("{}\n", encoding="utf-8")

    failed = adoption.run()

    assert failed.returncode != 0
    assert adoption.state()["commands"] == []


@pytest.mark.parametrize(
    "drift",
    (
        "dangling-current",
        "symlinked-records",
        "wrong-owner-root",
        "writable-records",
    ),
)
def test_noncanonical_empty_release_state_blocks_before_docker_mutation(
    adoption: InfrastructureAdoptionHarness,
    drift: str,
) -> None:
    release_root = adoption.root / "var/lib/nexus/releases"
    release_root.mkdir(parents=True)
    _run_privileged("chmod", "0750", str(release_root))
    if drift == "dangling-current":
        (release_root / "current").symlink_to("missing-record")
    elif drift == "symlinked-records":
        external = adoption.root / "empty-records"
        external.mkdir()
        (release_root / "records").symlink_to(external)
    elif drift == "wrong-owner-root":
        _run_privileged("chown", "65534:65534", str(release_root))
    else:
        records = release_root / "records"
        records.mkdir(mode=0o750)
        _run_privileged("chmod", "0770", str(records))

    failed = adoption.run()

    assert failed.returncode != 0
    assert adoption.state()["commands"] == []


def test_nested_content_addressed_config_is_rejected_before_docker_access(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    current = adoption.root / "etc/nexus/current.env"
    config = current.resolve(strict=True)
    nested = config.parent / "nested"
    nested.mkdir()
    nested_config = nested / config.name
    config.rename(nested_config)
    current.unlink()
    current.symlink_to(nested_config)

    failed = adoption.run()

    assert failed.returncode != 0
    assert adoption.state()["commands"] == []


@pytest.mark.parametrize("drift", ["image", "mount", "extra-volume"])
def test_same_image_and_named_mount_drift_abort_before_stopping_writers(
    adoption: InfrastructureAdoptionHarness,
    drift: str,
) -> None:
    state = adoption.state()
    if drift == "image":
        reference = next(iter(state["image_refs"]))
        state["image_refs"][reference] = "sha256:" + "f" * 64
    elif drift == "mount":
        postgres = state["containers"][state["active"]["postgres"]]
        postgres["mounts"][0]["Name"] = "different_postgres_data"
        postgres["mounts"][0]["Source"] = "different_postgres_data"
    else:
        postgres = state["containers"][state["active"]["postgres"]]
        postgres["mounts"].append(
            {
                "Destination": "/unexpected",
                "Name": "nexus_unexpected",
                "RW": True,
                "Source": "nexus_unexpected",
                "Type": "volume",
            }
        )
    from tests.testkit.host_infrastructure_adoption import _save

    _save(adoption.state_path, state)

    failed = adoption.run()

    assert failed.returncode != 0
    assert "stop-writers" not in adoption.state()["semantic_order"]


@pytest.mark.parametrize(
    ("running", "health"),
    [(False, "healthy"), (True, None), (True, "unhealthy")],
    ids=("stopped", "healthless", "unhealthy"),
)
def test_non_ready_writer_is_rejected_before_prepared_state(
    adoption: InfrastructureAdoptionHarness,
    running: bool,
    health: str | None,
) -> None:
    state = adoption.state()
    writer = state["containers"][state["active"]["api"]]
    writer["running"] = running
    writer["health"] = health
    from tests.testkit.host_infrastructure_adoption import _save

    _save(adoption.state_path, state)

    failed = adoption.run()

    assert failed.returncode != 0
    assert not (
        adoption.root / "var/lib/nexus/infra-adoption" / SOURCE_SHA / "attempt.json"
    ).exists()
    assert "stop-writers" not in adoption.state()["semantic_order"]


def test_replacement_configuration_drift_is_rejected_from_terminal_replay(
    adoption: InfrastructureAdoptionHarness,
) -> None:
    completed = adoption.run()
    assert completed.returncode == 0, completed.stderr
    state = adoption.state()
    caddy = state["containers"][state["active"]["caddy"]]
    caddy["config"]["Hostname"] = "drifted"
    from tests.testkit.host_infrastructure_adoption import _save

    _save(adoption.state_path, state)

    replay = adoption.run()

    assert replay.returncode != 0


@pytest.mark.parametrize(
    "failure",
    [
        "bundle",
        "image",
        "duplicate-json",
        "duplicate-vercel",
        "aliased-vercel",
        "cached-version",
        "system-env-disabled",
    ],
)
def test_local_admission_failure_precedes_every_ssh_host_effect(
    tmp_path: Path,
    failure: str,
) -> None:
    harness = LocalInfrastructureAdoptionHarness.create(tmp_path, repo_root=REPO_ROOT)
    if failure == "bundle":
        harness.update_bundle_state(publisher_run_attempt=2)
    elif failure == "image":
        harness.update_local_state(image_fetch_failure=True)
    elif failure == "duplicate-json":
        harness.update_local_state(vercel_duplicate_project_id=True)
    elif failure == "duplicate-vercel":
        harness.update_local_state(vercel_match_count=2)
    elif failure == "aliased-vercel":
        harness.update_local_state(vercel_aliases=["nexus.nielseriknandal.com"])
    elif failure == "cached-version":
        harness.update_local_state(vercel_cache_control="public, max-age=0")
    else:
        harness.update_local_state(vercel_system_envs=False)

    completed = harness.run()

    assert completed.returncode != 0
    assert not any(call["command"] in {"scp", "ssh"} for call in harness.calls())


def test_local_owner_admits_release_then_transfers_exact_commit_blobs(
    tmp_path: Path,
) -> None:
    harness = LocalInfrastructureAdoptionHarness.create(tmp_path, repo_root=REPO_ROOT)

    completed = harness.run()

    assert completed.returncode == 0, completed.stderr
    calls = harness.calls()
    root = str(REPO_ROOT)
    checkout_proof = [
        ["-C", root, "fetch", "--quiet", "origin", "main"],
        ["-C", root, "status", "--porcelain", "--untracked-files=all"],
        ["-C", root, "rev-parse", "HEAD"],
        ["-C", root, "rev-parse", "origin/main"],
    ]
    bundle_proof = [
        ["-C", root, "status", "--porcelain", "--untracked-files=normal"],
        ["-C", root, "rev-parse", "HEAD"],
        ["-C", root, "fetch", "--quiet", "origin", "main"],
        ["-C", root, "rev-parse", "origin/main"],
    ]
    tracked = {
        "docker-compose.yml": REPO_ROOT / "deploy/hetzner/docker-compose.yml",
        "Caddyfile": REPO_ROOT / "deploy/hetzner/Caddyfile",
        "adopt-infrastructure.py": REPO_ROOT / "deploy/hetzner/adopt-infrastructure.py",
    }
    git_calls = [call["arguments"] for call in calls if call["command"] == "git"]
    assert git_calls == [
        *checkout_proof,
        *[["-C", root, "show", f"{SOURCE_SHA}:deploy/hetzner/{name}"] for name in tracked],
        *bundle_proof,
        *checkout_proof,
    ]

    curl_calls = [call for call in calls if call["command"] == "curl"]
    assert len(curl_calls) == 4
    urls = [call["arguments"][-1] for call in curl_calls]
    assert urls[0].startswith(
        "https://api.vercel.com/v9/projects/prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs?teamId="
    )
    assert "target=production" in urls[1]
    assert f"meta-githubCommitSha={SOURCE_SHA}" in urls[1]
    assert urls[2].startswith("https://api.vercel.com/v13/deployments/dpl_")
    assert urls[3] == "https://nexus-adoption.vercel.app/version"
    assert "test-vercel-token" not in " ".join(
        argument for call in curl_calls for argument in call["arguments"]
    )
    first_ssh = next(index for index, call in enumerate(calls) if call["command"] == "ssh")
    assert all(calls.index(call) < first_ssh for call in curl_calls)
    bundle_state = json.loads(harness.bundle_state_path.read_text(encoding="utf-8"))
    assert any(event["command"] == "gh" for event in bundle_state["events"])

    docker_calls = [call for call in calls if call["command"] == "docker"]
    assert len(docker_calls) == 2
    assert all(
        call["arguments"][:3] == ["buildx", "imagetools", "inspect"] for call in docker_calls
    )
    assert all("@sha256:" in call["arguments"][3] for call in docker_calls)
    assert all(call["docker_config_entries"] == [] for call in docker_calls)
    assert all(call["docker_auth_config"] is None for call in docker_calls)
    assert all(call["registry_auth_file"] is None for call in docker_calls)
    assert all(calls.index(call) < first_ssh for call in docker_calls)

    ssh_options = [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
    ]
    target = "nexus@5.78.194.235"
    remote = "/tmp/nexus-infra-adoption.ABCDEFGH"
    scp_calls = [call for call in calls if call["command"] == "scp"]
    assert len(scp_calls) == 3
    for call in scp_calls:
        source = Path(call["arguments"][-2])
        name = source.name
        assert call["arguments"][:-2] == ssh_options
        assert call["arguments"][-1] == f"{target}:{remote}/{name}"
        assert source.parent.name.startswith("nexus-infra-adoption-")
        assert call["sha256"] == hashlib.sha256(tracked[name].read_bytes()).hexdigest()

    ssh_calls = [call for call in calls if call["command"] == "ssh"]
    assert len(ssh_calls) == 3
    assert all(call["arguments"][: len(ssh_options)] == ssh_options for call in ssh_calls)
    assert all(call["arguments"][len(ssh_options)] == target for call in ssh_calls)
    assert ssh_calls[0]["remote_arguments"] == [
        "mktemp",
        "-d",
        "/tmp/nexus-infra-adoption.XXXXXXXX",
    ]
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in tracked.items()}
    assert ssh_calls[1]["remote_arguments"] == [
        "sudo",
        "env",
        "PYTHONDONTWRITEBYTECODE=1",
        "python3",
        "-B",
        f"{remote}/adopt-infrastructure.py",
        "host",
        "--source-sha",
        SOURCE_SHA,
        "--compose",
        f"{remote}/docker-compose.yml",
        "--compose-sha256",
        hashes["docker-compose.yml"],
        "--caddy",
        f"{remote}/Caddyfile",
        "--caddy-sha256",
        hashes["Caddyfile"],
        "--owner",
        f"{remote}/adopt-infrastructure.py",
        "--owner-sha256",
        hashes["adopt-infrastructure.py"],
    ]
    assert ssh_calls[2]["remote_arguments"] == ["rm", "-r", "--", remote]
