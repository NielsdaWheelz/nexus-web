"""Integration tests for authentication middleware and bootstrap.

Tests the full auth flow including:
- Bearer token validation
- Internal header enforcement
- User and default library bootstrap
- GET /me endpoint
"""

from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import MockTokenVerifier
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import (
    auth_headers,
    create_test_user_id,
    mint_expired_token,
    mint_test_token,
    mint_token_with_bad_signature,
)
from tests.utils.db import DirectSessionManager


class TestAuthBoundary:
    """Tests for the authentication boundary.

    These tests verify that unauthenticated requests are rejected correctly.
    """

    @pytest.fixture
    def auth_client(self, engine):
        """Create a client with auth middleware for testing."""
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

        return TestClient(app)

    def test_no_authorization_header(self, auth_client):
        """Test 14: No Authorization header returns 401 E_UNAUTHENTICATED."""
        response = auth_client.get("/me")

        assert response.status_code == 401
        data = response.json()
        assert data["error"]["code"] == "E_UNAUTHENTICATED"
        assert "authentication" in data["error"]["message"].lower()

    def test_wrong_authorization_format(self, auth_client):
        """Test 15: Authorization header wrong format (Basic...) returns 401."""
        response = auth_client.get("/me", headers={"Authorization": "Basic abc123"})

        assert response.status_code == 401
        data = response.json()
        assert data["error"]["code"] == "E_UNAUTHENTICATED"

    def test_empty_bearer_token(self, auth_client):
        """Test 16: Authorization header 'Bearer ' (empty token) returns 401."""
        response = auth_client.get("/me", headers={"Authorization": "Bearer "})

        assert response.status_code == 401
        data = response.json()
        assert data["error"]["code"] == "E_UNAUTHENTICATED"

    def test_invalid_token_bad_signature(self, auth_client):
        """Test 17: Invalid token (bad signature) returns 401."""
        user_id = create_test_user_id()
        token = mint_token_with_bad_signature(user_id)

        response = auth_client.get("/me", headers={"Authorization": f"Bearer {token}"})

        assert response.status_code == 401
        data = response.json()
        assert data["error"]["code"] == "E_UNAUTHENTICATED"

    def test_expired_token(self, auth_client):
        """Test 18: Expired token returns 401."""
        user_id = create_test_user_id()
        token = mint_expired_token(user_id)

        response = auth_client.get("/me", headers={"Authorization": f"Bearer {token}"})

        assert response.status_code == 401
        data = response.json()
        assert data["error"]["code"] == "E_UNAUTHENTICATED"


class TestInternalHeaderEnforcement:
    """Tests for internal header enforcement in staging/prod mode."""

    @pytest.fixture
    def staging_client(self, engine):
        """Create a client that requires internal header (simulating staging)."""
        session_factory = create_session_factory(engine)

        def bootstrap_callback(user_id: UUID) -> UUID:
            db = session_factory()
            try:
                return ensure_user_and_default_library(db, user_id)
            finally:
                db.close()

        verifier = MockTokenVerifier()
        app = create_app(skip_auth_middleware=True)

        # Add middleware with internal header requirement
        app.add_middleware(
            AuthMiddleware,
            verifier=verifier,
            requires_internal_header=True,
            internal_secret="test-internal-secret",
            bootstrap_callback=bootstrap_callback,
        )

        return TestClient(app)

    def test_missing_internal_header_staging(self, staging_client):
        """Test 19: Missing internal header (NEXUS_ENV=staging) returns 403."""
        user_id = create_test_user_id()
        token = mint_test_token(user_id)

        response = staging_client.get("/me", headers={"Authorization": f"Bearer {token}"})

        assert response.status_code == 403
        data = response.json()
        assert data["error"]["code"] == "E_INTERNAL_ONLY"

    def test_wrong_internal_header_value(self, staging_client):
        """Test 20: Wrong internal header value returns 403."""
        user_id = create_test_user_id()
        token = mint_test_token(user_id)

        response = staging_client.get(
            "/me",
            headers={
                "Authorization": f"Bearer {token}",
                "X-Nexus-Internal": "wrong-secret",
            },
        )

        assert response.status_code == 403
        data = response.json()
        assert data["error"]["code"] == "E_INTERNAL_ONLY"

    def test_correct_internal_header(self, staging_client):
        """Internal header with correct value allows request through."""
        user_id = create_test_user_id()
        token = mint_test_token(user_id)

        response = staging_client.get(
            "/me",
            headers={
                "Authorization": f"Bearer {token}",
                "X-Nexus-Internal": "test-internal-secret",
            },
        )

        assert response.status_code == 200


