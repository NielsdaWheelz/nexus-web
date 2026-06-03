import json
import stat
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SCRIPT = _REPO_ROOT / "deploy" / "supabase" / "verify-auth-redirects.sh"


def _write_env(path: Path, values: dict[str, str]) -> None:
    path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))


def _fake_curl(directory: Path) -> None:
    curl = directory / "curl"
    curl.write_text(
        """#!/usr/bin/env python3
import os
import sys

if os.environ.get("FAKE_CURL_FAIL") == "1":
    sys.exit(22)
out = sys.argv[sys.argv.index("-o") + 1]
with open(out, "w", encoding="utf-8") as handle:
    handle.write(os.environ["SUPABASE_CONFIG_JSON"])
"""
    )
    curl.chmod(curl.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _run(tmp_path: Path, config: dict[str, object]):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _fake_curl(fake_bin)

    shared = tmp_path / "env-prod"
    frontend = tmp_path / "env-prod-frontend"
    _write_env(
        shared,
        {
            "APP_PUBLIC_URL": "https://app.nexus.test",
            "SUPABASE_ISSUER": "https://ref.supabase.co/auth/v1",
            "SUPABASE_JWKS_URL": "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
            "SUPABASE_AUDIENCES": "authenticated",
        },
    )
    _write_env(
        frontend,
        {
            "AUTH_ALLOWED_REDIRECT_ORIGINS": "https://app.nexus.test",
            "NEXT_PUBLIC_SUPABASE_URL": "https://ref.supabase.co",
        },
    )

    return subprocess.run(
        [
            "bash",
            str(_SCRIPT),
            "--env-file",
            str(shared),
            "--frontend-env-file",
            str(frontend),
        ],
        env={
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "SUPABASE_MANAGEMENT_ACCESS_TOKEN": "management-token",
            "SUPABASE_CONFIG_JSON": json.dumps(config),
        },
        capture_output=True,
        text=True,
    )


def _run_with_env(
    tmp_path: Path,
    config: dict[str, object],
    shared_values: dict[str, str],
    frontend_values: dict[str, str],
):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _fake_curl(fake_bin)

    shared = tmp_path / "env-prod"
    frontend = tmp_path / "env-prod-frontend"
    _write_env(shared, shared_values)
    _write_env(frontend, frontend_values)

    return subprocess.run(
        [
            "bash",
            str(_SCRIPT),
            "--env-file",
            str(shared),
            "--frontend-env-file",
            str(frontend),
        ],
        env={
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "SUPABASE_MANAGEMENT_ACCESS_TOKEN": "management-token",
            "SUPABASE_CONFIG_JSON": json.dumps(config),
        },
        capture_output=True,
        text=True,
    )


def test_supabase_redirect_verifier_passes_exact_callback_allowlist(tmp_path: Path):
    result = _run(
        tmp_path,
        {
            "site_url": "https://app.nexus.test",
            "uri_allow_list": "https://app.nexus.test/auth/callback",
        },
    )

    assert result.returncode == 0, result.stderr
    assert "PASS Supabase Auth redirect config matches" in result.stdout


def test_supabase_redirect_verifier_fails_missing_callback(tmp_path: Path):
    result = _run(
        tmp_path,
        {
            "site_url": "https://app.nexus.test",
            "uri_allow_list": "",
        },
    )

    assert result.returncode != 0
    assert "missing a configured /auth/callback URL" in result.stderr
    assert "https://app.nexus.test/auth/callback" not in result.stderr


def test_supabase_redirect_verifier_rejects_wildcards(tmp_path: Path):
    result = _run(
        tmp_path,
        {
            "site_url": "https://app.nexus.test",
            "uri_allow_list": "https://app.nexus.test/auth/callback,https://**",
        },
    )

    assert result.returncode != 0
    assert "must not contain wildcards" in result.stderr


def test_supabase_redirect_verifier_fails_unreadable_config(tmp_path: Path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _fake_curl(fake_bin)
    shared = tmp_path / "env-prod"
    frontend = tmp_path / "env-prod-frontend"
    _write_env(
        shared,
        {
            "APP_PUBLIC_URL": "https://app.nexus.test",
            "SUPABASE_ISSUER": "https://ref.supabase.co/auth/v1",
            "SUPABASE_JWKS_URL": "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
            "SUPABASE_AUDIENCES": "authenticated",
        },
    )
    _write_env(
        frontend,
        {
            "AUTH_ALLOWED_REDIRECT_ORIGINS": "https://app.nexus.test",
            "NEXT_PUBLIC_SUPABASE_URL": "https://ref.supabase.co",
        },
    )

    result = subprocess.run(
        ["bash", str(_SCRIPT), "--env-file", str(shared), "--frontend-env-file", str(frontend)],
        env={
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "SUPABASE_MANAGEMENT_ACCESS_TOKEN": "management-token",
            "SUPABASE_CONFIG_JSON": "{}",
            "FAKE_CURL_FAIL": "1",
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "could not read Supabase Auth config" in result.stderr


def test_supabase_redirect_verifier_fails_site_url_mismatch(tmp_path: Path):
    result = _run(
        tmp_path,
        {
            "site_url": "https://other.nexus.test",
            "uri_allow_list": "https://app.nexus.test/auth/callback",
        },
    )

    assert result.returncode != 0
    assert "site_url does not match APP_PUBLIC_URL" in result.stderr


def test_supabase_redirect_verifier_fails_http_app_origin(tmp_path: Path):
    result = _run_with_env(
        tmp_path,
        {
            "site_url": "http://app.nexus.test",
            "uri_allow_list": "http://app.nexus.test/auth/callback",
        },
        {
            "APP_PUBLIC_URL": "http://app.nexus.test",
            "SUPABASE_ISSUER": "https://ref.supabase.co/auth/v1",
            "SUPABASE_JWKS_URL": "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
            "SUPABASE_AUDIENCES": "authenticated",
        },
        {
            "AUTH_ALLOWED_REDIRECT_ORIGINS": "http://app.nexus.test",
            "NEXT_PUBLIC_SUPABASE_URL": "https://ref.supabase.co",
        },
    )

    assert result.returncode != 0
    assert "APP_PUBLIC_URL must be an HTTPS origin" in result.stderr


def test_supabase_redirect_verifier_requires_app_origin_in_redirect_origins(
    tmp_path: Path,
):
    result = _run_with_env(
        tmp_path,
        {
            "site_url": "https://app.nexus.test",
            "uri_allow_list": "https://other.nexus.test/auth/callback",
        },
        {
            "APP_PUBLIC_URL": "https://app.nexus.test",
            "SUPABASE_ISSUER": "https://ref.supabase.co/auth/v1",
            "SUPABASE_JWKS_URL": "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
            "SUPABASE_AUDIENCES": "authenticated",
        },
        {
            "AUTH_ALLOWED_REDIRECT_ORIGINS": "https://other.nexus.test",
            "NEXT_PUBLIC_SUPABASE_URL": "https://ref.supabase.co",
        },
    )

    assert result.returncode != 0
    assert "APP_PUBLIC_URL must be included" in result.stderr


def test_supabase_redirect_verifier_does_not_print_management_token(tmp_path: Path):
    result = _run(
        tmp_path,
        {
            "site_url": "https://app.nexus.test",
            "uri_allow_list": "",
        },
    )

    assert result.returncode != 0
    assert "management-token" not in result.stdout
    assert "management-token" not in result.stderr


def test_supabase_redirect_verifier_fails_malformed_json_without_traceback(
    tmp_path: Path,
):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _fake_curl(fake_bin)
    shared = tmp_path / "env-prod"
    frontend = tmp_path / "env-prod-frontend"
    _write_env(
        shared,
        {
            "APP_PUBLIC_URL": "https://app.nexus.test",
            "SUPABASE_ISSUER": "https://ref.supabase.co/auth/v1",
            "SUPABASE_JWKS_URL": "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
            "SUPABASE_AUDIENCES": "authenticated",
        },
    )
    _write_env(
        frontend,
        {
            "AUTH_ALLOWED_REDIRECT_ORIGINS": "https://app.nexus.test",
            "NEXT_PUBLIC_SUPABASE_URL": "https://ref.supabase.co",
        },
    )

    result = subprocess.run(
        ["bash", str(_SCRIPT), "--env-file", str(shared), "--frontend-env-file", str(frontend)],
        env={
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "SUPABASE_MANAGEMENT_ACCESS_TOKEN": "management-token",
            "SUPABASE_CONFIG_JSON": "{",
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "not readable JSON" in result.stderr
    assert "Traceback" not in result.stderr
