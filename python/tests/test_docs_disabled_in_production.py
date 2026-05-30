"""The interactive API docs are reachable only outside production.

FastAPI serves `/docs`, `/redoc`, and `/openapi.json` in non-production
environments and disables them in staging/prod, so the API schema is never
served publicly on a deployed environment.
"""

import pytest
from fastapi.testclient import TestClient

from nexus.app import create_app
from nexus.config import clear_settings_cache

pytestmark = pytest.mark.unit

DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")

# A consistent environment for create_app. staging/prod additionally require a
# full deploy var set; local/test do not.
_BASE_ENV = {
    "DATABASE_URL": "postgresql+psycopg://localhost/test",
    "SUPABASE_JWKS_URL": "http://localhost:54321/auth/v1/.well-known/jwks.json",
    "SUPABASE_ISSUER": "http://localhost:54321/auth/v1",
    "SUPABASE_AUDIENCES": "authenticated",
    "PODCAST_INDEX_API_KEY": "test-key",
    "PODCAST_INDEX_API_SECRET": "test-secret",
    "YOUTUBE_DATA_API_KEY": "test-youtube-key",
    "X_API_BEARER_TOKEN": "test-x-token",
    # Keep app and stream origins identical so the cross-origin stream guard
    # in create_app does not fire for staging/prod.
    "APP_PUBLIC_URL": "http://localhost:8000",
    "STREAM_BASE_URL": "http://localhost:8000",
}
_DEPLOY_ENV = {
    "NEXUS_INTERNAL_SECRET": "internal-secret",
    "BILLING_ENABLED": "false",
    "R2_ENDPOINT_URL": "https://abc123.r2.cloudflarestorage.com",
    "R2_ACCESS_KEY_ID": "r2-access",
    "R2_SECRET_ACCESS_KEY": "r2-secret",
    "R2_BUCKET": "media",
}


def _client_for_env(env: str, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Build a TestClient whose app was created under the given NEXUS_ENV."""
    monkeypatch.setenv("NEXUS_ENV", env)
    for key, value in _BASE_ENV.items():
        monkeypatch.setenv(key, value)
    if env in ("staging", "prod"):
        for key, value in _DEPLOY_ENV.items():
            monkeypatch.setenv(key, value)
    # create_app reads cached settings; clear so the patched env is picked up.
    clear_settings_cache()
    return TestClient(create_app(skip_auth_middleware=True))


@pytest.mark.parametrize("env", ["staging", "prod"])
@pytest.mark.parametrize("path", DOCS_PATHS)
def test_docs_endpoints_disabled_in_production(
    env: str, path: str, monkeypatch: pytest.MonkeyPatch
):
    """Docs endpoints return 404 in staging/prod."""
    client = _client_for_env(env, monkeypatch)
    assert client.get(path).status_code == 404


@pytest.mark.parametrize("env", ["local", "test"])
@pytest.mark.parametrize("path", DOCS_PATHS)
def test_docs_endpoints_available_outside_production(
    env: str, path: str, monkeypatch: pytest.MonkeyPatch
):
    """Docs endpoints are served in local/test."""
    client = _client_for_env(env, monkeypatch)
    assert client.get(path).status_code == 200
