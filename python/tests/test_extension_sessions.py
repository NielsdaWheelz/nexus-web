"""Integration tests for browser extension session capture."""

from uuid import UUID

import pytest
from sqlalchemy import func, select, text

from nexus.db.models import ExtensionSession, Fragment, Media
from nexus.services.url_normalize import normalize_url_for_display
from tests.helpers import auth_headers, create_test_user_id
from tests.support.storage import FakeStorageClient
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

PDF_CONTENT = b"%PDF-1.4\ncaptured pdf bytes"


def _run_latest_source_attempt(
    direct_db: DirectSessionManager, media_id: UUID, actor_user_id: UUID
) -> None:
    from nexus.services.media_source_ingest import run_source_attempt

    with direct_db.session() as db:
        row = db.execute(
            text(
                """
                SELECT id
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no DESC, created_at DESC, id DESC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).one()
        result = run_source_attempt(
            db=db,
            media_id=media_id,
            attempt_id=row[0],
            actor_user_id=actor_user_id,
            request_id="test-extension-source-attempt",
        )
        assert result["status"] == "success"


class TestExtensionSessions:
    def test_create_session_and_capture_article(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
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
            "source_html": (
                "<html><body><article><h1>Private Access</h1><p>Readable body.</p>"
                "<script>bad()</script></article></body></html>"
            ),
        }
        fake_storage = FakeStorageClient()
        monkeypatch.setattr(
            "nexus.services.media_source_ingest.get_storage_client", lambda: fake_storage
        )

        first_capture = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        assert first_capture.status_code == 202
        first_data = first_capture.json()["data"]
        first_media_id = UUID(first_data["media_id"])
        assert first_data["source_attempt_status"] == "queued"
        assert first_data["processing_status"] == "pending"
        assert first_data["ingest_enqueued"] is True
        _run_latest_source_attempt(direct_db, first_media_id, user_id)

        second_capture = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        assert second_capture.status_code == 202
        second_data = second_capture.json()["data"]
        second_media_id = UUID(second_data["media_id"])
        assert second_media_id != first_media_id
        _run_latest_source_attempt(direct_db, second_media_id, user_id)

        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(first_media_id))
        direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(second_media_id))
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
                "source_html": "<html><body><article><p>Readable body.</p></article></body></html>",
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
                "source_html": "<html><body><article><p>Readable body.</p></article></body></html>",
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
                "source_html": "<html><body><article><p>Readable body.</p></article></body></html>",
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
        monkeypatch.setattr(
            "nexus.services.media_source_ingest.get_storage_client", lambda: fake_storage
        )

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
        assert data["processing_status"] == "pending"
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


class _SimulatedCrash(BaseException):
    """Process-death stand-in: escapes ``except Exception`` like a real crash."""


class TestCaptureAuthorStepGatesReady:
    """Runner-seam contract (spec 2.4 / AC 9): the browser-capture handler
    attaches its byline observation to the result; ``run_source_attempt``
    commits the source work, applies the observation through the author facade
    in a fresh session, and only then crosses ready. An author-op failure fails
    the attempt + media (ready is never crossed, no credits land). A crash after
    the source commit leaves the attempt running; the lease-expiry re-run of the
    SAME attempt re-runs the source work, re-attaches the observation via the
    seam, and converges."""

    def _capture_article(self, auth_client, direct_db, monkeypatch, *, slug: str):
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        create_response = auth_client.post(
            "/auth/extension-sessions", headers=auth_headers(user_id)
        )
        assert create_response.status_code == 201
        create_data = create_response.json()["data"]
        session_id = UUID(create_data["id"])
        token = create_data["token"]

        fake_storage = FakeStorageClient()
        monkeypatch.setattr(
            "nexus.services.media_source_ingest.get_storage_client", lambda: fake_storage
        )

        capture = auth_client.post(
            "/media/capture/article",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "url": f"https://example.com/articles/{slug}",
                "title": "Author Step Ordering",
                "byline": "By Ada Lovelace",
                "content_html": (
                    "<article><h1>Author Step Ordering</h1><p>Readable body.</p></article>"
                ),
                "source_html": (
                    "<html><body><article><h1>Author Step Ordering</h1>"
                    "<p>Readable body.</p></article></body></html>"
                ),
            },
        )
        assert capture.status_code == 202
        media_id = UUID(capture.json()["data"]["media_id"])
        direct_db.register_cleanup("users", "id", user_id)
        direct_db.register_cleanup("background_jobs", "payload->>'media_id'", str(media_id))
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("extension_sessions", "id", session_id)
        return user_id, media_id

    def _media_state(self, direct_db, media_id) -> tuple[str, str, int]:
        with direct_db.session() as db:
            row = db.execute(
                text(
                    """
                    SELECT m.processing_status,
                           (SELECT msa.status FROM media_source_attempts msa
                            WHERE msa.media_id = m.id
                            ORDER BY msa.attempt_no DESC, msa.created_at DESC, msa.id DESC
                            LIMIT 1),
                           (SELECT count(*) FROM contributor_credits cc
                            WHERE cc.media_id = m.id)
                    FROM media m WHERE m.id = :media_id
                    """
                ),
                {"media_id": media_id},
            ).one()
        return str(row[0]), str(row[1]), int(row[2])

    def test_author_op_failure_fails_attempt_and_never_crosses_ready(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        import nexus.services.media_source_ingest as media_source_ingest_module

        user_id, media_id = self._capture_article(
            auth_client, direct_db, monkeypatch, slug="author-step-failure"
        )

        def _fail_author_step(**kwargs) -> None:
            raise RuntimeError("simulated author-step failure")

        monkeypatch.setattr(
            media_source_ingest_module, "replace_observed_role_slices", _fail_author_step
        )
        first_result = _run_attempt_result(direct_db, media_id, user_id)
        assert first_result["status"] == "failed"

        media_status, attempt_status, credit_count = self._media_state(direct_db, media_id)
        assert media_status == "failed", "author-op failure must gate ready (spec 2.4)"
        assert attempt_status == "failed"
        assert credit_count == 0, "no credit may land when the author op failed"

    def test_crash_after_source_commit_resumes_same_attempt_and_converges(
        self, auth_client, direct_db: DirectSessionManager, monkeypatch
    ):
        import nexus.services.media_source_ingest as media_source_ingest_module

        user_id, media_id = self._capture_article(
            auth_client, direct_db, monkeypatch, slug="author-step-crash-resume"
        )

        real_replace = media_source_ingest_module.replace_observed_role_slices

        def _crash_in_author_step(**kwargs) -> None:
            raise _SimulatedCrash

        monkeypatch.setattr(
            media_source_ingest_module, "replace_observed_role_slices", _crash_in_author_step
        )
        with pytest.raises(_SimulatedCrash):
            _run_attempt_result(direct_db, media_id, user_id)

        # The source work committed but the crash preceded the author op: the
        # attempt is still running (lease-expiry retries it), ready NOT crossed,
        # and no credit exists — exactly AC 9's crash window.
        media_status, attempt_status, credit_count = self._media_state(direct_db, media_id)
        assert media_status == "extracting"
        assert attempt_status == "running"
        assert credit_count == 0

        # Lease-expiry re-run of the SAME attempt: source work re-runs from the
        # stored capture markup, the observation is re-attached via the seam,
        # the real author op applies it, and only then ready is crossed.
        monkeypatch.setattr(
            media_source_ingest_module, "replace_observed_role_slices", real_replace
        )
        resume_result = _run_attempt_result(direct_db, media_id, user_id)
        assert resume_result["status"] == "success", resume_result

        with direct_db.session() as db:
            media_status_after = db.execute(
                text("SELECT processing_status FROM media WHERE id = :media_id"),
                {"media_id": media_id},
            ).scalar_one()
            credit_rows = db.execute(
                text(
                    """
                    SELECT cc.credited_name, cc.role, cc.source, cc.contributor_id
                    FROM contributor_credits cc
                    WHERE cc.media_id = :media_id
                    ORDER BY cc.ordinal
                    """
                ),
                {"media_id": media_id},
            ).fetchall()
        for contributor_id in {row[3] for row in credit_rows}:
            direct_db.register_cleanup("contributors", "id", contributor_id)
            direct_db.register_cleanup("contributor_aliases", "contributor_id", contributor_id)
            direct_db.register_cleanup("contributor_external_ids", "contributor_id", contributor_id)
            direct_db.register_cleanup("contributor_credits", "contributor_id", contributor_id)
        assert media_status_after == "ready_for_reading"
        assert [(row[0], row[1], row[2]) for row in credit_rows] == [
            ("Ada Lovelace", "author", "web_article_capture")
        ]


def _run_attempt_result(
    direct_db: DirectSessionManager, media_id: UUID, actor_user_id: UUID
) -> dict[str, object]:
    """Run the latest source attempt and return the raw result (no status assert)."""
    from nexus.services.media_source_ingest import run_source_attempt

    with direct_db.session() as db:
        row = db.execute(
            text(
                """
                SELECT id
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no DESC, created_at DESC, id DESC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        ).one()
        return run_source_attempt(
            db=db,
            media_id=media_id,
            attempt_id=row[0],
            actor_user_id=actor_user_id,
            request_id="test-author-step-ordering",
        )
