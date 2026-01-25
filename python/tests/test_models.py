"""Integration tests for models registry routes and service.

Tests cover PR-03 requirements:
- Model filtering based on key availability (platform keys and BYOK)
- Auth tests: endpoint requires authentication

Per PR-03 spec, a model is available to a user iff:
- model.is_available = true
- AND (platform key exists for model.provider OR user has BYOK with status ∈ {untested, valid})

Keys with status='invalid' or status='revoked' do NOT enable models.
"""

import base64
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.config import clear_settings_cache
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.crypto import MASTER_KEY_SIZE, clear_master_key_cache
from tests.helpers import auth_headers, create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture(autouse=True)
def setup_test_master_key(monkeypatch):
    """Set up a deterministic test master key for all tests."""
    clear_master_key_cache()

    test_key = b"test_master_key_for_encryption!!"
    assert len(test_key) == MASTER_KEY_SIZE

    test_key_b64 = base64.b64encode(test_key).decode("ascii")
    monkeypatch.setenv("NEXUS_KEY_ENCRYPTION_KEY", test_key_b64)

    yield

    clear_master_key_cache()


@pytest.fixture
def auth_client(engine):
    """Create a client with auth middleware for testing."""
    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    verifier = MockJwtVerifier()
    app = create_app(skip_auth_middleware=True)

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    return TestClient(app)


def seed_test_models(session: Session) -> None:
    """Seed test models if they don't exist."""
    # Check if models already exist
    result = session.execute(text("SELECT COUNT(*) FROM models"))
    if result.scalar() > 0:
        return

    # Seed test models
    session.execute(
        text("""
            INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
            VALUES
                (gen_random_uuid(), 'openai', 'gpt-4o-mini', 128000, true),
                (gen_random_uuid(), 'openai', 'gpt-4o', 128000, true),
                (gen_random_uuid(), 'anthropic', 'claude-sonnet-4-20250514', 200000, true),
                (gen_random_uuid(), 'anthropic', 'claude-haiku-4-20250514', 200000, true),
                (gen_random_uuid(), 'gemini', 'gemini-2.0-flash', 1000000, true)
            ON CONFLICT DO NOTHING
        """)
    )
    session.commit()


# =============================================================================
# Model Filtering Tests (PR-03 spec: "Model Filtering Tests")
# =============================================================================


class TestModelFiltering:
    """Tests for model availability filtering based on key status."""

    def test_no_keys_no_platform_key_returns_empty_list(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """No keys + no platform key → empty model list."""
        user_id = create_test_user_id()

        # Ensure no platform keys
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_platform_key_enables_provider_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Platform key present for provider → that provider's models appear."""
        user_id = create_test_user_id()

        # Set platform key for openai only
        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Should only have openai models
        providers = {m["provider"] for m in data}
        assert providers == {"openai"}
        assert len(data) == 2  # gpt-4o-mini and gpt-4o

    def test_byok_untested_enables_provider_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """BYOK with status='untested' → provider models appear."""
        user_id = create_test_user_id()

        # No platform keys
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Create BYOK key (status defaults to 'untested')
        auth_client.post(
            "/keys",
            json={"provider": "anthropic", "api_key": "sk-ant-test-key-1234567890abcdef"},
            headers=auth_headers(user_id),
        )

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Should only have anthropic models
        providers = {m["provider"] for m in data}
        assert providers == {"anthropic"}
        assert len(data) == 2  # claude-sonnet and claude-haiku

    def test_byok_valid_enables_provider_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """BYOK with status='valid' → provider models appear."""
        user_id = create_test_user_id()

        # No platform keys
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Create BYOK key
        auth_client.post(
            "/keys",
            json={"provider": "gemini", "api_key": "AIzaSy-test-key-1234567890abcdef"},
            headers=auth_headers(user_id),
        )

        # Set status to 'valid'
        with direct_db.session() as session:
            session.execute(
                text(
                    "UPDATE user_api_keys SET status = 'valid' "
                    "WHERE user_id = :user_id AND provider = 'gemini'"
                ),
                {"user_id": user_id},
            )
            session.commit()

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Should have gemini models
        providers = {m["provider"] for m in data}
        assert providers == {"gemini"}

    def test_byok_invalid_does_not_enable_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """BYOK with status='invalid' → provider models do NOT appear."""
        user_id = create_test_user_id()

        # No platform keys
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Create BYOK key
        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key-1234567890abcdefghij"},
            headers=auth_headers(user_id),
        )

        # Set status to 'invalid' (simulating failed auth)
        with direct_db.session() as session:
            session.execute(
                text(
                    "UPDATE user_api_keys SET status = 'invalid' "
                    "WHERE user_id = :user_id AND provider = 'openai'"
                ),
                {"user_id": user_id},
            )
            session.commit()

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_byok_revoked_does_not_enable_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """BYOK with status='revoked' → provider models do NOT appear."""
        user_id = create_test_user_id()

        # No platform keys
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Create BYOK key
        resp = auth_client.post(
            "/keys",
            json={"provider": "anthropic", "api_key": "sk-ant-test-key-1234567890abcdef"},
            headers=auth_headers(user_id),
        )
        key_id = resp.json()["data"]["id"]

        # Revoke the key
        auth_client.delete(f"/keys/{key_id}", headers=auth_headers(user_id))

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_multiple_providers_combined(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Platform + BYOK combined show all available provider models."""
        user_id = create_test_user_id()

        # Platform key for openai
        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # BYOK for gemini
        auth_client.post(
            "/keys",
            json={"provider": "gemini", "api_key": "AIzaSy-test-key-1234567890abcdef"},
            headers=auth_headers(user_id),
        )

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Should have both openai and gemini models
        providers = {m["provider"] for m in data}
        assert providers == {"openai", "gemini"}


# =============================================================================
# Model Response Format Tests
# =============================================================================


class TestModelResponseFormat:
    """Tests for model response format."""

    def test_model_response_has_required_fields(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Model response includes id, provider, model_name, max_context_tokens."""
        user_id = create_test_user_id()

        # Platform key for openai
        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) > 0

        model = data[0]
        assert "id" in model
        assert "provider" in model
        assert "model_name" in model
        assert "max_context_tokens" in model


# =============================================================================
# Auth Tests (PR-03 spec: "Auth Tests")
# =============================================================================


class TestModelsAuth:
    """Tests that models endpoint requires authentication."""

    def test_get_models_without_auth_returns_401(self, client):
        """GET /models without auth returns 401 E_UNAUTHENTICATED."""
        response = client.get("/models")

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "E_UNAUTHENTICATED"
