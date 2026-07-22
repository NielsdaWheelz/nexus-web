"""Startup-time validation of STREAM_CORS_ORIGINS against APP_PUBLIC_URL.

`create_app` must reject (in staging/prod) a configuration where the
`STREAM_CORS_ORIGINS` whitelist does not contain the canonical
`APP_PUBLIC_URL` origin. Without this guard the StreamCORSMiddleware
would 403 every preflight in production despite the env being "set".
"""

import logging

import pytest

from nexus.app import create_app
from nexus.config import clear_settings_cache

pytestmark = pytest.mark.unit

# Mirrors the env scaffolding used in test_docs_disabled_in_production.py.
_BASE_ENV = {
    "DATABASE_URL": "postgresql+psycopg://localhost/test",
    "SUPABASE_JWKS_URL": "http://localhost:54321/auth/v1/.well-known/jwks.json",
    "SUPABASE_ISSUER": "http://localhost:54321/auth/v1",
    "SUPABASE_AUDIENCES": "authenticated",
    "PODCAST_INDEX_API_KEY": "test-key",
    "PODCAST_INDEX_API_SECRET": "test-secret",
    "YOUTUBE_DATA_API_KEY": "test-youtube-key",
}
_DEPLOY_ENV = {
    "NEXUS_INTERNAL_SECRET": "internal-secret",
    "BILLING_ENABLED": "false",
    "R2_S3_API_ORIGIN": "https://abc123.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY_ID": "r2-access",
    "R2_SECRET_ACCESS_KEY": "r2-secret",
    "R2_BUCKET": "media",
    "X_API_BEARER_TOKEN": "test-x-api-bearer-token",
    # Platform LLM provider keys + Fable retention acceptance are required in
    # staging/prod (config.validate_required_settings, spec §12).
    "OPENAI_API_KEY": "sk-test-openai",
    "ANTHROPIC_API_KEY": "sk-test-anthropic",
    "GEMINI_API_KEY": "test-gemini",
    "MOONSHOT_API_KEY": "sk-test-moonshot",
    "NEXUS_FABLE_RETENTION_ACCEPTED_AT": "2026-01-01T00:00:00Z",
}


def _apply_env(monkeypatch: pytest.MonkeyPatch, env: str, overrides: dict[str, str]) -> None:
    monkeypatch.setenv("NEXUS_ENV", env)
    for key, value in _BASE_ENV.items():
        monkeypatch.setenv(key, value)
    if env in ("staging", "prod"):
        for key, value in _DEPLOY_ENV.items():
            monkeypatch.setenv(key, value)
    for key, value in overrides.items():
        monkeypatch.setenv(key, value)
    clear_settings_cache()


def test_prod_raises_when_cors_list_missing_app_public_url_origin(
    monkeypatch: pytest.MonkeyPatch,
):
    """STREAM_CORS_ORIGINS set but missing APP_PUBLIC_URL origin -> RuntimeError in prod."""
    _apply_env(
        monkeypatch,
        "prod",
        {
            "APP_PUBLIC_URL": "https://nexus.nielseriknandal.com",
            "STREAM_BASE_URL": "https://stream.nielseriknandal.com",
            "STREAM_CORS_ORIGINS": "https://other.example.com",
            "STREAM_TOKEN_SIGNING_KEY": "dGVzdC1zdHJlYW0tdG9rZW4tc2lnbmluZy1rZXktMzJieXRlcw==",
        },
    )
    with pytest.raises(RuntimeError, match="https://nexus.nielseriknandal.com"):
        create_app(skip_auth_middleware=True)


def test_prod_succeeds_when_cors_list_contains_app_public_url_origin(
    monkeypatch: pytest.MonkeyPatch,
):
    """STREAM_CORS_ORIGINS containing APP_PUBLIC_URL origin -> clean boot in prod."""
    _apply_env(
        monkeypatch,
        "prod",
        {
            "APP_PUBLIC_URL": "https://nexus.nielseriknandal.com",
            "STREAM_BASE_URL": "https://stream.nielseriknandal.com",
            "STREAM_CORS_ORIGINS": ("https://nexus.nielseriknandal.com,https://preview.foo.app"),
            "STREAM_TOKEN_SIGNING_KEY": "dGVzdC1zdHJlYW0tdG9rZW4tc2lnbmluZy1rZXktMzJieXRlcw==",
        },
    )
    # Should not raise.
    create_app(skip_auth_middleware=True)


def test_local_warns_when_cors_list_missing_app_public_url_origin(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
):
    """In local/dev, a missing app origin is a warning, not a fatal error."""
    _apply_env(
        monkeypatch,
        "local",
        {
            "APP_PUBLIC_URL": "http://localhost:3000",
            "STREAM_BASE_URL": "http://localhost:8000",
            "STREAM_CORS_ORIGINS": "https://other.example.com",
        },
    )
    with caplog.at_level(logging.WARNING):
        create_app(skip_auth_middleware=True)
    assert any(
        "stream_cors_middleware_missing_app_public_url_origin" in record.getMessage()
        for record in caplog.records
    )
