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


# =============================================================================
# S5 PR-04: EPUB Chapter + TOC Read API Tests
# =============================================================================


def _create_ready_epub(session, *, num_chapters=3, with_toc=True):
    """Insert a ready EPUB with contiguous chapter fragments and optional TOC nodes.

    Returns (media_id, [fragment_ids]).
    """
    media_id = uuid4()
    session.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status)
            VALUES (:id, 'epub', 'Test EPUB Book', 'ready_for_reading')
        """),
        {"id": media_id},
    )

    frag_ids = []
    for i in range(num_chapters):
        fid = uuid4()
        frag_ids.append(fid)
        html = f"<h2>Chapter {i + 1} Title</h2><p>Sentinel content for chapter {i}.</p>"
        canon = f"Chapter {i + 1} Title\nSentinel content for chapter {i}."
        session.execute(
            text("""
                INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                VALUES (:fid, :mid, :idx, :html, :canon)
            """),
            {"fid": fid, "mid": media_id, "idx": i, "html": html, "canon": canon},
        )

    if with_toc:
        for i in range(num_chapters):
            node_id = f"ch{i}"
            order_key = f"{i + 1:04d}"
            session.execute(
                text("""
                    INSERT INTO epub_toc_nodes
                        (media_id, node_id, parent_node_id, label, href, fragment_idx,
                         depth, order_key)
                    VALUES (:mid, :nid, NULL, :label, :href, :fidx, 0, :ok)
                """),
                {
                    "mid": media_id,
                    "nid": node_id,
                    "label": f"TOC Chapter {i + 1}",
                    "href": f"ch{i}.xhtml",
                    "fidx": i,
                    "ok": order_key,
                },
            )

    session.commit()
    return media_id, frag_ids


def _add_media_to_user_library(auth_client, user_id, media_id):
    """Bootstrap user and add media to their default library. Returns library_id."""
    me_resp = auth_client.get("/me", headers=auth_headers(user_id))
    library_id = me_resp.json()["data"]["default_library_id"]
    auth_client.post(
        f"/libraries/{library_id}/media",
        json={"media_id": str(media_id)},
        headers=auth_headers(user_id),
    )
    return library_id


class TestGetEpubChaptersManifestPaginationIsDeterministic:
    """test_get_epub_chapters_manifest_pagination_is_deterministic"""

    def test_paginate_chapters(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=5)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # Page 1: limit=2
        resp1 = auth_client.get(
            f"/media/{media_id}/chapters?limit=2", headers=auth_headers(user_id)
        )
        assert resp1.status_code == 200
        body1 = resp1.json()
        items1 = body1["data"]
        assert len(items1) == 2
        assert items1[0]["idx"] == 0
        assert items1[1]["idx"] == 1
        assert body1["page"]["has_more"] is True
        assert body1["page"]["next_cursor"] == 1

        # Page 2: cursor=1, limit=2
        resp2 = auth_client.get(
            f"/media/{media_id}/chapters?limit=2&cursor=1", headers=auth_headers(user_id)
        )
        assert resp2.status_code == 200
        body2 = resp2.json()
        items2 = body2["data"]
        assert len(items2) == 2
        assert items2[0]["idx"] == 2
        assert items2[1]["idx"] == 3
        assert body2["page"]["has_more"] is True

        # Page 3: cursor=3, limit=2
        resp3 = auth_client.get(
            f"/media/{media_id}/chapters?limit=2&cursor=3", headers=auth_headers(user_id)
        )
        assert resp3.status_code == 200
        body3 = resp3.json()
        items3 = body3["data"]
        assert len(items3) == 1
        assert items3[0]["idx"] == 4
        assert body3["page"]["has_more"] is False
        assert body3["page"]["next_cursor"] is None

        # No cross-page duplicates
        all_idxs = (
            [c["idx"] for c in items1] + [c["idx"] for c in items2] + [c["idx"] for c in items3]
        )
        assert all_idxs == [0, 1, 2, 3, 4]


class TestGetEpubChaptersCursorOutOfRangeReturnsEmptyPage:
    """test_get_epub_chapters_cursor_out_of_range_returns_empty_page"""

    def test_cursor_beyond_max(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/chapters?cursor=99", headers=auth_headers(user_id)
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"] == []
        assert body["page"]["next_cursor"] is None
        assert body["page"]["has_more"] is False

    def test_cursor_equal_to_max(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(
            f"/media/{media_id}/chapters?cursor=2", headers=auth_headers(user_id)
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"] == []
        assert body["page"]["next_cursor"] is None
        assert body["page"]["has_more"] is False


class TestGetEpubChaptersManifestIsMetadataOnly:
    """test_get_epub_chapters_manifest_is_metadata_only"""

    def test_no_heavy_columns(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters", headers=auth_headers(user_id))
        assert resp.status_code == 200
        items = resp.json()["data"]
        assert len(items) > 0
        for item in items:
            assert "html_sanitized" not in item
            assert "canonical_text" not in item
            assert "idx" in item
            assert "fragment_id" in item
            assert "title" in item
            assert "char_count" in item
            assert "word_count" in item
            assert "has_toc_entry" in item
            assert "primary_toc_node_id" in item


class TestGetEpubChaptersProjectionExcludesHeavyColumns:
    """test_get_epub_chapters_projection_excludes_heavy_columns

    Verifies the service layer does not return html_sanitized/canonical_text
    in the manifest items (serialization-level check).
    """

    def test_serialized_output_excludes_content(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=1)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters", headers=auth_headers(user_id))
        assert resp.status_code == 200
        raw = resp.text
        assert "html_sanitized" not in raw
        assert "canonical_text" not in raw


class TestGetEpubChaptersPrimaryTocNodeUsesMinOrderKey:
    """test_get_epub_chapters_primary_toc_node_uses_min_order_key"""

    def test_multiple_toc_nodes_same_chapter(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'epub', 'Multi-TOC EPUB', 'ready_for_reading')
                """),
                {"id": media_id},
            )
            fid = uuid4()
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:fid, :mid, 0, '<p>Content</p>', 'Content')
                """),
                {"fid": fid, "mid": media_id},
            )
            # Two TOC nodes both pointing to fragment_idx=0, different order_keys
            session.execute(
                text("""
                    INSERT INTO epub_toc_nodes
                        (media_id, node_id, parent_node_id, label, href, fragment_idx,
                         depth, order_key)
                    VALUES
                        (:mid, 'second', NULL, 'Second Label', NULL, 0, 0, '0002'),
                        (:mid, 'first', NULL, 'First Label', NULL, 0, 0, '0001')
                """),
                {"mid": media_id},
            )
            session.commit()

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters", headers=auth_headers(user_id))
        assert resp.status_code == 200
        items = resp.json()["data"]
        assert len(items) == 1
        ch = items[0]
        assert ch["primary_toc_node_id"] == "first"
        assert ch["title"] == "First Label"
        assert ch["has_toc_entry"] is True


class TestGetEpubChapterByIdxReturnsPayloadAndNavigation:
    """test_get_epub_chapter_by_idx_returns_payload_and_navigation"""

    def test_navigation_pointers(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, frag_ids = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # First chapter: prev_idx=null, next_idx=1
        resp0 = auth_client.get(f"/media/{media_id}/chapters/0", headers=auth_headers(user_id))
        assert resp0.status_code == 200
        ch0 = resp0.json()["data"]
        assert ch0["idx"] == 0
        assert ch0["prev_idx"] is None
        assert ch0["next_idx"] == 1
        assert ch0["fragment_id"] == str(frag_ids[0])
        assert "html_sanitized" in ch0
        assert "canonical_text" in ch0
        assert "created_at" in ch0

        # Middle chapter: prev_idx=0, next_idx=2
        resp1 = auth_client.get(f"/media/{media_id}/chapters/1", headers=auth_headers(user_id))
        ch1 = resp1.json()["data"]
        assert ch1["prev_idx"] == 0
        assert ch1["next_idx"] == 2

        # Last chapter: prev_idx=1, next_idx=null
        resp2 = auth_client.get(f"/media/{media_id}/chapters/2", headers=auth_headers(user_id))
        ch2 = resp2.json()["data"]
        assert ch2["prev_idx"] == 1
        assert ch2["next_idx"] is None


class TestGetEpubChapterReturnsSingleChapterNotConcatenated:
    """test_get_epub_chapter_returns_single_chapter_not_concatenated"""

    def test_no_adjacent_content(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=3)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters/1", headers=auth_headers(user_id))
        assert resp.status_code == 200
        ch = resp.json()["data"]
        # Should contain sentinel for chapter 1 only
        assert "Sentinel content for chapter 1" in ch["canonical_text"]
        assert "Sentinel content for chapter 0" not in ch["canonical_text"]
        assert "Sentinel content for chapter 2" not in ch["canonical_text"]


class TestGetEpubChapterMissingIdxReturns404:
    """test_get_epub_chapter_missing_idx_returns_404"""

    def test_nonexistent_idx(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/chapters/99", headers=auth_headers(user_id))
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "E_CHAPTER_NOT_FOUND"


class TestGetEpubTocReturnsNestedTreeOrderedByOrderKey:
    """test_get_epub_toc_returns_nested_tree_ordered_by_order_key"""

    def test_nested_toc_ordering(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'epub', 'Nested TOC EPUB', 'ready_for_reading')
                """),
                {"id": media_id},
            )
            # Create a fragment for linking
            fid = uuid4()
            session.execute(
                text("""
                    INSERT INTO fragments (id, media_id, idx, html_sanitized, canonical_text)
                    VALUES (:fid, :mid, 0, '<p>Content</p>', 'Content')
                """),
                {"fid": fid, "mid": media_id},
            )
            # Insert TOC nodes out of order to test deterministic ordering
            nodes = [
                ("root2", None, "Part II", None, None, 0, "0002"),
                ("root1", None, "Part I", None, None, 0, "0001"),
                ("child1_2", "root1", "Chapter 1.2", None, 0, 1, "0001.0002"),
                ("child1_1", "root1", "Chapter 1.1", None, 0, 1, "0001.0001"),
            ]
            for nid, pid, label, href, fidx, depth, ok in nodes:
                session.execute(
                    text("""
                        INSERT INTO epub_toc_nodes
                            (media_id, node_id, parent_node_id, label, href,
                             fragment_idx, depth, order_key)
                        VALUES (:mid, :nid, :pid, :label, :href, :fidx, :depth, :ok)
                    """),
                    {
                        "mid": media_id,
                        "nid": nid,
                        "pid": pid,
                        "label": label,
                        "href": href,
                        "fidx": fidx,
                        "depth": depth,
                        "ok": ok,
                    },
                )
            session.commit()

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/toc", headers=auth_headers(user_id))
        assert resp.status_code == 200
        nodes_out = resp.json()["data"]["nodes"]

        # Root ordering
        assert len(nodes_out) == 2
        assert nodes_out[0]["node_id"] == "root1"
        assert nodes_out[0]["order_key"] == "0001"
        assert nodes_out[1]["node_id"] == "root2"
        assert nodes_out[1]["order_key"] == "0002"

        # Children of root1 ordered
        children = nodes_out[0]["children"]
        assert len(children) == 2
        assert children[0]["node_id"] == "child1_1"
        assert children[0]["order_key"] == "0001.0001"
        assert children[1]["node_id"] == "child1_2"
        assert children[1]["order_key"] == "0001.0002"

        # root2 has no children
        assert nodes_out[1]["children"] == []


