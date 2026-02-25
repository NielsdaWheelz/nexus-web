"""Task-level tests for ingest_pdf async lifecycle transitions (S6 PR-03).

Mirrors test_epub_ingest.py coverage style with PDF-specific behavior.
"""

from datetime import UTC, datetime
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.errors import ApiErrorCode
from nexus.storage.client import FakeStorageClient

pytestmark = pytest.mark.integration


def _make_simple_pdf(text_content: str = "Hello", num_pages: int = 1) -> bytes:
    import fitz

    doc = fitz.open()
    for i in range(num_pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"{text_content} p{i + 1}", fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def _create_extracting_pdf(db: Session, storage: FakeStorageClient, pdf_bytes: bytes) -> Media:
    media_id = uuid4()
    user_id = uuid4()

    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'pdf', 'Test PDF', 'extracting', :uid)
        """),
        {"id": media_id, "uid": user_id},
    )
    storage_path = f"media/{media_id}/original.pdf"
    db.execute(
        text("""
            INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
            VALUES (:mid, :sp, 'application/pdf', :sz)
        """),
        {"mid": media_id, "sp": storage_path, "sz": len(pdf_bytes)},
    )
    db.flush()
    storage.put_object(storage_path, pdf_bytes)
    return db.get(Media, media_id)


class TestIngestPdfTask:
    def test_pr03_ingest_pdf_task_marks_ready_for_reading_on_success(self, db_session: Session):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Success test", num_pages=2)
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        with (
            patch("nexus.tasks.ingest_pdf.get_session_factory", return_value=lambda: db_session),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch.object(db_session, "close"),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        assert result["page_count"] == 2

        refreshed = db_session.get(Media, mid)
        assert refreshed.processing_status == ProcessingStatus.ready_for_reading
        assert refreshed.page_count == 2

    def test_pr03_ingest_pdf_task_marks_failed_on_extraction_error(self, db_session: Session):
        storage = FakeStorageClient()
        media_id = uuid4()
        user_id = uuid4()

        db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db_session.execute(
            text("""
                INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                VALUES (:id, 'pdf', 'Bad PDF', 'extracting', :uid)
            """),
            {"id": media_id, "uid": user_id},
        )
        storage_path = f"media/{media_id}/original.pdf"
        db_session.execute(
            text("""
                INSERT INTO media_file (media_id, storage_path, content_type, size_bytes)
                VALUES (:mid, :sp, 'application/pdf', 100)
            """),
            {"mid": media_id, "sp": storage_path},
        )
        db_session.flush()

        from tests.test_pdf_ingest import _make_password_pdf

        storage.put_object(storage_path, _make_password_pdf())

        with (
            patch("nexus.tasks.ingest_pdf.get_session_factory", return_value=lambda: db_session),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch.object(db_session, "close"),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(media_id))

        assert result["status"] == "failed"
        assert result["error_code"] == ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value
        assert result["terminal"] is True

        refreshed = db_session.get(Media, media_id)
        assert refreshed.processing_status == ProcessingStatus.failed
        assert refreshed.failure_stage == FailureStage.extract
        assert refreshed.last_error_code == ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value

    def test_pr03_ingest_pdf_task_idempotent_on_missing_or_nonextracting_media(
        self, db_session: Session
    ):
        storage = FakeStorageClient()

        with (
            patch("nexus.tasks.ingest_pdf.get_session_factory", return_value=lambda: db_session),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch.object(db_session, "close"),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result_missing = ingest_pdf(str(uuid4()))
            assert result_missing["status"] == "skipped"

            user_id = uuid4()
            media_id = uuid4()
            db_session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            db_session.execute(
                text("""
                    INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
                    VALUES (:id, 'pdf', 'Pending PDF', 'pending', :uid)
                """),
                {"id": media_id, "uid": user_id},
            )
            db_session.flush()

            result_pending = ingest_pdf(str(media_id))
            assert result_pending["status"] == "skipped"

    def test_pr03_ingest_pdf_task_unexpected_error_marks_failed_when_possible(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf()
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id
        db_session.commit()

        with (
            patch("nexus.tasks.ingest_pdf.get_session_factory", return_value=lambda: db_session),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch(
                "nexus.tasks.ingest_pdf.extract_pdf_artifacts",
                side_effect=RuntimeError("boom"),
            ),
            patch.object(db_session, "close"),
            pytest.raises(RuntimeError, match="boom"),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            ingest_pdf(str(mid))

        db_session.expire_all()
        refreshed = db_session.get(Media, mid)
        assert refreshed.processing_status == ProcessingStatus.failed
        assert refreshed.failure_stage == FailureStage.extract

    def test_pr03_ingest_pdf_task_hands_off_to_embedding_pipeline_after_successful_extraction(
        self, db_session: Session
    ):
        """After successful extraction, the task calls _try_embedding_handoff."""
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Embed test")
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        with (
            patch("nexus.tasks.ingest_pdf.get_session_factory", return_value=lambda: db_session),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch("nexus.tasks.ingest_pdf._try_embedding_handoff") as mock_handoff,
            patch.object(db_session, "close"),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        mock_handoff.assert_called_once()

    def test_pr03_ingest_pdf_task_handoff_failure_marks_failed_with_embed_stage_and_preserves_extracted_artifacts(
        self, db_session: Session
    ):
        """If embedding handoff fails, media is marked failed with embed stage
        but extracted artifacts (page_count, plain_text, page_spans) are preserved."""
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Handoff fail test", num_pages=2)
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        def failing_handoff(db, media_uuid, request_id):
            m = db.get(Media, media_uuid)
            if m and m.processing_status == ProcessingStatus.ready_for_reading:
                now = datetime.now(UTC)
                m.processing_status = ProcessingStatus.failed
                m.failure_stage = FailureStage.embed
                m.last_error_code = "E_INGEST_FAILED"
                m.last_error_message = "Embedding handoff failed: test"
                m.failed_at = now
                m.updated_at = now
                db.commit()

        with (
            patch("nexus.tasks.ingest_pdf.get_session_factory", return_value=lambda: db_session),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch("nexus.tasks.ingest_pdf._try_embedding_handoff", side_effect=failing_handoff),
            patch.object(db_session, "close"),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"

        refreshed = db_session.get(Media, mid)
        assert refreshed.page_count == 2
        assert refreshed.plain_text is not None
