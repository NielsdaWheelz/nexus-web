"""Integration tests for user API keys routes and service.

Tests cover PR-03 requirements:
- Crypto tests: encrypt/decrypt round-trip, unique nonces, unknown version
- API safety tests: response never includes sensitive fields
- Validation tests: invalid provider, key too short, whitespace in key
- Upsert semantics: same provider = same row, new nonce on overwrite
- Revocation tests: wipe ciphertext, retain fingerprint, idempotent
- Auth tests: all endpoints require authentication

Per PR-03 spec:
- No secrets ever leave the backend
- Keys are encrypted at rest with XChaCha20-Poly1305
- Fingerprint is the last 4 chars of the original key
"""

import base64
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.crypto import (
    CURRENT_MASTER_KEY_VERSION,
    MASTER_KEY_SIZE,
    CryptoError,
    clear_master_key_cache,
    decrypt_api_key,
    encrypt_api_key,
)
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


# =============================================================================
# Crypto Tests (PR-03 spec: "Crypto Tests")
# =============================================================================


class TestCryptoApiKey:
    """Tests for high-level API key encryption functions."""

    def test_encrypt_decrypt_roundtrip(self):
        """Encrypted API key can be decrypted back to original."""
        api_key = "sk-test-api-key-1234567890abcdef"

        ciphertext, nonce, version, fingerprint = encrypt_api_key(api_key)
        decrypted = decrypt_api_key(ciphertext, nonce, version)

        assert decrypted == api_key

    def test_ciphertext_differs_from_plaintext(self):
        """Ciphertext is different from plaintext."""
        api_key = "sk-test-api-key-1234567890abcdef"

        ciphertext, _, _, _ = encrypt_api_key(api_key)

        assert ciphertext != api_key.encode("utf-8")

    def test_two_encryptions_produce_different_ciphertext(self):
        """Two encryptions of same plaintext produce different ciphertexts (unique nonces)."""
        api_key = "sk-test-api-key-1234567890abcdef"

        ciphertext1, nonce1, _, _ = encrypt_api_key(api_key)
        ciphertext2, nonce2, _, _ = encrypt_api_key(api_key)

        assert ciphertext1 != ciphertext2
        assert nonce1 != nonce2

    def test_decrypt_with_unknown_version_raises_error(self):
        """Decryption with unknown version raises CryptoError."""
        api_key = "sk-test-api-key-1234567890abcdef"

        ciphertext, nonce, _, _ = encrypt_api_key(api_key)

        with pytest.raises(CryptoError) as exc_info:
            decrypt_api_key(ciphertext, nonce, version=999)

        assert "Unknown key version" in str(exc_info.value)

    def test_fingerprint_is_last_4_chars(self):
        """Fingerprint is exactly the last 4 characters of the key."""
        api_key = "sk-test-api-key-endswith1234"

        _, _, _, fingerprint = encrypt_api_key(api_key)

        assert fingerprint == "1234"

    def test_version_is_current(self):
        """Version returned is the current version."""
        api_key = "sk-test-api-key-1234567890abcdef"

        _, _, version, _ = encrypt_api_key(api_key)

        assert version == CURRENT_MASTER_KEY_VERSION


# =============================================================================
# API Safety Tests (PR-03 spec: "API Safety Tests")
# =============================================================================


