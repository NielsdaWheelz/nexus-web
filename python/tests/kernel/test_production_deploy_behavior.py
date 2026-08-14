from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tests.testkit.production_deploy import (
    BOUND_DEPLOYMENT_ID,
    CURRENT_DEPLOYMENT_ID,
    EARLIEST_PUBLISHER_RUN_ID,
    ProductionDeployHarness,
)

REPO_ROOT = Path(__file__).parents[3]
SOURCE_SHA = "1" * 40
CURRENT_SHA = "a" * 40
FAILED_SHA = "b" * 40


def _inspect(
    *,
    status: str,
    current_sha: str | None,
    current_deployment_id: str | None,
    authoritative_bound_id: str | None = None,
    failed_deployment_ids: list[str] | None = None,
    forward_fix_sha: str | None = None,
    phase: str | None = None,
) -> dict[str, object]:
    return {
        "current_sha": current_sha,
        "current_vercel_deployment_id": current_deployment_id,
        "failed_vercel_deployment_ids": failed_deployment_ids or [],
        "forward_fix_sha": forward_fix_sha,
        "phase": phase,
        "predecessor_sha": current_sha if (phase is not None or status == "new") else None,
        "status": status,
        "vercel_deployment_id": authoritative_bound_id,
    }


def _harness(
    tmp_path: Path,
    *,
    inspect: dict[str, object],
    authoritative_id: str,
) -> ProductionDeployHarness:
    return ProductionDeployHarness.create(
        tmp_path,
        repo_root=REPO_ROOT,
        source_sha=SOURCE_SHA,
        host_inspect=inspect,
        authoritative_id=authoritative_id,
    )


def _events(state: dict[str, Any], command: str) -> list[list[str]]:
    return [event["arguments"] for event in state["events"] if event["command"] == command]


def _joined_events(state: dict[str, Any], command: str) -> list[str]:
    return [" ".join(arguments) for arguments in _events(state, command)]


def _assert_only_bound_candidate_mutates(state: dict[str, Any]) -> None:
    ssh = _joined_events(state, "ssh")
    apply = [command for command in ssh if " apply " in f" {command} "]
    finalize = [command for command in ssh if " finalize " in f" {command} "]
    assert len(apply) == 1
    assert len(finalize) == 1
    assert f"--deployment-id {BOUND_DEPLOYMENT_ID}" in apply[0]
    assert f"--deployment-id {BOUND_DEPLOYMENT_ID}" in finalize[0]
    promotions = [arguments for arguments in _events(state, "node") if "promote" in arguments]
    assert all(BOUND_DEPLOYMENT_ID in arguments for arguments in promotions)


