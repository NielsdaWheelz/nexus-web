"""Integration tests for POST /media/from_url endpoint.

Tests cover URL-based media creation:
- Creating provisional web_article media from article URLs
- Creating file-backed PDF/EPUB media from direct document URLs
- URL validation (scheme, length, userinfo, localhost)
- Default library attachment
- Visibility enforcement
- Response envelope and status codes

Contract:
- Returns 202 Accepted (not 201) and enqueues ingestion
- processing_status reflects the created media lifecycle
- ingest_enqueued reflects whether task was enqueued
- web_article canonical_url is NULL until ingestion resolves redirects
- requested_url is stored exactly as provided
- canonical_source_url is normalized
"""

import io
import socket
import zipfile
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
import respx
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

from nexus.storage import build_storage_path
from nexus.storage.client import FakeStorageClient, StorageError
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

PDF_CONTENT = b"%PDF-1.4\nremote pdf bytes"


def _epub_content() -> bytes:
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", "<container />")
    return data.getvalue()


EPUB_CONTENT = _epub_content()
REMOTE_FILE_LIMIT_BYTES = 512


class _TrackingStorageClient(FakeStorageClient):
    """Fake storage client that records delete calls for cleanup assertions."""

    def __init__(self):
        super().__init__()
        self.put_paths: list[str] = []
        self.deleted_paths: list[str] = []

    def put_object(self, path: str, content: bytes, content_type: str = "application/pdf") -> None:
        self.put_paths.append(path)
        super().put_object(path, content, content_type)

    def delete_object(self, path: str) -> None:
        self.deleted_paths.append(path)
        super().delete_object(path)


class _FailingPutStorageClient(_TrackingStorageClient):
    """Fake storage client that fails on put_object after fetch succeeds."""

    def put_object(self, path: str, content: bytes, content_type: str = "application/pdf") -> None:
        self.put_paths.append(path)
        raise StorageError("forced storage put failure", code="E_STORAGE_ERROR")


def _bootstrap_user(auth_client, user_id):
    auth_client.get("/me", headers=auth_headers(user_id))


@pytest.fixture
def remote_http(monkeypatch):
    """Mock the remote HTTP boundary while preserving real URL/SSRF validation."""

    def _getaddrinfo(host: str, port: int | str | None, *args, **kwargs):
        if host == "private.test":
            return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("10.0.0.1", int(port or 80)))]
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("93.184.216.34", int(port or 80)))]

    monkeypatch.setattr(socket, "getaddrinfo", _getaddrinfo)
    with respx.mock(assert_all_called=False) as mock:
        yield mock


def _patch_remote_file_limits(monkeypatch, *, limit_bytes: int = REMOTE_FILE_LIMIT_BYTES) -> None:
    settings = SimpleNamespace(max_pdf_bytes=limit_bytes, max_epub_bytes=limit_bytes)
    monkeypatch.setattr("nexus.services.media.get_settings", lambda: settings)
    monkeypatch.setattr("nexus.services.upload.get_settings", lambda: settings)


def _patch_remote_storage(monkeypatch, storage_client) -> None:
    monkeypatch.setattr("nexus.services.media.get_storage_client", lambda: storage_client)
    monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: storage_client)
    monkeypatch.setattr("nexus.services.epub_lifecycle.get_storage_client", lambda: storage_client)


def _expect_remote_file(
    remote_http,
    url: str,
    body: bytes | str,
    *,
    content_type: str,
    status: int = 200,
    headers: dict[str, str] | None = None,
):
    remote_http.get(url).mock(
        return_value=httpx.Response(
            status,
            content=body,
            headers={"Content-Type": content_type, **(headers or {})},
        )
    )


def _expect_remote_redirect(remote_http, url: str, target_url: str, *, status: int = 302):
    remote_http.get(url).mock(return_value=httpx.Response(status, headers={"Location": target_url}))


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
        session.execute(text("DROP FUNCTION IF EXISTS nexus_test_fail_background_job_insert()"))
        session.commit()


