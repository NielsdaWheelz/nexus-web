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
    "STREAM_CORS_ORIGINS": "https://app.nexus.test",
    "R2_S3_API_ORIGIN": "https://acct.r2.cloudflarestorage.com",
}

_FRONTEND_ENV = {
    "AUTH_ALLOWED_REDIRECT_ORIGINS": "https://app.nexus.test",
    "FASTAPI_BASE_URL": "https://api.nexus.test",
    "NEXT_PUBLIC_SUPABASE_URL": "https://ref.supabase.co",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "anon-key-value",
}


def _write_env(path: Path, values: dict[str, str]) -> None:
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))


def _write_frontend_env(path: Path, values: dict[str, str] | None = None) -> None:
    merged = dict(_FRONTEND_ENV)
    if values:
        merged.update(values)
    _write_env(path, merged)


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
    _write_frontend_env(frontend_env)

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
    _write_frontend_env(frontend_env)

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert "missing or empty" not in result.stderr


def test_sync_env_allows_empty_server_action_allowed_origins(tmp_path: Path):
    """Direct Vercel deployments keep same-origin Server Actions by leaving the list empty."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, _REQUIRED_ENV)
    _write_frontend_env(frontend_env, {"SERVER_ACTION_ALLOWED_ORIGINS": ""})

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert "SERVER_ACTION_ALLOWED_ORIGINS" not in result.stderr


def test_sync_env_accepts_server_action_domain_patterns(tmp_path: Path):
    """Host-rewriting frontend deployments use Next.js domain patterns, not URL origins."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, _REQUIRED_ENV)
    _write_frontend_env(
        frontend_env,
        {"SERVER_ACTION_ALLOWED_ORIGINS": "app.nexus.test,*.proxy.nexus.test"},
    )

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert "SERVER_ACTION_ALLOWED_ORIGINS must contain" not in result.stderr


@pytest.mark.parametrize(
    "value",
    [
        "https://app.nexus.test",
        "app.nexus.test/path",
        "*",
        "*.com",
        "*.co.uk",
        "localhost",
    ],
)
def test_sync_env_rejects_invalid_server_action_allowed_origins(tmp_path: Path, value: str):
    """The optional Server Action admission list is validated before any Vercel write."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, _REQUIRED_ENV)
    _write_frontend_env(frontend_env, {"SERVER_ACTION_ALLOWED_ORIGINS": value})

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert "SERVER_ACTION_ALLOWED_ORIGINS must contain" in result.stderr
    assert "vercel CLI must not run" not in result.stderr


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
    _write_frontend_env(frontend_env)

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert "R2_S3_API_ORIGIN must be the Cloudflare R2 S3 API origin" in result.stderr
    assert "vercel CLI must not run" not in result.stderr


def test_sync_env_rejects_invalid_auth_redirect_origin(tmp_path: Path):
    """Production auth redirect origins are exact HTTPS origins."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, _REQUIRED_ENV)
    _write_frontend_env(
        frontend_env,
        {"AUTH_ALLOWED_REDIRECT_ORIGINS": "https://app.nexus.test/path"},
    )

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert "auth origin env contract is invalid" in result.stderr
    assert "vercel CLI must not run" not in result.stderr


def test_sync_env_requires_server_action_origins_for_trusted_proxy_origins(
    tmp_path: Path,
):
    """Host-rewriting proxy auth origins also need Next's Server Action admission list."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, _REQUIRED_ENV)
    _write_frontend_env(
        frontend_env,
        {"AUTH_TRUSTED_PROXY_ORIGINS": "https://proxy.nexus.test"},
    )

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert "auth origin env contract is invalid" in result.stderr
    assert "vercel CLI must not run" not in result.stderr


def test_sync_env_accepts_trusted_proxy_with_server_action_origins(tmp_path: Path):
    """Trusted proxy auth origins are valid when the Next.js admission list is explicit."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, _REQUIRED_ENV)
    _write_frontend_env(
        frontend_env,
        {
            "AUTH_TRUSTED_PROXY_ORIGINS": "https://proxy.nexus.test",
            "SERVER_ACTION_ALLOWED_ORIGINS": "app.nexus.test",
        },
    )

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert "auth origin env contract is invalid" not in result.stderr
    assert "SERVER_ACTION_ALLOWED_ORIGINS must contain" not in result.stderr


def test_sync_env_rejects_invalid_extension_redirect_origin(tmp_path: Path):
    """Extension redirect origins are frontend-only HTTPS origins, not URLs with paths."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, _REQUIRED_ENV)
    _write_frontend_env(
        frontend_env,
        {"NEXUS_EXTENSION_REDIRECT_ORIGINS": "https://extension.nexus.test/path"},
    )

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert "auth origin env contract is invalid" in result.stderr
    assert "vercel CLI must not run" not in result.stderr


@pytest.mark.parametrize(
    "key,value",
    [
        ("AUTH_ALLOWED_REDIRECT_ORIGINS", "https://app.nexus.test"),
        ("AUTH_TRUSTED_PROXY_ORIGINS", "https://proxy.nexus.test"),
        ("SERVER_ACTION_ALLOWED_ORIGINS", "app.nexus.test"),
        ("NEXUS_EXTENSION_REDIRECT_ORIGINS", "https://extension.nexus.test"),
        ("NEXT_PUBLIC_SUPABASE_URL", "https://ref.supabase.co"),
        ("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key-value"),
        ("FASTAPI_BASE_URL", "https://api.nexus.test"),
    ],
)
def test_sync_env_rejects_frontend_only_keys_in_shared_env(tmp_path: Path, key: str, value: str):
    """Frontend-only keys must not be hidden in env-prod and uploaded to the VPS."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared = dict(_REQUIRED_ENV)
    shared[key] = value
    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, shared)
    _write_frontend_env(frontend_env)

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert f"{key} must live in env-prod-frontend" in result.stderr
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
    _write_frontend_env(frontend_env)

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert f"{removed_key} must not be present" in result.stderr
    assert "vercel CLI must not run" not in result.stderr


@pytest.mark.parametrize(
    "forbidden_key",
    [
        "SUPABASE_DATABASE_URL",
        "SUPABASE_AUTH_ADMIN_KEY",
        "SUPABASE_SERVICE_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SERVICE_ROLE_KEY",
        "X_API_BEARER_TOKEN",
        "X_API_INCLUDE_USER_EXPANSIONS",
    ],
)
def test_sync_env_rejects_backend_runtime_keys(tmp_path: Path, forbidden_key: str):
    """Backend runtime env cannot be synced into Vercel production."""
    fake_bin_dir = tmp_path / "bin"
    fake_bin_dir.mkdir()
    _fake_vercel_cli(fake_bin_dir)

    shared = dict(_REQUIRED_ENV)
    shared[forbidden_key] = "forbidden-secret"
    shared_env = tmp_path / "env-prod"
    frontend_env = tmp_path / "env-prod-frontend"
    _write_env(shared_env, shared)
    _write_frontend_env(frontend_env)

    result = _run_sync_env(shared_env, frontend_env, fake_bin_dir)

    assert result.returncode != 0, result.stdout
    assert f"{forbidden_key} must not be present" in result.stderr
    assert "vercel CLI must not run" not in result.stderr