class TestGetEpubTocEmptyReturnsNodesEmpty:
    """test_get_epub_toc_empty_returns_nodes_empty"""

    def test_epub_without_toc(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=1, with_toc=False)

        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        resp = auth_client.get(f"/media/{media_id}/toc", headers=auth_headers(user_id))
        assert resp.status_code == 200
        assert resp.json()["data"]["nodes"] == []


class TestGetEpubReadEndpointsVisibilityMasking:
    """test_get_epub_read_endpoints_visibility_masking"""

    def test_unreadable_user_gets_404(self, auth_client, direct_db: DirectSessionManager):
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=2)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Only user A gets the media
        _add_media_to_user_library(auth_client, user_a, media_id)
        # Bootstrap user B (no media)
        auth_client.get("/me", headers=auth_headers(user_b))

        # User B should get 404 on all three endpoints (visibility masking)
        for path in [
            f"/media/{media_id}/chapters",
            f"/media/{media_id}/chapters/0",
            f"/media/{media_id}/toc",
        ]:
            resp = auth_client.get(path, headers=auth_headers(user_b))
            assert resp.status_code == 404, f"Expected 404 for {path}, got {resp.status_code}"
            body = resp.json()
            assert body["error"]["code"] == "E_MEDIA_NOT_FOUND"


