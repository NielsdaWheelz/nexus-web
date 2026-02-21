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


# =============================================================================
# S4 PR-05: Upload provenance assertions
# =============================================================================


class TestUploadProvenance:
    """Tests for S4 PR-05: intrinsic provenance on upload init."""

    def test_upload_init_creates_default_library_intrinsic_row(
        self, upload_client, fake_storage, direct_db: DirectSessionManager
    ):
        """Upload init creates both library_media and intrinsic row."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "provenance-test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]

        media_id = init_response["media_id"]
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            dl = session.execute(
                text("""
                    SELECT id FROM libraries
                    WHERE owner_user_id = :uid AND is_default = true
                """),
                {"uid": user_id},
            ).fetchone()
            assert dl is not None

            intrinsic = session.execute(
                text("""
                    SELECT 1 FROM default_library_intrinsics
                    WHERE default_library_id = :dl AND media_id = :m
                """),
                {"dl": dl[0], "m": media_id},
            ).fetchone()
            assert intrinsic is not None

    def test_ingest_duplicate_keeps_winner_attached_with_intrinsic(
        self, upload_client, fake_storage, direct_db: DirectSessionManager
    ):
        """Dedup path keeps winner in default library with intrinsic."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        # First upload
        init1 = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "dup1.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]
        media_id_1 = init1["media_id"]
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id_1)
        direct_db.register_cleanup("library_media", "media_id", media_id_1)
        direct_db.register_cleanup("media_file", "media_id", media_id_1)
        direct_db.register_cleanup("media", "id", media_id_1)

        fake_storage.put_object(init1["storage_path"], PDF_CONTENT, "application/pdf")
        upload_client.post(f"/media/{media_id_1}/ingest", headers=auth_headers(user_id))

        # Second upload (same content = duplicate)
        init2 = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "dup2.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]
        media_id_2 = init2["media_id"]
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id_2)
        direct_db.register_cleanup("library_media", "media_id", media_id_2)
        direct_db.register_cleanup("media_file", "media_id", media_id_2)
        direct_db.register_cleanup("media", "id", media_id_2)

        fake_storage.put_object(init2["storage_path"], PDF_CONTENT, "application/pdf")
        resp = upload_client.post(f"/media/{media_id_2}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 200
        winner_id = resp.json()["data"]["media_id"]

        # Verify winner has intrinsic
        with direct_db.session() as session:
            dl = session.execute(
                text("""
                    SELECT id FROM libraries
                    WHERE owner_user_id = :uid AND is_default = true
                """),
                {"uid": user_id},
            ).fetchone()

            intrinsic = session.execute(
                text("""
                    SELECT 1 FROM default_library_intrinsics
                    WHERE default_library_id = :dl AND media_id = :m
                """),
                {"dl": dl[0], "m": winner_id},
            ).fetchone()
            assert intrinsic is not None


class TestEpubIngestLifecycle:
    """S5 PR-03: EPUB ingest dispatch and lifecycle tests."""

    def _init_and_store_epub(self, upload_client, fake_storage, direct_db, user_id, content):
        """Helper: init upload + store content, return (media_id, storage_path)."""
        resp = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "epub",
                "filename": "test.epub",
                "content_type": "application/epub+zip",
                "size_bytes": len(content),
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200
        d = resp.json()["data"]
        mid = d["media_id"]
        direct_db.register_cleanup("epub_toc_nodes", "media_id", mid)
        direct_db.register_cleanup("fragment_blocks", "fragment_id", mid)  # best-effort
        direct_db.register_cleanup("default_library_intrinsics", "media_id", mid)
        direct_db.register_cleanup("fragments", "media_id", mid)
        direct_db.register_cleanup("library_media", "media_id", mid)
        direct_db.register_cleanup("media_file", "media_id", mid)
        direct_db.register_cleanup("media", "id", mid)

        fake_storage.put_object(d["storage_path"], content, "application/epub+zip")
        return mid, d["storage_path"]

    def test_ingest_epub_response_includes_dispatch_status_compat_fields(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        from unittest.mock import MagicMock

        from nexus.tasks.ingest_epub import ingest_epub as epub_task

        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr(
            "nexus.services.epub_lifecycle.get_storage_client", lambda: fake_storage
        )
        monkeypatch.setattr("nexus.services.epub_lifecycle.check_archive_safety", lambda data: None)
        mock_dispatch = MagicMock()
        monkeypatch.setattr(epub_task, "apply_async", mock_dispatch)

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )

        resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 200
        data = resp.json()["data"]

        assert "media_id" in data
        assert "duplicate" in data
        assert "processing_status" in data
        assert "ingest_enqueued" in data

    def test_ingest_epub_duplicate_preserves_compat_and_sets_ingest_enqueued_false(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        from unittest.mock import MagicMock

        from nexus.tasks.ingest_epub import ingest_epub as epub_task

        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr(
            "nexus.services.epub_lifecycle.get_storage_client", lambda: fake_storage
        )
        monkeypatch.setattr("nexus.services.epub_lifecycle.check_archive_safety", lambda data: None)
        monkeypatch.setattr(epub_task, "apply_async", MagicMock())

        mid1, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )
        upload_client.post(f"/media/{mid1}/ingest", headers=auth_headers(user_id))

        mid2, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )
        resp = upload_client.post(f"/media/{mid2}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 200
        data = resp.json()["data"]

        assert data["duplicate"] is True
        assert data["media_id"] == mid1
        assert data["ingest_enqueued"] is False

    def test_ingest_epub_archive_unsafe_fails_preflight_without_dispatch(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        from unittest.mock import MagicMock

        from nexus.tasks.ingest_epub import ingest_epub as epub_task

        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr(
            "nexus.services.epub_lifecycle.get_storage_client", lambda: fake_storage
        )
        mock_dispatch = MagicMock()
        monkeypatch.setattr(epub_task, "apply_async", mock_dispatch)

        from nexus.services.epub_ingest import EpubExtractionError

        monkeypatch.setattr(
            "nexus.services.epub_lifecycle.check_archive_safety",
            lambda data: EpubExtractionError(
                error_code="E_ARCHIVE_UNSAFE",
                error_message="forced unsafe",
                terminal=True,
            ),
        )

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )
        resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_ARCHIVE_UNSAFE"

        mock_dispatch.assert_not_called()

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT processing_status, last_error_code FROM media WHERE id = :id"),
                {"id": mid},
            ).fetchone()
            assert row is not None
            assert row[0] == "failed"
            assert row[1] == "E_ARCHIVE_UNSAFE"

    def test_ingest_epub_non_creator_forbidden(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_a))
        upload_client.get("/me", headers=auth_headers(user_b))

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_a, EPUB_CONTENT
        )

        resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_b))
        assert resp.status_code == 403
        assert resp.json()["error"]["code"] == "E_FORBIDDEN"

    def test_ingest_epub_repeat_call_is_idempotent_without_redispatch(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        from unittest.mock import MagicMock

        from nexus.tasks.ingest_epub import ingest_epub as epub_task

        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr(
            "nexus.services.epub_lifecycle.get_storage_client", lambda: fake_storage
        )
        monkeypatch.setattr("nexus.services.epub_lifecycle.check_archive_safety", lambda data: None)
        mock_dispatch = MagicMock()
        monkeypatch.setattr(epub_task, "apply_async", mock_dispatch)

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )

        resp1 = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp1.status_code == 200
        assert mock_dispatch.call_count == 1

        with direct_db.session() as session:
            attempts_after_first = session.execute(
                text("SELECT processing_attempts FROM media WHERE id = :id"),
                {"id": mid},
            ).scalar()

        resp2 = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp2.status_code == 200
        data2 = resp2.json()["data"]
        assert data2["ingest_enqueued"] is False

        assert mock_dispatch.call_count == 1

        with direct_db.session() as session:
            attempts_after_second = session.execute(
                text("SELECT processing_attempts FROM media WHERE id = :id"),
                {"id": mid},
            ).scalar()
        assert attempts_after_second == attempts_after_first

    def test_ingest_epub_rejects_extension_only_spoofed_payload(
        self,
        upload_client,
        fake_storage,
        direct_db,
    ):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, INVALID_CONTENT
        )

        resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "E_INVALID_FILE_TYPE"

    def test_ingest_epub_dispatch_failure_rolls_back_state(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        from nexus.tasks.ingest_epub import ingest_epub as epub_task

        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr(
            "nexus.services.epub_lifecycle.get_storage_client", lambda: fake_storage
        )
        monkeypatch.setattr("nexus.services.epub_lifecycle.check_archive_safety", lambda data: None)

        def _boom(*a, **kw):
            raise RuntimeError("broker down")

        monkeypatch.setattr(epub_task, "apply_async", _boom)

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )

        resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 500

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT processing_status FROM media WHERE id = :id"),
                {"id": mid},
            ).fetchone()
            assert row is not None
            assert row[0] != "extracting"


