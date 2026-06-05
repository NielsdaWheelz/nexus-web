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
import threading
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.models import MediaFile
from nexus.db.session import create_session_factory
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.file_ingest_validation import validate_file_source_integrity
from nexus.services.upload import confirm_ingest as confirm_upload_ingest
from nexus.storage.client import StorageError
from nexus.storage.paths import (
    build_storage_path,
    build_upload_staging_storage_path,
    get_file_extension,
)
from tests.factories import add_media_to_library, create_test_library
from tests.helpers import auth_headers, create_test_user_id
from tests.support.mock_verifier import MockJwtVerifier
from tests.support.storage import FakeStorageClient
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

# Sample file content for testing
PDF_MAGIC = b"%PDF-1.4"
PDF_CONTENT = PDF_MAGIC + b"fake pdf content " * 1000  # ~18KB
PDF_SHA256 = hashlib.sha256(PDF_CONTENT).hexdigest()

EPUB_MAGIC = b"PK\x03\x04"
EPUB_CONTENT = EPUB_MAGIC + b"fake epub content " * 1000
EPUB_SHA256 = hashlib.sha256(EPUB_CONTENT).hexdigest()

INVALID_CONTENT = b"not a valid file"


def _count_jobs_for_media(direct_db: DirectSessionManager, *, kind: str, media_id: str) -> int:
    with direct_db.session() as session:
        return int(
            session.execute(
                text(
                    """
                    SELECT COUNT(*)
                    FROM background_jobs
                    WHERE kind = :kind
                      AND payload->>'media_id' = :media_id
                    """
                ),
                {"kind": kind, "media_id": media_id},
            ).scalar_one()
        )


def _assert_failed_upload_source_attempt(
    direct_db: DirectSessionManager,
    *,
    media_id: str,
    source_attempt_id: str,
    error_code: str,
) -> None:
    with direct_db.session() as session:
        row = session.execute(
            text(
                """
                SELECT m.processing_status, m.failure_stage, m.last_error_code,
                       msa.status, msa.error_code
                FROM media m
                JOIN media_source_attempts msa ON msa.media_id = m.id
                WHERE m.id = :media_id
                  AND msa.id = :source_attempt_id
                """
            ),
            {"media_id": media_id, "source_attempt_id": source_attempt_id},
        ).one()

    assert tuple(row) == ("failed", "upload", error_code, "failed", error_code)


def _install_background_job_insert_failure(direct_db: DirectSessionManager) -> None:
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


def _upload_storage_path(init_data: dict, kind: str) -> str:
    return build_upload_staging_storage_path(UUID(init_data["media_id"]), get_file_extension(kind))


def _final_storage_path(init_data: dict, kind: str) -> str:
    return build_storage_path(UUID(init_data["media_id"]), get_file_extension(kind))


def _library_entries_for_media(direct_db: DirectSessionManager, media_id: str | UUID) -> set[UUID]:
    with direct_db.session() as session:
        rows = session.execute(
            text("""
                SELECT library_id
                FROM library_entries
                WHERE media_id = :media_id
            """),
            {"media_id": UUID(str(media_id))},
        ).fetchall()
    return {UUID(str(row[0])) for row in rows}


def _seed_duplicate_upload_loser_rows(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    winner_media_id: str,
    loser_media_id: str,
) -> None:
    with direct_db.session() as session:
        session.execute(
            text("""
                INSERT INTO user_media_deletions (user_id, media_id)
                VALUES (:user_id, :media_id)
            """),
            {"user_id": user_id, "media_id": UUID(loser_media_id)},
        )
        session.execute(
            text("""
                INSERT INTO media_content_index_states (media_id, status, status_reason)
                VALUES (:media_id, 'failed', 'test_duplicate_cleanup')
            """),
            {"media_id": UUID(loser_media_id)},
        )
        session.execute(
            text("""
                INSERT INTO object_links (
                    user_id,
                    relation_type,
                    a_type,
                    a_id,
                    b_type,
                    b_id
                )
                VALUES (:user_id, 'references', 'media', :loser_id, 'media', :winner_id)
            """),
            {
                "user_id": user_id,
                "loser_id": UUID(loser_media_id),
                "winner_id": UUID(winner_media_id),
            },
        )
        session.commit()


