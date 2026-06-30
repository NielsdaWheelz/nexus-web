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

import hashlib
import io
import socket
import tarfile
import zipfile
from collections import Counter
from pathlib import Path
from types import SimpleNamespace
from typing import BinaryIO
from uuid import UUID, uuid4

import httpx
import pytest
import respx
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

from nexus.errors import ApiErrorCode
from nexus.storage.client import StorageError
from nexus.storage.paths import build_source_artifact_storage_path, build_storage_path
from tests.helpers import auth_headers, create_test_user_id
from tests.support.storage import FakeStorageClient
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

PDF_CONTENT = b"%PDF-1.4\nremote pdf bytes"


def _valid_pdf_content(text_content: str = "Remote PDF") -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 72), text_content, fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def _tar_bytes(entries: list[tuple[str, bytes]]) -> bytes:
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        for name, content in entries:
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return data.getvalue()


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

    def put_object_stream(
        self, path: str, content: BinaryIO, content_type: str = "application/pdf"
    ) -> None:
        self.put_paths.append(path)
        super().put_object_stream(path, content, content_type)

    def delete_object(self, path: str) -> None:
        self.deleted_paths.append(path)
        super().delete_object(path)


class _FailingPutStorageClient(_TrackingStorageClient):
    """Fake storage client that fails on put_object after fetch succeeds."""

    def put_object(self, path: str, content: bytes, content_type: str = "application/pdf") -> None:
        self.put_paths.append(path)
        raise StorageError("forced storage put failure", code="E_STORAGE_ERROR")

    def put_object_stream(
        self, path: str, content: BinaryIO, content_type: str = "application/pdf"
    ) -> None:
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
    settings = SimpleNamespace(
        max_pdf_bytes=limit_bytes,
        max_epub_bytes=limit_bytes,
        max_arxiv_source_bytes=limit_bytes,
    )
    monkeypatch.setattr("nexus.services.remote_file_client.get_settings", lambda: settings)
    monkeypatch.setattr("nexus.services.upload.get_settings", lambda: settings)


def _patch_remote_storage(monkeypatch, storage_client) -> None:
    monkeypatch.setattr(
        "nexus.services.media_source_ingest.get_storage_client", lambda: storage_client
    )
    monkeypatch.setattr("nexus.services.pdf_lifecycle.get_storage_client", lambda: storage_client)
    monkeypatch.setattr("nexus.services.epub_lifecycle.get_storage_client", lambda: storage_client)
    monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: storage_client)
    monkeypatch.setattr("nexus.tasks.ingest_epub.get_storage_client", lambda: storage_client)
    monkeypatch.setattr("nexus.tasks.ingest_pdf.get_storage_client", lambda: storage_client)


def _expect_remote_file(
    remote_http,
    url: str,
    body: bytes | str,
    *,
    content_type: str,
    status: int = 200,
    headers: dict[str, str] | None = None,
):
    return remote_http.get(url).mock(
        return_value=httpx.Response(
            status,
            content=body,
            headers={"Content-Type": content_type, **(headers or {})},
        )
    )


def _expect_remote_redirect(remote_http, url: str, target_url: str, *, status: int = 302):
    remote_http.get(url).mock(return_value=httpx.Response(status, headers={"Location": target_url}))


def _patch_x_api_settings(monkeypatch) -> None:
    monkeypatch.setattr(
        "nexus.services.x_client.get_settings",
        lambda: SimpleNamespace(
            x_api_bearer_token="test-x-token",
            x_api_base_url="https://api.x.com/2",
            x_api_timeout_seconds=10.0,
            x_api_author_thread_max_posts=1000,
        ),
    )


def _x_root_payload(post_id: str, *, quoted_id: str | None = None) -> dict:
    refs = []
    includes_tweets = []
    include_users = [
        {"id": "10", "name": "Ada Lovelace", "username": "ada"},
    ]
    if quoted_id is not None:
        refs.append({"type": "quoted", "id": quoted_id})
        includes_tweets.append(
            {
                "id": quoted_id,
                "author_id": "20",
                "text": "Quoted insight from Grace.",
                "created_at": "2026-04-15T11:00:00.000Z",
                "conversation_id": quoted_id,
            }
        )
        include_users.append({"id": "20", "name": "Grace Hopper", "username": "grace"})
    return {
        "data": {
            "id": post_id,
            "author_id": "10",
            "text": "Opening post from Ada.",
            "created_at": "2026-04-15T12:00:00.000Z",
            "conversation_id": post_id,
            "referenced_tweets": refs,
        },
        "includes": {"users": include_users, "tweets": includes_tweets},
    }


def _x_search_payload(post_id: str) -> dict:
    return {
        "data": [
            {
                "id": post_id,
                "author_id": "10",
                "text": "Opening post from Ada.",
                "created_at": "2026-04-15T12:00:00.000Z",
                "conversation_id": post_id,
            },
            {
                "id": "1234567891",
                "author_id": "10",
                "text": "Second post in the author's thread.",
                "created_at": "2026-04-15T12:01:00.000Z",
                "conversation_id": post_id,
                "referenced_tweets": [{"type": "replied_to", "id": post_id}],
            },
            {
                "id": "9999999999",
                "author_id": "99",
                "text": "A reply from someone else should not be captured.",
                "created_at": "2026-04-15T12:02:00.000Z",
                "conversation_id": post_id,
                "referenced_tweets": [{"type": "replied_to", "id": post_id}],
            },
            {
                "id": "1234567892",
                "author_id": "10",
                "text": "Side reply from Ada to someone else.",
                "created_at": "2026-04-15T12:03:00.000Z",
                "conversation_id": post_id,
                "referenced_tweets": [{"type": "replied_to", "id": "9999999999"}],
            },
        ],
        "includes": {
            "users": [
                {"id": "10", "name": "Ada Lovelace", "username": "ada"},
                {"id": "99", "name": "Other Author", "username": "other"},
            ]
        },
        "meta": {"result_count": 3},
    }


def _expect_x_author_thread(remote_http, post_id: str, *, status: int = 200):
    root_route = remote_http.get(f"https://api.x.com/2/tweets/{post_id}").mock(
        return_value=httpx.Response(
            status,
            json=_x_root_payload(post_id, quoted_id="4444444444") if status == 200 else {},
        )
    )
    search_route = remote_http.get("https://api.x.com/2/tweets/search/all").mock(
        return_value=httpx.Response(200, json=_x_search_payload(post_id))
    )
    return root_route, search_route


def _register_x_provider_event_cleanup(
    direct_db: DirectSessionManager,
    *target_refs: str,
) -> None:
    if not target_refs:
        return
    with direct_db.session() as session:
        for event_id in session.execute(
            text("""
                SELECT id
                FROM external_provider_events
                WHERE provider = 'x'
                  AND target_ref = ANY(:target_refs)
            """),
            {"target_refs": list(target_refs)},
        ).scalars():
            direct_db.register_cleanup("external_provider_events", "id", event_id)


def _run_source_attempt_for_media(
    direct_db: DirectSessionManager,
    media_id: UUID,
) -> dict[str, object]:
    from nexus.services.media_source_ingest import run_source_attempt

    with direct_db.session() as session:
        row = (
            session.execute(
                text(
                    """
                    SELECT id, payload
                    FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            )
            .mappings()
            .one()
        )
    direct_db.register_cleanup("background_jobs", "id", row["id"])
    payload = row["payload"]
    with direct_db.session() as session:
        return run_source_attempt(
            db=session,
            media_id=UUID(payload["media_id"]),
            attempt_id=UUID(payload["attempt_id"]),
            actor_user_id=UUID(payload["actor_user_id"]),
            request_id=payload.get("request_id"),
        )


def _register_background_jobs_for_media(
    direct_db: DirectSessionManager,
    media_id: UUID,
) -> None:
    with direct_db.session() as session:
        job_ids = [
            row[0]
            for row in session.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                    """
                ),
                {"media_id": str(media_id)},
            ).fetchall()
        ]
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)


def _register_source_media_cleanup(
    direct_db: DirectSessionManager,
    media_id: UUID,
    *,
    source_attempt_id: UUID | None = None,
) -> None:
    direct_db.register_cleanup("media", "id", media_id)
    if source_attempt_id is not None:
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media_file", "media_id", media_id)
    direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
    direct_db.register_cleanup("reader_apparatus_states", "media_id", media_id)
    direct_db.register_cleanup("reader_apparatus_items", "media_id", media_id)
    direct_db.register_cleanup("reader_apparatus_edges", "media_id", media_id)
    _register_background_jobs_for_media(direct_db, media_id)


def _patch_file_extractors_success(
    monkeypatch,
    direct_db: DirectSessionManager,
) -> None:
    def _materialize_pdf_success(
        _db,
        *,
        media_id: UUID,
        request_id: str | None = None,
        **_kwargs,
    ) -> dict[str, object]:
        return {"status": "success", "media_id": str(media_id)}

    def _materialize_epub_success(_db, *, media_id: UUID) -> dict[str, object]:
        return {"status": "success", "media_id": str(media_id)}

    monkeypatch.setattr(
        "nexus.services.pdf_lifecycle.materialize_pdf_source",
        _materialize_pdf_success,
    )
    monkeypatch.setattr(
        "nexus.services.epub_lifecycle.materialize_epub_source",
        _materialize_epub_success,
    )


