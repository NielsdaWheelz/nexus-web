"""Tests for the sole platform-key reader (nexus.services.llm_credentials)."""

import pytest
from provider_runtime import ProviderCredential, RuntimeDefect

from nexus.config import Settings
from nexus.services.llm_credentials import (
    embedding_credential,
    generation_credential,
    transcription_credential,
)

pytestmark = pytest.mark.unit


def _make_settings(**overrides) -> Settings:
    defaults = {
        "DATABASE_URL": "postgresql+psycopg://localhost/test",
        "NEXUS_ENV": "test",
        "SUPABASE_JWKS_URL": "http://localhost:54321/auth/v1/.well-known/jwks.json",
        "SUPABASE_ISSUER": "http://localhost:54321/auth/v1",
        "SUPABASE_AUDIENCES": "authenticated",
        "APP_PUBLIC_URL": "http://localhost:3000",
        "STRIPE_SECRET_KEY": "sk_test",
        "STRIPE_WEBHOOK_SECRET": "whsec_test",
        "STRIPE_PLUS_PRICE_ID": "price_plus",
        "STRIPE_AI_PLUS_PRICE_ID": "price_ai_plus",
        "STRIPE_AI_PRO_PRICE_ID": "price_ai_pro",
        "PODCASTS_ENABLED": True,
        "PODCAST_INDEX_API_KEY": "test-key",
        "PODCAST_INDEX_API_SECRET": "test-secret",
        "YOUTUBE_DATA_API_KEY": "test-youtube-key",
        "X_API_BEARER_TOKEN": "test-x-token",
    }
    defaults.update(overrides)
    return Settings(_env_file=None, **defaults)


@pytest.mark.parametrize(
    ("accessor", "settings_field", "env_alias"),
    [
        (generation_credential, "openai_api_key", "OPENAI_API_KEY"),
        (embedding_credential, "anthropic_api_key", "ANTHROPIC_API_KEY"),
        (transcription_credential, "moonshot_api_key", "MOONSHOT_API_KEY"),
    ],
)
def test_credential_accessors_return_provider_credential_for_present_key(
    accessor, settings_field, env_alias
):
    provider = {
        "openai_api_key": "openai",
        "anthropic_api_key": "anthropic",
        "moonshot_api_key": "moonshot",
    }[settings_field]
    settings = _make_settings(**{env_alias: "the-configured-key"})

    credential = accessor(settings, provider)

    assert isinstance(credential, ProviderCredential)
    assert credential.provider == provider
    assert credential.key == "the-configured-key"


@pytest.mark.parametrize(
    "accessor",
    [generation_credential, embedding_credential, transcription_credential],
)
def test_credential_accessors_raise_runtime_defect_for_missing_key(accessor):
    settings = _make_settings(GEMINI_API_KEY=None)

    with pytest.raises(RuntimeDefect, match="gemini"):
        accessor(settings, "gemini")


def test_missing_key_defect_carries_credential_missing_code():
    settings = _make_settings(OPENAI_API_KEY=None)

    with pytest.raises(RuntimeDefect) as exc_info:
        generation_credential(settings, "openai")

    assert exc_info.value.code == "credential_missing"
    assert exc_info.value.origin == "provider_http"


def test_empty_string_key_is_treated_as_missing():
    settings = _make_settings(ANTHROPIC_API_KEY="")

    with pytest.raises(RuntimeDefect, match="anthropic"):
        generation_credential(settings, "anthropic")