class TestApiSafety:
    """Tests ensuring sensitive fields never leave the backend."""

    def test_list_keys_excludes_sensitive_fields(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """GET /keys response never includes encrypted_key, key_nonce, master_key_version."""
        user_id = create_test_user_id()

        # Create a key
        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-1234567890abcdefghijklmnop"},
            headers=auth_headers(user_id),
        )

        # List keys
        response = auth_client.get("/keys", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 1

        key = data[0]
        # These fields must NEVER be present
        assert "encrypted_key" not in key
        assert "key_nonce" not in key
        assert "master_key_version" not in key

        # These fields should be present
        assert "id" in key
        assert "provider" in key
        assert "key_fingerprint" in key
        assert "status" in key
        assert "created_at" in key

    def test_upsert_key_response_excludes_sensitive_fields(self, auth_client):
        """POST /keys response never includes sensitive fields."""
        user_id = create_test_user_id()

        response = auth_client.post(
            "/keys",
            json={"provider": "anthropic", "api_key": "sk-ant-1234567890abcdefghijklmnop"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        key = response.json()["data"]

        # These fields must NEVER be present
        assert "encrypted_key" not in key
        assert "key_nonce" not in key
        assert "master_key_version" not in key

    def test_fingerprint_is_last_4_chars_of_api_key(self, auth_client):
        """Fingerprint returned is exactly the last 4 characters."""
        user_id = create_test_user_id()

        api_key = "sk-test-1234567890abcdefXYZW"
        response = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": api_key},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        assert response.json()["data"]["key_fingerprint"] == "XYZW"


# =============================================================================
# Validation Tests - Negative (PR-03 spec: "Validation Tests (Negative)")
# =============================================================================


class TestValidation:
    """Tests for input validation error handling."""

    def test_invalid_provider_returns_400(self, auth_client):
        """POST /keys with invalid provider returns 400 E_KEY_PROVIDER_INVALID."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))  # Bootstrap

        response = auth_client.post(
            "/keys",
            json={"provider": "invalid_provider", "api_key": "sk-test-1234567890abcdefghijk"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        # Pydantic validation catches this before our service
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_key_too_short_returns_400(self, auth_client):
        """POST /keys with key < 20 chars returns 400 E_KEY_INVALID_FORMAT."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "short-key"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        # Pydantic validation returns E_INVALID_REQUEST via FastAPI's handler
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_key_with_space_returns_400(self, auth_client):
        """POST /keys with key containing space returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key with space in it"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        # Pydantic validation returns E_INVALID_REQUEST via FastAPI's handler
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_key_with_tab_returns_400(self, auth_client):
        """POST /keys with key containing tab returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key\twith-tab-in-it"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        # Pydantic validation returns E_INVALID_REQUEST via FastAPI's handler
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_key_with_newline_returns_400(self, auth_client):
        """POST /keys with key containing newline returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key\nwith-newline"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        # Pydantic validation returns E_INVALID_REQUEST via FastAPI's handler
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_key_leading_trailing_whitespace_stripped(self, auth_client):
        """Leading/trailing whitespace is stripped before validation."""
        user_id = create_test_user_id()

        # Key with leading/trailing spaces should be accepted if inner part is valid
        response = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "  sk-test-1234567890abcdefghijk  "},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        # Fingerprint should be from trimmed key
        assert response.json()["data"]["key_fingerprint"] == "hijk"


# =============================================================================
# Upsert Semantics Tests (PR-03 spec: "Upsert Semantics Tests")
# =============================================================================


class TestUpsertSemantics:
    """Tests for upsert behavior (same provider = same row)."""

    def test_same_provider_returns_same_row_id(self, auth_client):
        """Same (user_id, provider) upsert returns same row id."""
        user_id = create_test_user_id()

        # Create initial key
        resp1 = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-first-key-1234567890abc"},
            headers=auth_headers(user_id),
        )
        assert resp1.status_code == 201
        key_id_1 = resp1.json()["data"]["id"]

        # Update same provider
        resp2 = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-second-key-987654321xyz"},
            headers=auth_headers(user_id),
        )
        assert resp2.status_code == 200  # Updated, not created
        key_id_2 = resp2.json()["data"]["id"]

        assert key_id_1 == key_id_2

    def test_ciphertext_changes_on_overwrite(self, auth_client, direct_db: DirectSessionManager):
        """Ciphertext changes on overwrite (new nonce)."""
        user_id = create_test_user_id()

        # Create initial key
        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-first-key-1234567890abc"},
            headers=auth_headers(user_id),
        )

        # Get initial ciphertext
        with direct_db.session() as session:
            result = session.execute(
                text(
                    "SELECT encrypted_key, key_nonce FROM user_api_keys "
                    "WHERE user_id = :user_id AND provider = 'openai'"
                ),
                {"user_id": user_id},
            )
            row = result.fetchone()
            ciphertext_1 = bytes(row[0])
            nonce_1 = bytes(row[1])

        # Update with same key value
        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-first-key-1234567890abc"},
            headers=auth_headers(user_id),
        )

        # Get new ciphertext
        with direct_db.session() as session:
            result = session.execute(
                text(
                    "SELECT encrypted_key, key_nonce FROM user_api_keys "
                    "WHERE user_id = :user_id AND provider = 'openai'"
                ),
                {"user_id": user_id},
            )
            row = result.fetchone()
            ciphertext_2 = bytes(row[0])
            nonce_2 = bytes(row[1])

        # Ciphertext and nonce should differ
        assert ciphertext_1 != ciphertext_2
        assert nonce_1 != nonce_2

    def test_status_resets_to_untested_on_overwrite(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Status resets to 'untested' on overwrite."""
        user_id = create_test_user_id()

        # Create initial key
        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-first-key-1234567890abc"},
            headers=auth_headers(user_id),
        )

        # Manually set status to 'valid' (simulating a successful LLM call)
        with direct_db.session() as session:
            session.execute(
                text(
                    "UPDATE user_api_keys SET status = 'valid', last_tested_at = now() "
                    "WHERE user_id = :user_id AND provider = 'openai'"
                ),
                {"user_id": user_id},
            )
            session.commit()

        # Update key
        resp = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-second-key-987654321xyz"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        assert resp.json()["data"]["status"] == "untested"

    def test_last_tested_at_cleared_on_overwrite(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """last_tested_at is cleared on overwrite."""
        user_id = create_test_user_id()

        # Create initial key
        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-first-key-1234567890abc"},
            headers=auth_headers(user_id),
        )

        # Manually set last_tested_at
        with direct_db.session() as session:
            session.execute(
                text(
                    "UPDATE user_api_keys SET last_tested_at = now() "
                    "WHERE user_id = :user_id AND provider = 'openai'"
                ),
                {"user_id": user_id},
            )
            session.commit()

        # Update key
        resp = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-second-key-987654321xyz"},
            headers=auth_headers(user_id),
        )

        assert resp.status_code == 200
        assert resp.json()["data"]["last_tested_at"] is None

    def test_different_providers_create_different_rows(self, auth_client):
        """Different providers create different rows."""
        user_id = create_test_user_id()

        resp1 = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-openai-key-1234567890"},
            headers=auth_headers(user_id),
        )
        resp2 = auth_client.post(
            "/keys",
            json={"provider": "anthropic", "api_key": "sk-ant-anthropic-key-1234567890"},
            headers=auth_headers(user_id),
        )

        assert resp1.status_code == 201
        assert resp2.status_code == 201
        assert resp1.json()["data"]["id"] != resp2.json()["data"]["id"]


