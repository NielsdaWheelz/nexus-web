from __future__ import annotations

import base64

import pytest

from nexus.config import Environment, Settings


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "DATABASE_URL": "postgresql+psycopg://127.0.0.1:54320/nexus",
        "SUPABASE_JWKS_URL": "https://auth.example.invalid/.well-known/jwks.json",
        "SUPABASE_ISSUER": "https://auth.example.invalid",
        "SUPABASE_AUDIENCES": "authenticated",
    }
    values.update(overrides)
    return Settings(**values, _env_file=None)  # pyright: ignore[reportCallIssue]


def test_generation_provider_configuration_is_closed_and_secret_bound() -> None:
    continuation_key = base64.b64encode(b"k" * 32).decode("ascii")
    settings = _settings(
        GENERATION_API_PROVIDERS=("openai,anthropic,gemini,moonshot,openrouter,deepseek,xai"),
        OPENAI_GENERATION_API_KEY="openai",
        ANTHROPIC_GENERATION_API_KEY="anthropic",
        GEMINI_GENERATION_API_KEY="gemini",
        MOONSHOT_GENERATION_API_KEY="moonshot",
        OPENROUTER_GENERATION_API_KEY="openrouter",
        DEEPSEEK_GENERATION_API_KEY="deepseek",
        XAI_GENERATION_API_KEY="xai",
        GENERATION_CONTINUATION_ENCRYPTION_KEY=continuation_key,
        NEXUS_FABLE_RETENTION_ACCEPTED_AT="2026-08-31T00:00:00Z",
    )

    assert settings.generation_api_provider_list == (
        "openai",
        "anthropic",
        "gemini",
        "moonshot",
        "openrouter",
        "deepseek",
        "xai",
    )

    with pytest.raises(ValueError, match="duplicate"):
        _settings(GENERATION_API_PROVIDERS="openai,openai")
    with pytest.raises(ValueError, match="unknown"):
        _settings(GENERATION_API_PROVIDERS="openai,unknown")
    with pytest.raises(ValueError, match="unconfigured provider openai"):
        _settings(OPENAI_GENERATION_API_KEY="stale-secret")
    with pytest.raises(ValueError, match="Anthropic is unconfigured"):
        _settings(NEXUS_FABLE_RETENTION_ACCEPTED_AT="2026-08-31T00:00:00Z")


def test_generation_provider_configuration_fails_closed_on_missing_authority() -> None:
    continuation_key = base64.b64encode(b"k" * 32).decode("ascii")

    with pytest.raises(ValueError, match="OPENAI_GENERATION_API_KEY"):
        _settings(
            GENERATION_API_PROVIDERS="openai",
            GENERATION_CONTINUATION_ENCRYPTION_KEY=continuation_key,
        )
    with pytest.raises(ValueError, match="GENERATION_CONTINUATION_ENCRYPTION_KEY"):
        _settings(
            GENERATION_API_PROVIDERS="openai",
            OPENAI_GENERATION_API_KEY="openai",
        )
    with pytest.raises(ValueError, match="32-byte"):
        _settings(
            GENERATION_API_PROVIDERS="openai",
            OPENAI_GENERATION_API_KEY="openai",
            GENERATION_CONTINUATION_ENCRYPTION_KEY=base64.b64encode(b"short").decode("ascii"),
        )
    with pytest.raises(ValueError, match="NEXUS_FABLE_RETENTION_ACCEPTED_AT"):
        _settings(
            GENERATION_API_PROVIDERS="anthropic",
            ANTHROPIC_GENERATION_API_KEY="anthropic",
            GENERATION_CONTINUATION_ENCRYPTION_KEY=continuation_key,
        )
    deployed = _settings()
    deployed.nexus_env = Environment.PROD
    with pytest.raises(ValueError, match="GENERATION_API_PROVIDERS"):
        deployed._validate_deployed_generation_runtime()

    local_key = base64.b64decode(
        _settings().effective_generation_continuation_encryption_key.get_secret_value(),
        validate=True,
    )
    assert len(local_key) == 32


def test_podcasts_default_to_disabled_without_provider_credentials() -> None:
    settings = _settings(
        PODCAST_INDEX_API_KEY=None,
        PODCAST_INDEX_API_SECRET=None,
    )

    assert settings.podcasts_enabled is False


@pytest.mark.parametrize("nexus_env", [Environment.LOCAL, Environment.TEST])
@pytest.mark.parametrize(
    ("missing_alias", "present_alias", "present_value"),
    [
        ("PODCAST_INDEX_API_KEY", "PODCAST_INDEX_API_SECRET", "secret"),
        ("PODCAST_INDEX_API_SECRET", "PODCAST_INDEX_API_KEY", "key"),
    ],
)
def test_enabled_podcasts_reject_missing_provider_credentials(
    nexus_env: Environment,
    missing_alias: str,
    present_alias: str,
    present_value: str,
) -> None:
    with pytest.raises(ValueError, match=missing_alias):
        _settings(
            NEXUS_ENV=nexus_env,
            PODCASTS_ENABLED=True,
            **{missing_alias: None, present_alias: present_value},
        )


def test_enabled_podcasts_preserve_explicit_admission() -> None:
    settings = _settings(
        PODCASTS_ENABLED=True,
        PODCAST_INDEX_API_KEY="key",
        PODCAST_INDEX_API_SECRET="secret",
    )

    assert settings.podcasts_enabled is True