class TestBootstrap:
    """Tests for user and default library bootstrap."""

    @pytest.fixture
    def auth_client(self, engine):
        """Create a client with auth middleware for testing."""
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

        return TestClient(app)

    def test_first_request_creates_user(self, auth_client, db_session: Session):
        """Test 21: First authenticated request creates user row."""
        user_id = create_test_user_id()

        # Verify user doesn't exist yet
        result = db_session.execute(
            text("SELECT id FROM users WHERE id = :user_id"),
            {"user_id": user_id},
        )
        assert result.fetchone() is None

        # Make authenticated request
        response = auth_client.get("/me", headers=auth_headers(user_id))
        assert response.status_code == 200

        # Verify user was created
        db_session.expire_all()  # Clear cached results
        result = db_session.execute(
            text("SELECT id FROM users WHERE id = :user_id"),
            {"user_id": user_id},
        )
        row = result.fetchone()
        assert row is not None
        assert row[0] == user_id

    def test_default_library_created(self, auth_client, db_session: Session):
        """Test 22: Default library is created with is_default=true."""
        user_id = create_test_user_id()

        response = auth_client.get("/me", headers=auth_headers(user_id))
        assert response.status_code == 200

        db_session.expire_all()
        result = db_session.execute(
            text(
                "SELECT id, is_default FROM libraries "
                "WHERE owner_user_id = :user_id AND is_default = true"
            ),
            {"user_id": user_id},
        )
        row = result.fetchone()
        assert row is not None
        assert row[1] is True  # is_default

    def test_default_library_name(self, auth_client, db_session: Session):
        """Test 23: Default library is named 'My Library'."""
        user_id = create_test_user_id()

        response = auth_client.get("/me", headers=auth_headers(user_id))
        assert response.status_code == 200

        db_session.expire_all()
        result = db_session.execute(
            text("SELECT name FROM libraries WHERE owner_user_id = :user_id AND is_default = true"),
            {"user_id": user_id},
        )
        row = result.fetchone()
        assert row is not None
        assert row[0] == "My Library"

    def test_owner_membership_created(self, auth_client, db_session: Session):
        """Test 24: Owner admin membership is created."""
        user_id = create_test_user_id()

        response = auth_client.get("/me", headers=auth_headers(user_id))
        assert response.status_code == 200

        db_session.expire_all()

        # Get the default library ID
        result = db_session.execute(
            text("SELECT id FROM libraries WHERE owner_user_id = :user_id AND is_default = true"),
            {"user_id": user_id},
        )
        library_id = result.scalar()

        # Check membership
        result = db_session.execute(
            text(
                "SELECT role FROM memberships WHERE library_id = :library_id AND user_id = :user_id"
            ),
            {"library_id": library_id, "user_id": user_id},
        )
        row = result.fetchone()
        assert row is not None
        assert row[0] == "admin"

    def test_concurrent_first_requests_single_library(self, engine, db_session: Session):
        """Test 25: Concurrent first requests create only one default library."""
        user_id = create_test_user_id()
        session_factory = create_session_factory(engine)

        def bootstrap_callback(uid: UUID) -> UUID:
            db = session_factory()
            try:
                return ensure_user_and_default_library(db, uid)
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

        token = mint_test_token(user_id)

        def make_request():
            with TestClient(app) as client:
                return client.get("/me", headers={"Authorization": f"Bearer {token}"})

        # Make concurrent requests
        with ThreadPoolExecutor(max_workers=5) as executor:
            futures = [executor.submit(make_request) for _ in range(5)]
            results = [f.result() for f in futures]

        # All requests should succeed
        for r in results:
            assert r.status_code == 200

        # There should be exactly one default library
        db_session.expire_all()
        result = db_session.execute(
            text(
                "SELECT COUNT(*) FROM libraries "
                "WHERE owner_user_id = :user_id AND is_default = true"
            ),
            {"user_id": user_id},
        )
        count = result.scalar()
        assert count == 1

    def test_partial_state_recovery(self, engine, direct_db: DirectSessionManager):
        """Test 26: Partial state (missing membership) is repaired on next request."""
        user_id = create_test_user_id()

        # Register cleanup upfront (deleted in reverse order: memberships, libraries, users)
        direct_db.register_cleanup("memberships", "user_id", user_id)
        direct_db.register_cleanup("libraries", "owner_user_id", user_id)
        direct_db.register_cleanup("users", "id", user_id)

        # Create user and library manually, but DON'T create membership
        with direct_db.session() as session:
            session.execute(
                text("INSERT INTO users (id) VALUES (:user_id)"),
                {"user_id": user_id},
            )
            result = session.execute(
                text("""
                    INSERT INTO libraries (name, owner_user_id, is_default)
                    VALUES ('My Library', :user_id, true)
                    RETURNING id
                """),
                {"user_id": user_id},
            )
            library_id = result.scalar()
            session.commit()

        # Verify membership doesn't exist
        with direct_db.session() as session:
            result = session.execute(
                text(
                    "SELECT COUNT(*) FROM memberships "
                    "WHERE library_id = :library_id AND user_id = :user_id"
                ),
                {"library_id": library_id, "user_id": user_id},
            )
            assert result.scalar() == 0

        # Create client and make request
        session_factory = create_session_factory(engine)

        def bootstrap_callback(uid: UUID) -> UUID:
            db = session_factory()
            try:
                return ensure_user_and_default_library(db, uid)
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

        with TestClient(app) as client:
            response = client.get("/me", headers=auth_headers(user_id))

        assert response.status_code == 200

        # Membership should now exist
        with direct_db.session() as session:
            result = session.execute(
                text(
                    "SELECT role FROM memberships WHERE library_id = :library_id AND user_id = :user_id"
                ),
                {"library_id": library_id, "user_id": user_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == "admin"


class TestGetMe:
    """Tests for GET /me endpoint."""

    @pytest.fixture
    def auth_client(self, engine):
        """Create a client with auth middleware for testing."""
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

        return TestClient(app)

    def test_me_returns_user_id_and_library_id(self, auth_client):
        """Test 27: GET /me returns user_id and default_library_id."""
        user_id = create_test_user_id()

        response = auth_client.get("/me", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()

        assert "data" in data
        assert "user_id" in data["data"]
        assert "default_library_id" in data["data"]
        assert data["data"]["user_id"] == str(user_id)

    def test_me_response_shape(self, auth_client):
        """Test 28: GET /me response matches expected schema."""
        user_id = create_test_user_id()

        response = auth_client.get("/me", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()

        # Verify envelope structure
        assert "data" in data
        assert "error" not in data

        # Verify data fields are strings (UUIDs)
        assert isinstance(data["data"]["user_id"], str)
        assert isinstance(data["data"]["default_library_id"], str)

        # Verify they're valid UUIDs
        UUID(data["data"]["user_id"])
        UUID(data["data"]["default_library_id"])


class TestHealthEndpointNoAuth:
    """Tests that health endpoint doesn't require authentication."""

    @pytest.fixture
    def auth_client(self, engine):
        """Create a client with auth middleware for testing."""
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

        return TestClient(app)

    def test_health_no_auth_required(self, auth_client):
        """Health endpoint is accessible without authentication."""
        response = auth_client.get("/health")

        assert response.status_code == 200
        data = response.json()
        assert data["data"]["status"] == "ok"
