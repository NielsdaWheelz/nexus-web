"""Tests for X-Request-ID middleware.

Tests cover:
- Request ID generation when missing
- Request ID preservation when valid
- Request ID normalization (UUID lowercase)
- Request ID replacement when invalid
- Request ID presence on auth failures
- Request ID in error response body
"""

from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine

from nexus.app import add_request_id_middleware, create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import MockTokenVerifier
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import auth_headers, create_test_user_id


@pytest.fixture
def auth_client(engine: Engine):
    """Create a client with auth + request-id middleware."""
    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    verifier = MockTokenVerifier()
    app = create_app(skip_auth_middleware=True)

    # Add auth middleware first (so it runs second)
    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    # Add request-id middleware LAST (so it runs FIRST, outermost)
    add_request_id_middleware(app, log_requests=False)

    return TestClient(app)


class TestRequestIdMiddleware:
    """Tests for X-Request-ID middleware."""

    def test_request_id_generated_when_missing(self, auth_client):
        """Request ID is generated when not provided."""
        user_id = create_test_user_id()
        response = auth_client.get("/me", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert "X-Request-ID" in response.headers

        # Verify it's a valid UUID
        request_id = response.headers["X-Request-ID"]
        UUID(request_id)  # Raises if invalid

    def test_request_id_preserved_when_valid(self, auth_client):
        """Valid non-UUID request IDs are preserved."""
        user_id = create_test_user_id()
        custom_id = "abc_def-123"

        response = auth_client.get(
            "/me",
            headers={**auth_headers(user_id), "X-Request-ID": custom_id},
        )

        assert response.status_code == 200
        assert response.headers["X-Request-ID"] == custom_id

    def test_request_id_uuid_normalized_to_lowercase(self, auth_client):
        """UUID request IDs are normalized to lowercase."""
        user_id = create_test_user_id()
        uppercase_uuid = "550E8400-E29B-41D4-A716-446655440000"
        expected = "550e8400-e29b-41d4-a716-446655440000"

        response = auth_client.get(
            "/me",
            headers={**auth_headers(user_id), "X-Request-ID": uppercase_uuid},
        )

        assert response.status_code == 200
        assert response.headers["X-Request-ID"] == expected

    def test_request_id_replaced_when_invalid(self, auth_client):
        """Invalid request IDs (with spaces) are replaced."""
        user_id = create_test_user_id()
        invalid_id = "bad id with spaces"

        response = auth_client.get(
            "/me",
            headers={**auth_headers(user_id), "X-Request-ID": invalid_id},
        )

        assert response.status_code == 200
        # Should be replaced with a new UUID
        new_id = response.headers["X-Request-ID"]
        assert new_id != invalid_id
        UUID(new_id)  # Verify it's a valid UUID

    def test_request_id_replaced_when_too_long(self, auth_client):
        """Request IDs longer than 128 bytes are replaced."""
        user_id = create_test_user_id()
        long_id = "a" * 200  # > 128 chars

        response = auth_client.get(
            "/me",
            headers={**auth_headers(user_id), "X-Request-ID": long_id},
        )

        assert response.status_code == 200
        new_id = response.headers["X-Request-ID"]
        assert new_id != long_id
        UUID(new_id)  # Verify it's a valid UUID

    def test_request_id_present_on_auth_failure(self, auth_client):
        """Auth failures still include X-Request-ID in response."""
        # No auth token provided
        response = auth_client.get("/me")

        assert response.status_code == 401
        assert "X-Request-ID" in response.headers

    def test_error_response_includes_request_id_in_body(self, auth_client):
        """Error responses include request_id in the body."""
        user_id = create_test_user_id()

        # Trigger a 404 error
        response = auth_client.get(
            "/media/00000000-0000-0000-0000-000000000000",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404
        data = response.json()
        assert "error" in data
        assert "request_id" in data["error"]
        # Verify it matches the header
        assert data["error"]["request_id"] == response.headers["X-Request-ID"]

    def test_request_id_present_on_internal_header_failure(self, engine: Engine):
        """Internal header failures still include X-Request-ID."""
        # Create client that requires internal header
        session_factory = create_session_factory(engine)

        def bootstrap_callback(user_id: UUID) -> UUID:
            db = session_factory()
            try:
                return ensure_user_and_default_library(db, user_id)
            finally:
                db.close()

        verifier = MockTokenVerifier()
        app = create_app(skip_auth_middleware=True)

        # Add auth middleware first (so it runs second)
        app.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=True,
            internal_secret="test-secret",
            bootstrap_callback=bootstrap_callback,
        )

        # Add request-id middleware LAST (so it runs FIRST)
        add_request_id_middleware(app, log_requests=False)

        client = TestClient(app)

        user_id = create_test_user_id()
        # Auth token but no internal header
        response = client.get("/me", headers=auth_headers(user_id))

        assert response.status_code == 403
        assert "X-Request-ID" in response.headers


class TestRequestIdValidation:
    """Tests for request ID validation edge cases."""

    def test_request_id_with_dots_valid(self, auth_client):
        """Request IDs with dots are valid."""
        user_id = create_test_user_id()
        dotted_id = "request.id.with.dots"

        response = auth_client.get(
            "/me",
            headers={**auth_headers(user_id), "X-Request-ID": dotted_id},
        )

        assert response.status_code == 200
        assert response.headers["X-Request-ID"] == dotted_id

    def test_request_id_with_underscores_valid(self, auth_client):
        """Request IDs with underscores are valid."""
        user_id = create_test_user_id()
        underscore_id = "request_id_with_underscores"

        response = auth_client.get(
            "/me",
            headers={**auth_headers(user_id), "X-Request-ID": underscore_id},
        )

        assert response.status_code == 200
        assert response.headers["X-Request-ID"] == underscore_id

    def test_request_id_with_hyphens_valid(self, auth_client):
        """Request IDs with hyphens are valid."""
        user_id = create_test_user_id()
        hyphen_id = "request-id-with-hyphens"

        response = auth_client.get(
            "/me",
            headers={**auth_headers(user_id), "X-Request-ID": hyphen_id},
        )

        assert response.status_code == 200
        assert response.headers["X-Request-ID"] == hyphen_id

    def test_request_id_at_max_length_valid(self, auth_client):
        """Request IDs at exactly 128 chars are valid."""
        user_id = create_test_user_id()
        max_id = "a" * 128  # Exactly 128 chars

        response = auth_client.get(
            "/me",
            headers={**auth_headers(user_id), "X-Request-ID": max_id},
        )

        assert response.status_code == 200
        assert response.headers["X-Request-ID"] == max_id
