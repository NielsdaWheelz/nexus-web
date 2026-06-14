"""Hetzner env sync validates required production provider values locally."""

import stat
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SYNC_ENV_SCRIPT = _REPO_ROOT / "deploy" / "hetzner" / "sync-env.sh"
_WORKER_ENV_EXAMPLE = _REPO_ROOT / "deploy" / "env" / "env-prod-worker.example"
_SAFE_WORKER_ALLOWED_JOB_KINDS = (
    "ingest_media_source,enrich_metadata,chat_run,"
    "library_intelligence_artifact_generate,media_unit_build,note_reindex_job,"
    "podcast_sync_subscription_job,podcast_reindex_semantic_job,"
    "backfill_default_library_closure_job,oracle_reading_generate,synapse_scan"
)

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
    "NEXUS_KEY_ENCRYPTION_KEY": "key",
    "STREAM_TOKEN_SIGNING_KEY": "stream-key",
    "STREAM_BASE_URL": "https://api.nexus.test",
    "BILLING_ENABLED": "false",
    "PODCASTS_ENABLED": "false",
    "YOUTUBE_DATA_API_KEY": "youtube-key",
    "X_API_BEARER_TOKEN": "x-token",
}
_WORKER_ENV = {
    "WORKER_ALLOWED_JOB_KINDS": _SAFE_WORKER_ALLOWED_JOB_KINDS,
    "PODCAST_ACTIVE_POLL_SCHEDULE_SECONDS": "0",
    "INGEST_RECONCILE_SCHEDULE_SECONDS": "0",
    "SYNC_GUTENBERG_CATALOG_SCHEDULE_SECONDS": "0",
    "BACKGROUND_JOB_PRUNE_SCHEDULE_SECONDS": "0",
}


def _write_env(path: Path, values: dict[str, str]) -> None:
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))


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


def test_hetzner_sync_rejects_unsafe_worker_allowlist(tmp_path: Path):
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_bin(fake_bin_dir, "ssh")
    _fake_bin(fake_bin_dir, "scp")

    shared_env = tmp_path / "env-prod"
    backend_env = tmp_path / "env-prod-backend"
    worker_env = tmp_path / "env-prod-worker"
    worker = dict(_WORKER_ENV)
    worker["WORKER_ALLOWED_JOB_KINDS"] = "ingest_media_source,ingest_pdf,enrich_metadata,chat_run"
    _write_env(shared_env, _SHARED_ENV)
    _write_env(backend_env, _BACKEND_ENV)
    _write_env(worker_env, worker)

    result = _run_sync(shared_env, backend_env, worker_env, fake_bin_dir)

    assert result.returncode != 0
    assert "WORKER_ALLOWED_JOB_KINDS is not the safe production allowlist" in result.stderr
    assert "scp must not run" not in result.stderr


def test_worker_env_example_matches_safe_allowlist():
    """The operator-copied example must not drift from the safe allowlist.

    Operators ``cp env-prod-worker.example env-prod-worker`` per the deploy
    READMEs, so a stale ``WORKER_ALLOWED_JOB_KINDS`` here makes ``sync-env.sh``
    abort with "is not the safe production allowlist".
    """
    example_value: str | None = None
    for line in _WORKER_ENV_EXAMPLE.read_text().splitlines():
        if line.startswith("WORKER_ALLOWED_JOB_KINDS="):
            example_value = line.split("=", 1)[1]
            break

    assert example_value is not None, f"WORKER_ALLOWED_JOB_KINDS not found in {_WORKER_ENV_EXAMPLE}"
    assert example_value == _SAFE_WORKER_ALLOWED_JOB_KINDS


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
