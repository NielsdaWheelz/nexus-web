"""Real PDF extraction smoke tests.

Exercises extract_pdf_artifacts on checked-in academic PDFs with no mocks.
Complements synthetic PDF builders with parser-fidelity coverage.
"""

from pathlib import Path
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.models import Media
from nexus.services.pdf_ingest import PdfExtractionResult, extract_pdf_artifacts
from nexus.storage.client import FakeStorageClient

pytestmark = [pytest.mark.integration, pytest.mark.slow]

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "pdf"

CORPUS = [
    {
        "file": "attention.pdf",
        "label": "Attention Is All You Need",
        "min_pages": 10,
        "min_text_length": 5000,
    },
    {
        "file": "diffusion.pdf",
        "label": "Diffusion models paper",
        "min_pages": 5,
        "min_text_length": 3000,
    },
    {
        "file": "svms.pdf",
        "label": "SVMs paper",
        "min_pages": 5,
        "min_text_length": 3000,
    },
]


def _create_pdf_media(db: Session, storage: FakeStorageClient, pdf_bytes: bytes) -> UUID:
    """Insert media + media_file rows and stage bytes in fake storage."""
    media_id = uuid4()
    user_id = uuid4()
    db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    db.execute(
        text("""
            INSERT INTO media (id, kind, title, processing_status, created_by_user_id)
            VALUES (:id, 'pdf', 'Real Fixture PDF', 'extracting', :uid)
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
    return media_id


class TestRealPdfExtraction:
    @pytest.mark.parametrize("fixture_meta", CORPUS, ids=[item["file"] for item in CORPUS])
    def test_extraction(self, db_session: Session, fixture_meta: dict):
        fixture_path = FIXTURES_DIR / fixture_meta["file"]
        assert fixture_path.exists(), f"{fixture_meta['label']}: missing fixture at {fixture_path}"

        storage = FakeStorageClient()
        media_id = _create_pdf_media(db_session, storage, fixture_path.read_bytes())
        result = extract_pdf_artifacts(db_session, media_id, storage)

        assert isinstance(result, PdfExtractionResult), (
            f"{fixture_meta['label']}: expected PdfExtractionResult, got {result}"
        )
        assert result.page_count >= fixture_meta["min_pages"], (
            f"{fixture_meta['label']}: expected at least {fixture_meta['min_pages']} pages, "
            f"got {result.page_count}"
        )
        assert result.has_text is True, (
            f"{fixture_meta['label']}: expected text-bearing PDF, got has_text={result.has_text}"
        )
        assert len(result.plain_text) >= fixture_meta["min_text_length"], (
            f"{fixture_meta['label']}: expected plain_text length >= {fixture_meta['min_text_length']}, "
            f"got {len(result.plain_text)}"
        )

    @pytest.mark.parametrize("fixture_meta", CORPUS, ids=[item["file"] for item in CORPUS])
    def test_text_normalization(self, db_session: Session, fixture_meta: dict):
        fixture_path = FIXTURES_DIR / fixture_meta["file"]
        assert fixture_path.exists(), f"{fixture_meta['label']}: missing fixture at {fixture_path}"

        storage = FakeStorageClient()
        media_id = _create_pdf_media(db_session, storage, fixture_path.read_bytes())
        result = extract_pdf_artifacts(db_session, media_id, storage)

        assert isinstance(result, PdfExtractionResult), (
            f"{fixture_meta['label']}: expected PdfExtractionResult, got {result}"
        )
        assert "\r" not in result.plain_text, (
            f"{fixture_meta['label']}: plain_text contains carriage returns"
        )
        assert "\f" not in result.plain_text, (
            f"{fixture_meta['label']}: plain_text contains form-feed characters"
        )
        assert "\u00a0" not in result.plain_text, (
            f"{fixture_meta['label']}: plain_text contains non-breaking spaces"
        )
        assert "  " not in result.plain_text, (
            f"{fixture_meta['label']}: plain_text contains double spaces after normalization"
        )

    @pytest.mark.parametrize("fixture_meta", CORPUS, ids=[item["file"] for item in CORPUS])
    def test_page_spans_and_media_columns(self, db_session: Session, fixture_meta: dict):
        fixture_path = FIXTURES_DIR / fixture_meta["file"]
        assert fixture_path.exists(), f"{fixture_meta['label']}: missing fixture at {fixture_path}"

        storage = FakeStorageClient()
        media_id = _create_pdf_media(db_session, storage, fixture_path.read_bytes())
        result = extract_pdf_artifacts(db_session, media_id, storage)

        assert isinstance(result, PdfExtractionResult), (
            f"{fixture_meta['label']}: expected PdfExtractionResult, got {result}"
        )

        spans = db_session.execute(
            text("""
                SELECT page_number, start_offset, end_offset
                FROM pdf_page_text_spans
                WHERE media_id = :mid
                ORDER BY page_number
            """),
            {"mid": media_id},
        ).fetchall()
        assert len(spans) == result.page_count, (
            f"{fixture_meta['label']}: expected {result.page_count} spans, got {len(spans)}"
        )

        for index, (page_number, start_offset, end_offset) in enumerate(spans):
            expected_page_number = index + 1
            assert page_number == expected_page_number, (
                f"{fixture_meta['label']}: span index {index} expected page_number "
                f"{expected_page_number}, got {page_number}"
            )
            assert end_offset >= start_offset, (
                f"{fixture_meta['label']}: page {page_number} has inverted span "
                f"({start_offset}, {end_offset})"
            )
            if index > 0:
                previous_end = spans[index - 1][2]
                assert start_offset >= previous_end, (
                    f"{fixture_meta['label']}: page {page_number} starts at {start_offset}, "
                    f"overlaps prior page end {previous_end}"
                )

        media = db_session.get(Media, media_id)
        assert media is not None, f"{fixture_meta['label']}: media row missing for {media_id}"
        assert media.page_count == result.page_count, (
            f"{fixture_meta['label']}: media.page_count expected {result.page_count}, "
            f"got {media.page_count}"
        )
        assert media.plain_text is not None and len(media.plain_text) > 0, (
            f"{fixture_meta['label']}: media.plain_text was not persisted"
        )