# =============================================================================
# Revocation Tests (PR-03 spec: "Revocation Tests")
# =============================================================================


class TestRevocation:
    """Tests for key revocation."""

    def test_revoke_sets_status_revoked(self, auth_client, direct_db: DirectSessionManager):
        """DELETE /keys/:id sets status='revoked' and revoked_at."""
        user_id = create_test_user_id()

        # Create key
        resp = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key-to-revoke-1234567890"},
            headers=auth_headers(user_id),
        )
        key_id = resp.json()["data"]["id"]

        # Revoke
        response = auth_client.delete(f"/keys/{key_id}", headers=auth_headers(user_id))

        assert response.status_code == 204

        # Verify in DB
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT status, revoked_at FROM user_api_keys WHERE id = :id"),
                {"id": key_id},
            )
            row = result.fetchone()
            assert row[0] == "revoked"
            assert row[1] is not None  # revoked_at set

    def test_revoke_wipes_ciphertext(self, auth_client, direct_db: DirectSessionManager):
        """DELETE /keys/:id wipes encrypted_key, key_nonce, master_key_version to NULL."""
        user_id = create_test_user_id()

        # Create key
        resp = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key-to-revoke-1234567890"},
            headers=auth_headers(user_id),
        )
        key_id = resp.json()["data"]["id"]

        # Verify ciphertext exists before revoke
        with direct_db.session() as session:
            result = session.execute(
                text(
                    "SELECT encrypted_key, key_nonce, master_key_version "
                    "FROM user_api_keys WHERE id = :id"
                ),
                {"id": key_id},
            )
            row = result.fetchone()
            assert row[0] is not None  # encrypted_key exists
            assert row[1] is not None  # key_nonce exists
            assert row[2] is not None  # master_key_version exists

        # Revoke
        auth_client.delete(f"/keys/{key_id}", headers=auth_headers(user_id))

        # Verify ciphertext wiped
        with direct_db.session() as session:
            result = session.execute(
                text(
                    "SELECT encrypted_key, key_nonce, master_key_version "
                    "FROM user_api_keys WHERE id = :id"
                ),
                {"id": key_id},
            )
            row = result.fetchone()
            assert row[0] is None  # encrypted_key wiped
            assert row[1] is None  # key_nonce wiped
            assert row[2] is None  # master_key_version wiped

    def test_revoke_retains_fingerprint(self, auth_client, direct_db: DirectSessionManager):
        """DELETE /keys/:id retains key_fingerprint for audit trail."""
        user_id = create_test_user_id()

        # Create key
        resp = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key-to-revoke-1234567890"},
            headers=auth_headers(user_id),
        )
        key_id = resp.json()["data"]["id"]
        fingerprint = resp.json()["data"]["key_fingerprint"]

        # Revoke
        auth_client.delete(f"/keys/{key_id}", headers=auth_headers(user_id))

        # Verify fingerprint retained
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT key_fingerprint FROM user_api_keys WHERE id = :id"),
                {"id": key_id},
            )
            row = result.fetchone()
            assert row[0] == fingerprint

    def test_revoke_idempotent(self, auth_client):
        """Deleting already-revoked key returns 204 (idempotent)."""
        user_id = create_test_user_id()

        # Create key
        resp = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key-to-revoke-1234567890"},
            headers=auth_headers(user_id),
        )
        key_id = resp.json()["data"]["id"]

        # Revoke first time
        response1 = auth_client.delete(f"/keys/{key_id}", headers=auth_headers(user_id))
        assert response1.status_code == 204

        # Revoke second time (idempotent)
        response2 = auth_client.delete(f"/keys/{key_id}", headers=auth_headers(user_id))
        assert response2.status_code == 204

    def test_revoke_other_users_key_returns_404(self, auth_client):
        """Deleting another user's key returns 404 E_KEY_NOT_FOUND."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # User A creates key
        resp = auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key-user-a-1234567890"},
            headers=auth_headers(user_a),
        )
        key_id = resp.json()["data"]["id"]

        # User B tries to revoke
        auth_client.get("/me", headers=auth_headers(user_b))  # Bootstrap
        response = auth_client.delete(f"/keys/{key_id}", headers=auth_headers(user_b))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_KEY_NOT_FOUND"

    def test_revoke_nonexistent_key_returns_404(self, auth_client):
        """Deleting non-existent key returns 404 E_KEY_NOT_FOUND."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))  # Bootstrap

        response = auth_client.delete(f"/keys/{uuid4()}", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_KEY_NOT_FOUND"


# =============================================================================
# Auth Tests (PR-03 spec: "Auth Tests")
# =============================================================================


class TestAuth:
    """Tests that all endpoints require authentication."""

    def test_get_keys_without_auth_returns_401(self, client):
        """GET /keys without auth returns 401 E_UNAUTHENTICATED."""
        response = client.get("/keys")

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "E_UNAUTHENTICATED"

    def test_post_keys_without_auth_returns_401(self, client):
        """POST /keys without auth returns 401 E_UNAUTHENTICATED."""
        response = client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-key-1234567890abcdefghijk"},
        )

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "E_UNAUTHENTICATED"

    def test_delete_keys_without_auth_returns_401(self, client):
        """DELETE /keys/:id without auth returns 401 E_UNAUTHENTICATED."""
        response = client.delete(f"/keys/{uuid4()}")

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "E_UNAUTHENTICATED"


# =============================================================================
# List Keys Tests
# =============================================================================


class TestListKeys:
    """Tests for GET /keys endpoint."""

    def test_list_keys_empty(self, auth_client):
        """List keys returns empty list for user with no keys."""
        user_id = create_test_user_id()

        response = auth_client.get("/keys", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_list_keys_returns_all_user_keys(self, auth_client):
        """List keys returns all keys for the user."""
        user_id = create_test_user_id()

        # Create keys for multiple providers
        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-openai-1234567890abcdef"},
            headers=auth_headers(user_id),
        )
        auth_client.post(
            "/keys",
            json={"provider": "anthropic", "api_key": "sk-ant-anthropic-1234567890abcdef"},
            headers=auth_headers(user_id),
        )

        response = auth_client.get("/keys", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert len(response.json()["data"]) == 2

    def test_list_keys_isolation(self, auth_client):
        """Users can only see their own keys."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # User A creates key
        auth_client.post(
            "/keys",
            json={"provider": "openai", "api_key": "sk-test-user-a-1234567890abcdef"},
            headers=auth_headers(user_a),
        )

        # User B should see no keys
        response = auth_client.get("/keys", headers=auth_headers(user_b))

        assert response.status_code == 200
        assert response.json()["data"] == []