class TestIngestResponseBackwardCompatibility:
    """S5 PR-03: response extends with new fields while keeping legacy semantics."""

    def test_ingest_response_backward_compat(
        self, upload_client, fake_storage, direct_db, monkeypatch
    ):
        """Legacy clients reading only media_id and duplicate remain valid."""
        from unittest.mock import MagicMock

        from nexus.tasks.ingest_epub import ingest_epub as epub_task

        user_id = create_test_user_id()

        monkeypatch.setattr(
            "nexus.services.epub_lifecycle.get_storage_client", lambda: fake_storage
        )
        monkeypatch.setattr("nexus.services.epub_lifecycle.check_archive_safety", lambda data: None)
        monkeypatch.setattr(epub_task, "apply_async", MagicMock())

        resp = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "epub",
                "filename": "shape_test.epub",
                "content_type": "application/epub+zip",
                "size_bytes": len(EPUB_CONTENT),
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200
        init_data = resp.json()["data"]
        media_id = init_data["media_id"]
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(init_data["storage_path"], EPUB_CONTENT, "application/epub+zip")

        resp = upload_client.post(f"/media/{media_id}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 200

        data = resp.json()["data"]
        assert "media_id" in data
        assert "duplicate" in data
        assert isinstance(data["media_id"], str)
        assert isinstance(data["duplicate"], bool)
