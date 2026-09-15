"""Promoted release replay restores its backend before public auth smoke."""

from pathlib import Path
from unittest.mock import Mock

import pytest
from deploy.hetzner import release
from deploy.hetzner.release import (
    BackupPolicy,
    ContainerEvidence,
    HostRelease,
    ReleaseAttempt,
    ReleasePaths,
    ReleasePhase,
)

from nexus.release_artifact import CandidateImages, CandidateManifest


@pytest.mark.parametrize(
    "phase, expected_phase",
    [
        (ReleasePhase.BackendActivationStarted, ReleasePhase.AwaitingFrontendPromotion),
        (ReleasePhase.AwaitingFrontendPromotion, ReleasePhase.AwaitingFrontendPromotion),
        (ReleasePhase.FrontendPromoted, ReleasePhase.FrontendPromoted),
    ],
)
def test_apply_restores_candidate_without_regressing_promotion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    phase: ReleasePhase,
    expected_phase: ReleasePhase,
) -> None:
    candidate = CandidateManifest(
        schema_version=2,
        source_sha="a" * 40,
        repository="NielsdaWheelz/nexus-web",
        images=CandidateImages(
            api="ghcr.io/nielsdawheelz/nexus-api@sha256:" + "b" * 64,
            worker="ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "c" * 64,
        ),
        expected_database_revision="0229",
        expected_oracle_manifest_digest="sha256:" + "d" * 64,
    )
    attempt = ReleaseAttempt(
        schema_version=2,
        source_sha=candidate.source_sha,
        manifest_sha256="e" * 64,
        candidate_api_image_id="sha256:" + "b" * 64,
        candidate_worker_image_id="sha256:" + "c" * 64,
        predecessor_sha="f" * 40,
        forward_fix_of="1" * 40,
        containers={
            service: ContainerEvidence(
                container_id="2" * 64,
                image="sha256:" + "3" * 64,
                config_sha256="4" * 64,
            )
            for service in ("postgres", "caddy", "api", "worker-interactive", "worker-background")
        },
        config_path="/etc/nexus/config/" + "5" * 64 + ".env",
        config_sha256="5" * 64,
        vercel_deployment_id="dpl_candidate",
        production_host="nexus.example.invalid",
        phase=phase,
        backup_policy=BackupPolicy.Waived,
        backup=None,
        failure_code=None,
        created_at="2026-09-15T00:00:00Z",
        updated_at="2026-09-15T00:00:00Z",
    )
    host = HostRelease(ReleasePaths.under(tmp_path))
    monkeypatch.setattr(host.store, "active_attempt", lambda: attempt)
    monkeypatch.setattr(host.store, "load_attempt", lambda _sha: attempt)
    monkeypatch.setattr(host.store, "forward_fix_sha", lambda: attempt.forward_fix_of)
    save = Mock()
    monkeypatch.setattr(host.store, "replace_attempt", save)
    monkeypatch.setattr(host, "bundle", lambda _sha: tmp_path)
    monkeypatch.setattr(release, "load_candidate_manifest", lambda _path: candidate)
    for boundary in (
        "_require_codex_isolated_gateway_support",
        "_require_codex_state_storage",
        "_validate_codex_state_boot_guard",
        "_validate_release_inputs",
    ):
        monkeypatch.setattr(host, boundary, Mock())
    monkeypatch.setattr(
        host, "_requires_first_codex_capacity_qualification", Mock(return_value=True)
    )
    activate = Mock()
    monkeypatch.setattr(host, "_activate_backend", activate)

    result = host._apply_once(
        source_sha=attempt.source_sha,
        deployment_id=attempt.vercel_deployment_id,
        production_host=attempt.production_host,
        backup_policy=BackupPolicy.Waived,
    )

    activate.assert_called_once_with(bundle=tmp_path, candidate=candidate, attempt=attempt)
    assert result.phase is expected_phase
    assert result.vercel_deployment_id == attempt.vercel_deployment_id
    assert result.config_sha256 == attempt.config_sha256
    if phase is ReleasePhase.BackendActivationStarted:
        save.assert_called_once_with(result)
    else:
        assert result is attempt
        save.assert_not_called()