def test_codex_agent_host_is_private_worker_image_with_credential_and_socket_isolation() -> None:
    """Risk: agent credentials or a control endpoint escape the narrow host."""

    compose = (REPO_ROOT / "deploy/hetzner/docker-compose.yml").read_text(encoding="utf-8")
    cloud_init = (REPO_ROOT / "deploy/hetzner/cloud-init.yml").read_text(encoding="utf-8")
    apparmor_profile = (REPO_ROOT / "deploy/hetzner/nexus-codex-agent-host.apparmor").read_text(
        encoding="utf-8"
    )
    nightly_apparmor_profile = (
        REPO_ROOT / "deploy/hetzner/nexus-codex-nightly-bwrap.apparmor"
    ).read_text(encoding="utf-8")
    release_workflow = (REPO_ROOT / ".github/workflows/backend-images.yml").read_text(
        encoding="utf-8"
    )
    nightly_workflow = (REPO_ROOT / ".github/workflows/codex-personal-nightly.yml").read_text(
        encoding="utf-8"
    )
    actionlint_config = (REPO_ROOT / ".github/actionlint.yaml").read_text(encoding="utf-8")
    worker_image = (REPO_ROOT / "docker/Dockerfile.backend").read_text(encoding="utf-8")
    controller = (REPO_ROOT / "deploy/hetzner/release.py").read_text(encoding="utf-8")
    start = compose.index("  nexus-codex-agent-host:\n")
    end = compose.index("  migration:\n", start)
    host = compose[start:end]
    background_start = compose.index("  worker-background:\n")
    background_end = compose.index("\n  nexus-codex-agent-host:\n", background_start)
    background = compose[background_start:background_end]

    assert "image: ${WORKER_IMAGE:?set an immutable candidate digest}" in host
    assert 'command: ["python", "-m", "apps.codex_agent.main"]' in host
    assert "env_file:" not in host
    assert "ports:" not in host
    assert "expose:" not in host
    assert "DATABASE_URL" not in host
    assert "OPENAI_API_KEY" not in host
    assert "NEXUS_CODEX_STATE_ROOT_BASE: /var/lib/nexus-codex" in host
    assert "NEXUS_CODEX_WORKING_DIRECTORY: /var/empty/nexus-codex" in host
    assert "NEXUS_CODEX_AGENT_SOCKET: /run/nexus-codex/agent.sock" in host
    assert "read_only: true" in host
    assert "mem_reservation: 128m" in host
    assert "mem_limit: 384m" in host
    assert "memswap_limit: 384m" in host
    assert "cpus: 1.0" in host
    assert "cap_drop:" in host and "- ALL" in host
    assert "no-new-privileges:true" in host
    assert "seccomp=unconfined" in host
    assert "apparmor=nexus-codex-agent-host" in host
    assert "systempaths=unconfined" in host
    assert "networks:\n      - codex_egress" in host
    assert "nexus_codex_state:/var/lib/nexus-codex" in host
    assert "nexus_codex_run:/run/nexus-codex" in host
    assert "nexus_codex_run:/run/nexus-codex:ro" in background
    assert "NEXUS_CODEX_AGENT_SOCKET: /run/nexus-codex/agent.sock" in background
    assert "nexus-codex-agent-host:" not in background
    assert "python -m apps.codex_agent.health" in host
    assert "apps.codex_agent.sandbox_health" not in host
    assert '"nexus-codex-agent-host"' in controller
    assert '"apps.codex_agent.sandbox_health"' in controller
    assert '"apps.codex_agent.health"' in controller
    assert 'host_config.get("NanoCpus") != 1_000_000_000' in controller
    assert '"seccomp=unconfined"' in controller
    assert '"apparmor=nexus-codex-agent-host"' in controller
    assert 'host_config.get("MaskedPaths") != []' in controller
    assert 'host_config.get("ReadonlyPaths") != []' in controller
    assert 'set(networks) != {"nexus_codex_egress"}' in controller
    assert "_prepare_codex_agent_host_state" not in controller
    assert '"install -d -o 10001 -g 10001 -m 0700 /var/lib/nexus-codex"' not in controller
    sync_env = (REPO_ROOT / "deploy/hetzner/sync-env.sh").read_text(encoding="utf-8")
    assert "reject_codex_host_runtime_keys" in sync_env
    assert (
        "CODEX_HOME NEXUS_CODEX_STATE_ROOT_BASE NEXUS_CODEX_WORKING_DIRECTORY NEXUS_CODEX_AGENT_SOCKET"
        in sync_env
    )
    assert "  codex_egress:\n    driver: bridge" in compose
    assert "  - apparmor" in cloud_init
    assert "kernel.apparmor_restrict_unprivileged_userns=1" in cloud_init
    assert "apparmor_restrict_unprivileged_userns=0" not in cloud_init
    assert "profile nexus-codex-agent-host flags=(unconfined)" in apparmor_profile
    assert "userns," in apparmor_profile
    assert "include if exists <local/" not in apparmor_profile
    assert (
        "profile nexus-codex-nightly-bwrap /usr/bin/bwrap flags=(unconfined)"
        in nightly_apparmor_profile
    )
    assert "userns," in nightly_apparmor_profile
    assert "nexus-codex-agent-host.apparmor" in release_workflow
    assert "runs-on: [self-hosted, linux, nexus-codex-nightly]" in nightly_workflow
    assert "- nexus-codex-nightly" in actionlint_config
    assert "cmp deploy/hetzner/nexus-codex-nightly-bwrap.apparmor" in nightly_workflow
    assert "/etc/apparmor.d/nexus-codex-nightly-bwrap" in nightly_workflow
    assert "chmod u+s /usr/bin/bwrap" not in worker_image


