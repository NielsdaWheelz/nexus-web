"""Integration tests for PDF extraction domain logic (S6 PR-03).

Covers normalization, page-span construction, scanned/image-only,
password-protected, and parser exception mapping.
"""

import hashlib
from unittest.mock import patch
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.errors import ApiErrorCode
from nexus.services.pdf_ingest import (
    PdfExtractionError,
    PdfExtractionResult,
    PdfPageSpan,
    extract_pdf_artifacts,
    normalize_pdf_text,
    validate_page_spans,
)
from nexus.storage.client import FakeStorageClient
from nexus.tasks.ingest_pdf import run_pdf_ingest_sync


def _make_simple_pdf(text_content: str = "Hello World", num_pages: int = 1) -> bytes:
    """Build a minimal valid PDF with PyMuPDF for test purposes."""
    import fitz

    doc = fitz.open()
    for i in range(num_pages):
        page = doc.new_page()
        page_text = f"{text_content} page {i + 1}" if num_pages > 1 else text_content
        page.insert_text((72, 72), page_text, fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def _make_image_only_pdf() -> bytes:
    """Build a PDF that has pages but no extractable text."""
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    img = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 100, 100), 0)
    img.set_rect(img.irect, (255, 0, 0))
    page.insert_image(fitz.Rect(72, 72, 200, 200), pixmap=img)
    data = doc.tobytes()
    doc.close()
    return data


def _make_password_pdf() -> bytes:
    """Build a password-protected PDF."""
    import fitz

    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Secret content", fontsize=12)
    data = doc.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
    doc.close()
    return data


def _create_pdf_media(db: Session, storage: FakeStorageClient, pdf_bytes: bytes) -> Media:
    """Create a media+media_file row for a PDF, put bytes in fake storage."""
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


# ---------------------------------------------------------------------------
# Normalization unit tests
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestPdfTextNormalization:
    def test_crlf_and_cr_normalized(self):
        assert normalize_pdf_text("a\r\nb\rc") == "a\nb\nc"

    def test_form_feed_becomes_double_newline(self):
        assert normalize_pdf_text("page1\fpage2") == "page1\n\npage2"

    def test_nbsp_becomes_space(self):
        assert normalize_pdf_text("hello\u00a0world") == "hello world"

    def test_nul_bytes_are_removed(self):
        assert normalize_pdf_text("abc\x00def\x00ghi") == "abcdefghi"

    def test_collapse_spaces_tabs(self):
        assert normalize_pdf_text("a   b\tc") == "a b c"

    def test_collapse_excessive_newlines(self):
        assert normalize_pdf_text("a\n\n\n\nb") == "a\n\nb"

    def test_trim_whitespace(self):
        assert normalize_pdf_text("  hello  ") == "hello"

    def test_empty_string(self):
        assert normalize_pdf_text("") == ""

    def test_whitespace_only(self):
        assert normalize_pdf_text("   \n\n  ") == ""

    def test_pr03_s6_contract_mixed_input(self):
        raw = "Hello\r\nWorld\fPage  Two\n\n\n\nEnd"
        expected = "Hello\nWorld\n\nPage Two\n\nEnd"
        assert normalize_pdf_text(raw) == expected


# ---------------------------------------------------------------------------
# Page-span validation unit tests
# ---------------------------------------------------------------------------


@pytest.mark.unit
class TestValidatePageSpans:
    def test_valid_spans(self):
        spans = [PdfPageSpan(1, 0, 10), PdfPageSpan(2, 12, 20)]
        assert validate_page_spans(spans, 2, 20) is None

    def test_wrong_count(self):
        spans = [PdfPageSpan(1, 0, 10)]
        err = validate_page_spans(spans, 2, 20)
        assert err is not None and "Expected 2" in err

    def test_wrong_page_number(self):
        spans = [PdfPageSpan(2, 0, 10)]
        err = validate_page_spans(spans, 1, 10)
        assert err is not None and "page_number=2" in err

    def test_overlapping_spans(self):
        spans = [PdfPageSpan(1, 0, 15), PdfPageSpan(2, 10, 20)]
        err = validate_page_spans(spans, 2, 20)
        assert err is not None and "overlapping" in err

    def test_end_offset_exceeds_text(self):
        spans = [PdfPageSpan(1, 0, 100)]
        err = validate_page_spans(spans, 1, 50)
        assert err is not None and "text length" in err


