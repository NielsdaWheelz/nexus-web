"""Integration tests for upload and ingest endpoints.

Tests cover:
- Upload initialization
- File validation (magic bytes, size)
- Ingest confirmation with SHA-256 hashing
- Deduplication
- Permission enforcement
- Signed download URLs

Note: Tests use FakeStorageClient for unit tests.
Supabase integration tests live in test_supabase_integration.py.
"""

import hashlib
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import create_session_factory
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.storage.client import FakeStorageClient
from tests.helpers import auth_headers, create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

# Sample file content for testing
PDF_MAGIC = b"%PDF-1.4"
PDF_CONTENT = PDF_MAGIC + b"fake pdf content " * 1000  # ~18KB
PDF_SHA256 = hashlib.sha256(PDF_CONTENT).hexdigest()

EPUB_MAGIC = b"PK\x03\x04"
EPUB_CONTENT = EPUB_MAGIC + b"fake epub content " * 1000
EPUB_SHA256 = hashlib.sha256(EPUB_CONTENT).hexdigest()

INVALID_CONTENT = b"not a valid file"


@pytest.fixture
def fake_storage():
    """Provide a FakeStorageClient for testing."""
    return FakeStorageClient()


@pytest.fixture
def upload_client(engine, fake_storage, monkeypatch):
    """Create a client with auth middleware and fake storage."""
    from nexus.app import add_request_id_middleware

    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    # Patch storage to use fake client
    monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

    verifier = MockJwtVerifier()
    app = create_app(skip_auth_middleware=True)

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    add_request_id_middleware(app, log_requests=False)

    return TestClient(app)


class TestUploadInit:
    """Tests for POST /media/upload/init endpoint."""

    def test_upload_init_pdf_success(self, upload_client, fake_storage):
        """Upload init for PDF returns signed URL."""
        user_id = create_test_user_id()

        # Bootstrap user
        upload_client.get("/me", headers=auth_headers(user_id))

        response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]

        assert "media_id" in data
        assert "storage_path" in data
        assert "token" in data
        assert "expires_at" in data

        # Verify storage path format
        assert data["storage_path"].endswith("/original.pdf")
        assert data["media_id"] in data["storage_path"]

    def test_upload_init_epub_success(self, upload_client, fake_storage):
        """Upload init for EPUB returns signed URL."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "epub",
                "filename": "book.epub",
                "content_type": "application/epub+zip",
                "size_bytes": len(EPUB_CONTENT),
            },
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["storage_path"].endswith("/original.epub")

    def test_upload_init_invalid_kind(self, upload_client):
        """Upload init rejects invalid kind."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "web_article",  # Not a file-backed kind
                "filename": "test.html",
                "content_type": "text/html",
                "size_bytes": 1000,
            },
            headers=auth_headers(user_id),
        )

        # Pydantic validates kind before reaching service, returns E_INVALID_REQUEST
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"

    def test_upload_init_invalid_content_type(self, upload_client):
        """Upload init rejects mismatched content type."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "text/plain",  # Wrong content type
                "size_bytes": 1000,
            },
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_CONTENT_TYPE"

    def test_upload_init_file_too_large(self, upload_client):
        """Upload init rejects files exceeding size limit."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "huge.pdf",
                "content_type": "application/pdf",
                "size_bytes": 200 * 1024 * 1024,  # 200 MB, exceeds 100 MB limit
            },
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_FILE_TOO_LARGE"

    def test_upload_init_unauthenticated(self, upload_client):
        """Upload init requires authentication."""
        response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": 1000,
            },
        )

        assert response.status_code == 401