def _assert_duplicate_upload_loser_deleted(
    direct_db: DirectSessionManager,
    *,
    media_id: str,
) -> None:
    loser_id = UUID(media_id)
    with direct_db.session() as session:
        assert _count_rows(session, "media", "id = :media_id", media_id=loser_id) == 0
        assert (
            _count_rows(session, "library_entries", "media_id = :media_id", media_id=loser_id) == 0
        )
        assert (
            _count_rows(
                session,
                "default_library_intrinsics",
                "media_id = :media_id",
                media_id=loser_id,
            )
            == 0
        )
        assert (
            _count_rows(session, "user_media_deletions", "media_id = :media_id", media_id=loser_id)
            == 0
        )
        assert _count_rows(session, "media_file", "media_id = :media_id", media_id=loser_id) == 0
        assert (
            _count_rows(
                session,
                "media_content_index_states",
                "media_id = :media_id",
                media_id=loser_id,
            )
            == 0
        )
        object_links = session.execute(
            text("""
                SELECT COUNT(*)
                FROM object_links
                WHERE (a_type = 'media' AND a_id = :media_id)
                   OR (b_type = 'media' AND b_id = :media_id)
            """),
            {"media_id": loser_id},
        ).scalar_one()
        assert int(object_links) == 0


def _count_rows(session, table: str, where: str, **params: object) -> int:
    return int(
        session.execute(text(f"SELECT COUNT(*) FROM {table} WHERE {where}"), params).scalar_one()
    )


class HeadFailureStorageClient(FakeStorageClient):
    def head_object(self, path: str):
        raise StorageError(f"head failed for {path}")


class SignFailureStorageClient(FakeStorageClient):
    def sign_upload(self, *args, **kwargs):
        raise StorageError("sign failed", code=ApiErrorCode.E_SIGN_UPLOAD_FAILED.value)


class BlockingCopyStorageClient(FakeStorageClient):
    def __init__(self):
        super().__init__()
        self.copy_started = threading.Event()
        self.release_copy = threading.Event()
        self.copy_count = 0

    def copy_object(self, source_path: str, destination_path: str) -> None:
        self.copy_count += 1
        self.copy_started.set()
        if not self.release_copy.wait(timeout=5):
            raise StorageError("copy did not release")
        super().copy_object(source_path, destination_path)


@pytest.fixture
def fake_storage():
    """Provide a FakeStorageClient for testing."""
    return FakeStorageClient()