class TestGetEpubReadEndpointsKindAndReadinessGuards:
    """test_get_epub_read_endpoints_kind_and_readiness_guards"""

    def test_non_epub_returns_400(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        media_id = uuid4()

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status)
                    VALUES (:id, 'web_article', 'An Article', 'ready_for_reading')
                """),
                {"id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        for path in [
            f"/media/{media_id}/chapters",
            f"/media/{media_id}/chapters/0",
            f"/media/{media_id}/toc",
        ]:
            resp = auth_client.get(path, headers=auth_headers(user_id))
            assert resp.status_code == 400, f"Expected 400 for {path}"
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

        _add_media_to_user_library(auth_client, user_id, media_id)

        for path in [
            f"/media/{media_id}/chapters",
            f"/media/{media_id}/chapters/0",
            f"/media/{media_id}/toc",
        ]:
            resp = auth_client.get(path, headers=auth_headers(user_id))
            assert resp.status_code == 409, f"Expected 409 for {path}"
            assert resp.json()["error"]["code"] == "E_MEDIA_NOT_READY"


class TestGetEpubChaptersInvalidLimitCursorAndIdxAre400:
    """test_get_epub_chapters_invalid_limit_cursor_and_idx_are_400"""

    def test_invalid_params(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()

        with direct_db.session() as session:
            media_id, _ = _create_ready_epub(session, num_chapters=1)

        direct_db.register_cleanup("epub_toc_nodes", "media_id", media_id)
        direct_db.register_cleanup("fragments", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        _add_media_to_user_library(auth_client, user_id, media_id)

        # Invalid limit: 0
        resp = auth_client.get(f"/media/{media_id}/chapters?limit=0", headers=auth_headers(user_id))
        assert resp.status_code == 400

        # Invalid limit: 201
        resp = auth_client.get(
            f"/media/{media_id}/chapters?limit=201", headers=auth_headers(user_id)
        )
        assert resp.status_code == 400

        # Invalid cursor: -1
        resp = auth_client.get(
            f"/media/{media_id}/chapters?cursor=-1", headers=auth_headers(user_id)
        )
        assert resp.status_code == 400

        # Invalid chapter idx: -1
        resp = auth_client.get(f"/media/{media_id}/chapters/-1", headers=auth_headers(user_id))
        assert resp.status_code == 400
