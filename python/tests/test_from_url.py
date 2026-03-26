"""Integration tests for POST /media/from_url endpoint.

Tests cover PR-04 requirements:
- Creating provisional web_article media from URL
- URL validation (scheme, length, userinfo, localhost)
- Default library attachment
- Visibility enforcement
- Response envelope and status codes

Per s2_pr04.md spec:
- Returns 202 Accepted (not 201) and enqueues ingestion
- duplicate is always False at creation time
- processing_status is 'pending'
- ingest_enqueued reflects whether task was enqueued
- canonical_url is NULL (set during ingestion after redirect resolution)
- requested_url is stored exactly as provided
- canonical_source_url is normalized
"""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def _install_background_job_insert_failure(direct_db: DirectSessionManager) -> None:
    """Force background_jobs inserts to fail until teardown is called."""
    with direct_db.session() as session:
        session.execute(
            text(
                """
                CREATE OR REPLACE FUNCTION nexus_test_fail_background_job_insert()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                BEGIN
                    RAISE EXCEPTION 'queue unavailable';
                END;
                $$;
                """
            )
        )
        session.execute(
            text(
                """
                DROP TRIGGER IF EXISTS nexus_test_fail_background_job_insert
                ON background_jobs
                """
            )
        )
        session.execute(
            text(
                """
                CREATE TRIGGER nexus_test_fail_background_job_insert
                BEFORE INSERT ON background_jobs
                FOR EACH ROW
                EXECUTE FUNCTION nexus_test_fail_background_job_insert()
                """
            )
        )
        session.commit()


def _remove_background_job_insert_failure(direct_db: DirectSessionManager) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                """
                DROP TRIGGER IF EXISTS nexus_test_fail_background_job_insert
                ON background_jobs
                """
            )
        )
        session.execute(
            text("DROP FUNCTION IF EXISTS nexus_test_fail_background_job_insert()")
        )
        session.commit()

