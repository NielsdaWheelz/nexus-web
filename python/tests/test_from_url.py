"""Integration tests for POST /media/from_url endpoint.

Tests cover PR-03 requirements:
- Creating provisional web_article media from URL
- URL validation (scheme, length, userinfo, localhost)
- Default library attachment
- Visibility enforcement
- Response envelope and status codes

Per s2_pr03.md spec:
- duplicate is always False in PR-03
- processing_status is always 'pending'
- ingest_enqueued is always False
- canonical_url is NULL
- requested_url is stored exactly as provided
- canonical_source_url is normalized
"""

from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.helpers import auth_headers, create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def auth_client(engine):
    """Create a client with auth + request-id middleware for testing."""
    from nexus.app import add_request_id_middleware

    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    verifier = MockJwtVerifier()
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


# =============================================================================
# POST /media/from_url - Success Cases
# =============================================================================


class TestFromUrlSuccess:
    """Tests for successful POST /media/from_url requests."""

    def test_create_web_article_success(self, auth_client, direct_db: DirectSessionManager):
        """Test creating a provisional web_article from a valid URL."""
        user_id = create_test_user_id()

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        url = "https://example.com/article"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        data = response.json()["data"]

        # Verify response shape
        assert "media_id" in data
        media_id = UUID(data["media_id"])
        assert data["duplicate"] is False
        assert data["processing_status"] == "pending"
        assert data["ingest_enqueued"] is False

        # Register cleanup
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Verify media row in database
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT kind, title, requested_url, canonical_url, canonical_source_url,
                           processing_status, created_by_user_id
                    FROM media WHERE id = :media_id
                """),
                {"media_id": media_id},
            )
            row = result.fetchone()

            assert row is not None
            assert row[0] == "web_article"  # kind
            assert row[1] == url  # title (placeholder)
            assert row[2] == url  # requested_url (exact)
            assert row[3] is None  # canonical_url (NULL until PR-04)
            assert row[4] == "https://example.com/article"  # canonical_source_url (normalized)
            assert row[5] == "pending"  # processing_status
            assert row[6] == user_id  # created_by_user_id

    def test_media_attached_to_default_library(self, auth_client, direct_db: DirectSessionManager):
        """Test that created media is attached to viewer's default library."""
        user_id = create_test_user_id()

        # Bootstrap user and get default library ID
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        default_library_id = UUID(me_resp.json()["data"]["default_library_id"])

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/test"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        media_id = UUID(response.json()["data"]["media_id"])

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Verify library_media row exists
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT library_id, media_id FROM library_media
                    WHERE library_id = :library_id AND media_id = :media_id
                """),
                {"library_id": default_library_id, "media_id": media_id},
            )
            row = result.fetchone()
            assert row is not None

    def test_media_readable_by_creator(self, auth_client, direct_db: DirectSessionManager):
        """Test that creator can read the media via GET /media/{id}."""
        user_id = create_test_user_id()

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/readable"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        media_id = UUID(response.json()["data"]["media_id"])

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Creator should be able to read the media
        get_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert get_response.status_code == 200
        assert get_response.json()["data"]["id"] == str(media_id)

    def test_url_normalization_lowercase(self, auth_client, direct_db: DirectSessionManager):
        """Test that URL scheme and host are lowercased in canonical_source_url."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        url = "HTTPS://EXAMPLE.COM/Article"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        media_id = UUID(response.json()["data"]["media_id"])

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            result = session.execute(
                text("SELECT requested_url, canonical_source_url FROM media WHERE id = :id"),
                {"id": media_id},
            )
            row = result.fetchone()

            # requested_url should be exactly as provided
            assert row[0] == url
            # canonical_source_url should be normalized (lowercase scheme/host)
            assert row[1] == "https://example.com/Article"

    def test_url_normalization_strip_fragment(self, auth_client, direct_db: DirectSessionManager):
        """Test that URL fragment is stripped in canonical_source_url."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        url = "https://example.com/page#section1"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        media_id = UUID(response.json()["data"]["media_id"])

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            result = session.execute(
                text("SELECT requested_url, canonical_source_url FROM media WHERE id = :id"),
                {"id": media_id},
            )
            row = result.fetchone()

            # requested_url keeps fragment
            assert row[0] == url
            # canonical_source_url has fragment stripped
            assert row[1] == "https://example.com/page"

    def test_url_normalization_preserve_query_params(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test that query params are preserved in canonical_source_url."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        url = "https://example.com/search?q=test&page=1"
        response = auth_client.post(
            "/media/from_url",
            json={"url": url},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 201
        media_id = UUID(response.json()["data"]["media_id"])

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            result = session.execute(
                text("SELECT canonical_source_url FROM media WHERE id = :id"),
                {"id": media_id},
            )
            row = result.fetchone()
            # Query params should be preserved
            assert row[0] == "https://example.com/search?q=test&page=1"


# =============================================================================
# POST /media/from_url - Validation Errors
# =============================================================================


class TestFromUrlValidation:
    """Tests for URL validation in POST /media/from_url."""

    def test_invalid_scheme_rejected(self, auth_client):
        """Test that non-http/https schemes are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "ftp://example.com/file"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert "scheme" in response.json()["error"]["message"].lower()

    def test_javascript_scheme_rejected(self, auth_client):
        """Test that javascript: URLs are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "javascript:alert(1)"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_overlong_url_rejected(self, auth_client):
        """Test that URLs over 2048 characters are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        long_url = "https://example.com/" + "a" * 2050
        response = auth_client.post(
            "/media/from_url",
            json={"url": long_url},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert "2048" in response.json()["error"]["message"]

    def test_userinfo_rejected(self, auth_client):
        """Test that URLs with credentials (user:pass@host) are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://user:pass@example.com/article"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert "credentials" in response.json()["error"]["message"].lower()

    def test_localhost_rejected(self, auth_client):
        """Test that localhost URLs are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://localhost/admin"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert "localhost" in response.json()["error"]["message"].lower()

    def test_127_0_0_1_rejected(self, auth_client):
        """Test that 127.0.0.1 URLs are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://127.0.0.1:8080/secret"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_ipv6_loopback_rejected(self, auth_client):
        """Test that ::1 URLs are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://[::1]/secret"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_local_domain_rejected(self, auth_client):
        """Test that *.local domains are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://myserver.local/api"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_missing_host_rejected(self, auth_client):
        """Test that URLs without hosts are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https:///path/only"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_relative_url_rejected(self, auth_client):
        """Test that relative URLs are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "/just/a/path"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_empty_url_rejected(self, auth_client):
        """Test that empty URLs are rejected."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": ""},
            headers=auth_headers(user_id),
        )

        # Pydantic validation should reject empty string (min_length=1)
        assert response.status_code == 400


# =============================================================================
# POST /media/from_url - Visibility Tests
# =============================================================================


class TestFromUrlVisibility:
    """Tests for visibility enforcement on created media."""

    def test_other_user_cannot_read_media(self, auth_client, direct_db: DirectSessionManager):
        """Test that other users cannot read media they don't have access to."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # Bootstrap both users
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # User A creates media
        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/private"},
            headers=auth_headers(user_a),
        )

        assert response.status_code == 201
        media_id = UUID(response.json()["data"]["media_id"])

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User B tries to read - should get 404 (masked)
        get_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_b))
        assert get_response.status_code == 404
        assert get_response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"


# =============================================================================
# POST /media/from_url - Authentication Tests
# =============================================================================


class TestFromUrlAuth:
    """Tests for authentication requirements."""

    def test_unauthenticated_rejected(self, auth_client):
        """Test that unauthenticated requests are rejected."""
        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/article"},
            # No auth headers
        )

        assert response.status_code == 401
        assert response.json()["error"]["code"] == "E_UNAUTHENTICATED"
