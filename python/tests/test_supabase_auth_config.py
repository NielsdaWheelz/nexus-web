import pytest

from scripts.supabase_auth_config import (
    FORBIDDEN_SUPABASE_AUTH_CONFIG_KEYS,
    MISSING_SUPABASE_AUTH_CONFIG_MESSAGE,
    SupabaseAuthConfigError,
    load_supabase_auth_config,
    resolve_supabase_auth_config,
)

pytestmark = pytest.mark.unit


def test_resolve_supabase_auth_config_uses_strict_env_values():
    config = resolve_supabase_auth_config(
        {
            "SUPABASE_URL": "https://supabase.example",
            "SUPABASE_AUTH_ADMIN_KEY": "env-service-key",
        }
    )

    assert config == ("https://supabase.example", "env-service-key")


@pytest.mark.parametrize(
    "environ",
    [
        {},
        {"SUPABASE_URL": "http://127.0.0.1:54321"},
        {"SUPABASE_AUTH_ADMIN_KEY": "secret-key"},
    ],
)
def test_resolve_supabase_auth_config_returns_none_when_required_env_is_missing(environ):
    assert resolve_supabase_auth_config(environ) is None


def test_load_supabase_auth_config_raises_when_required_env_is_missing(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_AUTH_ADMIN_KEY", raising=False)

    with pytest.raises(SupabaseAuthConfigError, match=MISSING_SUPABASE_AUTH_CONFIG_MESSAGE):
        load_supabase_auth_config()


@pytest.mark.parametrize("forbidden_key", FORBIDDEN_SUPABASE_AUTH_CONFIG_KEYS)
def test_resolve_supabase_auth_config_rejects_legacy_admin_aliases(forbidden_key):
    with pytest.raises(SupabaseAuthConfigError, match=forbidden_key):
        resolve_supabase_auth_config(
            {
                "SUPABASE_URL": "http://127.0.0.1:54321",
                "SUPABASE_AUTH_ADMIN_KEY": "secret-key",
                forbidden_key: "legacy-secret",
            }
        )