# =============================================================================
# Fixtures
# =============================================================================


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

        assert response.status_code == 202
        data = response.json()["data"]

        # Verify response shape
        assert "media_id" in data
        media_id = UUID(data["media_id"])
        assert data["duplicate"] is False
        assert data["processing_status"] == "pending"
        # In test environment, task is not actually enqueued
        assert "ingest_enqueued" in data

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

        assert response.status_code == 202
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

        assert response.status_code == 202
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

        assert response.status_code == 202
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

        assert response.status_code == 202
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

        assert response.status_code == 202
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

    def test_youtube_variants_reuse_one_video_identity(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """YouTube URL variants should converge on one canonical video media row."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        first_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=auth_headers(user_id),
        )
        assert first_response.status_code == 202, (
            f"expected first youtube ingest to return 202, got {first_response.status_code}: "
            f"{first_response.text}"
        )
        first_data = first_response.json()["data"]
        media_id = UUID(first_data["media_id"])

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        assert first_data["idempotency_outcome"] == "created"
        assert first_data["duplicate"] is False

        second_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://youtu.be/dQw4w9WgXcQ?t=43"},
            headers=auth_headers(user_id),
        )
        assert second_response.status_code == 202, (
            f"expected second youtube ingest to return 202, got {second_response.status_code}: "
            f"{second_response.text}"
        )
        second_data = second_response.json()["data"]

        assert UUID(second_data["media_id"]) == media_id
        assert second_data["idempotency_outcome"] == "reused"
        assert second_data["duplicate"] is True

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT kind, provider, provider_id, canonical_url, canonical_source_url
                    FROM media
                    WHERE id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()
            count = session.execute(
                text("""
                    SELECT COUNT(*)
                    FROM media
                    WHERE kind = 'video'
                      AND provider = 'youtube'
                      AND provider_id = :provider_id
                      AND created_by_user_id = :user_id
                """),
                {"provider_id": "dQw4w9WgXcQ", "user_id": user_id},
            ).scalar()

        assert row is not None
        assert row[0] == "video"
        assert row[1] == "youtube"
        assert row[2] == "dQw4w9WgXcQ"
        assert row[3] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        assert row[4] == "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        assert count == 1, f"expected one canonical youtube media row, found {count}"

    def test_youtube_reuse_is_global_across_users(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Repeated ingest by different users should attach one shared video row."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        me_a = auth_client.get("/me", headers=auth_headers(user_a))
        me_b = auth_client.get("/me", headers=auth_headers(user_b))
        default_library_a = UUID(me_a.json()["data"]["default_library_id"])
        default_library_b = UUID(me_b.json()["data"]["default_library_id"])

        first_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://www.youtube.com/embed/dQw4w9WgXcQ"},
            headers=auth_headers(user_a),
        )
        assert first_response.status_code == 202
        first_data = first_response.json()["data"]
        media_id = UUID(first_data["media_id"])

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        second_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be"},
            headers=auth_headers(user_b),
        )
        assert second_response.status_code == 202
        second_data = second_response.json()["data"]

        assert UUID(second_data["media_id"]) == media_id
        assert first_data["idempotency_outcome"] == "created"
        assert second_data["idempotency_outcome"] == "reused"

        with direct_db.session() as session:
            attachments = session.execute(
                text("""
                    SELECT library_id
                    FROM library_media
                    WHERE media_id = :media_id
                """),
                {"media_id": media_id},
            ).fetchall()

        attached_library_ids = {row[0] for row in attachments}
        assert default_library_a in attached_library_ids
        assert default_library_b in attached_library_ids

    def test_web_article_creation_enqueues_background_job(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Creating a web article also persists one queue row."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/queue-check"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 202, (
            f"expected 202 for web from_url, got {response.status_code}: {response.text}"
        )

        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        assert data["ingest_enqueued"] is True, (
            "Expected ingest_enqueued=True when queue row is persisted."
        )

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT id, kind, payload->>'media_id'
                    FROM background_jobs
                    WHERE kind = 'ingest_web_article'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            ).fetchone()

        assert row is not None, (
            "Expected one ingest_web_article background job row for created media. "
            f"media_id={media_id}"
        )
        direct_db.register_cleanup("background_jobs", "id", row[0])
        assert row[1] == "ingest_web_article"

    def test_web_article_creation_rolls_back_when_enqueue_fails(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Queue enqueue failure must abort media creation transaction."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        url = f"https://example.com/queue-failure-{uuid4().hex}"

        _install_background_job_insert_failure(direct_db)
        try:
            response = auth_client.post(
                "/media/from_url",
                json={"url": url},
                headers=auth_headers(user_id),
            )
        finally:
            _remove_background_job_insert_failure(direct_db)

        assert response.status_code == 500, (
            "Expected hard failure when enqueue fails; no orphaned pending media should commit. "
            f"status={response.status_code}, body={response.text}"
        )

        with direct_db.session() as session:
            media_count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM media
                    WHERE requested_url = :url
                      AND created_by_user_id = :user_id
                    """
                ),
                {"url": url, "user_id": user_id},
            ).scalar_one()
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM background_jobs
                    WHERE kind = 'ingest_web_article'
                      AND payload->>'request_id' IS NULL
                      AND payload->>'actor_user_id' = :user_id
                    """
                ),
                {"user_id": str(user_id)},
            ).scalar_one()

        assert media_count == 0, (
            "Expected web media insert to roll back when enqueue fails, "
            f"but found {media_count} committed rows."
        )
        assert job_count == 0, (
            "Expected no ingest_web_article job rows for failed request, "
            f"but found {job_count}."
        )

    def test_youtube_creation_rolls_back_when_enqueue_fails(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """First-time YouTube creation must roll back if enqueue fails."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        video_id = uuid4().hex[:11]
        url = f"https://www.youtube.com/watch?v={video_id}"
        canonical_url = f"https://www.youtube.com/watch?v={video_id}"

        _install_background_job_insert_failure(direct_db)
        try:
            response = auth_client.post(
                "/media/from_url",
                json={"url": url},
                headers=auth_headers(user_id),
            )
        finally:
            _remove_background_job_insert_failure(direct_db)

        assert response.status_code == 500, (
            "Expected hard failure when YouTube enqueue fails; no orphaned pending media should commit. "
            f"status={response.status_code}, body={response.text}"
        )

        with direct_db.session() as session:
            media_count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM media
                    WHERE kind = 'video'
                      AND canonical_url = :canonical_url
                    """
                ),
                {"canonical_url": canonical_url},
            ).scalar_one()
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM background_jobs
                    WHERE kind = 'ingest_youtube_video'
                      AND payload->>'actor_user_id' = :user_id
                    """
                ),
                {"user_id": str(user_id)},
            ).scalar_one()

        assert media_count == 0, (
            "Expected YouTube media insert to roll back when enqueue fails, "
            f"but found {media_count} committed rows."
        )
        assert job_count == 0, (
            "Expected no ingest_youtube_video job rows for failed request, "
            f"but found {job_count}."
        )


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

    def test_localhost_rejected(self, auth_client, monkeypatch):
        """Test that localhost URLs are rejected in production."""
        monkeypatch.setenv("NEXUS_ENV", "production")
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

    def test_127_0_0_1_rejected(self, auth_client, monkeypatch):
        """Test that 127.0.0.1 URLs are rejected in production."""
        monkeypatch.setenv("NEXUS_ENV", "production")
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

        assert response.status_code == 202
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


# =============================================================================
# S4 PR-05: Provenance assertions
# =============================================================================


class TestFromUrlProvenance:
    """Tests for S4 PR-05: intrinsic provenance on from_url creation."""

    def test_from_url_creates_default_library_intrinsic_row(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """POST /media/from_url creates both library_media and intrinsic row."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/provenance-test"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 202
        media_id = UUID(response.json()["data"]["media_id"])

        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            # Get default library
            dl = session.execute(
                text("""
                    SELECT id FROM libraries
                    WHERE owner_user_id = :uid AND is_default = true
                """),
                {"uid": user_id},
            ).fetchone()
            assert dl is not None

            # Verify library_media exists
            lm = session.execute(
                text("""
                    SELECT 1 FROM library_media
                    WHERE library_id = :dl AND media_id = :m
                """),
                {"dl": dl[0], "m": media_id},
            ).fetchone()
            assert lm is not None

            # Verify intrinsic row exists
            intrinsic = session.execute(
                text("""
                    SELECT 1 FROM default_library_intrinsics
                    WHERE default_library_id = :dl AND media_id = :m
                """),
                {"dl": dl[0], "m": media_id},
            ).fetchone()
            assert intrinsic is not None
