"""Hetzner env sync validates required production provider values locally."""

import stat
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SYNC_ENV_SCRIPT = _REPO_ROOT / "deploy" / "hetzner" / "sync-env.sh"
_WORKER_ENV_EXAMPLE = _REPO_ROOT / "deploy" / "env" / "env-prod-worker.example"

_SHARED_ENV = {
    "NEXUS_ENV": "prod",
    "APP_PUBLIC_URL": "https://nexus.test",
    "SUPABASE_ISSUER": "https://ref.supabase.co/auth/v1",
    "SUPABASE_JWKS_URL": "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
    "SUPABASE_AUDIENCES": "authenticated",
    "NEXUS_INTERNAL_SECRET": "internal-secret",
    "STREAM_CORS_ORIGINS": "https://nexus.test",
    "R2_S3_API_ORIGIN": "https://acct.r2.cloudflarestorage.com",
}
_BACKEND_ENV = {
    "CADDY_SITE": "api.nexus.test",
    "CADDY_ACME_EMAIL": "ops@nexus.test",
    "POSTGRES_USER": "nexus",
    "POSTGRES_PASSWORD": "postgres-password",
    "POSTGRES_DB": "nexus",
    "DATABASE_URL": "postgresql+psycopg://nexus:postgres-password@postgres:5432/nexus",
    "R2_ACCESS_KEY_ID": "r2-access",
    "R2_SECRET_ACCESS_KEY": "r2-secret",
    "R2_BUCKET": "media",
    "NEXUS_ORACLE_CORPUS_OWNER_USER_ID": "00000000-0000-0000-0000-000000000001",
    "STREAM_TOKEN_SIGNING_KEY": "stream-key",
    "STREAM_BASE_URL": "https://api.nexus.test",
    "BILLING_ENABLED": "false",
    "PODCASTS_ENABLED": "false",
    "YOUTUBE_DATA_API_KEY": "youtube-key",
    "X_API_BEARER_TOKEN": "x-token",
    "OPENAI_API_KEY": "openai-key",
    "ANTHROPIC_API_KEY": "anthropic-key",
    "GEMINI_API_KEY": "gemini-key",
    "MOONSHOT_API_KEY": "moonshot-key",
    "NEXUS_FABLE_RETENTION_ACCEPTED_AT": "2026-01-01T00:00:00Z",
}
_WORKER_ENV = {
    "PODCAST_REFRESH_DUE_SCHEDULE_SECONDS": "900",
    "PODCAST_REFRESH_DUE_LIMIT": "100",
    "INGEST_RECONCILE_SCHEDULE_SECONDS": "600",
    "SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS": "0",
    "BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS": "0",
}


def _write_env(path: Path, values: dict[str, str]) -> None:
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))


def _read_env_value(path: Path, key: str) -> str | None:
    for line in path.read_text().splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return None


def _fake_bin(directory: Path, name: str) -> None:
    path = directory / name
    path.write_text(f'#!/usr/bin/env bash\necho "{name} must not run" >&2\nexit 1\n')
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _run_sync(shared_env: Path, backend_env: Path, worker_env: Path, fake_bin_dir: Path):
    return subprocess.run(
        ["bash", str(_SYNC_ENV_SCRIPT)],
        env={
            "PATH": f"{fake_bin_dir}:/usr/bin:/bin",
            "NEXUS_SHARED_ENV": str(shared_env),
            "NEXUS_BACKEND_ENV": str(backend_env),
            "NEXUS_WORKER_ENV": str(worker_env),
            "NEXUS_REMOTE_ENV_FILE": "/tmp/nexus.env",
        },
        capture_output=True,
        text=True,
    )


def test_hetzner_sync_requires_x_api_bearer_token(tmp_path: Path):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    backend = dict(_BACKEND_ENV)
    backend["X_API_BEARER_TOKEN"] = ""
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, backend)
    _write_env(worker_env, _WORKER_ENV)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert "missing or empty" in result.stderr
    assert "X_API_BEARER_TOKEN" in result.stderr
    assert "scp must not run" not in result.stderr


def test_hetzner_sync_requires_oracle_corpus_owner_user_id(tmp_path: Path):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    backend = dict(_BACKEND_ENV)
    backend["NEXUS_ORACLE_CORPUS_OWNER_USER_ID"] = ""
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, backend)
    _write_env(worker_env, _WORKER_ENV)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert "missing or empty" in result.stderr
    assert "NEXUS_ORACLE_CORPUS_OWNER_USER_ID" in result.stderr
    assert "scp must not run" not in result.stderr


def test_hetzner_sync_accepts_x_api_bearer_token(tmp_path: Path):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, _BACKEND_ENV)
    _write_env(worker_env, _WORKER_ENV)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert "missing or empty" not in result.stderr
    assert "scp must not run" in result.stderr


@pytest.mark.parametrize(
    "missing_key",
    [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "MOONSHOT_API_KEY",
        "NEXUS_FABLE_RETENTION_ACCEPTED_AT",
    ],
)
def test_hetzner_sync_requires_platform_llm_settings(tmp_path: Path, missing_key: str):
    """The 4 platform LLM keys and the Fable retention assertion are required."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    backend = dict(_BACKEND_ENV)
    backend[missing_key] = ""
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, backend)
    _write_env(worker_env, _WORKER_ENV)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert "missing or empty" in result.stderr
    assert missing_key in result.stderr
    assert "scp must not run" not in result.stderr


def test_hetzner_sync_rejects_key_encryption_key(tmp_path: Path):
    """NEXUS_KEY_ENCRYPTION_KEY was removed with BYOK; it can never be set again."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    backend = dict(_BACKEND_ENV)
    backend["NEXUS_KEY_ENCRYPTION_KEY"] = "some-encryption-key"
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, backend)
    _write_env(worker_env, _WORKER_ENV)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert "NEXUS_KEY_ENCRYPTION_KEY was removed" in result.stderr
    assert "scp must not run" not in result.stderr


