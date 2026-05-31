import subprocess

import pytest

from scripts import supabase_auth_config
from scripts.supabase_auth_config import (
    MISSING_SUPABASE_AUTH_CONFIG_MESSAGE,
    load_supabase_auth_config,
    resolve_supabase_auth_config,
)

pytestmark = pytest.mark.unit


def test_resolve_supabase_auth_config_prefers_env_values():
    config = resolve_supabase_auth_config(
        {
            "SUPABASE_URL": "https://supabase.example",
            "SUPABASE_AUTH_ADMIN_KEY": "env-service-key",
        },
        status={"API_URL": "http://127.0.0.1:54321", "SERVICE_ROLE_KEY": "local-key"},
    )

    assert config == ("https://supabase.example", "env-service-key")


def test_resolve_supabase_auth_config_uses_local_status_service_role_key():
    config = resolve_supabase_auth_config(
        {},
        status={"API_URL": "http://127.0.0.1:54321", "SERVICE_ROLE_KEY": "local-key"},
    )

    assert config == ("http://127.0.0.1:54321", "local-key")


def test_load_supabase_auth_config_filters_supabase_cli_status_warnings(
    monkeypatch,
):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_AUTH_ADMIN_KEY", raising=False)

    def fake_check_output(*args: object, **kwargs: object) -> str:
        _ = args, kwargs
        return (
            "Stopped services: imgproxy\n"
            '{"API_URL": "http://127.0.0.1:54321", "SECRET_KEY": "secret-key"}'
        )

    monkeypatch.setattr(
        supabase_auth_config.subprocess,
        "check_output",
        fake_check_output,
    )

    assert load_supabase_auth_config() == (
        "http://127.0.0.1:54321",
        "secret-key",
    )


def test_load_supabase_auth_config_raises_when_env_and_status_are_missing(
    monkeypatch,
):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_AUTH_ADMIN_KEY", raising=False)

    def fail_check_output(*args: object, **kwargs: object) -> str:
        _ = args, kwargs
        raise subprocess.CalledProcessError(1, ["supabase"])

    monkeypatch.setattr(
        supabase_auth_config.subprocess,
        "check_output",
        fail_check_output,
    )

    with pytest.raises(RuntimeError, match=MISSING_SUPABASE_AUTH_CONFIG_MESSAGE):
        load_supabase_auth_config()