def test_existing_vps_capacity_qualification_is_immutable_and_exact_candidate_bound() -> None:
    """Risk: first 0216 promotion runs without exact, immutable measured-host evidence."""

    controller = (REPO_ROOT / "deploy/hetzner/release.py").read_text(encoding="utf-8")
    capacity_probe = (REPO_ROOT / "deploy/hetzner/prove-codex-capacity.sh").read_text(
        encoding="utf-8"
    )
    bundle_fetch = (REPO_ROOT / "deploy/hetzner/fetch-release-bundle.sh").read_text(
        encoding="utf-8"
    )
    release_workflow = (REPO_ROOT / ".github/workflows/backend-images.yml").read_text(
        encoding="utf-8"
    )
    capacity_canary = (REPO_ROOT / "apps/codex_agent/capacity_canary.py").read_text(
        encoding="utf-8"
    )

    assert "_MIN_HOST_MEMORY_BYTES = 1900 * 1024 * 1024" in controller
    assert "sum(_RESOURCE_LIMITS[service][0]forservicein_CAPACITY_SERVICES)" in "".join(
        controller.split()
    )
    assert "Codex capacity qualification" in controller
    assert "codex-capacity" in controller
    assert "chmod(0o444)" in controller
    assert "qualify-codex-capacity" in capacity_probe
    assert " apply " not in capacity_probe
    assert "install-bundle" in capacity_probe
    assert '"apps.codex_agent.capacity_canary"' in controller
    assert '("cold", UUID(' in capacity_canary
    assert '("warm_1", UUID(' in capacity_canary
    assert '("warm_2", UUID(' in capacity_canary
    assert "client.observe_turn(command)" in capacity_canary
    assert "prove-codex-capacity.sh" in release_workflow
    assert "prove-codex-capacity.sh" in bundle_fetch


def test_deploy_uses_existing_current_record_and_artifact_owner_publisher(
    tmp_path: Path,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=_inspect(
            status="new",
            current_sha=CURRENT_SHA,
            current_deployment_id=CURRENT_DEPLOYMENT_ID,
        ),
        authoritative_id=CURRENT_DEPLOYMENT_ID,
    )

    completed = harness.run()

    assert completed.returncode == 0, completed.stderr
    state = harness.state()
    downloads = [
        arguments for arguments in _events(state, "gh") if arguments[:2] == ["run", "download"]
    ]
    assert len(downloads) == 1
    assert downloads[0][2] == str(EARLIEST_PUBLISHER_RUN_ID)
    assert not any("adopt" in command.lower() for command in _joined_events(state, "ssh"))
    provider_urls = [arguments[-1] for arguments in _events(state, "curl")]
    assert any("projectId=prj_WFC4SZpNF9YV5DpHpc4EjctAS8zs" in url for url in provider_urls)
    assert all(
        "teamId=team_fKVvTyTsMBQ7qFjccFO17BJL" in url
        for url in provider_urls
        if url.startswith("https://api.vercel.com/")
    )
    _assert_only_bound_candidate_mutates(state)
    promotions = [args for args in _events(state, "node") if "promote" in args]
    assert len(promotions) == 1


def test_staged_frontend_auth_smoke_blocks_host_activation(
    tmp_path: Path,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=_inspect(
            status="new",
            current_sha=CURRENT_SHA,
            current_deployment_id=CURRENT_DEPLOYMENT_ID,
        ),
        authoritative_id=CURRENT_DEPLOYMENT_ID,
    )
    harness.update_state(candidate_auth_smoke_failure=True)

    failed = harness.run()

    assert failed.returncode != 0
    assert "staged frontend auth smoke failed before host activation" in failed.stderr
    state = harness.state()
    ssh = _joined_events(state, "ssh")
    assert not any(" apply " in f" {command} " for command in ssh)
    assert not any(" fail-auth-smoke " in f" {command} " for command in ssh)
    assert not any("promote" in arguments for arguments in _events(state, "node"))


@pytest.mark.parametrize(
    ("authoritative_id", "forward_fix_sha", "failed_deployment_ids", "promotes"),
    [
        (BOUND_DEPLOYMENT_ID, None, [], False),
        ("dpl_ActiveFailed", FAILED_SHA, ["dpl_ActiveFailed"], True),
    ],
    ids=("resume-bound", "active-epoch-failed"),
)
def test_deploy_accepts_only_resume_bound_or_active_epoch_failed_authority(
    tmp_path: Path,
    authoritative_id: str,
    forward_fix_sha: str | None,
    failed_deployment_ids: list[str],
    promotes: bool,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=_inspect(
            status="resume",
            current_sha=CURRENT_SHA,
            current_deployment_id=CURRENT_DEPLOYMENT_ID,
            authoritative_bound_id=BOUND_DEPLOYMENT_ID,
            failed_deployment_ids=failed_deployment_ids,
            forward_fix_sha=forward_fix_sha,
            phase="AwaitingFrontendPromotion",
        ),
        authoritative_id=authoritative_id,
    )

    completed = harness.run()

    assert completed.returncode == 0, completed.stderr
    state = harness.state()
    assert _events(state, "gh") == []
    _assert_only_bound_candidate_mutates(state)
    promotions = [args for args in _events(state, "node") if "promote" in args]
    assert bool(promotions) is promotes