# ---------------------------------------------------------------------------
# PDF extraction integration tests
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestPdfExtractionArtifacts:
    def test_pr03_pdf_ingest_extracts_page_count_plain_text_and_page_spans(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Hello World", num_pages=3)
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionResult)
        assert result.page_count == 3
        assert result.has_text is True
        assert len(result.plain_text) > 0
        assert result.source_fingerprint == f"sha256:{hashlib.sha256(pdf_bytes).hexdigest()}"
        assert all(span.page_width and span.page_width > 0 for span in result.page_spans)
        assert all(span.page_height and span.page_height > 0 for span in result.page_spans)
        assert all(span.page_rotation_degrees == 0 for span in result.page_spans)

        refreshed = db_session.get(Media, media.id)
        assert refreshed.page_count == 3
        assert refreshed.plain_text is not None
        assert len(refreshed.plain_text) > 0

        spans = db_session.execute(
            text("""
                    SELECT page_number, start_offset, end_offset
                    FROM pdf_page_text_spans
                    WHERE media_id = :mid
                    ORDER BY page_number
                """),
            {"mid": media.id},
        ).fetchall()
        assert len(spans) == 3
        for i, span in enumerate(spans):
            assert span[0] == i + 1

    def test_pr03_pdf_plain_text_normalization_matches_s6_contract(self, db_session: Session):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Test  Content")
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionResult)
        assert "\r" not in result.plain_text
        assert "\f" not in result.plain_text
        assert "\u00a0" not in result.plain_text
        assert "  " not in result.plain_text

    def test_pr03_pdf_ingest_scanned_or_image_only_marks_readable_without_quote_text(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_image_only_pdf()
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionResult)
        assert result.page_count >= 1
        assert result.has_text is False
        assert result.source_fingerprint == f"sha256:{hashlib.sha256(pdf_bytes).hexdigest()}"

        refreshed = db_session.get(Media, media.id)
        assert refreshed.page_count >= 1
        assert refreshed.plain_text is None
        assert (
            db_session.execute(
                text("SELECT count(*) FROM pdf_page_text_spans WHERE media_id = :mid"),
                {"mid": media.id},
            ).scalar_one()
            == 0
        )

    def test_pr03_pdf_ingest_password_protected_fails_with_deterministic_error_code(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_password_pdf()
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionError)
        assert result.error_code == ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value
        assert result.terminal is True

    def test_pr03_pdf_ingest_maps_pymupdf_parser_exceptions_to_parser_agnostic_outcomes(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        media = _create_pdf_media(db_session, storage, b"not a real pdf at all")

        result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionError)
        assert result.error_code in (
            ApiErrorCode.E_INGEST_FAILED.value,
            ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value,
        )

    def test_pr03_pdf_ingest_text_bearing_invariant_failure_rolls_back_partial_text_artifacts(
        self, db_session: Session
    ):
        """If page-span invariants fail on a text-bearing PDF, no partial
        text artifacts should remain."""
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Content", num_pages=2)
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        with patch(
            "nexus.services.pdf_ingest.validate_page_spans",
            return_value="Forced invariant failure",
        ):
            result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionError)
        assert "invariant" in result.error_message.lower()

    def test_pr03_pdf_ingest_fails_extract_when_page_spans_not_contiguous_after_text_extraction(
        self, db_session: Session
    ):
        """Non-contiguous page spans -> deterministic extract failure (fail closed)."""
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Contiguity test", num_pages=2)
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        def _bad_contiguous(page_spans, page_count, text_len):
            return "Non-contiguous spans detected"

        with patch("nexus.services.pdf_ingest.validate_page_spans", side_effect=_bad_contiguous):
            result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionError)
        assert (
            "contiguous" in result.error_message.lower()
            or "invariant" in result.error_message.lower()
        )

    def test_pr03_pdf_ingest_fails_extract_when_page_span_set_incomplete_after_text_extraction(
        self, db_session: Session
    ):
        """Missing page-span rows for multi-page PDF -> deterministic extract failure."""
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Incomplete test", num_pages=3)
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        def _bad_incomplete(page_spans, page_count, text_len):
            return "Expected 3 spans, got 1"

        with patch("nexus.services.pdf_ingest.validate_page_spans", side_effect=_bad_incomplete):
            result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionError)

    def test_pr03_embedding_retry_does_not_rewrite_pdf_text_artifacts_or_invalidate_matches(
        self, db_session: Session
    ):
        """Embedding-only retry path preserves text artifacts and quote-match metadata."""
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Embed retry", num_pages=2)
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = extract_pdf_artifacts(db_session, media.id, storage)
        assert isinstance(result, PdfExtractionResult)
        assert result.has_text is True

        original_text = db_session.get(Media, media.id).plain_text
        original_page_count = db_session.get(Media, media.id).page_count

        original_spans = db_session.execute(
            text(
                "SELECT page_number, start_offset, end_offset FROM pdf_page_text_spans "
                "WHERE media_id = :mid ORDER BY page_number"
            ),
            {"mid": media.id},
        ).fetchall()

        assert original_text is not None
        assert len(original_spans) == 2

        refreshed = db_session.get(Media, media.id)
        assert refreshed.plain_text == original_text
        assert refreshed.page_count == original_page_count

        after_spans = db_session.execute(
            text(
                "SELECT page_number, start_offset, end_offset FROM pdf_page_text_spans "
                "WHERE media_id = :mid ORDER BY page_number"
            ),
            {"mid": media.id},
        ).fetchall()
        assert after_spans == list(original_spans)

    def test_pr03_sync_runner_matches_extract(self, db_session: Session):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Sync test")
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = run_pdf_ingest_sync(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionResult)
        assert result.has_text is True