@pytest.mark.parametrize("forbidden_key", ["CLOUDFLARE_AI_API_TOKEN", "CLOUDFLARE_AI_ACCOUNT_ID"])
def test_hetzner_sync_rejects_cloudflare_ai_keys(tmp_path: Path, forbidden_key: str):
    """Cloudflare AI keys were removed; Cloudflare is no longer an LLM provider."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    backend = dict(_BACKEND_ENV)
    backend[forbidden_key] = "some-cloudflare-value"
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, backend)
    _write_env(worker_env, _WORKER_ENV)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert f"{forbidden_key} was removed" in result.stderr
    assert "scp must not run" not in result.stderr


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("WORKER_LANE", "background"),
        ("WORKER_ALLOWED_JOB_KINDS", "prune_background_jobs_job"),
        ("NEXUS_ALLOW_WORKER_MAINTENANCE", "1"),
    ],
)
def test_hetzner_sync_rejects_stored_worker_invocation_state(
    tmp_path: Path,
    key: str,
    value: str,
):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    worker = dict(_WORKER_ENV)
    worker[key] = value
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, _BACKEND_ENV)
    _write_env(worker_env, worker)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert f"{key} is invocation-owned" in result.stderr
    assert "scp must not run" not in result.stderr


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS", "0"),
        ("PODCAST_ACTIVE_POLL_LIMIT", "100"),
        ("PODCAST_ACTIVE_POLL_RUN_LEASE_SECONDS", "900"),
        ("PODCAST_SYNC_RUNNING_LEASE_SECONDS", ""),
    ],
)
def test_hetzner_sync_rejects_removed_podcast_runtime_keys(
    tmp_path: Path,
    key: str,
    value: str,
):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    worker = dict(_WORKER_ENV)
    worker[key] = value
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, _BACKEND_ENV)
    _write_env(worker_env, worker)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert f"{key} was removed by the Podcast freshness hard cut" in result.stderr
    assert "scp must not run" not in result.stderr


def test_worker_env_example_uses_background_schedule_contract():
    assert _read_env_value(_WORKER_ENV_EXAMPLE, "WORKER_LANE") is None
    assert _read_env_value(_WORKER_ENV_EXAMPLE, "WORKER_ALLOWED_JOB_KINDS") is None
    assert _read_env_value(_WORKER_ENV_EXAMPLE, "NEXUS_ALLOW_WORKER_MAINTENANCE") is None
    assert _read_env_value(_WORKER_ENV_EXAMPLE, "INGEST_RECONCILE_SCHEDULE_SECONDS") == "600"
    assert _read_env_value(_WORKER_ENV_EXAMPLE, "PODCAST_REFRESH_DUE_SCHEDULE_SECONDS") == "900"
    assert _read_env_value(_WORKER_ENV_EXAMPLE, "PODCAST_REFRESH_DUE_LIMIT") == "100"


def test_hetzner_sync_requires_reconciliation_schedule(tmp_path: Path):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    worker = dict(_WORKER_ENV)
    worker["INGEST_RECONCILE_SCHEDULE_SECONDS"] = "0"
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, _BACKEND_ENV)
    _write_env(worker_env, worker)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert "INGEST_RECONCILE_SCHEDULE_SECONDS must be 600" in result.stderr
    assert "scp must not run" not in result.stderr


@pytest.mark.parametrize(
    "schedule_key",
    [
        "SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS",
        "BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS",
    ],
)
def test_hetzner_sync_rejects_positive_maintenance_schedule(
    tmp_path: Path,
    schedule_key: str,
):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    worker = dict(_WORKER_ENV)
    worker[schedule_key] = "3600"
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, _BACKEND_ENV)
    _write_env(worker_env, worker)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert f"{schedule_key} must be 0" in result.stderr
    assert "scp must not run" not in result.stderr


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("PODCAST_REFRESH_DUE_SCHEDULE_SECONDS", "0"),
        ("PODCAST_REFRESH_DUE_SCHEDULE_SECONDS", "0900"),
        ("PODCAST_REFRESH_DUE_LIMIT", "0"),
        ("PODCAST_REFRESH_DUE_LIMIT", "many"),
    ],
)
def test_hetzner_sync_requires_canonical_positive_podcast_refresh_values(
    tmp_path: Path,
    key: str,
    value: str,
):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    worker = dict(_WORKER_ENV)
    worker[key] = value
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, _BACKEND_ENV)
    _write_env(worker_env, worker)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert f"{key} must be a canonical positive integer" in result.stderr
    assert "scp must not run" not in result.stderr


def test_hetzner_sync_rejects_removed_x_expansion_knob(tmp_path: Path):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    backend = dict(_BACKEND_ENV)
    backend["X_API_INCLUDE_USER_EXPANSIONS"] = "false"
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, backend)
    _write_env(worker_env, _WORKER_ENV)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert "X_API_INCLUDE_USER_EXPANSIONS was removed" in result.stderr
    assert "scp must not run" not in result.stderr
