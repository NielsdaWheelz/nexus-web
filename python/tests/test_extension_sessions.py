"""Integration tests for browser extension session capture."""

from uuid import UUID

import pytest
from sqlalchemy import func, select, text

from nexus.db.models import ExtensionSession, Fragment, Media
from nexus.services.url_normalize import normalize_url_for_display
from nexus.storage.client import FakeStorageClient
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

PDF_CONTENT = b"%PDF-1.4\ncaptured pdf bytes"


class TestExtensionSessions:
    def test_create_session_and_capture_article(self, auth_client, direct_db: DirectSessionManager):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/auth/extension-sessions", headers=auth_headers(user_id)
        )
        assert create_response.status_code == 201
        create_data = create_response.json()["data"]
        session_id = UUID(create_data["id"])
        token = create_data["token"]

        payload = {
            "url": "https://example.com/articles/private-access",
            "title": "Private Access",
            "byline": "By Ada Lovelace",
            "excerpt": "Captured from the browser.",
            "site_name": "Example",
            "published_time": "2026-04-15T10:00:00Z",
            "content_html": (
                "<article><h1>Private Access</h1><p>Readable body.</p>"
                "<script>bad()</script></article>"
            ),
        }

        first_capture = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        assert first_capture.status_code == 201
        first_data = first_capture.json()["data"]
        first_media_id = UUID(first_data["media_id"])
        assert first_data["processing_status"] == "ready_for_reading"

        second_capture = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        assert second_capture.status_code == 201
        second_data = second_capture.json()["data"]
        second_media_id = UUID(second_data["media_id"])
        assert second_media_id != first_media_id

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("media", "id", first_media_id)
        direct_db.register_cleanup("media", "id", second_media_id)
        direct_db.register_cleanup("extension_sessions", "id", session_id)

        with direct_db.session() as db:
            extension_session = db.get(ExtensionSession, session_id)
            assert extension_session is not None
            assert extension_session.user_id == user_id
            assert extension_session.revoked_at is None
            assert extension_session.last_used_at is not None

            first_media = db.get(Media, first_media_id)
            assert first_media is not None
            assert first_media.kind == "web_article"
            assert first_media.requested_url == payload["url"]
            assert first_media.canonical_url is None
            assert first_media.canonical_source_url == normalize_url_for_display(payload["url"])

            fragment = db.execute(
                select(Fragment).where(Fragment.media_id == first_media_id)
            ).scalar_one()
            assert fragment.idx == 0
            assert "<script" not in fragment.html_sanitized
            assert fragment.canonical_text.strip()

            captured_count = db.execute(
                select(func.count()).select_from(Media).where(Media.requested_url == payload["url"])
            ).scalar_one()
            assert captured_count == 2

    def test_capture_article_rejects_invalid_extension_token(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))
        direct_db.register_cleanup("users", "id", user_id)

        response = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": "Bearer nx_ext_invalid"},
            json={
                "url": "https://example.com/articles/private-access",
                "title": "Private Access",
                "content_html": "<article><p>Readable body.</p></article>",
            },
        )

        assert response.status_code == 401
        data = response.json()
        assert data["error"]["code"] == "E_UNAUTHENTICATED"

    def test_revoke_extension_session_blocks_later_capture(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/auth/extension-sessions", headers=auth_headers(user_id)
        )
        assert create_response.status_code == 201
        session_id = UUID(create_response.json()["data"]["id"])
        token = create_response.json()["data"]["token"]

        revoke_response = auth_client.delete(
            "/auth/extension-sessions/current",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert revoke_response.status_code == 204

        capture_response = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "url": "https://example.com/articles/revoked",
                "title": "Revoked",
                "content_html": "<article><p>Readable body.</p></article>",
            },
        )
        assert capture_response.status_code == 401

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("extension_sessions", "id", session_id)

        with direct_db.session() as db:
            extension_session = db.get(ExtensionSession, session_id)
            assert extension_session is not None
            assert extension_session.revoked_at is not None

    def test_capture_article_rejects_oversized_html(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/auth/extension-sessions", headers=auth_headers(user_id)
        )
        assert create_response.status_code == 201
        token = create_response.json()["data"]["token"]

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup(
            "extension_sessions", "id", UUID(create_response.json()["data"]["id"])
        )

        response = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "url": "https://example.com/articles/large",
                "title": "Large Article",
                "content_html": "<article>" + ("x" * 2_100_000) + "</article>",
            },
        )

        assert response.status_code == 413
        data = response.json()
        assert data["error"]["code"] == "E_CAPTURE_TOO_LARGE"

    def test_capture_pdf_file_uses_extension_token_and_file_lifecycle(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        monkeypatch,
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/auth/extension-sessions", headers=auth_headers(user_id)
        )
        assert create_response.status_code == 201
        session_id = UUID(create_response.json()["data"]["id"])
        token = create_response.json()["data"]["token"]

        fake_storage = FakeStorageClient()
        monkeypatch.setattr("nexus.services.media.get_storage_client", lambda: fake_storage)
        monkeypatch.setattr("nexus.services.upload.get_storage_client", lambda: fake_storage)

        response = auth_client.post(
            "/media/capture/file",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/pdf",
                "X-Nexus-Filename": "private-report.pdf",
                "X-Nexus-Source-URL": "https://example.com/private/report.pdf",
            },
            content=PDF_CONTENT,
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        assert data["idempotency_outcome"] == "created"
        assert data["processing_status"] == "extracting"
        assert data["ingest_enqueued"] is True

        with direct_db.session() as db:
            job_id = db.execute(
                text("SELECT id FROM background_jobs WHERE payload->>'media_id' = :media_id"),
                {"media_id": str(media_id)},
            ).scalar()
            if job_id is not None:
                direct_db.register_cleanup("background_jobs", "id", job_id)

            media = db.get(Media, media_id)
            assert media is not None
            assert media.kind == "pdf"
            assert media.title == "private-report.pdf"
            assert media.requested_url == "https://example.com/private/report.pdf"
            assert media.canonical_source_url == "https://example.com/private/report.pdf"
            assert media.file_sha256 is not None
            assert media.media_file is not None
            assert media.media_file.content_type == "application/pdf"
            assert media.media_file.size_bytes == len(PDF_CONTENT)

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("extension_sessions", "id", session_id)

    def test_capture_video_url_uses_extension_token_and_url_lifecycle(
        self, auth_client, direct_db: DirectSessionManager
    ):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/auth/extension-sessions", headers=auth_headers(user_id)
        )
        assert create_response.status_code == 201
        session_id = UUID(create_response.json()["data"]["id"])
        token = create_response.json()["data"]["token"]
        video_id = user_id.hex[:11]

        response = auth_client.post(
            "/media/capture/url",
            headers={"Authorization": f"Bearer {token}"},
            json={"url": f"https://www.youtube.com/watch?v={video_id}"},
        )

        assert response.status_code == 202
        data = response.json()["data"]
        media_id = UUID(data["media_id"])
        assert data["idempotency_outcome"] == "created"
        assert data["ingest_enqueued"] is True

        with direct_db.session() as db:
            job_id = db.execute(
                text("SELECT id FROM background_jobs WHERE payload->>'media_id' = :media_id"),
                {"media_id": str(media_id)},
            ).scalar()
            if job_id is not None:
                direct_db.register_cleanup("background_jobs", "id", job_id)

            media = db.get(Media, media_id)
            assert media is not None
            assert media.kind == "video"
            assert media.provider == "youtube"
            assert media.provider_id == video_id
            assert media.canonical_url == f"https://www.youtube.com/watch?v={video_id}"

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("extension_sessions", "id", session_id)