class TestConfirmIngest:
    """Tests for POST /media/{id}/ingest endpoint."""

    def test_ingest_success(self, upload_client, fake_storage, direct_db: DirectSessionManager):
        """Ingest confirms upload and computes hash."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # Initialize upload
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        )
        init_data = init_response.json()["data"]
        media_id = init_data["media_id"]
        storage_path = init_data["storage_path"]

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Simulate upload to storage
        fake_storage.put_object(storage_path, PDF_CONTENT, "application/pdf")

        # Confirm ingest
        response = upload_client.post(
            f"/media/{media_id}/ingest",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["media_id"] == media_id
        assert data["duplicate"] is False

        # Verify hash was stored in DB
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT file_sha256 FROM media WHERE id = :id"),
                {"id": media_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == PDF_SHA256

    def test_ingest_invalid_file_type(self, upload_client, fake_storage, direct_db):
        """Ingest rejects file with invalid magic bytes."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # Initialize upload
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "fake.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(INVALID_CONTENT),
            },
            headers=auth_headers(user_id),
        )
        init_data = init_response.json()["data"]
        media_id = init_data["media_id"]
        storage_path = init_data["storage_path"]

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Upload invalid content
        fake_storage.put_object(storage_path, INVALID_CONTENT, "application/pdf")

        # Confirm ingest
        response = upload_client.post(
            f"/media/{media_id}/ingest",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_FILE_TYPE"

        # Verify media is marked failed
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT processing_status, failure_stage FROM media WHERE id = :id"),
                {"id": media_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == "failed"
            assert row[1] == "upload"

    def test_ingest_storage_missing(self, upload_client, fake_storage, direct_db):
        """Ingest fails if file not in storage."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # Initialize upload
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "missing.pdf",
                "content_type": "application/pdf",
                "size_bytes": 1000,
            },
            headers=auth_headers(user_id),
        )
        init_data = init_response.json()["data"]
        media_id = init_data["media_id"]

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Don't upload - leave storage empty

        # Confirm ingest
        response = upload_client.post(
            f"/media/{media_id}/ingest",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_STORAGE_MISSING"

    def test_ingest_non_creator_forbidden(self, upload_client, fake_storage, direct_db):
        """Non-creator cannot confirm ingest."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        upload_client.get("/me", headers=auth_headers(user_a))
        upload_client.get("/me", headers=auth_headers(user_b))

        # User A initializes upload
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_a),
        )
        init_data = init_response.json()["data"]
        media_id = init_data["media_id"]
        storage_path = init_data["storage_path"]

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(storage_path, PDF_CONTENT, "application/pdf")

        # User B tries to confirm
        response = upload_client.post(
            f"/media/{media_id}/ingest",
            headers=auth_headers(user_b),
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "E_FORBIDDEN"

    def test_ingest_duplicate_detection(self, upload_client, fake_storage, direct_db):
        """Second upload of same file returns existing media."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # First upload
        init_1 = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test1.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]

        media_id_1 = init_1["media_id"]
        direct_db.register_cleanup("library_media", "media_id", media_id_1)
        direct_db.register_cleanup("media_file", "media_id", media_id_1)
        direct_db.register_cleanup("media", "id", media_id_1)

        fake_storage.put_object(init_1["storage_path"], PDF_CONTENT, "application/pdf")

        ingest_1 = upload_client.post(
            f"/media/{media_id_1}/ingest",
            headers=auth_headers(user_id),
        ).json()["data"]

        assert ingest_1["duplicate"] is False

        # Second upload (same content)
        init_2 = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test2.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]

        media_id_2 = init_2["media_id"]
        # Note: media_id_2 will be deleted by dedupe, so cleanup registration
        # is not strictly needed, but let's be safe
        direct_db.register_cleanup("library_media", "media_id", media_id_2)
        direct_db.register_cleanup("media_file", "media_id", media_id_2)
        direct_db.register_cleanup("media", "id", media_id_2)

        fake_storage.put_object(init_2["storage_path"], PDF_CONTENT, "application/pdf")

        ingest_2 = upload_client.post(
            f"/media/{media_id_2}/ingest",
            headers=auth_headers(user_id),
        ).json()["data"]

        # Should return existing media
        assert ingest_2["duplicate"] is True
        assert ingest_2["media_id"] == media_id_1

        # Verify second media row was deleted
        with direct_db.session() as session:
            result = session.execute(
                text("SELECT COUNT(*) FROM media WHERE id = :id"),
                {"id": media_id_2},
            )
            assert result.scalar() == 0

    def test_ingest_different_users_no_dedupe(self, upload_client, fake_storage, direct_db):
        """Same file by different users creates separate rows (no cross-user dedupe)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        upload_client.get("/me", headers=auth_headers(user_a))
        upload_client.get("/me", headers=auth_headers(user_b))

        # User A uploads
        init_a = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_a),
        ).json()["data"]

        media_id_a = init_a["media_id"]
        direct_db.register_cleanup("library_media", "media_id", media_id_a)
        direct_db.register_cleanup("media_file", "media_id", media_id_a)
        direct_db.register_cleanup("media", "id", media_id_a)

        fake_storage.put_object(init_a["storage_path"], PDF_CONTENT, "application/pdf")
        upload_client.post(f"/media/{media_id_a}/ingest", headers=auth_headers(user_a))

        # User B uploads same content
        init_b = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_b),
        ).json()["data"]

        media_id_b = init_b["media_id"]
        direct_db.register_cleanup("library_media", "media_id", media_id_b)
        direct_db.register_cleanup("media_file", "media_id", media_id_b)
        direct_db.register_cleanup("media", "id", media_id_b)

        fake_storage.put_object(init_b["storage_path"], PDF_CONTENT, "application/pdf")
        ingest_b = upload_client.post(
            f"/media/{media_id_b}/ingest",
            headers=auth_headers(user_b),
        ).json()["data"]

        # Should NOT be marked as duplicate (different users)
        assert ingest_b["duplicate"] is False
        assert ingest_b["media_id"] == media_id_b


