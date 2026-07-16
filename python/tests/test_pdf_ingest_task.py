"""Integration tests for the PDF ingest worker lifecycle and content indexing."""

from datetime import UTC, datetime
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import FailureStage, Media, ProcessingStatus
from nexus.errors import ApiErrorCode
from tests.support.storage import FakeStorageClient
from tests.utils.db import task_session_factory

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


def _make_labeled_pdf(text_content: str = "Hello") -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=420, height=595)
    page.insert_text((72, 72), text_content, fontsize=12)
    doc.set_page_labels([{"startpage": 0, "prefix": "A-", "style": "D", "firstpagenum": 7}])
    data = doc.tobytes()
    doc.close()
    return data


def _make_image_only_pdf() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    img = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 100, 100), 0)
    img.set_rect(img.irect, (255, 0, 0))
    page.insert_image(fitz.Rect(72, 72, 200, 200), pixmap=img)
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
    def test_ingest_pdf_marks_ready_for_reading_and_persists_page_count(self, db_session: Session):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Success test", num_pages=2)
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        with (
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        assert result["page_count"] == 2

        db_session.expire_all()
        refreshed = db_session.get(Media, mid)
        assert refreshed.processing_status == ProcessingStatus.ready_for_reading
        assert refreshed.page_count == 2

    def test_pdf_ingest_writes_page_aware_evidence_index_for_digital_pdf(self, db_session: Session):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Evidence indexing", num_pages=2)
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        with (
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        assert result["has_text"] is True

        state = db_session.execute(
            text(
                """
                SELECT status
                FROM content_index_states
                WHERE owner_kind = 'media' AND owner_id = :mid
                """
            ),
            {"mid": mid},
        ).one()
        assert state[0] == "ready"

        blocks = db_session.execute(
            text(
                """
                SELECT block_idx, block_kind, canonical_text, locator, selector
                FROM content_blocks
                WHERE owner_kind = 'media' AND owner_id = :mid
                ORDER BY block_idx
                """
            ),
            {"mid": mid},
        ).fetchall()
        assert len(blocks) == 2
        assert blocks[0][1] == "pdf_text_block"
        assert "Evidence indexing p1" in blocks[0][2]
        locator = blocks[0][3]
        selector = blocks[0][4]
        assert locator["page_number"] == 1
        assert locator["physical_page_number"] == 1
        assert locator["page_text_start_offset"] == 0
        assert locator["page_text_end_offset"] == len(blocks[0][2])
        assert locator["text_quote"]["exact"] == blocks[0][2]
        assert locator["geometry"]["page_width"] > 0
        assert locator["geometry"]["page_height"] > 0
        assert selector["kind"] == "pdf_text_quote"
        assert selector["text_quote"]["exact"] == blocks[0][2]

        assert (
            db_session.execute(
                text(
                    "SELECT count(*) FROM evidence_spans "
                    "WHERE owner_kind = 'media' AND owner_id = :mid"
                ),
                {"mid": mid},
            ).scalar_one()
            == 2
        )
        evidence_selector = db_session.execute(
            text(
                """
                SELECT selector
                FROM evidence_spans
                WHERE owner_kind = 'media' AND owner_id = :mid
                ORDER BY created_at
                LIMIT 1
                """
            ),
            {"mid": mid},
        ).scalar_one()
        assert evidence_selector["geometry"]["projection"] == "proportional_text_offsets"
        assert len(evidence_selector["geometry"]["quads"]) == 1
        assert (
            db_session.execute(
                text(
                    "SELECT count(*) FROM content_chunks "
                    "WHERE owner_kind = 'media' AND owner_id = :mid"
                ),
                {"mid": mid},
            ).scalar_one()
            == 2
        )

    def test_pdf_page_label_and_geometry_survive_content_index_repair(self, db_session: Session):
        from nexus.services.content_indexing import (
            IndexOwner,
            delete_content_index,
            repair_ready_media_content_index_now,
        )

        storage = FakeStorageClient()
        pdf_bytes = _make_labeled_pdf("Repair preserves labeled geometry")
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        with (
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        span_row = db_session.execute(
            text(
                """
                SELECT page_label, page_width, page_height, page_rotation_degrees
                FROM pdf_page_text_spans
                WHERE media_id = :mid
                  AND page_number = 1
                """
            ),
            {"mid": mid},
        ).one()
        assert span_row[0] == "A-7"
        assert span_row[1] == 420
        assert span_row[2] == 595
        assert span_row[3] == 0

        delete_content_index(db_session, owner=IndexOwner("media", mid))
        repair_result = repair_ready_media_content_index_now(
            db_session,
            media_id=mid,
            reason="test_pdf_repair",
        )

        assert repair_result is not None
        assert repair_result.status == "ready"
        repaired = db_session.execute(
            text(
                """
                SELECT locator, selector, heading_path
                FROM content_blocks
                WHERE owner_kind = 'media' AND owner_id = :mid
                ORDER BY block_idx ASC
                LIMIT 1
                """
            ),
            {"mid": mid},
        ).one()
        locator = repaired[0]
        selector = repaired[1]
        assert repaired[2] == ["p. A-7"]
        assert locator["page_label"] == "A-7"
        assert locator["geometry"]["page_width"] == 420
        assert locator["geometry"]["page_height"] == 595
        assert locator["geometry"]["page_rotation_degrees"] == 0
        assert selector["page_label"] == "A-7"

    def test_image_only_pdf_marks_content_index_ocr_required(self, db_session: Session):
        storage = FakeStorageClient()
        pdf_bytes = _make_image_only_pdf()
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        with (
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        assert result["has_text"] is False

        db_session.expire_all()
        refreshed = db_session.get(Media, mid)
        assert refreshed.processing_status == ProcessingStatus.ready_for_reading
        assert refreshed.last_error_code == "E_PDF_TEXT_UNAVAILABLE"
        assert refreshed.plain_text is None

        state = db_session.execute(
            text(
                """
                SELECT mcis.status, mcis.status_reason
                FROM content_index_states mcis
                WHERE mcis.owner_kind = 'media' AND mcis.owner_id = :mid
                """
            ),
            {"mid": mid},
        ).one()
        assert state[0] == "ocr_required"
        assert state[1] == "ocr_required"

        block = db_session.execute(
            text(
                """
                SELECT canonical_text, locator, selector
                FROM content_blocks
                WHERE owner_kind = 'media' AND owner_id = :mid
                """
            ),
            {"mid": mid},
        ).one()
        assert block[0] == ""
        assert block[1]["page_number"] == 1
        assert block[1]["geometry"]["page_width"] > 0
        assert block[2]["text_quote"]["exact"] == ""
        assert (
            db_session.execute(
                text(
                    "SELECT count(*) FROM content_chunks "
                    "WHERE owner_kind = 'media' AND owner_id = :mid"
                ),
                {"mid": mid},
            ).scalar_one()
            == 0
        )

    def test_ingest_pdf_marks_extract_failed_for_password_protected_pdf(self, db_session: Session):
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
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(media_id))

        assert result["status"] == "failed"
        assert result["error_code"] == ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value
        assert result["terminal"] is True

        db_session.expire_all()
        refreshed = db_session.get(Media, media_id)
        assert refreshed.processing_status == ProcessingStatus.failed
        assert refreshed.failure_stage == FailureStage.extract
        assert refreshed.last_error_code == ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value

    def test_ingest_pdf_skips_missing_or_non_extracting_media(self, db_session: Session):
        storage = FakeStorageClient()

        with (
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
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

    def test_ingest_pdf_marks_extract_failed_before_reraising_unexpected_error(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf()
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id
        db_session.commit()

        with (
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch(
                "nexus.tasks.ingest_pdf.extract_pdf_artifacts",
                side_effect=RuntimeError("boom"),
            ),
            pytest.raises(RuntimeError, match="boom"),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            ingest_pdf(str(mid))

        db_session.expire_all()
        refreshed = db_session.get(Media, mid)
        assert refreshed.processing_status == ProcessingStatus.failed
        assert refreshed.failure_stage == FailureStage.extract

    def test_ingest_pdf_indexes_pdf_evidence_after_successful_extraction(self, db_session: Session):
        """After successful extraction, the task indexes PDF evidence."""
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Embed test")
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        with (
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch("nexus.tasks.ingest_pdf.index_pdf_evidence") as mock_indexer,
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        mock_indexer.assert_called_once()

    def test_ingest_pdf_preserves_extracted_artifacts_when_evidence_index_marks_embed_failed(
        self, db_session: Session
    ):
        """If evidence indexing fails, media is marked failed with embed stage
        but extracted artifacts (page_count, plain_text, page_spans) are preserved."""
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Handoff fail test", num_pages=2)
        media = _create_extracting_pdf(db_session, storage, pdf_bytes)
        mid = media.id

        def failing_handoff(db, media_uuid, request_id, extraction_result=None):
            m = db.get(Media, media_uuid)
            if m and m.processing_status == ProcessingStatus.ready_for_reading:
                now = datetime.now(UTC)
                m.processing_status = ProcessingStatus.failed
                m.failure_stage = FailureStage.embed
                m.last_error_code = "E_INGEST_FAILED"
                m.last_error_message = "PDF evidence index failed: test"
                m.failed_at = now
                m.updated_at = now
                db.commit()

        with (
            patch(
                "nexus.tasks.ingest_pdf.get_session_factory",
                return_value=task_session_factory(db_session),
            ),
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch("nexus.tasks.ingest_pdf.index_pdf_evidence", side_effect=failing_handoff),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"

        db_session.expire_all()
        refreshed = db_session.get(Media, mid)
        assert refreshed.processing_status == ProcessingStatus.failed
        assert refreshed.failure_stage == FailureStage.embed
        assert refreshed.last_error_code == "E_INGEST_FAILED"
        assert refreshed.page_count == 2
        assert refreshed.plain_text is not None


def _make_pdf_with_author(author: str, text_content: str = "Body") -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), text_content, fontsize=12)
    doc.set_metadata({"author": author, "title": "Authored PDF"})
    data = doc.tobytes()
    doc.close()
    return data


class TestIngestPdfAuthorStep:
    """The fresh-session author step wired into the PDF task (D-13, spec 2.4).

    The task and the facade's fresh author session share the test connection so
    the author op's writes are visible and roll back with the test. Asserts the
    order contract — ready only after the author op commits (AC 9) — and that the
    automatic lane writes no ``resource_mutations`` (D-43).
    """

    @staticmethod
    def _both_factories(db_session: Session):
        factory = task_session_factory(db_session)
        return (
            patch("nexus.tasks.ingest_pdf.get_session_factory", return_value=factory),
            patch("nexus.services.contributors.get_session_factory", return_value=factory),
        )

    @staticmethod
    def _credit_names(db_session: Session, media_id) -> list[str]:
        return list(
            db_session.execute(
                text(
                    "SELECT credited_name FROM contributor_credits "
                    "WHERE media_id = :mid AND role = 'author' ORDER BY ordinal"
                ),
                {"mid": media_id},
            ).scalars()
        )

    @staticmethod
    def _mutation_count(db_session: Session) -> int:
        return db_session.execute(text("SELECT count(*) FROM resource_mutations")).scalar_one()

    def test_ingest_pdf_persists_author_credit_and_marks_ready(self, db_session: Session):
        storage = FakeStorageClient()
        media = _create_extracting_pdf(db_session, storage, _make_pdf_with_author("Ada Lovelace"))
        mid = media.id
        before = self._mutation_count(db_session)

        task_patch, facade_patch = self._both_factories(db_session)
        with (
            task_patch,
            facade_patch,
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        db_session.expire_all()
        assert db_session.get(Media, mid).processing_status == ProcessingStatus.ready_for_reading
        assert self._credit_names(db_session, mid) == ["Ada Lovelace"]
        # Automatic lanes never write resource_mutations (D-43).
        assert self._mutation_count(db_session) == before

    def test_author_step_failure_gates_ready_and_retry_converges(self, db_session: Session):
        storage = FakeStorageClient()
        media = _create_extracting_pdf(
            db_session, storage, _make_pdf_with_author("Grace Hopper; Grace Hopper")
        )
        mid = media.id
        before = self._mutation_count(db_session)

        from nexus.services import contributors

        real = contributors.replace_observed_role_slices
        calls = {"n": 0}

        def flaky(**kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("author step boom")
            return real(**kwargs)

        task_patch, facade_patch = self._both_factories(db_session)
        with (
            task_patch,
            facade_patch,
            patch("nexus.tasks.ingest_pdf.get_storage_client", return_value=storage),
            patch.object(contributors, "replace_observed_role_slices", side_effect=flaky),
        ):
            from nexus.tasks.ingest_pdf import ingest_pdf

            # First attempt: the author step raises, so ready is never crossed and
            # no credit is written.
            with pytest.raises(RuntimeError):
                ingest_pdf(str(mid))
            db_session.expire_all()
            assert (
                db_session.get(Media, mid).processing_status != ProcessingStatus.ready_for_reading
            )
            assert self._credit_names(db_session, mid) == []

            # The durable job re-dispatches the attempt from extraction; the same
            # source work reruns, the author op converges, ready crosses, and the
            # deduped slice is exactly one row.
            db_session.execute(
                text("UPDATE media SET processing_status = 'extracting' WHERE id = :id"),
                {"id": mid},
            )
            db_session.flush()
            result = ingest_pdf(str(mid))

        assert result["status"] == "success"
        assert calls["n"] == 2
        db_session.expire_all()
        assert db_session.get(Media, mid).processing_status == ProcessingStatus.ready_for_reading
        assert self._credit_names(db_session, mid) == ["Grace Hopper"]
        assert self._mutation_count(db_session) == before
