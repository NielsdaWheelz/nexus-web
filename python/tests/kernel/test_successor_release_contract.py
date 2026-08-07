"""Static contract for the successor-only immutable release protocol."""

from __future__ import annotations

from pathlib import Path

REPO_ROOT = Path(__file__).parents[3]


def test_successor_release_has_no_one_time_controller_or_genesis_path() -> None:
    """The completed infrastructure cutover is historical, not executable code."""
    assert not (REPO_ROOT / "deploy/hetzner/adopt-infrastructure.py").exists()
    for relative in (
        "deploy/hetzner/deploy.sh",
        "deploy/hetzner/release.py",
        "deployment.md",
        "python/nexus_test_control/runner.py",
        "testdata/proofs.json",
    ):
        text = (REPO_ROOT / relative).read_text(encoding="utf-8")
        assert "adopt-infrastructure.py" not in text
        assert "adopt-genesis-vercel-deployment" not in text
        assert "genesis_vercel_deployment" not in text
        assert "genesis-vercel-deployment" not in text


def test_canonical_environment_example_has_only_explicit_config_publication_controls() -> None:
    text = (REPO_ROOT / ".env.example").read_text(encoding="utf-8")
    for retired in (
        "NEXUS_DEPLOY_PATH",
        "NEXUS_ENV_FILE",
        "NEXUS_REMOTE_ENV_FILE",
        "CUTOVER_SHA",
        "NEXUS_SYNC_ENV",
        "NEXUS_SUPABASE_EXIT_CONFIRM",
    ):
        assert retired not in text
    assert "NEXUS_SHARED_ENV=deploy/env/env-prod" in text
    assert "NEXUS_BACKEND_ENV=deploy/env/env-prod-backend" in text
    assert "NEXUS_WORKER_ENV=deploy/env/env-prod-worker" in text


def test_backend_publisher_disables_implicit_build_record_artifacts() -> None:
    workflow = (REPO_ROOT / ".github/workflows/backend-images.yml").read_text(encoding="utf-8")
    assert 'DOCKER_BUILD_RECORD_UPLOAD: "false"' in workflow