def _assert_latest_source_failure(
    direct_db: DirectSessionManager,
    media_id: UUID,
    expected_code: ApiErrorCode,
) -> None:
    with direct_db.session() as session:
        media_row = session.execute(
            text(
                """
                SELECT processing_status, failure_stage, last_error_code
                FROM media
                WHERE id = :media_id
                """
            ),
            {"media_id": media_id},
        ).fetchone()
        attempt_row = session.execute(
            text(
                """
                SELECT status, error_code
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no DESC, created_at DESC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).fetchone()

    assert media_row == ("failed", "extract", expected_code.value)
    assert attempt_row == ("failed", expected_code.value)


def _accept_source_url(
    auth_client,
    direct_db: DirectSessionManager,
    user_id: UUID,
    url: str,
    *,
    expected_source_type: str,
) -> tuple[dict[str, object], UUID]:
    response = auth_client.post(
        "/media/from_url",
        json={"url": url},
        headers=auth_headers(user_id),
    )
    assert response.status_code == 202, response.text
    data = response.json()["data"]
    media_id = UUID(data["media_id"])
    source_attempt_id = UUID(data["source_attempt_id"])
    _register_source_media_cleanup(
        direct_db,
        media_id,
        source_attempt_id=source_attempt_id,
    )
    assert data["idempotency_outcome"] == "created"
    assert data["source_type"] == expected_source_type
    assert data["processing_status"] == "pending"
    assert data["ingest_enqueued"] is True
    with direct_db.session() as session:
        attempt = session.execute(
            text(
                """
                SELECT media_id, source_type, status, requested_url, job_id
                FROM media_source_attempts
                WHERE id = :attempt_id
                """
            ),
            {"attempt_id": source_attempt_id},
        ).fetchone()
    assert attempt is not None
    assert attempt[0] == media_id
    assert attempt[1] == expected_source_type
    assert attempt[2] == "queued"
    assert attempt[3] == url
    assert attempt[4] is not None
    return data, media_id


def _accept_remote_source_and_expect_worker_error(
    auth_client,
    direct_db: DirectSessionManager,
    user_id: UUID,
    url: str,
    *,
    expected_source_type: str,
    expected_code: ApiErrorCode,
) -> UUID:
    _, media_id = _accept_source_url(
        auth_client,
        direct_db,
        user_id,
        url,
        expected_source_type=expected_source_type,
    )
    result = _run_source_attempt_for_media(direct_db, media_id)
    assert result["status"] == "failed"
    assert result["error_code"] == expected_code.value
    _assert_latest_source_failure(direct_db, media_id, expected_code)
    return media_id


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


def _install_library_entry_insert_failure(direct_db: DirectSessionManager) -> None:
    """Force library_entries inserts to fail until teardown is called."""
    with direct_db.session() as session:
        session.execute(
            text(
                """
                CREATE OR REPLACE FUNCTION nexus_test_fail_library_entry_insert()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $$
                BEGIN
                    RAISE EXCEPTION 'library_entries unavailable';
                END;
                $$;
                """
            )
        )
        session.execute(
            text(
                """
                DROP TRIGGER IF EXISTS nexus_test_fail_library_entry_insert
                ON library_entries
                """
            )
        )
        session.execute(
            text(
                """
                CREATE TRIGGER nexus_test_fail_library_entry_insert
                BEFORE INSERT ON library_entries
                FOR EACH ROW
                EXECUTE FUNCTION nexus_test_fail_library_entry_insert()
                """
            )
        )
        session.commit()


def _remove_library_entry_insert_failure(direct_db: DirectSessionManager) -> None:
    with direct_db.session() as session:
        session.execute(
            text(
                """
                DROP TRIGGER IF EXISTS nexus_test_fail_library_entry_insert
                ON library_entries
                """
            )
        )
        session.execute(text("DROP FUNCTION IF EXISTS nexus_test_fail_library_entry_insert()"))
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
            assert row[3] is None  # canonical_url (set after ingestion resolves redirects)
            assert row[4] == "https://example.com/article"  # canonical_source_url (normalized)
            assert row[5] == "pending"  # processing_status
            assert row[6] == user_id  # created_by_user_id

    def test_create_remote_pdf_url_success(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        """A .pdf URL creates file-backed PDF media through remote ingest."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        fake_storage = FakeStorageClient()
        _patch_remote_file_limits(monkeypatch)
        _patch_remote_storage(monkeypatch, fake_storage)
        _patch_file_extractors_success(monkeypatch, direct_db)
        _expect_remote_file(
            remote_http,
            "https://example.com/report.pdf",
            PDF_CONTENT,
            content_type="application/pdf",
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/report.pdf"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        source_attempt_id = UUID(data["source_attempt_id"])

        _register_source_media_cleanup(
            direct_db,
            media_id,
            source_attempt_id=source_attempt_id,
        )

        assert data["idempotency_outcome"] == "created"
        assert data["source_type"] == "remote_pdf_url"
        assert data["processing_status"] == "pending"
        assert data["ingest_enqueued"] is True

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

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
            assert row[4] == "ready_for_reading"
            assert row[5] == "application/pdf"
            assert row[6] == len(PDF_CONTENT)

    def test_create_remote_epub_url_success(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        """A .epub URL creates file-backed EPUB media through remote ingest."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        fake_storage = FakeStorageClient()
        _patch_remote_file_limits(monkeypatch)
        _patch_remote_storage(monkeypatch, fake_storage)
        _patch_file_extractors_success(monkeypatch, direct_db)
        _expect_remote_file(
            remote_http,
            "https://example.com/books/book.epub?download=1",
            EPUB_CONTENT,
            content_type="application/epub+zip",
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://example.com/books/book.epub?download=1"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        source_attempt_id = UUID(data["source_attempt_id"])

        _register_source_media_cleanup(
            direct_db,
            media_id,
            source_attempt_id=source_attempt_id,
        )

        assert data["idempotency_outcome"] == "created"
        assert data["source_type"] == "remote_epub_url"
        assert data["processing_status"] == "pending"
        assert data["ingest_enqueued"] is True

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.kind, m.title, m.processing_status, mf.content_type, mf.size_bytes
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()

            assert row is not None
            assert row[0] == "epub"
            assert row[1] == "book.epub"
            assert row[2] == "ready_for_reading"
            assert row[3] == "application/epub+zip"
            assert row[4] == len(EPUB_CONTENT)

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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        # Verify library_entries row exists
        with direct_db.session() as session:
            result = session.execute(
                text("""
                    SELECT library_id, media_id FROM library_entries
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
                    FROM library_entries
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
        source_attempt_id = UUID(data["source_attempt_id"])
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        assert data["ingest_enqueued"] is True, (
            "Expected ingest_enqueued=True when queue row is persisted."
        )
        assert data["source_type"] == "generic_web_url"

        with direct_db.session() as session:
            row = session.execute(
                text(
                    """
                    SELECT id, kind, payload->>'media_id', payload->>'attempt_id',
                           payload->>'actor_user_id'
                    FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": str(media_id)},
            ).fetchone()
            attempt = session.execute(
                text(
                    """
                    SELECT media_id, source_type, status, requested_url, job_id
                    FROM media_source_attempts
                    WHERE id = :attempt_id
                    """
                ),
                {"attempt_id": source_attempt_id},
            ).fetchone()

        assert row is not None, (
            "Expected one ingest_media_source background job row for created media. "
            f"media_id={media_id}"
        )
        direct_db.register_cleanup("background_jobs", "id", row[0])
        assert row[1] == "ingest_media_source"
        assert UUID(row[3]) == source_attempt_id
        assert row[4] == str(user_id)
        assert attempt is not None
        assert attempt[0] == media_id
        assert attempt[1] == "generic_web_url"
        assert attempt[2] == "queued"
        assert attempt[3] == "https://example.com/queue-check"
        assert attempt[4] == row[0]

    def test_web_article_creation_persists_failed_source_when_enqueue_fails(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """Queue enqueue failure fails the saved media/source instead of losing the item."""
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

        assert response.status_code == 202, response.text
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT processing_status, last_error_code
                    FROM media
                    WHERE requested_url = :url
                      AND created_by_user_id = :user_id
                    """
                ),
                {"url": url, "user_id": user_id},
            ).fetchone()
            attempt_row = session.execute(
                text(
                    """
                    SELECT status, error_code
                    FROM media_source_attempts
                    WHERE media_id = :media_id
                    ORDER BY attempt_no DESC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                    """
                ),
                {"media_id": str(media_id)},
            ).scalar_one()

        assert media_row == ("failed", "E_INTERNAL")
        assert attempt_row == ("failed", "E_INTERNAL")
        assert job_count == 0

    def test_youtube_creation_persists_failed_source_when_enqueue_fails(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """First-time YouTube enqueue failure fails the saved media/source."""
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

        assert response.status_code == 202, response.text
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        direct_db.register_cleanup("media", "id", media_id)

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT processing_status, last_error_code
                    FROM media
                    WHERE kind = 'video'
                      AND canonical_url = :canonical_url
                    """
                ),
                {"canonical_url": canonical_url},
            ).fetchone()
            attempt_row = session.execute(
                text(
                    """
                    SELECT status, error_code
                    FROM media_source_attempts
                    WHERE media_id = :media_id
                    ORDER BY attempt_no DESC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            job_count = session.execute(
                text(
                    """
                    SELECT COUNT(*) FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                    """
                ),
                {"media_id": str(media_id)},
            ).scalar_one()

        assert media_row == ("failed", "E_INTERNAL")
        assert attempt_row == ("failed", "E_INTERNAL")
        assert job_count == 0

    def test_youtube_transcript_failure_fails_saved_source_attempt(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        """A YouTube provider failure should fail the saved item, not lose it."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        video_id = uuid4().hex[:11]

        monkeypatch.setattr(
            "nexus.services.youtube_video_ingest.fetch_youtube_metadata",
            lambda _provider_id: None,
        )
        monkeypatch.setattr(
            "nexus.services.youtube_video_ingest.fetch_youtube_transcript",
            lambda _provider_id: {
                "status": "failed",
                "error_code": ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
                "error_message": "Transcript unavailable",
            },
        )

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            f"https://www.youtube.com/watch?v={video_id}",
            expected_source_type="youtube_video",
        )
        result = _run_source_attempt_for_media(direct_db, media_id)

        assert result["status"] == "failed"
        assert result["error_code"] == ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value

        with direct_db.session() as session:
            media_row = session.execute(
                text(
                    """
                    SELECT processing_status, failure_stage, last_error_code
                    FROM media
                    WHERE id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            attempt_row = session.execute(
                text(
                    """
                    SELECT status, error_code
                    FROM media_source_attempts
                    WHERE media_id = :media_id
                    ORDER BY attempt_no DESC, created_at DESC
                    LIMIT 1
                    """
                ),
                {"media_id": media_id},
            ).fetchone()
            transcript_row = session.execute(
                text(
                    """
                    SELECT transcript_state, transcript_coverage, semantic_status, last_error_code
                    FROM media_transcript_states
                    WHERE media_id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).fetchone()

        assert media_row == (
            "failed",
            "transcribe",
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
        )
        assert attempt_row == ("failed", ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value)
        assert transcript_row == (
            "unavailable",
            "none",
            "failed",
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
        )


class TestFromUrlXPost:
    """Tests for official X API-backed author-thread ingestion."""

    def test_x_post_source_attempt_materializes_single_post_without_thread_search(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        from nexus.services.media_source_ingest import run_source_attempt

        _patch_x_api_settings(monkeypatch)
        user_id = create_test_user_id()
        default_library_id = UUID(
            auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
                "default_library_id"
            ]
        )
        media_id = uuid4()
        source_attempt_id = uuid4()
        root_route = remote_http.get("https://api.x.com/2/tweets/1212121212").mock(
            return_value=httpx.Response(200, json=_x_root_payload("1212121212"))
        )
        search_route = remote_http.get("https://api.x.com/2/tweets/search/all").mock(
            return_value=httpx.Response(500, json={})
        )

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, requested_url, canonical_url,
                        canonical_source_url, provider, provider_id,
                        processing_status, created_by_user_id, created_at, updated_at
                    )
                    VALUES (
                        :media_id, 'web_article', 'Embedded X post 1212121212',
                        'https://x.com/ada/status/1212121212',
                        NULL,
                        'https://x.com/i/status/1212121212',
                        'x', NULL, 'pending', :user_id, now(), now()
                    )
                """),
                {"media_id": media_id, "user_id": user_id},
            )
            session.execute(
                text("""
                    INSERT INTO default_library_intrinsics (default_library_id, media_id)
                    VALUES (:default_library_id, :media_id)
                """),
                {"default_library_id": default_library_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO media_source_attempts (
                        id, media_id, created_by_user_id, source_type, attempt_no,
                        status, intent_key, requested_url, canonical_source_url,
                        provider, provider_target_ref, source_payload
                    )
                    VALUES (
                        :source_attempt_id, :media_id, :user_id,
                        'x_post', 1, 'accepted',
                        :intent_key,
                        'https://x.com/ada/status/1212121212',
                        'https://x.com/i/status/1212121212',
                        'x', '1212121212',
                        '{"kind": "embedded_source", "post_id": "1212121212"}'::jsonb
                    )
                """),
                {
                    "source_attempt_id": source_attempt_id,
                    "media_id": media_id,
                    "user_id": user_id,
                    "intent_key": f"test:x_post:{media_id}",
                },
            )
            session.commit()

        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        with direct_db.session() as session:
            result = run_source_attempt(
                db=session,
                media_id=media_id,
                attempt_id=source_attempt_id,
                actor_user_id=user_id,
                request_id="test-x-post",
            )

        assert result["media_id"] == str(media_id)
        assert result["processing_status"] == "ready_for_reading"
        assert root_route.call_count == 1
        assert search_route.call_count == 0
        _register_x_provider_event_cleanup(direct_db, "post:1212121212")
        _register_background_jobs_for_media(direct_db, media_id)

        with direct_db.session() as session:
            media = session.execute(
                text("""
                    SELECT kind, title, requested_url, canonical_url, canonical_source_url,
                           provider, provider_id, processing_status, publisher, description
                    FROM media
                    WHERE id = :media_id
                """),
                {"media_id": media_id},
            ).one()
            fragment = session.execute(
                text("""
                    SELECT html_sanitized, canonical_text
                    FROM fragments
                    WHERE media_id = :media_id
                    ORDER BY idx ASC
                    LIMIT 1
                """),
                {"media_id": media_id},
            ).one()
            attempt = session.execute(
                text("""
                    SELECT status, error_code
                    FROM media_source_attempts
                    WHERE id = :source_attempt_id
                """),
                {"source_attempt_id": source_attempt_id},
            ).one()
            provider_event = session.execute(
                text("""
                    SELECT provider, capability, operation, status, target_ref, source_attempt_id
                    FROM external_provider_events
                    WHERE provider = 'x'
                      AND target_ref = 'post:1212121212'
                    ORDER BY created_at DESC
                    LIMIT 1
                """)
            ).one()

        assert tuple(media) == (
            "web_article",
            "X post by Ada Lovelace",
            "https://x.com/ada/status/1212121212",
            "https://x.com/i/status/1212121212",
            "https://x.com/i/status/1212121212",
            "x",
            "post:1212121212",
            "ready_for_reading",
            "X",
            "Opening post from Ada.",
        )
        assert "<script" not in fragment[0]
        assert "Opening post from Ada." in fragment[1]
        assert tuple(attempt) == ("succeeded", None)
        assert tuple(provider_event) == (
            "x",
            "post",
            "ingest_x_post",
            "success",
            "post:1212121212",
            source_attempt_id,
        )

    def test_x_post_url_creates_ready_author_thread_web_article(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        _patch_x_api_settings(monkeypatch)
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        root_route, search_route = _expect_x_author_thread(remote_http, "1234567890")

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/1234567890?s=20"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", UUID(data["source_attempt_id"]))
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        assert data["idempotency_outcome"] == "created"
        assert data["source_type"] == "x_author_thread"
        assert data["processing_status"] == "pending"
        assert data["ingest_enqueued"] is True
        assert root_route.call_count == 0
        assert search_route.call_count == 0

        result = _run_source_attempt_for_media(direct_db, media_id)
        _register_x_provider_event_cleanup(direct_db, "author-thread:10:1234567890")

        assert result["media_id"] == str(media_id)
        assert result["processing_status"] == "ready_for_reading"
        assert root_route.call_count == 1
        assert search_route.call_count == 1

        with direct_db.session() as session:
            media = session.execute(
                text("""
                    SELECT kind, title, requested_url, canonical_url, canonical_source_url,
                           provider, provider_id, processing_status, publisher, description
                    FROM media
                    WHERE id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()
            fragments = session.execute(
                text("""
                    SELECT f.idx, f.html_sanitized, f.canonical_text, COUNT(fb.id)
                    FROM fragments f
                    LEFT JOIN fragment_blocks fb ON fb.fragment_id = f.id
                    WHERE f.media_id = :media_id
                    GROUP BY f.id
                    ORDER BY f.idx ASC
                """),
                {"media_id": media_id},
            ).fetchall()
            quoted_media = session.execute(
                text("""
                    SELECT id, kind, title, canonical_url, canonical_source_url,
                           provider, provider_id, processing_status
                    FROM media
                    WHERE provider = 'x'
                      AND provider_id = 'post:4444444444'
                """)
            ).fetchone()
            quoted_job_ids = (
                []
                if quoted_media is None
                else [
                    row[0]
                    for row in session.execute(
                        text("""
                        SELECT id
                        FROM background_jobs
                        WHERE payload->>'media_id' = :media_id
                    """),
                        {"media_id": str(quoted_media[0])},
                    ).fetchall()
                ]
            )
            jobs = [
                tuple(row)
                for row in session.execute(
                    text("""
                    SELECT id, kind
                    FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                """),
                    {"media_id": str(media_id)},
                ).fetchall()
            ]

        assert media is not None
        assert media[0] == "web_article"
        assert media[1] == "X thread by Ada Lovelace"
        assert media[2] == "https://x.com/ada/status/1234567890?s=20"
        assert media[3] is None
        assert media[4] == "https://x.com/i/status/1234567890"
        assert media[5] == "x"
        assert media[6] == "author-thread:10:1234567890"
        assert media[7] == "ready_for_reading"
        assert media[8] == "X"
        assert "Opening post from Ada." in media[9]
        assert len(fragments) == 2
        assert fragments[0][0] == 0
        assert "<script" not in fragments[0][1]
        assert "Opening post from Ada." in fragments[0][2]
        assert "Quoted post by Grace Hopper" in fragments[0][2]
        assert "A reply from someone else" not in "\n".join(row[2] for row in fragments)
        assert "Side reply from Ada" not in "\n".join(row[2] for row in fragments)
        assert fragments[0][3] >= 1
        assert fragments[1][0] == 1
        assert "Second post in the author's thread." in fragments[1][2]
        assert quoted_media is not None
        direct_db.register_cleanup("default_library_intrinsics", "media_id", quoted_media[0])
        direct_db.register_cleanup("library_entries", "media_id", quoted_media[0])
        direct_db.register_cleanup("media", "id", quoted_media[0])
        assert quoted_media[1] == "web_article"
        assert quoted_media[2] == "X post by Grace Hopper"
        assert quoted_media[3] == "https://x.com/i/status/4444444444"
        assert quoted_media[4] == "https://x.com/i/status/4444444444"
        assert quoted_media[5] == "x"
        assert quoted_media[6] == "post:4444444444"
        assert quoted_media[7] == "ready_for_reading"
        for job_id in quoted_job_ids:
            direct_db.register_cleanup("background_jobs", "id", job_id)
        for job_id, _kind in jobs:
            direct_db.register_cleanup("background_jobs", "id", job_id)
        assert [kind for _job_id, kind in jobs if kind == "ingest_media_source"] == [
            "ingest_media_source"
        ]

    def test_x_post_reuse_is_global_across_users(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        _patch_x_api_settings(monkeypatch)
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        default_library_a = UUID(
            auth_client.get("/me", headers=auth_headers(user_a)).json()["data"][
                "default_library_id"
            ]
        )
        default_library_b = UUID(
            auth_client.get("/me", headers=auth_headers(user_b)).json()["data"][
                "default_library_id"
            ]
        )
        root_route, search_route = _expect_x_author_thread(remote_http, "2222222222")

        first_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/2222222222"},
            headers=auth_headers(user_a),
        )
        assert first_response.status_code == 202
        first_data = first_response.json()["data"]
        media_id = UUID(first_data["media_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup(
            "media_source_attempts", "id", UUID(first_data["source_attempt_id"])
        )
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        assert first_data["idempotency_outcome"] == "created"
        assert first_data["source_type"] == "x_author_thread"
        assert first_data["processing_status"] == "pending"
        assert first_data["ingest_enqueued"] is True

        first_result = _run_source_attempt_for_media(direct_db, media_id)
        _register_x_provider_event_cleanup(direct_db, "author-thread:10:2222222222")
        assert first_result["media_id"] == str(media_id)
        with direct_db.session() as session:
            quoted_media = session.execute(
                text("""
                    SELECT id
                    FROM media
                    WHERE provider = 'x'
                      AND provider_id = 'post:4444444444'
                """)
            ).fetchone()
            if quoted_media is not None:
                direct_db.register_cleanup(
                    "default_library_intrinsics", "media_id", quoted_media[0]
                )
                direct_db.register_cleanup("library_entries", "media_id", quoted_media[0])
                direct_db.register_cleanup("media", "id", quoted_media[0])
            cleanup_media_ids = [str(media_id)]
            if quoted_media is not None:
                cleanup_media_ids.append(str(quoted_media[0]))
            for job_id in session.execute(
                text("""
                    SELECT id
                    FROM background_jobs
                    WHERE payload->>'media_id' = ANY(:media_ids)
                """),
                {"media_ids": cleanup_media_ids},
            ).scalars():
                direct_db.register_cleanup("background_jobs", "id", job_id)

        second_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://mobile.twitter.com/ada/statuses/2222222222?ref=copy"},
            headers=auth_headers(user_b),
        )
        assert second_response.status_code == 202
        second_data = second_response.json()["data"]
        direct_db.register_cleanup(
            "media_source_attempts", "id", UUID(second_data["source_attempt_id"])
        )

        assert second_data["idempotency_outcome"] == "reused"
        assert UUID(second_data["media_id"]) == media_id
        assert second_data["source_type"] == "x_author_thread"
        assert second_data["ingest_enqueued"] is False
        assert root_route.call_count == 1
        assert search_route.call_count == 1

        with direct_db.session() as session:
            attachments = session.execute(
                text("""
                    SELECT library_id
                    FROM library_entries
                    WHERE media_id = :media_id
                """),
                {"media_id": media_id},
            ).fetchall()

        attached_library_ids = {row[0] for row in attachments}
        assert default_library_a in attached_library_ids
        assert default_library_b in attached_library_ids

    def test_x_api_failure_does_not_fall_back_to_generic_article(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        _patch_x_api_settings(monkeypatch)
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        _expect_x_author_thread(remote_http, "3333333333", status=404)

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/3333333333"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        source_attempt_id = UUID(data["source_attempt_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        assert data["source_type"] == "x_author_thread"
        assert data["processing_status"] == "pending"
        assert data["ingest_enqueued"] is True

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "failed"
        assert result["error_code"] == "E_X_POST_UNAVAILABLE"

        with direct_db.session() as session:
            media = session.execute(
                text("""
                    SELECT processing_status, last_error_code
                    FROM media
                    WHERE id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()
            attempt = session.execute(
                text("""
                    SELECT status, error_code
                    FROM media_source_attempts
                    WHERE id = :source_attempt_id
                """),
                {"source_attempt_id": source_attempt_id},
            ).fetchone()
            provider_event = session.execute(
                text("""
                    SELECT id, provider, capability, operation, status, api_error_code,
                           provider_status_code, target_ref, source_attempt_id
                    FROM external_provider_events
                    WHERE provider = 'x'
                      AND target_ref = '3333333333'
                    ORDER BY created_at DESC
                    LIMIT 1
                """)
            ).fetchone()
            job_count = session.execute(
                text("""
                    SELECT COUNT(*)
                    FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'actor_user_id' = :user_id
                """),
                {"user_id": str(user_id)},
            ).scalar_one()

        assert media is not None
        assert media[0] == "failed"
        assert media[1] == "E_X_POST_UNAVAILABLE"
        assert attempt is not None
        assert attempt[0] == "failed"
        assert attempt[1] == "E_X_POST_UNAVAILABLE"
        assert job_count == 1
        assert provider_event is not None
        direct_db.register_cleanup("external_provider_events", "id", provider_event[0])
        assert provider_event[1:] == (
            "x",
            "author-thread",
            "lookup_post",
            "failure",
            "E_X_POST_UNAVAILABLE",
            404,
            "3333333333",
            source_attempt_id,
        )

    def test_readding_failed_x_post_reuses_saved_failed_item(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        _patch_x_api_settings(monkeypatch)
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        root_route, search_route = _expect_x_author_thread(remote_http, "9999991111", status=404)

        first_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/9999991111"},
            headers=auth_headers(user_id),
        )
        assert first_response.status_code == 202
        first_data = first_response.json()["data"]
        media_id = UUID(first_data["media_id"])
        first_attempt_id = UUID(first_data["source_attempt_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", first_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "failed"
        assert result["error_code"] == ApiErrorCode.E_X_POST_UNAVAILABLE.value
        _register_x_provider_event_cleanup(direct_db, "9999991111")

        second_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://twitter.com/ada/statuses/9999991111?ref=copy"},
            headers=auth_headers(user_id),
        )
        assert second_response.status_code == 202
        second_data = second_response.json()["data"]
        second_attempt_id = UUID(second_data["source_attempt_id"])
        direct_db.register_cleanup("media_source_attempts", "id", second_attempt_id)

        assert UUID(second_data["media_id"]) == media_id
        assert second_data["idempotency_outcome"] == "reused"
        assert second_data["source_attempt_status"] == "failed"
        assert second_data["processing_status"] == "failed"
        assert second_data["ingest_enqueued"] is False
        assert root_route.call_count == 1
        assert search_route.call_count == 0

        with direct_db.session() as session:
            media_count = session.execute(
                text("""
                    SELECT COUNT(DISTINCT m.id)
                    FROM media m
                    JOIN media_source_attempts msa ON msa.media_id = m.id
                    WHERE msa.source_type = 'x_author_thread'
                      AND msa.provider_target_ref = '9999991111'
                """)
            ).scalar_one()
            latest_attempt = session.execute(
                text("""
                    SELECT status, error_code
                    FROM media_source_attempts
                    WHERE id = :source_attempt_id
                """),
                {"source_attempt_id": second_attempt_id},
            ).one()

        assert media_count == 1
        assert tuple(latest_attempt) == (
            "failed",
            ApiErrorCode.E_X_POST_UNAVAILABLE.value,
        )

    def test_readding_pending_x_post_reuses_in_flight_item_without_new_job(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        _patch_x_api_settings(monkeypatch)
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        root_route, search_route = _expect_x_author_thread(remote_http, "9999992222")

        first_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/9999992222"},
            headers=auth_headers(user_id),
        )
        assert first_response.status_code == 202
        first_data = first_response.json()["data"]
        media_id = UUID(first_data["media_id"])
        first_attempt_id = UUID(first_data["source_attempt_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", first_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        second_response = auth_client.post(
            "/media/from_url",
            json={"url": "https://mobile.twitter.com/ada/status/9999992222"},
            headers=auth_headers(user_id),
        )
        assert second_response.status_code == 202
        second_data = second_response.json()["data"]
        second_attempt_id = UUID(second_data["source_attempt_id"])
        direct_db.register_cleanup("media_source_attempts", "id", second_attempt_id)

        assert UUID(second_data["media_id"]) == media_id
        assert second_data["idempotency_outcome"] == "reused"
        assert second_data["processing_status"] == "pending"
        assert second_data["ingest_enqueued"] is False
        assert root_route.call_count == 0
        assert search_route.call_count == 0

        with direct_db.session() as session:
            job_count = session.execute(
                text("""
                    SELECT COUNT(*)
                    FROM background_jobs
                    WHERE kind = 'ingest_media_source'
                      AND payload->>'media_id' = :media_id
                """),
                {"media_id": str(media_id)},
            ).scalar_one()
            media_count = session.execute(
                text("""
                    SELECT COUNT(DISTINCT m.id)
                    FROM media m
                    JOIN media_source_attempts msa ON msa.media_id = m.id
                    WHERE msa.source_type = 'x_author_thread'
                      AND msa.provider_target_ref = '9999992222'
                """)
            ).scalar_one()

        assert job_count == 1
        assert media_count == 1

    def test_x_source_retry_can_materialize_after_saved_failure(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        _patch_x_api_settings(monkeypatch)
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        root_route = remote_http.get("https://api.x.com/2/tweets/9999993333").mock(
            side_effect=[
                httpx.Response(404, json={}),
                httpx.Response(200, json=_x_root_payload("9999993333", quoted_id="4444444444")),
            ]
        )
        search_route = remote_http.get("https://api.x.com/2/tweets/search/all").mock(
            return_value=httpx.Response(200, json=_x_search_payload("9999993333"))
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/9999993333"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        source_attempt_id = UUID(data["source_attempt_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        first_result = _run_source_attempt_for_media(direct_db, media_id)
        assert first_result["status"] == "failed"
        assert first_result["error_code"] == ApiErrorCode.E_X_POST_UNAVAILABLE.value

        retry_response = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )
        assert retry_response.status_code == 202
        retry_data = retry_response.json()["data"]
        retry_attempt_id = UUID(retry_data["source_attempt_id"])
        direct_db.register_cleanup("media_source_attempts", "id", retry_attempt_id)
        assert retry_data["source_attempt_status"] == "queued"
        assert retry_data["processing_status"] == "extracting"
        assert retry_data["ingest_enqueued"] is True

        retry_result = _run_source_attempt_for_media(direct_db, media_id)
        assert retry_result["media_id"] == str(media_id)
        assert retry_result["processing_status"] == "ready_for_reading"
        assert root_route.call_count == 2
        assert search_route.call_count == 1
        _register_x_provider_event_cleanup(
            direct_db,
            "9999993333",
            "author-thread:10:9999993333",
        )

        with direct_db.session() as session:
            media = session.execute(
                text("""
                    SELECT processing_status, provider, provider_id
                    FROM media
                    WHERE id = :media_id
                """),
                {"media_id": media_id},
            ).one()
            quoted_media = session.execute(
                text("""
                    SELECT id
                    FROM media
                    WHERE provider = 'x'
                      AND provider_id = 'post:4444444444'
                """)
            ).fetchone()
            if quoted_media is not None:
                direct_db.register_cleanup(
                    "default_library_intrinsics", "media_id", quoted_media[0]
                )
                direct_db.register_cleanup("library_entries", "media_id", quoted_media[0])
                direct_db.register_cleanup("media", "id", quoted_media[0])

        assert tuple(media) == (
            "ready_for_reading",
            "x",
            "author-thread:10:9999993333",
        )

    def test_x_provider_call_starts_after_media_is_extracting(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        from nexus.services.x_types import XProviderError, XProviderErrorCode

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/6666666666"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        source_attempt_id = UUID(data["source_attempt_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        observed: dict[str, tuple[object, ...]] = {}

        def _assert_provider_boundary(post_id: str):
            assert post_id == "6666666666"
            with direct_db.session() as session:
                observed["media"] = session.execute(
                    text("""
                        SELECT processing_status, processing_attempts, processing_completed_at
                        FROM media
                        WHERE id = :media_id
                    """),
                    {"media_id": media_id},
                ).one()
                observed["attempt"] = session.execute(
                    text("""
                        SELECT status, run_count
                        FROM media_source_attempts
                        WHERE id = :source_attempt_id
                    """),
                    {"source_attempt_id": source_attempt_id},
                ).one()
            raise XProviderError(
                XProviderErrorCode.UNAVAILABLE,
                "forced provider failure",
                operation="lookup_post",
                provider_status_code=503,
            )

        monkeypatch.setattr(
            "nexus.services.x_ingest.fetch_author_thread_snapshot",
            _assert_provider_boundary,
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "failed"
        assert result["error_code"] == ApiErrorCode.E_X_PROVIDER_UNAVAILABLE.value
        _register_x_provider_event_cleanup(direct_db, "6666666666")

        assert observed["media"] == ("extracting", 1, None)
        assert observed["attempt"] == ("running", 1)

    def test_x_rate_limit_persists_retry_after_on_source_attempt(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        from nexus.services.x_types import XProviderError, XProviderErrorCode

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/7777777777"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        source_attempt_id = UUID(data["source_attempt_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        def _rate_limited(post_id: str):
            assert post_id == "7777777777"
            raise XProviderError(
                XProviderErrorCode.RATE_LIMITED,
                "provider rate limited",
                operation="lookup_post",
                provider_status_code=429,
                retry_after_seconds=7,
            )

        monkeypatch.setattr(
            "nexus.services.x_ingest.fetch_author_thread_snapshot",
            _rate_limited,
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "failed"
        assert result["error_code"] == ApiErrorCode.E_X_PROVIDER_RATE_LIMITED.value

        with direct_db.session() as session:
            attempt = session.execute(
                text("""
                    SELECT status, error_code, retry_after_seconds
                    FROM media_source_attempts
                    WHERE id = :source_attempt_id
                """),
                {"source_attempt_id": source_attempt_id},
            ).one()
            provider_event = session.execute(
                text("""
                    SELECT id, retry_after_seconds
                    FROM external_provider_events
                    WHERE provider = 'x'
                      AND target_ref = '7777777777'
                    ORDER BY created_at DESC
                    LIMIT 1
                """)
            ).one()
        direct_db.register_cleanup("external_provider_events", "id", provider_event[0])
        assert tuple(attempt) == ("failed", "E_X_PROVIDER_RATE_LIMITED", 7)
        assert provider_event[1] == 7

    def test_x_timeout_creates_failed_retryable_source_item(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        from nexus.services.x_types import XProviderError, XProviderErrorCode

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/8888888888"},
            headers=auth_headers(user_id),
        )
        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        source_attempt_id = UUID(data["source_attempt_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        def _timed_out(post_id: str):
            assert post_id == "8888888888"
            raise XProviderError(
                XProviderErrorCode.TIMEOUT,
                "provider timed out",
                operation="lookup_post",
            )

        monkeypatch.setattr(
            "nexus.services.x_ingest.fetch_author_thread_snapshot",
            _timed_out,
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "failed"
        assert result["error_code"] == ApiErrorCode.E_X_PROVIDER_TIMEOUT.value

        media_response = auth_client.get(f"/media/{media_id}", headers=auth_headers(user_id))
        assert media_response.status_code == 200
        media_data = media_response.json()["data"]
        assert media_data["processing_status"] == "failed"
        assert media_data["last_error_code"] == ApiErrorCode.E_X_PROVIDER_TIMEOUT.value
        assert media_data["capabilities"]["can_retry"] is True

        with direct_db.session() as session:
            attempt = session.execute(
                text("""
                    SELECT status, error_code
                    FROM media_source_attempts
                    WHERE id = :source_attempt_id
                """),
                {"source_attempt_id": source_attempt_id},
            ).one()
            provider_event = session.execute(
                text("""
                    SELECT id, api_error_code, target_ref, source_attempt_id
                    FROM external_provider_events
                    WHERE provider = 'x'
                      AND target_ref = '8888888888'
                    ORDER BY created_at DESC
                    LIMIT 1
                """)
            ).one()

        direct_db.register_cleanup("external_provider_events", "id", provider_event[0])
        assert tuple(attempt) == ("failed", ApiErrorCode.E_X_PROVIDER_TIMEOUT.value)
        assert provider_event[1:] == (
            ApiErrorCode.E_X_PROVIDER_TIMEOUT.value,
            "8888888888",
            source_attempt_id,
        )

    def test_x_credits_depleted_records_provider_event(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        _patch_x_api_settings(monkeypatch)
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        remote_http.get("https://api.x.com/2/tweets/4444444444").mock(
            return_value=httpx.Response(
                402,
                json={"title": "CreditsDepleted", "detail": "account has no credits"},
            )
        )

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/ada/status/4444444444"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        source_attempt_id = UUID(data["source_attempt_id"])
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)

        assert data["source_type"] == "x_author_thread"
        assert data["processing_status"] == "pending"
        assert data["ingest_enqueued"] is True

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "failed"
        assert result["error_code"] == "E_X_PROVIDER_CREDITS_DEPLETED"

        with direct_db.session() as session:
            media = session.execute(
                text("""
                    SELECT processing_status, last_error_code
                    FROM media
                    WHERE id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()
            attempt = session.execute(
                text("""
                    SELECT status, error_code
                    FROM media_source_attempts
                    WHERE id = :source_attempt_id
                """),
                {"source_attempt_id": source_attempt_id},
            ).fetchone()
            provider_event = session.execute(
                text("""
                    SELECT id, status, api_error_code, provider_status_code,
                           provider_error_title, target_ref, source_attempt_id
                    FROM external_provider_events
                    WHERE provider = 'x'
                      AND target_ref = '4444444444'
                    ORDER BY created_at DESC
                    LIMIT 1
                """)
            ).fetchone()

        assert media is not None
        assert media[0] == "failed"
        assert media[1] == "E_X_PROVIDER_CREDITS_DEPLETED"
        assert attempt is not None
        assert attempt[0] == "failed"
        assert attempt[1] == "E_X_PROVIDER_CREDITS_DEPLETED"
        assert provider_event is not None
        direct_db.register_cleanup("external_provider_events", "id", provider_event[0])
        assert provider_event[1:] == (
            "failure",
            "E_X_PROVIDER_CREDITS_DEPLETED",
            402,
            "CreditsDepleted",
            "4444444444",
            source_attempt_id,
        )

    def test_refresh_existing_x_post_upgrades_to_author_thread_snapshot(
        self, auth_client, direct_db: DirectSessionManager, remote_http, monkeypatch
    ):
        _patch_x_api_settings(monkeypatch)
        user_id = create_test_user_id()
        default_library_id = UUID(
            auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
                "default_library_id"
            ]
        )
        media_id = uuid4()
        source_attempt_id = uuid4()
        _expect_x_author_thread(remote_http, "5555555555")

        with direct_db.session() as session:
            session.execute(
                text("""
                    INSERT INTO media (
                        id, kind, title, requested_url, canonical_url,
                        canonical_source_url, provider, provider_id,
                        processing_status, publisher, description,
                        created_by_user_id, created_at, updated_at,
                        processing_completed_at
                    )
                    VALUES (
                        :media_id, 'web_article', 'Old X post',
                        'https://x.com/ada/status/5555555555',
                        'https://x.com/i/status/5555555555',
                        'https://x.com/i/status/5555555555',
                        'x', '5555555555', 'ready_for_reading',
                        'X', 'Old single-post capture', :user_id,
                        now(), now(), now()
                    )
                """),
                {"media_id": media_id, "user_id": user_id},
            )
            fragment_id = session.execute(
                text("""
                    INSERT INTO fragments (media_id, idx, html_sanitized, canonical_text)
                    VALUES (
                        :media_id, 0,
                        '<article>Old single tweet</article>',
                        'Old single tweet'
                    )
                    RETURNING id
                """),
                {"media_id": media_id},
            ).scalar_one()
            session.execute(
                text("""
                    INSERT INTO fragment_blocks (fragment_id, block_idx, start_offset, end_offset)
                    VALUES (:fragment_id, 0, 0, 16)
                """),
                {"fragment_id": fragment_id},
            )
            session.execute(
                text("""
                    INSERT INTO default_library_intrinsics (default_library_id, media_id)
                    VALUES (:default_library_id, :media_id)
                """),
                {"default_library_id": default_library_id, "media_id": media_id},
            )
            session.execute(
                text("""
                    INSERT INTO media_source_attempts (
                        id, media_id, created_by_user_id, source_type, attempt_no,
                        status, intent_key, requested_url, canonical_source_url,
                        provider, provider_target_ref, source_payload, finished_at
                    )
                    VALUES (
                        :source_attempt_id, :media_id, :user_id,
                        'x_author_thread', 1, 'succeeded',
                        'x_author_thread:https://x.com/ada/status/5555555555',
                        'https://x.com/ada/status/5555555555',
                        'https://x.com/i/status/5555555555',
                        'x', '5555555555',
                        '{"post_id": "5555555555"}'::jsonb,
                        now()
                    )
                """),
                {
                    "source_attempt_id": source_attempt_id,
                    "media_id": media_id,
                    "user_id": user_id,
                },
            )
            session.commit()

        direct_db.register_cleanup("media_source_attempts", "id", source_attempt_id)
        direct_db.register_cleanup("default_library_intrinsics", "media_id", media_id)
        direct_db.register_cleanup("library_entries", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(
            f"/media/{media_id}/refresh",
            headers={**auth_headers(user_id), "Idempotency-Key": "x-refresh-key-1"},
        )
        _register_x_provider_event_cleanup(direct_db, "author-thread:10:5555555555")

        assert response.status_code == 202, response.text
        data = response.json()["data"]
        assert UUID(data["media_id"]) == media_id
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True
        assert data["idempotency_outcome"] == "refreshed"

        replay = auth_client.post(
            f"/media/{media_id}/refresh",
            headers={**auth_headers(user_id), "Idempotency-Key": "x-refresh-key-1"},
        )
        assert replay.status_code == 202, replay.text
        replay_data = replay.json()["data"]
        assert replay_data["source_attempt_id"] == data["source_attempt_id"]
        assert replay_data["idempotency_outcome"] == "reused"
        assert replay_data["processing_status"] == "extracting"

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["processing_status"] == "ready_for_reading"

        with direct_db.session() as session:
            media = session.execute(
                text("""
                    SELECT title, canonical_url, canonical_source_url, provider,
                           provider_id, processing_status, publisher, description
                    FROM media
                    WHERE id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()
            fragments = session.execute(
                text("""
                    SELECT idx, canonical_text
                    FROM fragments
                    WHERE media_id = :media_id
                    ORDER BY idx ASC
                """),
                {"media_id": media_id},
            ).fetchall()
            quoted_media = session.execute(
                text("""
                    SELECT id, provider_id, title
                    FROM media
                    WHERE provider = 'x'
                      AND provider_id = 'post:4444444444'
                """)
            ).fetchone()
            media_ids = [str(media_id)]
            if quoted_media is not None:
                media_ids.append(str(quoted_media[0]))
            job_ids = [
                row[0]
                for row in session.execute(
                    text("""
                        SELECT id
                        FROM background_jobs
                        WHERE payload->>'media_id' = ANY(:media_ids)
                    """),
                    {"media_ids": media_ids},
                ).fetchall()
            ]

        assert media is not None
        assert media[0] == "X thread by Ada Lovelace"
        assert media[1] is None
        assert media[2] == "https://x.com/i/status/5555555555"
        assert media[3] == "x"
        assert media[4] == "author-thread:10:5555555555"
        assert media[5] == "ready_for_reading"
        assert media[6] == "X"
        assert "Opening post from Ada." in media[7]
        assert len(fragments) == 2
        combined_text = "\n".join(row[1] for row in fragments)
        assert "Old single tweet" not in combined_text
        assert "Opening post from Ada." in combined_text
        assert "Second post in the author's thread." in combined_text
        assert "Quoted post by Grace Hopper" in combined_text
        assert "Side reply from Ada" not in combined_text
        assert quoted_media is not None
        direct_db.register_cleanup("default_library_intrinsics", "media_id", quoted_media[0])
        direct_db.register_cleanup("library_entries", "media_id", quoted_media[0])
        direct_db.register_cleanup("media", "id", quoted_media[0])
        assert quoted_media[1] == "post:4444444444"
        assert quoted_media[2] == "X post by Grace Hopper"
        for job_id in job_ids:
            direct_db.register_cleanup("background_jobs", "id", job_id)

    def test_x_url_without_post_id_is_rejected(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        response = auth_client.post(
            "/media/from_url",
            json={"url": "https://x.com/home"},
            headers=auth_headers(user_id),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_INVALID_REQUEST"


class TestBrowserArticleCapture:
    def test_no_readable_text_after_acceptance_saves_failed_source_item(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        from nexus.services.media_source_ingest import accept_browser_article_capture

        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())

        with direct_db.session() as session:
            result = accept_browser_article_capture(
                db=session,
                viewer_id=user_id,
                url="https://example.com/empty-capture",
                title="Empty Capture",
                content_html=(
                    "<html><head><title>Empty Capture</title>"
                    "<style>body{display:none}</style></head>"
                    "<body><script>window.__nexus=1</script></body></html>"
                ),
                source_html=(
                    "<html><head><title>Empty Capture</title>"
                    "<style>body{display:none}</style></head>"
                    "<body><script>window.__nexus=1</script></body></html>"
                ),
                library_ids=[],
                request_id="test-empty-browser-article",
                idempotency_key=None,
            )

        media_id = result.media_id
        _register_source_media_cleanup(
            direct_db,
            media_id,
            source_attempt_id=result.source_attempt_id,
        )

        assert result.source_type == "browser_article_capture"
        assert result.source_attempt_status == "queued"
        assert result.processing_status == "pending"
        assert result.ingest_enqueued is True

        run_result = _run_source_attempt_for_media(direct_db, media_id)
        assert run_result["status"] == "failed"
        assert run_result["error_code"] == ApiErrorCode.E_INVALID_REQUEST.value
        _assert_latest_source_failure(direct_db, media_id, ApiErrorCode.E_INVALID_REQUEST)


class TestBrowserFileCapture:
    def test_invalid_magic_bytes_save_failed_source_item(
        self,
        auth_client,
        direct_db: DirectSessionManager,
    ):
        from nexus.services.media_source_ingest import accept_browser_file_capture

        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)

        with direct_db.session() as session:
            result = accept_browser_file_capture(
                db=session,
                viewer_id=user_id,
                payload=b"not a pdf",
                filename="captured.pdf",
                content_type="application/pdf",
                library_ids=[],
                source_url="https://example.com/captured.pdf",
                request_id="test-invalid-browser-file",
                idempotency_key=None,
            )

        media_id = result.media_id
        _register_source_media_cleanup(
            direct_db,
            media_id,
            source_attempt_id=result.source_attempt_id,
        )

        assert result.source_type == "browser_pdf_capture"
        assert result.source_attempt_status == "failed"
        assert result.processing_status == "failed"
        assert result.ingest_enqueued is False

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.processing_status, m.failure_stage, m.last_error_code,
                           mf.media_id, msa.status, msa.error_code
                    FROM media m
                    JOIN media_source_attempts msa ON msa.media_id = m.id
                    LEFT JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.id = :media_id
                """),
                {"media_id": media_id},
            ).one()

        assert row == (
            "failed",
            "upload",
            ApiErrorCode.E_INVALID_FILE_TYPE.value,
            None,
            "failed",
            ApiErrorCode.E_INVALID_FILE_TYPE.value,
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
        _patch_file_extractors_success(monkeypatch, direct_db)

        url = "http://example.com/report.pdf"
        _expect_remote_file(remote_http, url, PDF_CONTENT, content_type="application/pdf")

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_pdf_url",
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.kind, m.title, m.requested_url, m.canonical_source_url,
                           m.processing_status, mf.content_type, mf.size_bytes, msa.status
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    JOIN media_source_attempts msa ON msa.media_id = m.id
                    WHERE m.id = :media_id
                    ORDER BY msa.attempt_no DESC
                    LIMIT 1
                """),
                {"media_id": media_id},
            ).fetchone()

        assert row is not None
        assert row[0] == "pdf"
        assert row[1] == "report.pdf"
        assert row[2] == url
        assert row[3] == url
        assert row[4] == "ready_for_reading"
        assert row[5] == "application/pdf"
        assert row[6] == len(PDF_CONTENT)
        assert row[7] == "succeeded"
        assert storage.get_object(build_storage_path(media_id, "pdf")) == PDF_CONTENT

    def test_arxiv_pdf_endpoint_is_remote_pdf_not_generic_web_article(
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
        url = "https://arxiv.org/pdf/1706.03762"
        source_url = "https://arxiv.org/e-print/1706.03762"
        source_bytes = (
            Path(__file__).parent / "fixtures/reader_apparatus/arxiv/2606.01109-source.tar"
        ).read_bytes()
        _patch_remote_file_limits(
            monkeypatch, limit_bytes=max(len(source_bytes), len(PDF_CONTENT)) + 1024
        )
        _patch_file_extractors_success(monkeypatch, direct_db)

        _expect_remote_file(remote_http, url, PDF_CONTENT, content_type="application/pdf")
        _expect_remote_file(
            remote_http,
            source_url,
            source_bytes,
            content_type="application/e-print",
        )

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_pdf_url",
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.kind, m.requested_url, m.canonical_source_url,
                           m.processing_status, mf.content_type, msa.id, msa.source_payload
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    JOIN media_source_attempts msa ON msa.media_id = m.id
                    WHERE m.id = :media_id
                    ORDER BY msa.attempt_no DESC
                    LIMIT 1
                """),
                {"media_id": media_id},
            ).fetchone()

        assert row is not None
        assert row[0] == "pdf"
        assert row[1] == url
        assert row[2] == url
        assert row[3] == "ready_for_reading"
        assert row[4] == "application/pdf"
        source_payload = row[6]
        source_package = source_payload["arxiv_source_package"]
        assert source_package["status"] == "fetched"
        assert source_package["arxiv_id"] == "1706.03762"
        assert source_package["source_url"] == source_url
        assert source_package["storage_path"] == build_source_artifact_storage_path(
            media_id,
            row[5],
            "tar",
        )
        assert source_package["content_type"] == "application/x-tar"
        assert source_package["size_bytes"] == len(source_bytes)
        assert source_package["sha256_hex"] == hashlib.sha256(source_bytes).hexdigest()
        assert storage.get_object(build_storage_path(media_id, "pdf")) == PDF_CONTENT
        assert storage.get_object(source_package["storage_path"]) == source_bytes

    def test_arxiv_pdf_hard_delete_removes_pdf_and_source_package_storage(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        default_id = auth_client.get("/me", headers=auth_headers(user_id)).json()["data"][
            "default_library_id"
        ]

        storage = _TrackingStorageClient()
        _patch_remote_storage(monkeypatch, storage)
        monkeypatch.setattr("nexus.services.media_deletion.get_storage_client", lambda: storage)
        url = "https://arxiv.org/pdf/1706.03762"
        source_url = "https://arxiv.org/e-print/1706.03762"
        source_bytes = (
            Path(__file__).parent / "fixtures/reader_apparatus/arxiv/2606.01109-source.tar"
        ).read_bytes()
        _patch_remote_file_limits(
            monkeypatch, limit_bytes=max(len(source_bytes), len(PDF_CONTENT)) + 1024
        )
        _patch_file_extractors_success(monkeypatch, direct_db)

        _expect_remote_file(remote_http, url, PDF_CONTENT, content_type="application/pdf")
        _expect_remote_file(
            remote_http,
            source_url,
            source_bytes,
            content_type="application/e-print",
        )

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_pdf_url",
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        with direct_db.session() as session:
            source_package_path = session.execute(
                text("""
                    SELECT source_payload->'arxiv_source_package'->>'storage_path'
                    FROM media_source_attempts
                    WHERE media_id = :media_id
                    ORDER BY attempt_no DESC
                    LIMIT 1
                """),
                {"media_id": media_id},
            ).scalar_one()

        delete_response = auth_client.delete(f"/media/{media_id}", headers=auth_headers(user_id))

        assert delete_response.status_code == 200, delete_response.text
        assert delete_response.json()["data"] == {
            "status": "deleted",
            "hard_deleted": True,
            "removed_from_library_ids": [default_id],
            "hidden_for_viewer": False,
            "remaining_reference_count": 0,
        }
        assert storage.get_object(build_storage_path(media_id, "pdf")) is None
        assert storage.get_object(source_package_path) is None
        assert set(storage.deleted_paths) == {
            build_storage_path(media_id, "pdf"),
            source_package_path,
        }
        with direct_db.session() as session:
            counts = session.execute(
                text("""
                    SELECT
                        (SELECT count(*) FROM media WHERE id = :media_id),
                        (SELECT count(*) FROM media_file WHERE media_id = :media_id),
                        (SELECT count(*) FROM media_source_attempts WHERE media_id = :media_id),
                        (SELECT count(*) FROM reader_apparatus_items WHERE media_id = :media_id),
                        (SELECT count(*) FROM reader_apparatus_edges WHERE media_id = :media_id)
                """),
                {"media_id": media_id},
            ).one()
        assert counts == (0, 0, 0, 0, 0)

    def test_arxiv_pdf_retry_does_not_clone_previous_source_package_artifact(
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
        url = "https://arxiv.org/pdf/1706.03762"
        source_url = "https://arxiv.org/e-print/1706.03762"
        source_bytes = (
            Path(__file__).parent / "fixtures/reader_apparatus/arxiv/2606.01109-source.tar"
        ).read_bytes()
        _patch_remote_file_limits(
            monkeypatch, limit_bytes=max(len(source_bytes), len(PDF_CONTENT)) + 1024
        )
        _patch_file_extractors_success(monkeypatch, direct_db)

        _expect_remote_file(remote_http, url, PDF_CONTENT, content_type="application/pdf")
        _expect_remote_file(
            remote_http,
            source_url,
            source_bytes,
            content_type="application/e-print",
        )

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_pdf_url",
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        with direct_db.session() as session:
            previous_attempt = session.execute(
                text("""
                    SELECT id, source_payload
                    FROM media_source_attempts
                    WHERE media_id = :media_id
                    ORDER BY attempt_no DESC
                    LIMIT 1
                """),
                {"media_id": media_id},
            ).one()
            assert "arxiv_source_package" in previous_attempt.source_payload
            session.execute(
                text("""
                    UPDATE media
                    SET processing_status = 'failed',
                        failure_stage = 'extract',
                        last_error_code = 'E_INGEST_FAILED',
                        last_error_message = 'retry test'
                    WHERE id = :media_id
                """),
                {"media_id": media_id},
            )
            session.execute(
                text("""
                    UPDATE media_source_attempts
                    SET status = 'failed',
                        error_code = 'E_INGEST_FAILED',
                        error_message = 'retry test'
                    WHERE id = :attempt_id
                """),
                {"attempt_id": previous_attempt.id},
            )
            session.commit()

        retry_response = auth_client.post(
            f"/media/{media_id}/retry",
            json={"from_stage": "source"},
            headers=auth_headers(user_id),
        )
        assert retry_response.status_code == 202, retry_response.text
        retry_attempt_id = UUID(retry_response.json()["data"]["source_attempt_id"])
        direct_db.register_cleanup("media_source_attempts", "id", retry_attempt_id)
        _register_background_jobs_for_media(direct_db, media_id)

        with direct_db.session() as session:
            retry_payload = session.execute(
                text("""
                    SELECT source_payload
                    FROM media_source_attempts
                    WHERE id = :attempt_id
                """),
                {"attempt_id": retry_attempt_id},
            ).scalar_one()

        assert retry_payload["remote_kind"] == "pdf"
        assert retry_payload["kind"] == "pdf"
        assert retry_payload["url"] == url
        assert "arxiv_source_package" not in retry_payload

    def test_arxiv_pdf_from_url_persists_source_package_apparatus_api(
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
        url = "https://arxiv.org/pdf/2606.01109"
        source_url = "https://arxiv.org/e-print/2606.01109"
        pdf_bytes = _valid_pdf_content("arXiv source-package apparatus API smoke")
        source_bytes = (
            Path(__file__).parent / "fixtures/reader_apparatus/arxiv/2606.01109-source.tar"
        ).read_bytes()
        _patch_remote_file_limits(
            monkeypatch,
            limit_bytes=max(len(source_bytes), len(pdf_bytes)) + 1024,
        )

        _expect_remote_file(remote_http, url, pdf_bytes, content_type="application/pdf")
        _expect_remote_file(
            remote_http,
            source_url,
            source_bytes,
            content_type="application/e-print",
        )

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_pdf_url",
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        response = auth_client.get(
            f"/media/{media_id}/document-map",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        data = response.json()["data"]["apparatus"]
        assert data["media_kind"] == "pdf"
        assert data["status"] == "ready"
        assert data["capabilities"]["has_sidecar_items"] is True
        assert data["capabilities"]["has_inline_markers"] is False
        assert data["capabilities"]["supports_jump_to_marker"] is False
        assert data["capabilities"]["supports_jump_to_target"] is False
        assert Counter(item["kind"] for item in data["items"]) == {
            "bibliography_entry": 17,
            "bibliography_ref": 15,
            "footnote": 1,
        }
        assert Counter(item["extraction_method"] for item in data["items"]) == {
            "latex_biblatex_bibliography": 17,
            "latex_biblatex_citation": 15,
            "latex_footnote": 1,
        }
        assert len(data["items"]) == 33
        assert len(data["edges"]) == 20
        assert {item["locator_status"] for item in data["items"]} == {"missing"}
        assert {item["locator"] for item in data["items"]} == {None}
        assert {item["source_ref"]["format"] for item in data["items"]} == {"arxiv_source"}
        assert {item["source_ref"]["arxiv_id"] for item in data["items"]} == {"2606.01109"}
        assert {item["source_ref"]["sha256_hex"] for item in data["items"]} == {
            hashlib.sha256(source_bytes).hexdigest()
        }
        assert {edge["relation"] for edge in data["edges"]} == {"cites_bibliography_entry"}
        assert data["diagnostics"]["arxiv_source_package"]["status"] == "fetched"
        assert data["diagnostics"]["arxiv_source_package"]["source_url"] == source_url
        assert (
            data["diagnostics"]["arxiv_source_package"]["sha256_hex"]
            == hashlib.sha256(source_bytes).hexdigest()
        )
        assert data["diagnostics"]["latex_biblatex"] == {
            "status": "ready",
            "citation_marker_count": 15,
            "citation_edge_count": 20,
            "cited_bibliography_entry_count": 17,
            "bib_entry_count": 22,
            "uncited_bib_entry_count": 5,
            "footnote_count": 1,
            "missing_citation_keys": [],
        }
        assert storage.get_object(build_storage_path(media_id, "pdf")) == pdf_bytes

    def test_arxiv_pdf_from_url_rejects_unsafe_source_package_but_completes_pdf_ingest(
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
        url = "https://arxiv.org/pdf/2606.01109"
        source_url = "https://arxiv.org/e-print/2606.01109"
        pdf_bytes = _valid_pdf_content("Unsafe arXiv source-package apparatus API smoke")
        source_bytes = _tar_bytes([("../main.tex", b"\\begin{document}\\cite{a}\\end{document}")])
        _patch_remote_file_limits(
            monkeypatch,
            limit_bytes=max(len(source_bytes), len(pdf_bytes)) + 1024,
        )

        _expect_remote_file(remote_http, url, pdf_bytes, content_type="application/pdf")
        _expect_remote_file(
            remote_http,
            source_url,
            source_bytes,
            content_type="application/e-print",
        )

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_pdf_url",
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.processing_status, msa.status, msa.id
                    FROM media m
                    JOIN media_source_attempts msa ON msa.media_id = m.id
                    WHERE m.id = :media_id
                    ORDER BY msa.attempt_no DESC
                    LIMIT 1
                """),
                {"media_id": media_id},
            ).fetchone()
        assert row is not None
        assert row[0:2] == ("ready_for_reading", "succeeded")
        assert storage.get_object(build_storage_path(media_id, "pdf")) == pdf_bytes

        response = auth_client.get(
            f"/media/{media_id}/document-map",
            headers=auth_headers(user_id),
        )

        assert response.status_code == 200, response.text
        data = response.json()["data"]["apparatus"]
        assert data["media_kind"] == "pdf"
        assert data["status"] == "empty"
        assert data["items"] == []
        assert data["edges"] == []
        assert data["capabilities"] == {
            "has_inline_markers": False,
            "has_sidecar_items": False,
            "supports_hover_preview": False,
            "supports_jump_to_marker": False,
            "supports_jump_to_target": False,
            "has_probable_items": False,
        }
        assert data["diagnostics"]["arxiv_source_package"] == {
            "status": "unsafe_archive",
            "storage_path": build_source_artifact_storage_path(
                media_id,
                row[2],
                "tar",
            ),
            "source_url": source_url,
            "reason": "path_traversal",
        }

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
        _patch_file_extractors_success(monkeypatch, direct_db)

        url = "http://example.com/book.epub"
        _expect_remote_file(remote_http, url, EPUB_CONTENT, content_type="application/epub+zip")

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_epub_url",
        )

        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.kind, m.title, m.processing_status, mf.content_type, mf.size_bytes,
                           msa.status
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    JOIN media_source_attempts msa ON msa.media_id = m.id
                    WHERE m.id = :media_id
                    ORDER BY msa.attempt_no DESC
                    LIMIT 1
                """),
                {"media_id": media_id},
            ).fetchone()

        assert row is not None
        assert row[0] == "epub"
        assert row[1] == "book.epub"
        assert row[2] == "ready_for_reading"
        assert row[3] == "application/epub+zip"
        assert row[4] == len(EPUB_CONTENT)
        assert row[5] == "succeeded"
        assert storage.get_object(build_storage_path(media_id, "epub")) == EPUB_CONTENT

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
        _patch_file_extractors_success(monkeypatch, direct_db)

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

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/old.pdf",
            expected_source_type="remote_pdf_url",
        )
        result = _run_source_attempt_for_media(direct_db, media_id)
        assert result["status"] == "success"

        with direct_db.session() as session:
            row = session.execute(
                text("""
                    SELECT m.canonical_source_url, m.processing_status, mf.size_bytes,
                           mf.content_type
                    FROM media m
                    JOIN media_file mf ON mf.media_id = m.id
                    WHERE m.id = :media_id
                """),
                {"media_id": media_id},
            ).fetchone()

        assert row is not None
        assert row[0] == "http://cdn.example.com/final.pdf"
        assert row[1] == "ready_for_reading"
        assert row[2] == len(PDF_CONTENT)
        assert row[3] == "application/pdf"

    def test_remote_redirect_to_private_ip_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_redirect(
            remote_http,
            "http://example.com/old.pdf",
            "http://private.test/final.pdf",
        )

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/old.pdf",
            expected_source_type="remote_pdf_url",
            expected_code=ApiErrorCode.E_SSRF_BLOCKED,
        )

    def test_remote_file_too_many_redirects_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
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

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/r1.pdf",
            expected_source_type="remote_pdf_url",
            expected_code=ApiErrorCode.E_INGEST_FAILED,
        )

    def test_remote_file_non_2xx_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)

        url = "http://example.com/missing.pdf"
        _expect_remote_file(remote_http, url, "Not Found", content_type="text/plain", status=404)

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_pdf_url",
            expected_code=ApiErrorCode.E_INGEST_FAILED,
        )

    def test_remote_file_timeout_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)
        monkeypatch.setattr("nexus.services.remote_file_client._TIMEOUT", httpx.Timeout(0.05))

        remote_http.get("http://example.com/slow.pdf").mock(
            side_effect=httpx.ReadTimeout("timed out")
        )

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/slow.pdf",
            expected_source_type="remote_pdf_url",
            expected_code=ApiErrorCode.E_INGEST_TIMEOUT,
        )

    def test_remote_file_invalid_magic_bytes_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_file(
            remote_http,
            "http://example.com/bad.pdf",
            b"<html><body>not a pdf</body></html>",
            content_type="application/pdf",
        )

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/bad.pdf",
            expected_source_type="remote_pdf_url",
            expected_code=ApiErrorCode.E_INVALID_FILE_TYPE,
        )

    def test_remote_file_content_length_over_limit_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_file(
            remote_http,
            "http://example.com/too-large.pdf",
            PDF_CONTENT,
            content_type="application/pdf",
            headers={"Content-Length": str(REMOTE_FILE_LIMIT_BYTES + 1)},
        )

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/too-large.pdf",
            expected_source_type="remote_pdf_url",
            expected_code=ApiErrorCode.E_FILE_TOO_LARGE,
        )

    def test_remote_file_streamed_body_over_limit_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)

        over_limit_body = b"%PDF-1.4\n" + (b"a" * (REMOTE_FILE_LIMIT_BYTES + 1))
        _expect_remote_file(
            remote_http,
            "http://example.com/stream-too-large.pdf",
            over_limit_body,
            content_type="application/pdf",
        )

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/stream-too-large.pdf",
            expected_source_type="remote_pdf_url",
            expected_code=ApiErrorCode.E_FILE_TOO_LARGE,
        )

    def test_remote_file_storage_put_failure_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
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

        media_id = _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/storage-fail.pdf",
            expected_source_type="remote_pdf_url",
            expected_code=ApiErrorCode.E_STORAGE_ERROR,
        )
        assert storage.put_paths == [build_storage_path(media_id, "pdf")]

    def test_remote_epub_not_found_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)

        url = "http://example.com/missing.epub"
        _expect_remote_file(remote_http, url, "Not Found", content_type="text/plain", status=404)

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            url,
            expected_source_type="remote_epub_url",
            expected_code=ApiErrorCode.E_INGEST_FAILED,
        )

    def test_remote_epub_timeout_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)
        monkeypatch.setattr("nexus.services.remote_file_client._TIMEOUT", httpx.Timeout(0.05))

        remote_http.get("http://example.com/slow.epub").mock(
            side_effect=httpx.ReadTimeout("timed out")
        )

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/slow.epub",
            expected_source_type="remote_epub_url",
            expected_code=ApiErrorCode.E_INGEST_TIMEOUT,
        )

    def test_remote_epub_invalid_magic_bytes_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        remote_http,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        _bootstrap_user(auth_client, user_id)
        _patch_remote_storage(monkeypatch, FakeStorageClient())
        _patch_remote_file_limits(monkeypatch)

        _expect_remote_file(
            remote_http,
            "http://example.com/bad.epub",
            b"%PDF-1.4\nnot an epub archive",
            content_type="application/epub+zip",
        )

        _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/bad.epub",
            expected_source_type="remote_epub_url",
            expected_code=ApiErrorCode.E_INVALID_FILE_TYPE,
        )

    def test_remote_epub_storage_put_failure_marks_source_failed(
        self,
        auth_client,
        direct_db: DirectSessionManager,
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
            "http://example.com/storage-fail.epub",
            EPUB_CONTENT,
            content_type="application/epub+zip",
        )

        media_id = _accept_remote_source_and_expect_worker_error(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/storage-fail.epub",
            expected_source_type="remote_epub_url",
            expected_code=ApiErrorCode.E_STORAGE_ERROR,
        )
        assert storage.put_paths == [build_storage_path(media_id, "epub")]

    def test_remote_file_db_failure_before_acceptance_does_not_fetch_or_store(
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
        route = _expect_remote_file(
            remote_http,
            "http://example.com/db-fail.pdf",
            PDF_CONTENT,
            content_type="application/pdf",
        )

        _install_library_entry_insert_failure(direct_db)
        try:
            with pytest.raises(ProgrammingError):
                auth_client.post(
                    "/media/from_url",
                    json={"url": "http://example.com/db-fail.pdf"},
                    headers=auth_headers(user_id),
                )
        finally:
            _remove_library_entry_insert_failure(direct_db)

        assert route.call_count == 0
        assert storage.put_paths == []
        assert storage.deleted_paths == []

    def test_same_bytes_remote_pdf_urls_materialize_separate_media(
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
        _patch_file_extractors_success(monkeypatch, direct_db)

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

        _, media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/dup-a.pdf",
            expected_source_type="remote_pdf_url",
        )
        first_result = _run_source_attempt_for_media(direct_db, media_id)
        assert first_result["status"] == "success"
        first_final_path = build_storage_path(media_id, "pdf")

        second_data, second_media_id = _accept_source_url(
            auth_client,
            direct_db,
            user_id,
            "http://example.com/dup-b.pdf",
            expected_source_type="remote_pdf_url",
        )

        assert second_media_id != media_id
        assert second_data["idempotency_outcome"] == "created"

        second_result = _run_source_attempt_for_media(direct_db, second_media_id)
        assert second_result["status"] == "success"
        assert second_result["media_id"] == str(second_media_id)
        second_final_path = build_storage_path(second_media_id, "pdf")

        with direct_db.session() as session:
            count = session.execute(
                text("""
                    SELECT COUNT(*)
                    FROM media
                    WHERE id = ANY(:media_ids)
                      AND created_by_user_id = :user_id
                      AND kind = 'pdf'
                """),
                {"user_id": user_id, "media_ids": [media_id, second_media_id]},
            ).scalar_one()
            second_attempt = session.execute(
                text(
                    """
                    SELECT media_id, status
                    FROM media_source_attempts
                    WHERE requested_url = 'http://example.com/dup-b.pdf'
                    """
                )
            ).fetchone()

        assert count == 2
        assert second_attempt == (second_media_id, "succeeded")
        assert storage.get_object(first_final_path) == PDF_CONTENT
        assert storage.get_object(second_final_path) == PDF_CONTENT
        assert storage.deleted_paths == []


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

        direct_db.register_cleanup("library_entries", "media_id", media_id)
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
# From-url provenance assertions
# =============================================================================


class TestFromUrlProvenance:
    """Tests intrinsic provenance on from_url creation."""

    def test_from_url_creates_default_library_intrinsic_row(
        self, auth_client, direct_db: DirectSessionManager
    ):
        """POST /media/from_url creates both library_entries and intrinsic rows."""
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
        direct_db.register_cleanup("library_entries", "media_id", media_id)
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

            # Verify library_entries exists
            lm = session.execute(
                text("""
                    SELECT 1 FROM library_entries
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