@pytest.fixture
def upload_client(engine, fake_storage, monkeypatch):
    """Create a client with auth middleware and fake storage."""
    from nexus.app import add_request_id_middleware

    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "")

    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID, email: str | None = None) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id, email=email)
        finally:
            db.close()

    # Patch storage to use fake client
    monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)
    monkeypatch.setattr(
        "nexus.services.media_source_ingest.get_storage_client", lambda: fake_storage
    )
    monkeypatch.setattr("nexus.services.media_file_access.get_storage_client", lambda: fake_storage)

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
        assert "storage_path" not in data
        assert "upload_url" in data
        assert "expires_at" in data

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
        assert "storage_path" not in data

    def test_upload_init_replays_idempotency_key(
        self, upload_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))
        headers = {**auth_headers(user_id), "Idempotency-Key": f"upload-init-{uuid4()}"}
        body = {
            "kind": "pdf",
            "filename": "idempotent.pdf",
            "content_type": "application/pdf",
            "size_bytes": len(PDF_CONTENT),
        }

        first = upload_client.post("/media/upload/init", json=body, headers=headers)
        second = upload_client.post("/media/upload/init", json=body, headers=headers)

        assert first.status_code == 200
        assert second.status_code == 200
        first_data = first.json()["data"]
        second_data = second.json()["data"]
        media_id = first_data["media_id"]
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", first_data["source_attempt_id"])
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

        assert second_data["media_id"] == media_id
        assert second_data["source_attempt_id"] == first_data["source_attempt_id"]
        assert second_data["idempotency_outcome"] == "reused"
        assert second_data["source_attempt_status"] == "accepted"
        assert second_data["upload_url"]

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT COUNT(*), COUNT(DISTINCT media_id)
                    FROM media_source_attempts
                    WHERE idempotency_key = :idempotency_key
                    """
                ),
                {"idempotency_key": headers["Idempotency-Key"]},
            ).one()
        assert row == (1, 1)

    def test_upload_init_idempotency_key_rejects_parameter_mismatch(
        self, upload_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))
        headers = {**auth_headers(user_id), "Idempotency-Key": f"upload-init-{uuid4()}"}
        body = {
            "kind": "pdf",
            "filename": "idempotent.pdf",
            "content_type": "application/pdf",
            "size_bytes": len(PDF_CONTENT),
        }

        first = upload_client.post("/media/upload/init", json=body, headers=headers)
        mismatch = upload_client.post(
            "/media/upload/init",
            json={**body, "filename": "different.pdf"},
            headers=headers,
        )

        assert first.status_code == 200
        first_data = first.json()["data"]
        media_id = first_data["media_id"]
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", first_data["source_attempt_id"])
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

        assert mismatch.status_code == 409
        assert mismatch.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"

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

    def test_upload_init_sign_failure_saves_failed_source_item(
        self, upload_client, monkeypatch, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))
        failing_storage = SignFailureStorageClient()
        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: failing_storage)
        monkeypatch.setattr(
            "nexus.services.media_source_ingest.get_storage_client",
            lambda: failing_storage,
        )

        response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "sign-failure.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]
        media_id = data["media_id"]
        source_attempt_id = data["source_attempt_id"]
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)

        assert data["upload_url"] is None
        assert data["source_attempt_status"] == "failed"
        assert data["processing_status"] == "failed"
        assert data["ingest_enqueued"] is False

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.processing_status, m.failure_stage, m.last_error_code,
                           mf.storage_path, msa.status, msa.error_code
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    JOIN media_source_attempts msa ON msa.media_id = m.id
                    WHERE m.id = :media_id
                      AND msa.id = :source_attempt_id
                """),
                {"media_id": media_id, "source_attempt_id": source_attempt_id},
            ).one()

        assert row[0] == "failed"
        assert row[1] == "upload"
        assert row[2] == ApiErrorCode.E_SIGN_UPLOAD_FAILED.value
        assert row[3] == _upload_storage_path(data, "pdf")
        assert row[4] == "failed"
        assert row[5] == ApiErrorCode.E_SIGN_UPLOAD_FAILED.value

        media_response = upload_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200
        capabilities = media_response.json()["data"]["capabilities"]
        assert capabilities["can_retry"] is False
        assert capabilities["can_refresh_source"] is False

        retry_response = upload_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )
        assert retry_response.status_code == 409
        assert retry_response.json()["error"]["code"] == ApiErrorCode.E_RETRY_NOT_ALLOWED.value
        refresh_response = upload_client.post(
            f"/media/{media_id}/refresh",
            headers=auth_headers(user_id),
        )
        assert refresh_response.status_code == 409
        assert refresh_response.json()["error"]["code"] == ApiErrorCode.E_RETRY_NOT_ALLOWED.value
        with direct_db.session() as session:
            attempt_count = session.execute(
                text("SELECT count(*) FROM media_source_attempts WHERE media_id = :media_id"),
                {"media_id": media_id},
            ).scalar_one()
        assert attempt_count == 1


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
        storage_path = _upload_storage_path(init_data, "pdf")
        final_storage_path = _final_storage_path(init_data, "pdf")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
                text(
                    """
                    SELECT m.file_sha256, mf.storage_path
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.id = :id
                    """
                ),
                {"id": media_id},
            )
            row = result.fetchone()
            assert row is not None
            assert row[0] == PDF_SHA256
            assert row[1] == final_storage_path

        assert fake_storage.get_object(storage_path) is None
        assert fake_storage.get_object(final_storage_path) == PDF_CONTENT
        fake_storage.put_object(storage_path, b"%PDF-1.4overwritten staging", "application/pdf")
        assert fake_storage.get_object(final_storage_path) == PDF_CONTENT

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
        source_attempt_id = init_data["source_attempt_id"]
        storage_path = _upload_storage_path(init_data, "pdf")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        assert fake_storage.get_object(storage_path) is None

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
        _assert_failed_upload_source_attempt(
            direct_db,
            media_id=media_id,
            source_attempt_id=source_attempt_id,
            error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
        )

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
        source_attempt_id = init_data["source_attempt_id"]

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        _assert_failed_upload_source_attempt(
            direct_db,
            media_id=media_id,
            source_attempt_id=source_attempt_id,
            error_code=ApiErrorCode.E_STORAGE_MISSING.value,
        )

    def test_ingest_rejects_non_staged_storage_path(self, upload_client, fake_storage, direct_db):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        final_storage_path = _final_storage_path(init_data, "pdf")
        with direct_db.session() as session:
            session.execute(
                text("UPDATE media_file SET storage_path = :path WHERE media_id = :media_id"),
                {"path": final_storage_path, "media_id": media_id},
            )
            session.commit()

        fake_storage.put_object(final_storage_path, PDF_CONTENT, "application/pdf")
        response = upload_client.post(
            f"/media/{media_id}/ingest",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_UPLOAD_CONFLICT"
        assert fake_storage.get_object(final_storage_path) == PDF_CONTENT

    def test_concurrent_ingest_confirms_do_not_overwrite_final_object(
        self, engine, upload_client, monkeypatch, direct_db
    ):
        storage = BlockingCopyStorageClient()
        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: storage)
        session_factory = create_session_factory(engine)

        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "race.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        )
        init_data = init_response.json()["data"]
        media_id = UUID(init_data["media_id"])
        storage_path = _upload_storage_path(init_data, "pdf")
        final_storage_path = _final_storage_path(init_data, "pdf")
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        storage.put_object(storage_path, PDF_CONTENT, "application/pdf")

        results: dict[str, object] = {}

        def first_confirm() -> None:
            try:
                with session_factory() as session:
                    results["first"] = confirm_upload_ingest(session, user_id, media_id)
            except Exception as exc:
                results["first_error"] = exc

        def second_confirm() -> None:
            try:
                with session_factory() as session:
                    confirm_upload_ingest(session, user_id, media_id)
            except ConflictError as exc:
                results["second_conflict"] = exc.code
            except Exception as exc:
                results["second_error"] = exc

        first = threading.Thread(target=first_confirm)
        first.start()
        assert storage.copy_started.wait(timeout=5)

        second = threading.Thread(target=second_confirm)
        second.start()
        second.join(timeout=5)
        storage.release_copy.set()
        first.join(timeout=5)

        assert not first.is_alive()
        assert not second.is_alive()
        assert "first_error" not in results
        assert "second_error" not in results
        assert results["first"] == {"media_id": str(media_id), "duplicate": False}
        assert results["second_conflict"] == ApiErrorCode.E_UPLOAD_CONFLICT
        assert storage.copy_count == 1
        assert storage.get_object(storage_path) is None
        assert storage.get_object(final_storage_path) == PDF_CONTENT

    def test_ingest_head_failure_marks_accepted_media_failed(
        self, upload_client, monkeypatch, direct_db
    ):
        storage = HeadFailureStorageClient()
        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: storage)

        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))
        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "storage-down.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        )
        init_data = init_response.json()["data"]
        media_id = init_data["media_id"]
        source_attempt_id = init_data["source_attempt_id"]
        storage_path = _upload_storage_path(init_data, "pdf")
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)
        storage.put_object(storage_path, PDF_CONTENT, "application/pdf")

        response = upload_client.post(f"/media/{media_id}/ingest", headers=auth_headers(user_id))

        assert response.status_code == 500
        assert response.json()["error"]["code"] == "E_STORAGE_ERROR"
        assert storage.get_object(storage_path) == PDF_CONTENT
        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT processing_status, failure_stage, processing_started_at
                    FROM media
                    WHERE id = :id
                    """
                ),
                {"id": media_id},
            ).fetchone()
        assert row is not None
        assert row[0] == "failed"
        assert row[1] == "upload"
        assert row[2] is None
        _assert_failed_upload_source_attempt(
            direct_db,
            media_id=media_id,
            source_attempt_id=source_attempt_id,
            error_code=ApiErrorCode.E_STORAGE_ERROR.value,
        )

    def test_ingest_empty_object_rejected(self, upload_client, fake_storage, direct_db):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "empty.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        )
        init_data = init_response.json()["data"]
        media_id = init_data["media_id"]
        source_attempt_id = init_data["source_attempt_id"]
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        storage_path = _upload_storage_path(init_data, "pdf")
        fake_storage.put_object(storage_path, b"", "application/pdf")
        response = upload_client.post(
            f"/media/{media_id}/ingest",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert fake_storage.get_object(storage_path) is None
        _assert_failed_upload_source_attempt(
            direct_db,
            media_id=media_id,
            source_attempt_id=source_attempt_id,
            error_code=ApiErrorCode.E_INVALID_REQUEST.value,
        )

    def test_ingest_short_object_rejected(self, upload_client, fake_storage, direct_db):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        init_response = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "short.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        )
        init_data = init_response.json()["data"]
        media_id = init_data["media_id"]
        source_attempt_id = init_data["source_attempt_id"]
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        storage_path = _upload_storage_path(init_data, "pdf")
        fake_storage.put_object(storage_path, PDF_MAGIC + b"short", "application/pdf")
        response = upload_client.post(
            f"/media/{media_id}/ingest",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
        assert fake_storage.get_object(storage_path) is None
        _assert_failed_upload_source_attempt(
            direct_db,
            media_id=media_id,
            source_attempt_id=source_attempt_id,
            error_code=ApiErrorCode.E_INVALID_REQUEST.value,
        )

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
        storage_path = _upload_storage_path(init_data, "pdf")

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id_1)
        direct_db.register_cleanup("media_file", "media_id", media_id_1)
        direct_db.register_cleanup("media", "id", media_id_1)

        fake_storage.put_object(_upload_storage_path(init_1, "pdf"), PDF_CONTENT, "application/pdf")

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
        direct_db.register_cleanup("library_entries", "media_id", media_id_2)
        direct_db.register_cleanup("media_file", "media_id", media_id_2)
        direct_db.register_cleanup("media", "id", media_id_2)
        _seed_duplicate_upload_loser_rows(
            direct_db,
            user_id=user_id,
            winner_media_id=media_id_1,
            loser_media_id=media_id_2,
        )

        init_2_storage_path = _upload_storage_path(init_2, "pdf")
        fake_storage.put_object(init_2_storage_path, PDF_CONTENT, "application/pdf")

        ingest_2 = upload_client.post(
            f"/media/{media_id_2}/ingest",
            headers=auth_headers(user_id),
        ).json()["data"]

        # Should return existing media
        assert ingest_2["duplicate"] is True
        assert ingest_2["media_id"] == media_id_1
        assert fake_storage.get_object(init_2_storage_path) is None

        _assert_duplicate_upload_loser_deleted(direct_db, media_id=media_id_2)

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
        direct_db.register_cleanup("library_entries", "media_id", media_id_a)
        direct_db.register_cleanup("media_file", "media_id", media_id_a)
        direct_db.register_cleanup("media", "id", media_id_a)

        fake_storage.put_object(_upload_storage_path(init_a, "pdf"), PDF_CONTENT, "application/pdf")
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
        direct_db.register_cleanup("library_entries", "media_id", media_id_b)
        direct_db.register_cleanup("media_file", "media_id", media_id_b)
        direct_db.register_cleanup("media", "id", media_id_b)

        fake_storage.put_object(_upload_storage_path(init_b, "pdf"), PDF_CONTENT, "application/pdf")
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(
            _upload_storage_path(init_response, "pdf"), PDF_CONTENT, "application/pdf"
        )
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(
            _upload_storage_path(init_response, "pdf"), PDF_CONTENT, "application/pdf"
        )
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

            add_media_to_library(session, library_id, media_id)
            session.commit()

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(
            _upload_storage_path(init_response, "pdf"), PDF_CONTENT, "application/pdf"
        )
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Put file but don't call ingest
        fake_storage.put_object(
            _upload_storage_path(init_response, "pdf"), PDF_CONTENT, "application/pdf"
        )

        # Get media (before ingest, sha256 not set but file exists)
        response = upload_client.get(
            f"/media/{media_id}",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200
        data = response.json()["data"]

        # Pending PDF with file can be viewed, but annotations wait for extraction.
        caps = data["capabilities"]
        assert caps["can_read"] is True
        assert caps["can_highlight"] is False
        assert caps["can_download_file"] is True
        # But can't quote until text extraction has completed.
        assert caps["can_quote"] is False


class TestUploadProvenance:
    """Tests intrinsic default-library provenance for uploads."""

    def test_upload_init_creates_default_library_intrinsic_row(
        self, upload_client, fake_storage, direct_db: DirectSessionManager
    ):
        """Upload init creates both library_entries and intrinsic rows."""
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

            entry = session.execute(
                text("""
                    SELECT 1 FROM library_entries
                    WHERE library_id = :dl AND media_id = :m
                """),
                {"dl": dl[0], "m": media_id},
            ).fetchone()
            assert entry is not None

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
        direct_db.register_cleanup("library_entries", "media_id", media_id_1)
        direct_db.register_cleanup("media_file", "media_id", media_id_1)
        direct_db.register_cleanup("media", "id", media_id_1)

        fake_storage.put_object(_upload_storage_path(init1, "pdf"), PDF_CONTENT, "application/pdf")
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
        direct_db.register_cleanup("library_entries", "media_id", media_id_2)
        direct_db.register_cleanup("media_file", "media_id", media_id_2)
        direct_db.register_cleanup("media", "id", media_id_2)

        fake_storage.put_object(_upload_storage_path(init2, "pdf"), PDF_CONTENT, "application/pdf")
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

    def test_duplicate_confirm_applies_selected_libraries_to_winner(
        self, upload_client, fake_storage, direct_db: DirectSessionManager
    ):
        """Confirm-time destinations attach to the dedupe winner, not the loser."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            selected_library_id = create_test_library(
                session, user_id, "Duplicate Confirm Destination"
            )
        direct_db.register_cleanup("memberships", "library_id", selected_library_id)
        direct_db.register_cleanup("libraries", "id", selected_library_id)

        init1 = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "winner.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]
        winner_media_id = init1["media_id"]
        direct_db.register_cleanup("default_library_intrinsics", "media_id", winner_media_id)
        direct_db.register_cleanup("library_entries", "media_id", winner_media_id)
        direct_db.register_cleanup("media_file", "media_id", winner_media_id)
        direct_db.register_cleanup("media", "id", winner_media_id)
        fake_storage.put_object(_upload_storage_path(init1, "pdf"), PDF_CONTENT, "application/pdf")
        first_confirm = upload_client.post(
            f"/media/{winner_media_id}/ingest",
            headers=auth_headers(user_id),
        )
        assert first_confirm.status_code == 200

        init2 = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "loser.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(PDF_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]
        loser_media_id = init2["media_id"]
        direct_db.register_cleanup("default_library_intrinsics", "media_id", loser_media_id)
        direct_db.register_cleanup("library_entries", "media_id", loser_media_id)
        direct_db.register_cleanup("media_file", "media_id", loser_media_id)
        direct_db.register_cleanup("media", "id", loser_media_id)
        fake_storage.put_object(_upload_storage_path(init2, "pdf"), PDF_CONTENT, "application/pdf")

        duplicate_confirm = upload_client.post(
            f"/media/{loser_media_id}/ingest",
            json={"library_ids": [str(selected_library_id)]},
            headers=auth_headers(user_id),
        )

        assert duplicate_confirm.status_code == 200
        assert duplicate_confirm.json()["data"]["media_id"] == winner_media_id
        assert selected_library_id in _library_entries_for_media(direct_db, winner_media_id)

    def test_invalid_confirm_does_not_attach_confirm_time_libraries(
        self, upload_client, fake_storage, direct_db: DirectSessionManager
    ):
        """Failed confirm validates destinations without writing destination rows."""
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))
        with direct_db.session() as session:
            selected_library_id = create_test_library(session, user_id, "Invalid Confirm Library")
        direct_db.register_cleanup("memberships", "library_id", selected_library_id)
        direct_db.register_cleanup("libraries", "id", selected_library_id)

        init_data = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "invalid-confirm.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(INVALID_CONTENT),
            },
            headers=auth_headers(user_id),
        ).json()["data"]
        media_id = init_data["media_id"]
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media_file", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        fake_storage.put_object(
            _upload_storage_path(init_data, "pdf"), INVALID_CONTENT, "application/pdf"
        )

        response = upload_client.post(
            f"/media/{media_id}/ingest",
            json={"library_ids": [str(selected_library_id)]},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_FILE_TYPE"
        assert selected_library_id not in _library_entries_for_media(direct_db, media_id)


class TestEpubIngestLifecycle:
    """EPUB ingest dispatch and lifecycle tests."""

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
        direct_db.register_cleanup("library_entries", "media_id", mid)
        direct_db.register_cleanup("media_file", "media_id", mid)
        direct_db.register_cleanup("media", "id", mid)

        storage_path = _upload_storage_path(d, "epub")
        fake_storage.put_object(storage_path, content, "application/epub+zip")
        return mid, storage_path

    def test_ingest_epub_confirm_dispatches_source_ingest(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )
        resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 200
        assert resp.json()["data"]["ingest_enqueued"] is True
        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=str(mid)) == 1

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT processing_status, last_error_code FROM media WHERE id = :id"),
                {"id": mid},
            ).fetchone()
            assert row is not None
            assert row[0] == "extracting"
            assert row[1] is None

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
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )

        resp1 = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp1.status_code == 200
        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=str(mid)) == 1

        with direct_db.session() as session:
            attempts_after_first = session.execute(
                text("SELECT processing_attempts FROM media WHERE id = :id"),
                {"id": mid},
            ).scalar()

        resp2 = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp2.status_code == 200
        data2 = resp2.json()["data"]
        assert data2["ingest_enqueued"] is False

        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=str(mid)) == 1

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

    def test_ingest_epub_dispatch_failure_marks_source_failed(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

        mid, _ = self._init_and_store_epub(
            upload_client, fake_storage, direct_db, user_id, EPUB_CONTENT
        )
        _install_background_job_insert_failure(direct_db)
        try:
            resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        finally:
            _remove_background_job_insert_failure(direct_db)
        assert resp.status_code == 200
        assert resp.json()["data"]["ingest_enqueued"] is False

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT processing_status, last_error_code FROM media WHERE id = :id"),
                {"id": mid},
            ).fetchone()
            assert row is not None
            assert row[0] == "failed"
            assert row[1] == "E_INTERNAL"