def _install_library_media_insert_failure(direct_db: DirectSessionManager) -> None:
    """Force library_media inserts to fail until teardown is called."""
    with direct_db.session() as session:
        session.execute(
            text(
                """
                CREATE OR REPLACE FUNCTION nexus_test_fail_library_media_insert()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                BEGIN
                    RAISE EXCEPTION 'library_media unavailable';
                END;
                $$;
                """
            )
        )
        session.execute(
            text(
                """
                DROP TRIGGER IF EXISTS nexus_test_fail_library_media_insert
                ON library_media
                """
            )
        )
        session.execute(
            text(
                """
                CREATE TRIGGER nexus_test_fail_library_media_insert
                BEFORE INSERT ON library_media
                FOR EACH ROW
                EXECUTE FUNCTION nexus_test_fail_library_media_insert()
                """
            )
        )
        session.commit()


def _remove_library_media_insert_failure(direct_db: DirectSessionManager) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                """
                DROP TRIGGER IF EXISTS nexus_test_fail_library_media_insert
                ON library_media
                """
            )
        )
        session.execute(text("DROP FUNCTION IF EXISTS nexus_test_fail_library_media_insert()"))
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
        assert "duplicate" not in data
        media_id = UUID(data["media_id"])
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

    def test_create_remote_pdf_url_success(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        """A .pdf URL creates file-backed PDF media through the upload lifecycle."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        fake_storage = FakeStorageClient()
        monkeypatch.setattr("nexus.services.media.get_storage_client", lambda: fake_storage)
        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)
        monkeypatch.setattr(
            "nexus.services.media._download_remote_file",
            lambda url, kind: (PDF_CONTENT, "application/pdf"),
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/report.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])

        with direct_db.session() as session:
            job_id = session.execute(
                text("""
                    SELECT id FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                """),
                {"media_id": str(media_id)},
            ).scalar()
            if job_id is not None:
                direct_db.register_cleanup("background_jobs", "id", job_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        assert data["idempotency_outcome"] == "created"
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.kind, m.title, m.requested_url, m.canonical_source_url,
                           m.processing_status, mf.content_type, mf.size_bytes
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()

            assert row is not None
            assert row[0] == "pdf"
            assert row[1] == "report.pdf"
            assert row[2] == "https://example.com/report.pdf"
            assert row[3] == "https://example.com/report.pdf"
            assert row[4] == "extracting"
            assert row[5] == "application/pdf"
            assert row[6] == len(PDF_CONTENT)

    def test_create_remote_epub_url_success(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        """A .epub URL creates file-backed EPUB media through the upload lifecycle."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        fake_storage = FakeStorageClient()
        monkeypatch.setattr("nexus.services.media.get_storage_client", lambda: fake_storage)
        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)
        monkeypatch.setattr(
            "nexus.services.epub_lifecycle.get_storage_client",
            lambda: fake_storage,
        )
        monkeypatch.setattr("nexus.services.epub_lifecycle.check_archive_safety", lambda data: None)
        monkeypatch.setattr(
            "nexus.services.media._download_remote_file",
            lambda url, kind: (EPUB_CONTENT, "application/epub+zip"),
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/books/book.epub?download=1"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])

        with direct_db.session() as session:
            job_id = session.execute(
                text("""
                    SELECT id FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                """),
                {"media_id": str(media_id)},
            ).scalar()
            if job_id is not None:
                direct_db.register_cleanup("background_jobs", "id", job_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        assert data["idempotency_outcome"] == "created"
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.kind, m.title, mf.content_type, mf.size_bytes
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()

            assert row is not None
            assert row[0] == "epub"
            assert row[1] == "book.epub"
            assert row[2] == "application/epub+zip"
            assert row[3] == len(EPUB_CONTENT)

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
        assert "duplicate" not in second_data
        assert second_data["idempotency_outcome"] == "reused"

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
            f"Expected no ingest_web_article job rows for failed request, but found {job_count}."
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
            f"Expected no ingest_youtube_video job rows for failed request, but found {job_count}."
        )


class TestFromUrlRemoteFiles:
    """Tests for file-backed from_url ingestion through the remote HTTP boundary."""

    def test_create_remote_pdf_url_success_via_http_fetch(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        storage = _TrackingStorageClient()
        _patch_remote_storage(monkeypatch, storage)
        _patch_remote_file_limits(monkeypatch)

        url = "http://example.com/report.pdf"
        _expect_remote_file(remote_http, url, PDF_CONTENT, content_type="application/pdf")

        response = auth_client.post(
            "/media/from_url", json={"url": url}, headers=auth_headers(user_id)
        )
        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])

        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        assert data["idempotency_outcome"] == "created"
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.kind, m.title, m.requested_url, m.canonical_source_url,
                           m.processing_status, mf.content_type, mf.size_bytes
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()

        assert row is not None
        assert row[0] == "pdf"
        assert row[1] == "report.pdf"
        assert row[2] == url
        assert row[3] == url
        assert row[4] == "extracting"
        assert row[5] == "application/pdf"
        assert row[6] == len(PDF_CONTENT)

    def test_create_remote_epub_url_success_via_http_fetch(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        storage = _TrackingStorageClient()
        _patch_remote_storage(monkeypatch, storage)
        _patch_remote_file_limits(monkeypatch)

        url = "http://example.com/book.epub"
        _expect_remote_file(remote_http, url, EPUB_CONTENT, content_type="application/epub+zip")

        response = auth_client.post(
            "/media/from_url", json={"url": url}, headers=auth_headers(user_id)
        )
        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])

        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        assert data["idempotency_outcome"] == "created"
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.kind, m.title, mf.content_type, mf.size_bytes
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()

        assert row is not None
        assert row[0] == "epub"
        assert row[1] == "book.epub"
        assert row[2] == "application/epub+zip"
        assert row[3] == len(EPUB_CONTENT)

    def test_remote_pdf_redirect_is_followed_to_final_bytes(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        storage = _TrackingStorageClient()
        _patch_remote_storage(monkeypatch, storage)
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_redirect(
            remote_http,
            "http://example.com/old.pdf",
            "http://cdn.example.com/final.pdf",
        )
        _expect_remote_file(
            remote_http,
            "http://cdn.example.com/final.pdf",
            PDF_CONTENT,
            content_type="application/pdf",
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/old.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])

        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT mf.size_bytes, mf.content_type
                    FROM media_file mf
                    WHERE mf.media_id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()

        assert row is not None
        assert row[0] == len(PDF_CONTENT)
        assert row[1] == "application/pdf"

    def test_remote_redirect_to_private_ip_is_blocked(
        self,
        auth_client,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_redirect(
            remote_http,
            "http://example.com/old.pdf",
            "http://private.test/final.pdf",
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/old.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_SSRF_BLOCKED"

    def test_remote_file_too_many_redirects_is_rejected(
        self,
        auth_client,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_redirect(
            remote_http, "http://example.com/r1.pdf", "http://example.com/r2.pdf"
        )
        _expect_remote_redirect(
            remote_http, "http://example.com/r2.pdf", "http://example.com/r3.pdf"
        )
        _expect_remote_redirect(
            remote_http, "http://example.com/r3.pdf", "http://example.com/r4.pdf"
        )
        _expect_remote_redirect(
            remote_http, "http://example.com/r4.pdf", "http://example.com/r5.pdf"
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/r1.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 502
        assert response.json()["error"]["code"] == "E_INGEST_FAILED"

    def test_remote_file_non_2xx_is_rejected(
        self,
        auth_client,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_file_limits(monkeypatch)

        url = "http://example.com/missing.pdf"
        _expect_remote_file(remote_http, url, "Not Found", content_type="text/plain", status=404)

        response = auth_client.post(
            "/media/from_url",
            json={"url": url},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 502
        assert response.json()["error"]["code"] == "E_INGEST_FAILED"

    def test_remote_file_timeout_is_rejected(
        self,
        auth_client,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_file_limits(monkeypatch)
        monkeypatch.setattr("nexus.services.media._REMOTE_FILE_TIMEOUT", httpx.Timeout(0.05))

        remote_http.get("http://example.com/slow.pdf").mock(
            side_effect=httpx.ReadTimeout("timed out")
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/slow.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 504
        assert response.json()["error"]["code"] == "E_INGEST_TIMEOUT"

    def test_remote_file_invalid_magic_bytes_are_rejected(
        self,
        auth_client,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_file(
            remote_http,
            "http://example.com/bad.pdf",
            b"<html><body>not a pdf</body></html>",
            content_type="application/pdf",
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/bad.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_FILE_TYPE"

    def test_remote_file_content_length_over_limit_is_rejected(
        self,
        auth_client,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_file(
            remote_http,
            "http://example.com/too-large.pdf",
            PDF_CONTENT,
            content_type="application/pdf",
            headers={"Content-Length": str(REMOTE_FILE_LIMIT_BYTES + 1)},
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/too-large.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_FILE_TOO_LARGE"

    def test_remote_file_streamed_body_over_limit_is_rejected(
        self,
        auth_client,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_file_limits(monkeypatch)

        over_limit_body = b"%PDF-1.4\n" + (b"a" * (REMOTE_FILE_LIMIT_BYTES + 1))
        _expect_remote_file(
            remote_http,
            "http://example.com/stream-too-large.pdf",
            over_limit_body,
            content_type="application/pdf",
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/stream-too-large.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_FILE_TOO_LARGE"

    def test_remote_file_storage_put_failure_returns_storage_error(
        self,
        auth_client,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        storage = _FailingPutStorageClient()
        _patch_remote_storage(monkeypatch, storage)
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_file(
            remote_http,
            "http://example.com/storage-fail.pdf",
            PDF_CONTENT,
            content_type="application/pdf",
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/storage-fail.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 500
        assert response.json()["error"]["code"] == "E_STORAGE_ERROR"

    def test_remote_file_db_failure_after_storage_write_cleans_up_storage(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        storage = _TrackingStorageClient()
        _patch_remote_storage(monkeypatch, storage)
        _patch_remote_file_limits(monkeypatch)

        media_uuid = UUID("11111111-1111-1111-1111-111111111111")
        monkeypatch.setattr("nexus.services.media.uuid4", lambda: media_uuid)
        storage_path = build_storage_path(media_uuid, "pdf")

        _install_library_media_insert_failure(direct_db)
        try:
            _expect_remote_file(
                remote_http,
                "http://example.com/db-fail.pdf",
                PDF_CONTENT,
                content_type="application/pdf",
            )

            with pytest.raises(ProgrammingError):
                auth_client.post(
                    "/media/from_url",
                    json={"url": "http://example.com/db-fail.pdf"},
                    headers=auth_headers(user_id),
                )
        finally:
            _remove_library_media_insert_failure(direct_db)

        assert storage.put_paths == [storage_path]
        assert storage.get_object(storage_path) is None
        assert storage.deleted_paths == [storage_path]

    def test_duplicate_remote_pdf_url_reuses_existing_media(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        storage = _TrackingStorageClient()
        _patch_remote_storage(monkeypatch, storage)
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_file(
            remote_http,
            "http://example.com/dup-a.pdf",
            PDF_CONTENT,
            content_type="application/pdf",
        )
        _expect_remote_file(
            remote_http,
            "http://example.com/dup-b.pdf",
            PDF_CONTENT,
            content_type="application/pdf",
        )

        first_response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/dup-a.pdf"},
            headers=auth_headers(user_id),
        )
        assert first_response.status_code == 202
        first_data = first_response.json()["data"]
        media_id = UUID(first_data["media_id"])

        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        second_response = auth_client.post(
            "/media/from_url",
            json={"url": "http://example.com/dup-b.pdf"},
            headers=auth_headers(user_id),
        )
        assert second_response.status_code == 202
        second_data = second_response.json()["data"]

        assert UUID(second_data["media_id"]) == media_id
        assert "duplicate" not in second_data
        assert second_data["idempotency_outcome"] == "reused"

        with direct_db.session() as session:
            count = session.execute(
                text("""
                    SELECT COUNT(*)
                    FROM media
                    WHERE created_by_user_id = :user_id
                      AND kind = 'pdf'
                      AND file_sha256 IS NOT NULL
                """),
                {"user_id": user_id},
            ).scalar_one()

        assert count == 1
        assert len(storage.deleted_paths) == 1


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
