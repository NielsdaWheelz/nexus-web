"""BFF Smoke Tests.

These tests verify the BFF security boundary:
1. Bearer token forwarded correctly to FastAPI
2. X-Nexus-Internal header attached by proxy
3. Direct FastAPI call without internal header → 403 (when NEXUS_ENV=staging)

Note: These tests hit FastAPI directly to verify header behavior.
The actual Next.js → FastAPI integration is verified via end-to-end tests.
"""

import pytest
from fastapi.testclient import TestClient

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import MockTokenVerifier
from tests.helpers import auth_headers


class TestEchoHeadersEndpoint:
    """Test the /__test/echo_headers endpoint.

    This endpoint is only available when NEXUS_ENV=test.
    """

    @pytest.fixture
    def test_app(self, engine):
        """Create app with test routes enabled."""
        from uuid import UUID

        from nexus.db.session import create_session_factory
        from nexus.services.bootstrap import ensure_user_and_default_library

        session_factory = create_session_factory(engine)

        def bootstrap_callback(user_id: UUID) -> UUID:
            db = session_factory()
            try:
                return ensure_user_and_default_library(db, user_id)
            finally:
                db.close()

        verifier = MockTokenVerifier()
        app = create_app(skip_auth_middleware=True)

        app.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=False,
            internal_secret=None,
            bootstrap_callback=bootstrap_callback,
        )

        return app

    @pytest.fixture
    def test_client(self, test_app, db_session):
        """Create test client with test routes."""
        with TestClient(test_app) as client:
            yield client

    def test_echo_headers_returns_request_headers(self, test_client, test_user_id):
        """Test that echo_headers returns all request headers."""
        headers = auth_headers(test_user_id)
        headers["X-Custom-Header"] = "custom-value"

        response = test_client.get("/__test/echo_headers", headers=headers)

        # Should return 200 with headers
        assert response.status_code == 200
        data = response.json()
        assert "data" in data
        assert "headers" in data["data"]

        # Check that our custom header was received
        headers_dict = data["data"]["headers"]
        assert headers_dict.get("x-custom-header") == "custom-value"

    def test_echo_headers_receives_authorization(self, test_client, test_user_id):
        """Test that Authorization header is received correctly."""
        headers = auth_headers(test_user_id)

        response = test_client.get("/__test/echo_headers", headers=headers)

        assert response.status_code == 200
        data = response.json()
        headers_dict = data["data"]["headers"]

        # Authorization header should be present
        assert "authorization" in headers_dict
        assert headers_dict["authorization"].startswith("Bearer ")


class TestInternalHeaderEnforcement:
    """Test X-Nexus-Internal header enforcement in staging/prod."""

    @pytest.fixture
    def staging_app(self, engine):
        """Create app that requires internal header (simulating staging)."""
        from uuid import UUID

        from nexus.db.session import create_session_factory
        from nexus.services.bootstrap import ensure_user_and_default_library

        session_factory = create_session_factory(engine)

        def bootstrap_callback(user_id: UUID) -> UUID:
            db = session_factory()
            try:
                return ensure_user_and_default_library(db, user_id)
            finally:
                db.close()

        verifier = MockTokenVerifier()
        app = create_app(skip_auth_middleware=True)

        # Add middleware that REQUIRES internal header
        app.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=True,
            internal_secret="test-internal-secret",
            bootstrap_callback=bootstrap_callback,
        )

        return app

    @pytest.fixture
    def staging_client(self, staging_app, db_session):
        """Create client for staging-like environment."""
        with TestClient(staging_app) as client:
            yield client

    def test_missing_internal_header_returns_403(self, staging_client, test_user_id):
        """Test that missing internal header returns 403 E_INTERNAL_ONLY."""
        headers = auth_headers(test_user_id)
        # No X-Nexus-Internal header

        response = staging_client.get("/me", headers=headers)

        assert response.status_code == 403
        data = response.json()
        assert data["error"]["code"] == "E_INTERNAL_ONLY"

    def test_wrong_internal_header_returns_403(self, staging_client, test_user_id):
        """Test that wrong internal header value returns 403."""
        headers = auth_headers(test_user_id)
        headers["X-Nexus-Internal"] = "wrong-secret"

        response = staging_client.get("/me", headers=headers)

        assert response.status_code == 403
        data = response.json()
        assert data["error"]["code"] == "E_INTERNAL_ONLY"

    def test_correct_internal_header_succeeds(self, staging_client, test_user_id):
        """Test that correct internal header allows request to proceed."""
        headers = auth_headers(test_user_id)
        headers["X-Nexus-Internal"] = "test-internal-secret"

        response = staging_client.get("/me", headers=headers)

        assert response.status_code == 200
        data = response.json()
        assert "data" in data
        assert "user_id" in data["data"]


class TestBearerTokenForwarding:
    """Test that bearer tokens are properly validated."""

    def test_missing_bearer_token_returns_401(self, authenticated_client):
        """Test that missing token returns 401."""
        response = authenticated_client.get("/me")

        assert response.status_code == 401
        data = response.json()
        assert data["error"]["code"] == "E_UNAUTHENTICATED"

    def test_valid_bearer_token_succeeds(self, authenticated_client, test_user_id):
        """Test that valid token allows request."""
        headers = auth_headers(test_user_id)

        response = authenticated_client.get("/me", headers=headers)

        assert response.status_code == 200
        data = response.json()
        assert data["data"]["user_id"] == str(test_user_id)