class TestPdfIngestLifecycle:
    """PDF ingest dispatch and lifecycle tests."""

    def _init_and_store_pdf(self, upload_client, fake_storage, direct_db, user_id, content):
        """Helper: init upload + store content, return (media_id, storage_path)."""
        resp = upload_client.post(
            "/media/upload/init",
            json={
                "kind": "pdf",
                "filename": "test.pdf",
                "content_type": "application/pdf",
                "size_bytes": len(content),
            },
            headers=auth_headers(user_id),
        )
        assert resp.status_code == 200
        d = resp.json()["data"]
        mid = d["media_id"]
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", mid)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", mid)
        direct_db.register_cleanup("library_entries", "media_id", mid)
        direct_db.register_cleanup("media_file", "media_id", mid)
        direct_db.register_cleanup("media", "id", mid)

        storage_path = _upload_storage_path(d, "pdf")
        fake_storage.put_object(storage_path, content, "application/pdf")
        return mid, storage_path

    def test_ingest_pdf_confirm_dispatches_source_ingest(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

        mid, _ = self._init_and_store_pdf(
            upload_client, fake_storage, direct_db, user_id, PDF_CONTENT
        )

        resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp.status_code == 200
        data = resp.json()["data"]

        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True
        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=str(mid)) == 1

    def test_ingest_pdf_confirm_non_creator_forbidden(
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

        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

        mid, _ = self._init_and_store_pdf(
            upload_client, fake_storage, direct_db, user_a, PDF_CONTENT
        )

        resp = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_b))
        assert resp.status_code in (403, 404)

    def test_ingest_pdf_confirm_repeat_call_idempotent_without_redispatch(
        self,
        upload_client,
        fake_storage,
        direct_db,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        upload_client.get("/me", headers=auth_headers(user_id))

        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

        mid, _ = self._init_and_store_pdf(
            upload_client, fake_storage, direct_db, user_id, PDF_CONTENT
        )

        resp1 = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp1.status_code == 200
        assert resp1.json()["data"]["ingest_enqueued"] is True
        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=str(mid)) == 1

        resp2 = upload_client.post(f"/media/{mid}/ingest", headers=auth_headers(user_id))
        assert resp2.status_code == 200
        data2 = resp2.json()["data"]
        assert data2["ingest_enqueued"] is False
        assert _count_jobs_for_media(direct_db, kind="ingest_media_source", media_id=str(mid)) == 1


class TestValidateSourceIntegrity:
    def test_head_failure_is_storage_error(self):
        media_file = MediaFile(
            media_id=uuid4(),
            storage_path="media/test/original.pdf",
            content_type="application/pdf",
            size_bytes=len(PDF_CONTENT),
        )

        with pytest.raises(ApiError) as exc_info:
            validate_file_source_integrity(HeadFailureStorageClient(), media_file, "pdf")

        assert exc_info.value.code == ApiErrorCode.E_STORAGE_ERROR
