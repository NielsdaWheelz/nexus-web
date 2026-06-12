"""Integration tests for models registry routes and service.

Tests cover model availability behavior:
- Model filtering based on billing-entitled platform keys and BYOK
- Auth tests: endpoint requires authentication

A model is available to a user iff:
- model.is_available = true
- model.provider is enabled by feature flag
- AND (user has AI-tier access to a platform key for model.provider OR user has decryptable BYOK with status ∈ {untested, valid})

Keys with invalid status, revoked status, or undecryptable key material do NOT enable models.
"""

import base64

import pytest
from sqlalchemy import text

from nexus.config import clear_settings_cache
from nexus.errors import ApiError, ApiErrorCode
from nexus.services.api_key_resolver import resolve_api_key
from nexus.services.billing_entitlements import grant_entitlement_override
from nexus.services.crypto import MASTER_KEY_SIZE, _get_master_key
from nexus.services.models import list_available_models
from tests.factories import seed_test_models
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture(autouse=True)
def setup_test_master_key(monkeypatch):
    """Set up a deterministic test master key for all tests."""
    _get_master_key.cache_clear()

    test_key = b"test_master_key_for_encryption!!"
    assert len(test_key) == MASTER_KEY_SIZE

    test_key_b64 = base64.b64encode(test_key).decode("ascii")
    monkeypatch.setenv("NEXUS_KEY_ENCRYPTION_KEY", test_key_b64)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
    monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("ENABLE_OPENAI", raising=False)
    monkeypatch.delenv("ENABLE_ANTHROPIC", raising=False)
    monkeypatch.delenv("ENABLE_GEMINI", raising=False)
    monkeypatch.delenv("ENABLE_OPENROUTER", raising=False)
    monkeypatch.delenv("ENABLE_CLOUDFLARE", raising=False)
    clear_settings_cache()

    yield

    clear_settings_cache()
    _get_master_key.cache_clear()


# =============================================================================
# Model Filtering Tests
# =============================================================================


