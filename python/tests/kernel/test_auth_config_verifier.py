from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parents[3]


def _provider_config(**overrides: object) -> dict[str, object]:
    config: dict[str, object] = {
        "disable_signup": True,
        "external_anonymous_users_enabled": False,
        "external_email_enabled": True,
        "external_github_enabled": True,
        "external_google_enabled": True,
        "external_phone_enabled": False,
        "custom_oauth_enabled": False,
        "mailer_autoconfirm": False,
        "mailer_allow_unverified_email_sign_ins": False,
        "mailer_notifications_password_changed_enabled": True,
        "password_hibp_enabled": False,
        "passkey_enabled": False,
        "saml_enabled": False,
        "security_captcha_enabled": False,
        "security_manual_linking_enabled": True,
        "security_update_password_require_reauthentication": False,
        "refresh_token_rotation_enabled": True,
        "refresh_token_reuse_interval": 10,
        "hook_after_user_created_enabled": False,
        "hook_before_user_created_enabled": False,
        "hook_custom_access_token_enabled": False,
        "hook_mfa_verification_attempt_enabled": False,
        "hook_password_verification_attempt_enabled": False,
        "hook_send_email_enabled": False,
        "hook_send_sms_enabled": False,
        "password_min_length": 15,
        "password_required_characters": "",
        "smtp_admin_email": "owner@nexus.example",
        "smtp_host": "smtp.nexus.example",
        "smtp_pass": "******",
        "smtp_sender_name": "Nexus",
        "smtp_user": "nexus",
        "smtp_port": 587,
        "mailer_subjects_invite": "You're invited to Nexus",
        "mailer_subjects_recovery": "Reset your Nexus password",
        "mailer_templates_invite_content": (REPO_ROOT / "supabase/templates/invite.html").read_text(
            encoding="utf-8"
        ),
        "mailer_templates_recovery_content": (
            REPO_ROOT / "supabase/templates/recovery.html"
        ).read_text(encoding="utf-8"),
        "site_url": "https://app.nexus.example",
        "uri_allow_list": "https://app.nexus.example/auth/callback",
    }
    config.update(overrides)
    return config


def _run_verifier(
    tmp_path: Path,
    config: dict[str, object],
    third_party_auth: list[object] | None = None,
) -> subprocess.CompletedProcess[str]:
    shared_env = tmp_path / "env-prod"
    shared_env.write_text(
        "APP_PUBLIC_URL=https://app.nexus.example\n"
        "SUPABASE_ISSUER=https://fixture.supabase.co/auth/v1\n"
        "SUPABASE_JWKS_URL=https://fixture.supabase.co/auth/v1/.well-known/jwks.json\n"
        "SUPABASE_AUDIENCES=authenticated\n",
        encoding="utf-8",
    )
    frontend_env = tmp_path / "env-prod-frontend"
    frontend_env.write_text(
        "FASTAPI_BASE_URL=https://api.nexus.example\n"
        "NEXT_PUBLIC_SUPABASE_URL=https://fixture.supabase.co\n"
        "AUTH_ALLOWED_REDIRECT_ORIGINS=https://app.nexus.example\n",
        encoding="utf-8",
    )
    fixture = tmp_path / "auth-config.json"
    fixture.write_text(json.dumps(config), encoding="utf-8")
    third_party_fixture = tmp_path / "third-party-auth.json"
    third_party_fixture.write_text(
        json.dumps([] if third_party_auth is None else third_party_auth),
        encoding="utf-8",
    )

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        "#!/bin/sh\n"
        '[ -z "${SUPABASE_MANAGEMENT_ACCESS_TOKEN+x}" ] || { echo "token leaked to curl environment" >&2; exit 3; }\n'
        "output=\n"
        "header=\n"
        "url=\n"
        'while [ "$#" -gt 0 ]; do\n'
        '  case "$1" in *test-operator-token*) echo "token leaked to curl argv" >&2; exit 4 ;; esac\n'
        '  if [ "$1" = "-o" ]; then shift; output=$1; fi\n'
        '  if [ "$1" = "-H" ]; then shift; header=$1; fi\n'
        '  case "$1" in https://*) url=$1 ;; esac\n'
        "  shift\n"
        "done\n"
        '[ -n "$output" ] || exit 2\n'
        'case "$header" in @*) header=${header#@} ;; *) echo "token leaked to curl argv" >&2; exit 4 ;; esac\n'
        '[ "$(stat -c %a "$header")" = "600" ] || { echo "header file permissions are not private" >&2; exit 5; }\n'
        '[ "$(cat "$header")" = "Authorization: Bearer test-operator-token" ] || exit 6\n'
        'case "$url" in\n'
        '  "https://api.supabase.com/v1/projects/fixture/config/auth") source=$NEXUS_AUTH_CONFIG_FIXTURE ;;\n'
        '  "https://api.supabase.com/v1/projects/fixture/config/auth/third-party-auth") source=$NEXUS_THIRD_PARTY_AUTH_FIXTURE ;;\n'
        "  *) exit 7 ;;\n"
        "esac\n"
        'cp "$source" "$output"\n',
        encoding="utf-8",
    )
    fake_curl.chmod(0o755)
    real_python = shutil.which("python3")
    assert real_python is not None
    fake_python = fake_bin / "python3"
    fake_python.write_text(
        "#!/bin/sh\n"
        '[ -z "${SUPABASE_MANAGEMENT_ACCESS_TOKEN+x}" ] || { echo "token leaked to python environment" >&2; exit 8; }\n'
        f'exec {shlex.quote(real_python)} "$@"\n',
        encoding="utf-8",
    )
    fake_python.chmod(0o755)

    environment = os.environ.copy()
    environment.update(
        {
            "NEXUS_AUTH_CONFIG_FIXTURE": str(fixture),
            "NEXUS_THIRD_PARTY_AUTH_FIXTURE": str(third_party_fixture),
            "PATH": f"{fake_bin}:{environment['PATH']}",
            "SUPABASE_MANAGEMENT_ACCESS_TOKEN": "test-operator-token",
        }
    )
    for name in (
        "NEXUS_SMOKE_APP_URL",
        "NEXUS_SMOKE_API_URL",
        "NEXUS_SMOKE_SUPABASE_URL",
    ):
        environment.pop(name, None)

    return subprocess.run(
        (
            str(REPO_ROOT / "deploy/supabase/verify-auth-config.sh"),
            "--env-file",
            str(shared_env),
            "--frontend-env-file",
            str(frontend_env),
        ),
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )


