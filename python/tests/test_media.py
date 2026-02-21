"""Integration tests for media service and routes.

Tests cover:
- Media visibility enforcement
- Fragment retrieval
- 404 masking for unreadable media
- Timestamp serialization

Tests scenarios from s0_spec.md:
- #12: Non-member cannot read media
- #19: GET /media/{id} enforces visibility
- #20: GET /media/{id}/fragments returns content
"""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from tests.fixtures import (
    FIXTURE_CANONICAL_TEXT,
    FIXTURE_FRAGMENT_ID,
    FIXTURE_HTML_SANITIZED,
    FIXTURE_MEDIA_ID,
    FIXTURE_TITLE,
)
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


def create_seeded_media(session: Session) -> UUID:
    """Create the seeded fixture media directly in the database.

    Returns the media ID.
    """
    session.execute(
        text("""
            INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
            VALUES (
                :media_id,
                'web_article',
                :title,
                'https://example.com/test-article',
                'ready_for_reading'
            )
            ON CONFLICT (id) DO NOTHING
        """),
        {"media_id": FIXTURE_MEDIA_ID, "title": FIXTURE_TITLE},
    )

    session.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
            VALUES (
                :fragment_id,
                :media_id,
                0,
                :html_sanitized,
                :canonical_text
            )
            ON CONFLICT (id) DO NOTHING
        """),
        {
            "fragment_id": FIXTURE_FRAGMENT_ID,
            "media_id": FIXTURE_MEDIA_ID,
            "html_sanitized": FIXTURE_HTML_SANITIZED,
            "canonical_text": FIXTURE_CANONICAL_TEXT,
        },
    )

    session.commit()
    return FIXTURE_MEDIA_ID


# =============================================================================
# GET /media/{id} Tests
# =============================================================================


class TestGetMedia:
    """Tests for GET /media/{id} endpoint."""

    def test_get_media_success(self, auth_client, direct_db: DirectSessionManager):
        """Test #19a: Member can read media in their library."""
        user_id = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add media to user's library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get media
        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["id"] == str(media_id)
        assert data["kind"] == "web_article"
        assert data["title"] == FIXTURE_TITLE
        assert data["processing_status"] == "ready_for_reading"

    def test_get_media_includes_request_id_header(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Test #21: GET /media/{id} includes X-Request-ID header on 200 response."""
        user_id = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add media to user's library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get media
        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        # Verify X-Request-ID header is present
        assert "X-Request-ID" in response.headers
        # Verify it's a valid format (UUID or alphanumeric)
        request_id = response.headers["X-Request-ID"]
        assert len(request_id) > 0
        assert len(request_id) <= 128

    def test_get_media_not_found(self, auth_client):
        """Test #19b: Non-existent media returns 404."""
        user_id = create_test_user_id()

        # Bootstrap user
        auth_client.get("/me", headers=auth_headers(user_id))

        # Try to get non-existent media
        response = auth_client.get(f"/media/{uuid4()}", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_get_media_not_in_library(self, auth_client, direct_db: DirectSessionManager):
        """Test #12 & #19c: Media not in user's library returns 404 (masks existence)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media to their library
        me_resp_a = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp_a.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # User B tries to access media (not in their library)
        auth_client.get("/me", headers=auth_headers(user_b))

        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_b))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_get_media_response_shape(self, auth_client, direct_db: DirectSessionManager):
        """Verify response shape matches spec."""
        user_id = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Verify all required fields present
        assert "id" in data
        assert "kind" in data
        assert "title" in data
        assert "canonical_source_url" in data
        assert "processing_status" in data
        assert "created_at" in data
        assert "updated_at" in data

        # Verify no extra fields (author is NOT included per spec)
        assert "author" not in data

        # Verify timestamps are valid ISO8601
        from datetime import datetime

        datetime.fromisoformat(data["created_at"].replace("Z", "+00:00"))
        datetime.fromisoformat(data["updated_at"].replace("Z", "+00:00"))


# =============================================================================
# GET /media/{id}/fragments Tests
# =============================================================================


class TestGetMediaFragments:
    """Tests for GET /media/{id}/fragments endpoint."""

    def test_get_fragments_success(self, auth_client, direct_db: DirectSessionManager):
        """Test #20: GET /media/{id}/fragments returns content."""
        user_id = create_test_user_id()

        # Create media with fragment
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get fragments
        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 1

        fragment = data[0]
        assert fragment["id"] == str(FIXTURE_FRAGMENT_ID)
        assert fragment["media_id"] == str(media_id)
        assert fragment["idx"] == 0
        assert "html_sanitized" in fragment
        assert "canonical_text" in fragment
        assert fragment["html_sanitized"] == FIXTURE_HTML_SANITIZED
        assert fragment["canonical_text"] == FIXTURE_CANONICAL_TEXT

    def test_get_fragments_not_found(self, auth_client):
        """Non-existent media returns 404."""
        user_id = create_test_user_id()

        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.get(f"/media/{uuid4()}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_get_fragments_not_in_library(self, auth_client, direct_db: DirectSessionManager):
        """Media not in user's library returns 404 (masks existence)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        # Create media
        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User A adds media
        me_resp_a = auth_client.get("/me", headers=auth_headers(user_a))
        library_a = me_resp_a.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_a}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_a),
        )

        # User B tries to access fragments (not in their library)
        auth_client.get("/me", headers=auth_headers(user_b))

        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_b))

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_get_fragments_ordering(self, auth_client, direct_db: DirectSessionManager):
        """Fragments are ordered by idx ASC."""
        user_id = create_test_user_id()

        # Create media with multiple fragments
        media_id = uuid4()
        fragment_ids = [uuid4() for _ in range(3)]

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:media_id, 'web_article', 'Multi Fragment', 'ready_for_reading')
                """),
                {"media_id": media_id},
            )

            # Insert fragments in reverse order to test ordering
            for i, frag_id in enumerate(reversed(fragment_ids)):
                session.execute(
                    text("""
                        INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                        VALUES (:frag_id, :media_id, :idx, :html, :text)
                    """),
                    {
                        "frag_id": frag_id,
                        "media_id": media_id,
                        "idx": 2 - i,  # Insert as 2, 1, 0
                        "html": f"<p>Fragment {2 - i}</p>",
                        "text": f"Fragment {2 - i}",
                    },
                )

            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get fragments
        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3

        # Verify ordering by idx ASC
        for i, fragment in enumerate(data):
            assert fragment["idx"] == i

    def test_get_fragments_empty(self, auth_client, direct_db: DirectSessionManager):
        """Media with no fragments returns empty list."""
        user_id = create_test_user_id()

        # Create media without fragments
        media_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:media_id, 'web_article', 'No Fragments', 'ready_for_reading')
                """),
                {"media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Add to library
        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Get fragments
        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 200
        assert response.json()["data"] == []


# =============================================================================
# Content Safety Tests
# =============================================================================


class TestContentSafety:
    """Tests verifying no endpoint returns unsanitized HTML."""

    def test_fragments_return_sanitized_html(self, auth_client, direct_db: DirectSessionManager):
        """Verify fragments endpoint returns html_sanitized field."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        assert response.status_code == 200
        data = response.json()["data"]

        # Verify the field is called html_sanitized, not html_raw
        for fragment in data:
            assert "html_sanitized" in fragment
            assert "html_raw" not in fragment
            assert "html" not in fragment  # No ambiguous "html" field