def _seed_ai_plus_billing(direct_db: DirectSessionManager, user_id) -> None:
    direct_db.register_cleanup("billing_entitlement_overrides", "user_id", user_id)
    direct_db.register_cleanup("billing_entitlement_override_events", "user_id", user_id)
    with direct_db.session() as session:
        grant_entitlement_override(
            session,
            user_id=user_id,
            plan_tier="ai_plus",
            platform_token_quota_mode="plan",
            platform_token_limit_monthly=None,
            transcription_quota_mode="plan",
            transcription_minutes_limit_monthly=None,
            expires_at=None,
            reason="model test access",
            actor_label="test",
        )


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
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_real_media_fixture_mode_enables_entitled_platform_models_without_keys(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch, tmp_path
    ):
        """Real-media fixture LLMs expose enabled platform models without live keys."""
        user_id = create_test_user_id()

        monkeypatch.setenv("REAL_MEDIA_PROVIDER_FIXTURES", "true")
        monkeypatch.setenv("REAL_MEDIA_FIXTURE_DIR", str(tmp_path))
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert {m["provider"] for m in data} == {
            "openai",
            "anthropic",
            "gemini",
            "openrouter",
        }
        assert {m["available_via"] for m in data} == {"platform"}

    def test_real_media_fixture_mode_resolves_platform_key_without_live_key(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch, tmp_path
    ):
        """Fixture-mode chat runs use an explicit fixture platform key boundary."""
        user_id = create_test_user_id()

        monkeypatch.setenv("REAL_MEDIA_PROVIDER_FIXTURES", "true")
        monkeypatch.setenv("REAL_MEDIA_FIXTURE_DIR", str(tmp_path))
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        clear_settings_cache()

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)

        with direct_db.session() as session:
            resolved = resolve_api_key(session, user_id, "openai", "auto")

        assert resolved.provider == "openai"
        assert resolved.mode == "platform"
        assert resolved.api_key == "real-media-fixture"

    def test_resolve_api_key_rejects_unknown_key_mode(self, direct_db: DirectSessionManager):
        """Unknown key modes must not silently fall back to auto routing."""
        with direct_db.session() as session, pytest.raises(ApiError) as exc_info:
            resolve_api_key(session, create_test_user_id(), "openai", "byok")

        assert exc_info.value.code == ApiErrorCode.E_INVALID_REQUEST

    def test_platform_key_enables_provider_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Platform key present for provider → that provider's models appear."""
        user_id = create_test_user_id()

        # Set platform key for openai only
        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Should only have openai models
        providers = {m["provider"] for m in data}
        assert providers == {"openai"}
        assert {m["model_name"] for m in data} == {"gpt-5.5", "gpt-5.4-mini"}
        assert {m["available_via"] for m in data} == {"platform"}

    def test_db_catalog_drift_defects_instead_of_hiding_model(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """A DB model row missing from the shared catalog is an operator defect."""
        user_id = create_test_user_id()

        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)
            session.execute(
                text(
                    """
                    INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
                    VALUES (gen_random_uuid(), 'openai', 'uncataloged-model', 8192, true)
                    """
                )
            )
            session.commit()

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)

        with direct_db.session() as session:
            with pytest.raises(AssertionError, match="uncataloged-model"):
                list_available_models(session, user_id)

    def test_disabled_provider_hides_models_even_with_platform_key(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Provider feature flag off → models hidden even if platform key exists."""
        user_id = create_test_user_id()

        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        monkeypatch.setenv("ENABLE_OPENAI", "false")
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_openrouter_platform_key_enables_openrouter_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """OpenRouter platform key + enabled flag → OpenRouter models appear."""
        user_id = create_test_user_id()

        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-platform-key-openrouter")
        monkeypatch.setenv("ENABLE_OPENROUTER", "true")
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        providers = {m["provider"] for m in data}
        assert providers == {"openrouter"}
        assert {m["model_name"] for m in data} == {
            "moonshotai/kimi-k2.6",
            "openai/gpt-5.5",
            "openai/gpt-5.4-mini",
        }
        assert {m["available_via"] for m in data} == {"platform"}

    def test_cloudflare_is_not_exposed_until_chat_capabilities_are_live(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Cloudflare platform credentials do not expose non-streaming/non-tool chat rows."""
        user_id = create_test_user_id()

        monkeypatch.setenv("CLOUDFLARE_AI_API_TOKEN", "cf-platform-token")
        monkeypatch.setenv("CLOUDFLARE_AI_ACCOUNT_ID", "cf-account-id")
        monkeypatch.setenv("ENABLE_CLOUDFLARE", "true")
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_cloudflare_token_without_account_id_does_not_enable_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Cloudflare platform availability requires both token and account id."""
        user_id = create_test_user_id()

        monkeypatch.setenv("CLOUDFLARE_AI_API_TOKEN", "cf-platform-token")
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
        monkeypatch.setenv("ENABLE_CLOUDFLARE", "true")
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_byok_untested_enables_provider_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """BYOK with status='untested' → provider models appear."""
        user_id = create_test_user_id()

        # No platform keys
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
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
        assert len(data) == 3  # claude-opus, claude-sonnet, claude-haiku
        assert {m["available_via"] for m in data} == {"byok"}

    def test_byok_valid_enables_provider_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """BYOK with status='valid' → provider models appear."""
        user_id = create_test_user_id()

        # No platform keys
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
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
        assert {m["available_via"] for m in data} == {"byok"}

    def test_models_endpoint_marks_server_defaults_for_each_key_mode(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """The server owns defaults for auto/platform/BYOK filtered model views."""
        user_id = create_test_user_id()

        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-v1-platform-key-openrouter")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)
        auth_client.post(
            "/keys",
            json={"provider": "anthropic", "api_key": "sk-ant-test-key-1234567890abcdef"},
            headers=auth_headers(user_id),
        )

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert any(
            model["is_default"] and "platform_only" in model["available_key_modes"]
            for model in data
        )
        auto_defaults = [
            model["provider"]
            for model in data
            if model["is_default"] and "auto" in model["available_key_modes"]
        ]
        assert auto_defaults == ["openai", "anthropic", "openrouter"]
        platform_defaults = [
            model["provider"]
            for model in data
            if model["is_default"] and "platform_only" in model["available_key_modes"]
        ]
        assert platform_defaults == ["openai", "openrouter"]
        byok_defaults = [
            model
            for model in data
            if model["is_default"] and "byok_only" in model["available_key_modes"]
        ]
        assert [model["provider"] for model in byok_defaults] == ["anthropic"]

    def test_byok_invalid_does_not_enable_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """BYOK with status='invalid' → provider models do NOT appear."""
        user_id = create_test_user_id()

        # No platform keys
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
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

    def test_undecryptable_byok_does_not_enable_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """BYOK rows with corrupt key material do NOT appear as runnable models."""
        user_id = create_test_user_id()

        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)

        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key-1234567890abcdefghij"},
            headers=auth_headers(user_id),
        )

        with direct_db.session() as session:
            session.execute(
                text(
                    "UPDATE user_api_keys "
                    "SET encrypted_key = :encrypted_key, key_nonce = :key_nonce, status = 'valid' "
                    "WHERE user_id = :user_id AND provider = 'openai'"
                ),
                {
                    "encrypted_key": b"x" * 32,
                    "key_nonce": b"0" * 24,
                    "user_id": user_id,
                },
            )
            session.commit()

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_byok_without_key_material_does_not_enable_models(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """A status-only BYOK row without encrypted material does not enable models."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        direct_db.register_cleanup("user_api_keys", "user_id", user_id)

        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)
            session.execute(
                text(
                    """
                    INSERT INTO user_api_keys (
                        user_id,
                        provider,
                        status,
                        key_fingerprint,
                        encrypted_key,
                        key_nonce,
                        master_key_version
                    )
                    VALUES (
                        :user_id,
                        'openai',
                        'valid',
                        'abcd',
                        NULL,
                        NULL,
                        NULL
                    )
                    """
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
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
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
        monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_API_TOKEN", raising=False)
        monkeypatch.delenv("CLOUDFLARE_AI_ACCOUNT_ID", raising=False)
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
        _seed_ai_plus_billing(direct_db, user_id)

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Should have both openai and gemini models
        providers = {m["provider"] for m in data}
        assert providers == {"openai", "gemini"}
        assert {m["available_via"] for m in data if m["provider"] == "openai"} == {"platform"}
        assert {m["available_via"] for m in data if m["provider"] == "gemini"} == {"byok"}

    def test_platform_and_byok_marks_models_available_via_both(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Provider with both platform key and BYOK returns available_via='both'."""
        user_id = create_test_user_id()

        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)

        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-openai-key-1234567890abcdef"},
            headers=auth_headers(user_id),
        )
        _seed_ai_plus_billing(direct_db, user_id)

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert {m["provider"] for m in data} == {"openai"}
        assert {m["available_via"] for m in data} == {"both"}


# =============================================================================
# Model Response Format Tests
# =============================================================================


class TestModelResponseFormat:
    """Tests for model response format."""

    def test_model_response_has_required_fields(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """Model response includes display metadata and reasoning modes."""
        user_id = create_test_user_id()

        # Platform key for openai
        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        clear_settings_cache()

        # Seed models
        with direct_db.session() as session:
            seed_test_models(session)

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) > 0

        model = data[0]
        assert "id" in model
        assert "provider" in model
        assert "provider_display_name" in model
        assert "model_name" in model
        assert "model_display_name" in model
        assert "model_tier" in model
        assert "reasoning_modes" in model
        assert "max_context_tokens" in model
        assert "available_via" in model
        assert "provider_rank" in model
        assert "model_rank" in model
        assert "is_default" in model
        assert "available_key_modes" in model
        assert "capabilities" in model
        assert model["reasoning_modes"][0] == "default"
        assert "none" in model["reasoning_modes"]
        assert data[0]["is_default"] is True
        assert data[0]["model_tier"] == "light"
        assert "auto" in data[0]["available_key_modes"]
        assert data[0]["capabilities"]["prompt_cache"]["mode"] in {
            "keyed_ttl",
            "turn_ttl",
            "none",
        }

    def test_model_response_context_window_comes_from_shared_catalog(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        """DB rows own availability/id; capability values come from provider_runtime."""
        user_id = create_test_user_id()

        monkeypatch.setenv("OPENAI_API_KEY", "sk-platform-key-openai")
        clear_settings_cache()

        with direct_db.session() as session:
            seed_test_models(session)
            session.execute(
                text(
                    """
                    UPDATE models
                    SET max_context_tokens = 1
                    WHERE provider = 'openai' AND model_name = 'gpt-5.4-mini'
                    """
                )
            )
            session.commit()

        auth_client.get("/me", headers=auth_headers(user_id))
        _seed_ai_plus_billing(direct_db, user_id)

        response = auth_client.get("/models", headers=auth_headers(user_id))

        assert response.status_code == 200
        light_model = next(
            item for item in response.json()["data"] if item["model_name"] == "gpt-5.4-mini"
        )
        assert light_model["max_context_tokens"] == 400000


# =============================================================================
# Auth Tests
# =============================================================================


class TestModelsAuth:
    """Tests that models endpoint requires authentication."""

    def test_get_models_without_auth_returns_401(self, client):
        """GET /models without auth returns 401 E_UNAUTHENTICATED."""
        response = client.get("/models")

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "E_UNAUTHENTICATED"