def test_auth_config_verifier_accepts_the_closed_membership_contract(tmp_path: Path) -> None:
    result = _run_verifier(tmp_path, _provider_config())

    assert result.returncode == 0
    assert result.stdout.strip() == (
        "PASS Supabase Auth configuration matches the closed-membership contract"
    )


@pytest.mark.parametrize(
    ("override", "field"),
    [
        ({"refresh_token_rotation_enabled": False}, "refresh_token_rotation_enabled"),
        ({"refresh_token_reuse_interval": 9}, "refresh_token_reuse_interval"),
    ],
)
def test_auth_config_verifier_requires_the_session_recovery_rotation_contract(
    tmp_path: Path,
    override: dict[str, object],
    field: str,
) -> None:
    result = _run_verifier(tmp_path, _provider_config(**override))

    assert result.returncode != 0
    assert field in result.stderr


def test_auth_config_verifier_rejects_third_party_auth_integrations(
    tmp_path: Path,
) -> None:
    result = _run_verifier(
        tmp_path,
        _provider_config(),
        third_party_auth=[{"id": "integration-1", "type": "oidc"}],
    )

    assert result.returncode != 0
    assert "third-party Auth integrations must be empty" in result.stderr
    assert "test-operator-token" not in result.stdout + result.stderr


@pytest.mark.parametrize(
    ("override", "field"),
    [
        ({"external_anonymous_users_enabled": True}, "external_anonymous_users_enabled"),
        ({"external_phone_enabled": True}, "external_phone_enabled"),
        ({"external_discord_enabled": True}, "external_discord_enabled"),
        ({"custom_oauth_enabled": True}, "custom_oauth_enabled"),
        ({"password_hibp_enabled": True}, "password_hibp_enabled"),
        ({"passkey_enabled": True}, "passkey_enabled"),
        ({"saml_enabled": True}, "saml_enabled"),
        ({"security_captcha_enabled": True}, "security_captcha_enabled"),
        ({"security_manual_linking_enabled": False}, "security_manual_linking_enabled"),
        (
            {"mailer_allow_unverified_email_sign_ins": True},
            "mailer_allow_unverified_email_sign_ins",
        ),
        ({"hook_send_email_enabled": True}, "hook_send_email_enabled"),
    ],
)
def test_auth_config_verifier_rejects_closed_membership_drift(
    tmp_path: Path,
    override: dict[str, object],
    field: str,
) -> None:
    result = _run_verifier(tmp_path, _provider_config(**override))

    assert result.returncode != 0
    assert field in result.stderr
    assert "test-operator-token" not in result.stdout + result.stderr


def test_auth_config_verifier_rejects_a_second_token_consuming_template_link(
    tmp_path: Path,
) -> None:
    canonical = _provider_config()
    canonical["mailer_templates_invite_content"] = (
        f"{canonical['mailer_templates_invite_content']}\n"
        '<a href="{{ .ConfirmationURL }}">Legacy invite</a>'
    )

    result = _run_verifier(tmp_path, canonical)

    assert result.returncode != 0
    assert "invitation template" in result.stderr


def test_auth_config_verifier_requires_a_configured_smtp_credential(
    tmp_path: Path,
) -> None:
    result = _run_verifier(tmp_path, _provider_config(smtp_pass=""))

    assert result.returncode != 0
    assert "smtp_pass" in result.stderr
    assert "test-operator-token" not in result.stdout + result.stderr


def test_auth_config_verifier_rejects_a_normalized_but_noncanonical_site_url(
    tmp_path: Path,
) -> None:
    result = _run_verifier(
        tmp_path,
        _provider_config(site_url="https://app.nexus.example/"),
    )

    assert result.returncode != 0
    assert "site_url" in result.stderr