class TestFileDownload:
    """Tests for GET /media/{id}/file endpoint."""

    def test_download_success(self, upload_client, fake_storage, direct_db):
        """Member can get signed download URL."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # Upload and ingest
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]

        media_id = init_response["media_id"]
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(init_response["storage_path"], PDF_CONTENT, "application/pdf")
        upload_client.post(f"/media/{media_id}/ingest", headers=auth_headers(user_id))

        # Get download URL
        response = upload_client.get(
            f"/media/{media_id}/file",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert "url" in data
        assert "expires_at" in data

    def test_download_non_member_forbidden(self, upload_client, fake_storage, direct_db):
        """Non-member cannot get download URL (returns 404 to mask existence)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()

        upload_client.get("/me", headers=auth_headers(user_a))
        upload_client.get("/me", headers=auth_headers(user_b))

        # User A uploads
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_a),
        ).json()["data"]

        media_id = init_response["media_id"]
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(init_response["storage_path"], PDF_CONTENT, "application/pdf")
        upload_client.post(f"/media/{media_id}/ingest", headers=auth_headers(user_a))

        # User B tries to download
        response = upload_client.get(
            f"/media/{media_id}/file",
            headers=auth_headers(user_b),
        )

        # 404 masks existence
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_FOUND"

    def test_download_no_file(self, upload_client, direct_db):
        """Media without file returns 404."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # Create media without file (e.g., web_article)
        media_id = uuid4()
        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'web_article', 'Test', 'pending',
                            (SELECT id FROM users WHERE id = :user_id))
                """),
                {"id": media_id, "user_id": user_id},
            )

            # Get user's default library
            result = session.execute(
                text("""
                    SELECT id FROM libraries WHERE owner_user_id = :user_id AND is_default = true
                """),
                {"user_id": user_id},
            )
            library_id = result.scalar()

            # Add to library
            session.execute(
                text("""
                    INSERT INTO library_media (library_id, media_id)
                    VALUES (:lib_id, :media_id)
                """),
                {"lib_id": library_id, "media_id": media_id},
            )
            session.commit()

        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = upload_client.get(
            f"/media/{media_id}/file",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 404


class TestMediaWithCapabilities:
    """Tests for GET /media/{id} with capabilities."""

    def test_media_includes_capabilities(self, upload_client, fake_storage, direct_db):
        """GET /media/{id} includes capabilities object."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # Upload PDF
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]

        media_id = init_response["media_id"]
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(init_response["storage_path"], PDF_CONTENT, "application/pdf")
        upload_client.post(f"/media/{media_id}/ingest", headers=auth_headers(user_id))

        # Get media
        response = upload_client.get(
            f"/media/{media_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]

        # Verify capabilities are present
        assert "capabilities" in data
        caps = data["capabilities"]
        assert "can_read" in caps
        assert "can_highlight" in caps
        assert "can_quote" in caps
        assert "can_search" in caps
        assert "can_play" in caps
        assert "can_download_file" in caps

        # PDF with file should be readable and downloadable
        assert caps["can_read"] is True
        assert caps["can_download_file"] is True

    def test_media_capabilities_pdf_pending(self, upload_client, fake_storage, direct_db):
        """PDF in pending status has correct capabilities."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # Upload PDF but don't ingest (stays pending)
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]

        media_id = init_response["media_id"]
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Put file but don't call ingest
        fake_storage.put_object(init_response["storage_path"], PDF_CONTENT, "application/pdf")

        # Get media (before ingest, sha256 not set but file exists)
        response = upload_client.get(
            f"/media/{media_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]

        # Pending PDF with file can be read (pdf.js can render)
        caps = data["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_highlight"] is True
        assert caps["can_download_file"] is True
        # But can't quote until text extraction (not in S1)
        assert caps["can_quote"] is False
