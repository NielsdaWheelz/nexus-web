"""The Vercel env-sync script rejects empty required production values.

`deploy/vercel/sync-env.sh` validates the merged production env locally before
it writes anything to Vercel. An empty required value must fail that validation
and abort the sync, naming the offending key, so a half-configured production
env can never reach Vercel.
"""

import stat
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SYNC_ENV_SCRIPT = _REPO_ROOT / "deploy" / "vercel" / "sync-env.sh"

# Every key the script requires, with non-placeholder values. The placeholder
# guard rejects `<`, `>`, `example.com`, and `changeme`, so values steer clear
# of those. NEXUS_ENV must be `prod` for a production sync.
_REQUIRED_ENV = {
    "NEXUS_ENV": "prod",
    "APP_PUBLIC_URL": "https://app.nexus.test",
    "SUPABASE_ISSUER": "https://ref.supabase.co/auth/v1",
    "SUPABASE_JWKS_URL": "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
    "SUPABASE_AUDIENCES": "authenticated",
    "NEXUS_INTERNAL_SECRET": "a-long-random-internal-secret",
    "AUTH_ALLOWED_REDIRECT_ORIGINS": "https://app.nexus.test",
    "STREAM_CORS_ORIGINS": "https://app.nexus.test",
    "FASTAPI_BASE_URL": "https://api.nexus.test",
    "R2_S3_API_ORIGIN": "https://acct.r2.cloudflarestorage.com",
    "NEXT_PUBLIC_SUPABASE_URL": "https://ref.supabase.co",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "anon-key-value",
}


def _write_env(path: Path, values: dict[str, str]) -> None:
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))


def _fake_vercel_cli(directory: Path) -> Path:
    """Install a stub `vercel` so the script clears its CLI-present guard.

    Validation runs before any `vercel` invocation, so an empty required value
    aborts the sync without this stub ever being executed. Made to fail loudly
    if it ever is, which would mean validation did not stop the sync.
    """
    fake = directory / "vercel"
    fake.write_text('#!/usr/bin/env bash\necho "vercel CLI must not run" >&2\nexit 1\n')
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return fake


def _run_sync_env(shared_env: Path, frontend_env: Path, fake_bin_dir: Path):
    return subprocess.run(
        ["bash", str(_SYNC_ENV_SCRIPT)],
        env={
            "PATH": f"{fake_bin_dir}:/usr/bin:/bin",
            "NEXUS_SHARED_ENV": str(shared_env),
            "NEXUS_FRONTEND_ENV": str(frontend_env),
        },
        capture_output=True,
        text=True,
    )


def test_sync_env_fails_when_a_required_value_is_empty(tmp_path: Path):
    """An empty required key aborts the sync nonzero, naming the key."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared = dict(_REQUIRED_ENV)
    shared["SUPABASE_ISSUER"] = ""
    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, shared)
    frontend_env.write_text("")

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert "missing or empty" in result.stderr
    assert "SUPABASE_ISSUER" in result.stderr
    # Validation must abort before the script ever shells out to `vercel`.
    assert "vercel CLI must not run" not in result.stderr


def test_sync_env_passes_validation_when_all_required_values_are_present(
    tmp_path: Path,
):
    """A fully populated env clears the required-value validation.

    This is the negative control for the test above: it proves the abort is
    caused by the empty value, not by an unrelated guard that would fail any
    invocation. The stub `vercel` makes the sync fail past validation, so the
    check is the absence of the validation error, not a zero exit.
    """
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, _REQUIRED_ENV)
    frontend_env.write_text("")

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert "missing or empty" not in result.stderr


def test_sync_env_rejects_invalid_r2_s3_api_origin(tmp_path: Path):
    """The shared public R2 origin must be Cloudflare's origin-only S3 API URL."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared = dict(_REQUIRED_ENV)
    shared["R2_S3_API_ORIGIN"] = "https://storage.nexus.test/path"
    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, shared)
    frontend_env.write_text("")

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert "R2_S3_API_ORIGIN must be the Cloudflare R2 S3 API origin" in result.stderr
    assert "vercel CLI must not run" not in result.stderr


@pytest.mark.parametrize("removed_key", ["R2_ENDPOINT_URL", "CSP_EXTRA_CONNECT_ORIGINS"])
def test_sync_env_rejects_removed_storage_origin_keys(tmp_path: Path, removed_key: str):
    """Removed storage-origin env names cannot be present in the Vercel env set."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared = dict(_REQUIRED_ENV)
    shared[removed_key] = "https://acct.r2.cloudflarestorage.com"
    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, shared)
    frontend_env.write_text("")

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert f"{removed_key} must not be present" in result.stderr
    assert "vercel CLI must not run" not in result.stderr