# =============================================================================
# Timestamp Serialization Tests
# =============================================================================


class TestTimestampSerialization:
    """Tests for timestamp serialization format."""

    def test_media_timestamps_iso8601(self, auth_client, direct_db: DirectSessionManager):
        """Media timestamps are valid ISO8601."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))

        data = response.json()["data"]

        # Verify parseability
        from datetime import datetime

        for ts_field in ["created_at", "updated_at"]:
            ts = data[ts_field]
            # Replace Z with +00:00 for Python parsing
            parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            assert parsed is not None

    def test_fragment_timestamps_iso8601(self, auth_client, direct_db: DirectSessionManager):
        """Fragment timestamps are valid ISO8601."""
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id = create_seeded_media(session)

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        response = auth_client.get(f"/media/{media_id}/fragments", headers=auth_headers(user_id))

        for fragment in response.json()["data"]:
            from datetime import datetime

            ts = fragment["created_at"]
            parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            assert parsed is not None


# =============================================================================
# S5 PR-02: EPUB Asset Endpoint Tests
# =============================================================================


class TestGetEpubAssetSuccessAndMasking:
    """test_get_epub_asset_success_and_masking"""

    def test_resolved_asset_returns_binary(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()
        asset_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'epub', 'Test EPUB', 'ready_for_reading')
                """),
                {"id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        # Put asset into fake storage
        from nexus.storage.client import FakeStorageClient

        fake = FakeStorageClient()
        fake.put_object(f"media/{media_id}/assets/images/fig1.png", asset_content, "image/png")

        from unittest.mock import patch

        with patch("nexus.storage.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/images/fig1.png",
                headers=auth_headers(user_id),
            )

        assert resp.status_code == 200
        assert resp.content == asset_content
        assert "image/png" in resp.headers.get("content-type", "")

    def test_unauthorized_viewer_gets_404(self, auth_client, direct_db: DirectSessionManager):
        other_user = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'epub', 'Test EPUB', 'ready_for_reading')
                """),
                {"id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("media", "id", media_id)

        resp = auth_client.get(
            f"/media/{media_id}/assets/images/fig1.png",
            headers=auth_headers(other_user),
        )
        assert resp.status_code == 404

    def test_missing_asset_returns_404(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'epub', 'Test EPUB', 'ready_for_reading')
                """),
                {"id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import patch

        from nexus.storage.client import FakeStorageClient

        fake = FakeStorageClient()

        with patch("nexus.storage.get_storage_client", return_value=fake):
            resp = auth_client.get(
                f"/media/{media_id}/assets/nonexistent.png",
                headers=auth_headers(user_id),
            )
        assert resp.status_code == 404


class TestGetEpubAssetKindAndReadyGuards:
    """test_get_epub_asset_kind_and_ready_guards"""

    def test_non_epub_returns_400(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'web_article', 'Article', 'ready_for_reading')
                """),
                {"id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        resp = auth_client.get(
            f"/media/{media_id}/assets/test.png",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_KIND"

    def test_non_ready_epub_returns_409(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'epub', 'Pending EPUB', 'pending')
                """),
                {"id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        resp = auth_client.get(
            f"/media/{media_id}/assets/test.png",
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"


# =============================================================================
# S5 PR-03: EPUB Retry Endpoint Tests
# =============================================================================


def _create_failed_epub(
    session,
    user_id,
    *,
    last_error_code="E_INGEST_FAILED",
    with_file=True,
    file_sha256="abc123",
):
    """Insert a failed EPUB media row suitable for retry tests."""
    media_id = uuid4()
    session.execute(
        text("""
            INSERT INTO media (
                id, kind, title, processing_status, created_by_user_id,
                failure_stage, last_error_code, last_error_message, failed_at,
                file_sha256, processing_attempts
            )
            VALUES (
                :id, 'epub', 'Failed EPUB', 'failed', :uid,
                'extract', :err, 'test failure', now(),
                :sha, 1
            )
        """),
        {
            "id": media_id,
            "uid": user_id,
            "err": last_error_code,
            "sha": file_sha256,
        },
    )
    if with_file:
        session.execute(
            text("""
                INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                VALUES (:mid, :sp, 'application/epub+zip', 1000)
            """),
            {"mid": media_id, "sp": f"media/{media_id}/original.epub"},
        )
    session.commit()
    return media_id


class TestRetryEpubEndpoint:
    """S5 PR-03: POST /media/{id}/retry tests."""

    def test_retry_epub_failed_resets_and_dispatches(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200
        import hashlib

        sha = hashlib.sha256(epub_bytes).hexdigest()

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256=sha)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import MagicMock, patch

        mock_dispatch = MagicMock()

        with (
            patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage),
            patch("nexus.tasks.ingest_epub.ingest_epub.apply_async", mock_dispatch),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202
        data = resp.json()["data"]
        assert data["processing_status"] == "extracting"
        assert data["retry_enqueued"] is True

        mock_dispatch.assert_called_once()

        with direct_db.session() as session:
            row = session.execute(
                text(
                    "SELECT processing_status, processing_attempts, last_error_code FROM media WHERE id = :id"
                ),
                {"id": media_id},
            ).fetchone()
            assert row[0] == "extracting"
            assert row[1] == 2
            assert row[2] is None

    def test_retry_invalid_state_returns_409(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        media_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'epub', 'Not Failed', 'pending', :uid)
                """),
                {"id": media_id, "uid": user_id},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_RETRY_INVALID_STATE"

    def test_retry_terminal_archive_failure_blocked(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, last_error_code="E_ARCHIVE_UNSAFE")

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))
        assert resp.status_code == 409
        assert resp.json()["error"]["code"] == "E_RETRY_NOT_ALLOWED"

    def test_retry_kind_guard_and_auth(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        # non-EPUB
        non_epub_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Article', 'failed', :uid)
                """),
                {"id": non_epub_id, "uid": user_a},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", non_epub_id)
        direct_db.register_cleanup("media", "id", non_epub_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_a))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(non_epub_id)},
            headers=auth_headers(user_a),
        )

        resp = auth_client.post(f"/media/{non_epub_id}/retry", headers=auth_headers(user_a))
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_KIND"

        # non-creator
        with direct_db.session() as session:
            epub_id = _create_failed_epub(session, user_a)

        direct_db.register_cleanup("library_media", "media_id", epub_id)
        direct_db.register_cleanup("media_file", "media_id", epub_id)
        direct_db.register_cleanup("media", "id", epub_id)

        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(epub_id)},
            headers=auth_headers(user_a),
        )

        me_b = auth_client.get("/me", headers=auth_headers(user_b))
        lib_b = me_b.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{lib_b}/media",
            json={"media_id": str(epub_id)},
            headers=auth_headers(user_b),
        )

        resp = auth_client.post(f"/media/{epub_id}/retry", headers=auth_headers(user_b))
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "E_FORBIDDEN"

    def test_retry_visibility_masking(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_a)

        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_b))
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_retry_source_integrity_precondition_failure_no_mutation(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256="deadbeef")

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()

        from unittest.mock import patch

        with patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_STORAGE_MISSING"

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT processing_status, processing_attempts FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()
            assert row[0] == "failed"
            assert row[1] == 1

    def test_retry_preserves_source_identity_fields(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200
        import hashlib

        sha = hashlib.sha256(epub_bytes).hexdigest()

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256=sha)

        storage_path = f"media/{media_id}/original.epub"
        fake_storage.put_object(storage_path, epub_bytes, "application/epub+zip")

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import MagicMock, patch

        with (
            patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage),
            patch("nexus.tasks.ingest_epub.ingest_epub.apply_async", MagicMock()),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 202

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT file_sha256 FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()
            assert row[0] == sha

            mf = session.execute(
                text("SELECT storage_path FROM media_file WHERE media_id = :id"),
                {"id": media_id},
            ).fetchone()
            assert mf[0] == storage_path

    def test_retry_dispatch_failure_rolls_back_state(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        from nexus.storage.client import FakeStorageClient

        fake_storage = FakeStorageClient()
        epub_bytes = b"PK\x03\x04" + b"\x00" * 200
        import hashlib

        sha = hashlib.sha256(epub_bytes).hexdigest()

        with direct_db.session() as session:
            media_id = _create_failed_epub(session, user_id, file_sha256=sha)

        fake_storage.put_object(
            f"media/{media_id}/original.epub", epub_bytes, "application/epub+zip"
        )

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        me_resp = auth_client.get("/me", headers=auth_headers(user_id))
        library_id = me_resp.json()["data"]["default_library_id"]
        auth_client.post(
            f"/libraries/{library_id}/media",
            json={"media_id": str(media_id)},
            headers=auth_headers(user_id),
        )

        from unittest.mock import patch

        def boom(*a, **kw):
            raise RuntimeError("broker down")

        with (
            patch("nexus.services.epub_lifecycle.get_storage_client", return_value=fake_storage),
            patch("nexus.tasks.ingest_epub.ingest_epub.apply_async", side_effect=boom),
        ):
            resp = auth_client.post(f"/media/{media_id}/retry", headers=auth_headers(user_id))

        assert resp.status_code == 500

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT processing_status FROM media WHERE id = :id"),
                {"id": media_id},
            ).fetchone()
            assert row[0] != "extracting"