@pytest.mark.parametrize(
    ("inspect", "authoritative_id", "message"),
    [
        (
            _inspect(
                status="current",
                current_sha=SOURCE_SHA,
                current_deployment_id=CURRENT_DEPLOYMENT_ID,
                authoritative_bound_id=CURRENT_DEPLOYMENT_ID,
                phase="Succeeded",
            ),
            "dpl_WrongCurrent",
            "differs from the current release record",
        ),
        (
            _inspect(
                status="new",
                current_sha=CURRENT_SHA,
                current_deployment_id=CURRENT_DEPLOYMENT_ID,
            ),
            "dpl_OrdinaryUnknown",
            "unknown before host mutation",
        ),
        (
            _inspect(
                status="new",
                current_sha=CURRENT_SHA,
                current_deployment_id=CURRENT_DEPLOYMENT_ID,
                failed_deployment_ids=["dpl_ActiveFailed"],
                forward_fix_sha=FAILED_SHA,
            ),
            "dpl_HistoricalFailed",
            "unknown before host mutation",
        ),
    ],
    ids=("wrong-current", "ordinary-unknown", "historical-failed"),
)
def test_deploy_rejects_unknown_authority_before_apply_or_promotion(
    tmp_path: Path,
    inspect: dict[str, object],
    authoritative_id: str,
    message: str,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=inspect,
        authoritative_id=authoritative_id,
    )

    failed = harness.run()

    assert failed.returncode != 0
    assert message in failed.stderr
    state = harness.state()
    ssh = _joined_events(state, "ssh")
    assert not any(" apply " in f" {command} " for command in ssh)
    assert not any(" finalize " in f" {command} " for command in ssh)
    assert not any("promote" in arguments for arguments in _events(state, "node"))


@pytest.mark.parametrize(
    ("phase", "expected_terminal"),
    [
        ("Prepared", "RolledBack"),
        ("WritersStopped", "RolledBack"),
        ("BackupVerified", "RolledBack"),
        ("DataMutationStarted", "ForwardFixRequired"),
        ("BackendActivationStarted", "ForwardFixRequired"),
        ("AwaitingFrontendPromotion", "ForwardFixRequired"),
        ("FrontendPromoted", "ForwardFixRequired"),
    ],
)
@pytest.mark.parametrize(
    ("api_status", "ready_state"),
    [(404, "READY"), (200, "ERROR"), (200, "CANCELED")],
)
def test_missing_or_terminal_bound_frontend_settles_without_reselection(
    tmp_path: Path,
    phase: str,
    expected_terminal: str,
    api_status: int,
    ready_state: str,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=_inspect(
            status="resume",
            current_sha=CURRENT_SHA,
            current_deployment_id=CURRENT_DEPLOYMENT_ID,
            authoritative_bound_id=BOUND_DEPLOYMENT_ID,
            phase=phase,
        ),
        authoritative_id=CURRENT_DEPLOYMENT_ID,
    )
    harness.update_state(bound_api_status=api_status, bound_ready_state=ready_state)

    failed = harness.run()

    assert failed.returncode != 0
    assert "host settlement completed" in failed.stderr
    state = harness.state()
    assert state["host_inspect"]["phase"] == expected_terminal
    fail_calls = [
        command for command in _joined_events(state, "ssh") if "fail-bound-frontend" in command
    ]
    assert len(fail_calls) == 1
    assert f"--deployment-id {BOUND_DEPLOYMENT_ID}" in fail_calls[0]
    assert not any(" apply " in f" {command} " for command in _joined_events(state, "ssh"))
    assert not any(" finalize " in f" {command} " for command in _joined_events(state, "ssh"))
    assert not any("promote" in arguments for arguments in _events(state, "node"))


