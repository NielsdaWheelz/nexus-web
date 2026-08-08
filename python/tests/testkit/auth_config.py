"""Canonical closed-membership Supabase Auth fixture for executable tests."""

from __future__ import annotations

from pathlib import Path


def provider_config(repo_root: Path, **overrides: object) -> dict[str, object]:
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
        "security_refresh_token_reuse_interval": 10,
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
        "mailer_templates_invite_content": (repo_root / "supabase/templates/invite.html").read_text(
            encoding="utf-8"
        ),
        "mailer_templates_recovery_content": (
            repo_root / "supabase/templates/recovery.html"
        ).read_text(encoding="utf-8"),
        "site_url": "https://app.nexus.example",
        "uri_allow_list": "https://app.nexus.example/auth/callback",
    }
    config.update(overrides)
    return config