def test_transient_bound_frontend_inspection_does_not_terminalize(
    tmp_path: Path,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=_inspect(
            status="resume",
            current_sha=CURRENT_SHA,
            current_deployment_id=CURRENT_DEPLOYMENT_ID,
            authoritative_bound_id=BOUND_DEPLOYMENT_ID,
            phase="AwaitingFrontendPromotion",
        ),
        authoritative_id=CURRENT_DEPLOYMENT_ID,
    )
    harness.update_state(bound_api_status=503)

    failed = harness.run()

    assert failed.returncode != 0
    assert "transient/operator HTTP 503" in failed.stderr
    state = harness.state()
    assert state["host_inspect"]["phase"] == "AwaitingFrontendPromotion"
    assert not any("fail-bound-frontend" in command for command in _joined_events(state, "ssh"))
    direct_inspections = [
        arguments
        for arguments in _events(state, "curl")
        if arguments[-1].startswith("https://api.vercel.com/v13/deployments/")
    ]
    assert len(direct_inspections) == 2


@pytest.mark.parametrize(
    ("payload_mode", "message"),
    [
        ("malformed", "response is malformed"),
        ("identity_mismatch", "identity disagrees"),
    ],
)
def test_untrustworthy_bound_frontend_response_fails_without_settlement(
    tmp_path: Path,
    payload_mode: str,
    message: str,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=_inspect(
            status="resume",
            current_sha=CURRENT_SHA,
            current_deployment_id=CURRENT_DEPLOYMENT_ID,
            authoritative_bound_id=BOUND_DEPLOYMENT_ID,
            phase="AwaitingFrontendPromotion",
        ),
        authoritative_id=CURRENT_DEPLOYMENT_ID,
    )
    harness.update_state(
        bound_payload_mode=payload_mode,
        bound_ready_state="ERROR",
    )

    failed = harness.run()

    assert failed.returncode != 0
    assert message in failed.stderr
    state = harness.state()
    assert state["host_inspect"]["phase"] == "AwaitingFrontendPromotion"
    assert not any("fail-bound-frontend" in call for call in _joined_events(state, "ssh"))
    assert not any(" apply " in f" {call} " for call in _joined_events(state, "ssh"))


@pytest.mark.parametrize(
    "project_identity_mode",
    ("mismatch", "system-env-disabled"),
)
def test_bound_404_cannot_settle_under_unproven_provider_scope(
    tmp_path: Path,
    project_identity_mode: str,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=_inspect(
            status="resume",
            current_sha=CURRENT_SHA,
            current_deployment_id=CURRENT_DEPLOYMENT_ID,
            authoritative_bound_id=BOUND_DEPLOYMENT_ID,
            phase="AwaitingFrontendPromotion",
        ),
        authoritative_id=CURRENT_DEPLOYMENT_ID,
    )
    harness.update_state(
        bound_api_status=404,
        project_identity_mode=project_identity_mode,
    )

    failed = harness.run()

    assert failed.returncode != 0
    assert "committed Vercel project/team identity" in failed.stderr
    state = harness.state()
    assert state["host_inspect"]["phase"] == "AwaitingFrontendPromotion"
    assert not any("fail-bound-frontend" in call for call in _joined_events(state, "ssh"))


@pytest.mark.parametrize("phase", ("RollbackRequired", "ForwardFixPending"))
def test_pending_settlement_uses_installed_bundle_without_provider_dependencies(
    tmp_path: Path,
    phase: str,
) -> None:
    harness = _harness(
        tmp_path,
        inspect=_inspect(
            status="resume",
            current_sha=CURRENT_SHA,
            current_deployment_id=CURRENT_DEPLOYMENT_ID,
            authoritative_bound_id=BOUND_DEPLOYMENT_ID,
            phase=phase,
        ),
        authoritative_id=CURRENT_DEPLOYMENT_ID,
    )

    settled = harness.run(include_provider_credentials=False)

    assert settled.returncode != 0
    assert "durable failure settlement unexpectedly returned success" in settled.stderr
    state = harness.state()
    assert _events(state, "gh") == []
    assert _events(state, "node") == []
    assert _events(state, "curl") == []
    apply = [command for command in _joined_events(state, "ssh") if " apply " in f" {command} "]
    assert len(apply) == 1
    assert f"--deployment-id {BOUND_DEPLOYMENT_ID}" in apply[0]
