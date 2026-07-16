"""Tests for PDF text extraction, page spans, and ingest error handling.

Covers normalization, page-span construction, scanned/image-only,
password-protected, and parser exception mapping.
"""

import hashlib
import io
import tarfile
from collections import Counter
from pathlib import Path
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
    PdfReferenceBlock,
    PdfSourcePackageArtifact,
    _extract_pdf_legal_footnote_apparatus,
    _extract_pdf_native_link_apparatus,
    _pdf_reference_block_for_destination,
    extract_pdf_artifacts,
    normalize_pdf_text,
    validate_page_spans,
)
from nexus.tasks.ingest_pdf import run_pdf_ingest_sync
from tests.support.storage import FakeStorageClient


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


def _tar_bytes(entries: list[tuple[str, bytes]]) -> bytes:
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as archive:
        for name, content in entries:
            info = tarfile.TarInfo(name)
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return data.getvalue()


def _make_unpaired_marker_pdf() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 90), "Claim with marker", fontsize=12)
    page.insert_text((172, 82), "1", fontsize=6)
    data = doc.tobytes()
    doc.close()
    return data


def _make_numbered_lower_page_legend_pdf() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 90), "The chart marks two ordinary legend callouts", fontsize=12)
    page.insert_text((300, 82), "1", fontsize=6)
    page.insert_text((308, 90), " and another callout", fontsize=12)
    page.insert_text((408, 82), "2", fontsize=6)
    page.insert_text((72, 620), "1", fontsize=7)
    page.insert_text((90, 620), "First numbered legend row, not a footnote.", fontsize=12)
    page.insert_text((72, 642), "2", fontsize=7)
    page.insert_text((90, 642), "Second numbered legend row, not a footnote.", fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def _make_non_contiguous_legal_footnote_pdf() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 90), "Claim", fontsize=12)
    page.insert_text((104, 82), "1", fontsize=6)
    page.insert_text((112, 90), " with another claim", fontsize=12)
    page.insert_text((212, 82), "3", fontsize=6)
    page.insert_text((72, 620), "1", fontsize=7)
    page.insert_text((90, 620), "First legal footnote body.", fontsize=7)
    page.insert_text((72, 642), "3", fontsize=7)
    page.insert_text((90, 642), "Third legal footnote body skips label two.", fontsize=7)
    data = doc.tobytes()
    doc.close()
    return data


def _make_duplicate_marker_legal_footnote_pdf() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 90), "First claim", fontsize=12)
    page.insert_text((132, 82), "1", fontsize=6)
    page.insert_text((140, 90), " and repeated marker", fontsize=12)
    page.insert_text((244, 82), "1", fontsize=6)
    page.insert_text((252, 90), " again", fontsize=12)
    page.insert_text((72, 620), "1", fontsize=7)
    page.insert_text((90, 620), "Only one target exists for the duplicated marker.", fontsize=7)
    data = doc.tobytes()
    doc.close()
    return data


def _make_same_line_target_legal_footnote_pdf() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 90), "Claim with marker", fontsize=12)
    page.insert_text((172, 82), "1", fontsize=6)
    page.insert_text((72, 620), "1 Same-line note bodies are not v1 targets.", fontsize=7)
    data = doc.tobytes()
    doc.close()
    return data


def _make_native_link_partial_marker_pdf() -> bytes:
    import fitz

    doc = fitz.open()
    page = doc.new_page(width=612, height=792)
    page.insert_text((72, 72), "Unresolved [U] and outside-column [X].", fontsize=12)
    references_page = doc.new_page(width=612, height=792)
    references_page.insert_text((72, 72), "References", fontsize=12)
    references_page.insert_text((72, 100), "[1] Only material reference block.", fontsize=8)

    page = doc[0]
    references_page = doc[1]
    unresolved_rect = page.search_for("[U]")[0]
    outside_rect = page.search_for("[X]")[0]
    target_top = references_page.search_for("[1]")[0].y0
    page.insert_link(
        {
            "kind": fitz.LINK_NAMED,
            "from": unresolved_rect,
            "nameddest": "cite.unresolved",
        }
    )
    page.insert_link(
        {
            "kind": fitz.LINK_NAMED,
            "from": outside_rect,
            "nameddest": "cite.outsideColumn",
        }
    )

    references_page_xref = doc.page_xref(1)
    references_page_height = float(references_page.rect.height)
    doc.xref_set_key(
        doc.pdf_catalog(),
        "Names",
        (
            "<< /Dests << /Names ["
            f"(cite.outsideColumn) [{references_page_xref} 0 R /XYZ 500 "
            f"{references_page_height - target_top:.3f} 0] "
            f"(cite.unresolved) [{references_page_xref} 0 R /XYZ 72 492 0]"
            "] >> >>"
        ),
    )
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

    def test_normalizes_mixed_pdf_text_control_chars_and_spacing(self):
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
    def test_extract_pdf_artifacts_persists_page_count_plain_text_and_page_spans(
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
        assert all(span.page_width and span.page_width > 0 for span in result.page_spans)
        assert all(span.page_height and span.page_height > 0 for span in result.page_spans)
        assert all(span.page_rotation_degrees == 0 for span in result.page_spans)

        refreshed = db_session.get(Media, media.id)
        assert refreshed.page_count == 3
        assert refreshed.plain_text is not None
        assert len(refreshed.plain_text) > 0
        apparatus_state = db_session.execute(
            text("""
                SELECT status, item_count, edge_count
                FROM reader_apparatus_states
                WHERE media_id = :mid
            """),
            {"mid": media.id},
        ).one()
        assert tuple(apparatus_state) == ("empty", 0, 0)

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

    def test_extract_pdf_artifacts_normalizes_plain_text(self, db_session: Session):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Test  Content")
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionResult)
        assert "\r" not in result.plain_text
        assert "\f" not in result.plain_text
        assert "\u00a0" not in result.plain_text
        assert "  " not in result.plain_text

    def test_extract_pdf_artifacts_persists_arxiv_source_package_apparatus(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Arxiv source package")
        media = _create_pdf_media(db_session, storage, pdf_bytes)
        source_bytes = (
            Path(__file__).parent / "fixtures/reader_apparatus/arxiv/2606.01109-source.tar"
        ).read_bytes()
        source_path = f"media/{media.id}/source/source-package.tar"
        storage.put_object(source_path, source_bytes, "application/x-tar")

        result = extract_pdf_artifacts(
            db_session,
            media.id,
            storage,
            source_package=PdfSourcePackageArtifact(
                storage_path=source_path,
                content_type="application/x-tar",
                size_bytes=len(source_bytes),
                sha256_hex=hashlib.sha256(source_bytes).hexdigest(),
                source_url="https://arxiv.org/e-print/2606.01109",
                source_kind="arxiv_source",
                source_ref={"arxiv_id": "2606.01109"},
            ),
        )

        assert isinstance(result, PdfExtractionResult)
        apparatus_state = db_session.execute(
            text("""
                SELECT status, item_count, edge_count, diagnostics
                FROM reader_apparatus_states
                WHERE media_id = :mid
            """),
            {"mid": media.id},
        ).one()
        assert tuple(apparatus_state[:3]) == ("ready", 33, 20)
        assert apparatus_state[3]["latex_biblatex"] == {
            "status": "ready",
            "citation_marker_count": 15,
            "citation_edge_count": 20,
            "cited_bibliography_entry_count": 17,
            "bib_entry_count": 22,
            "uncited_bib_entry_count": 5,
            "footnote_count": 1,
            "missing_citation_keys": [],
        }

        rows = db_session.execute(
            text("""
                SELECT kind, extraction_method, locator_status, source_ref
                FROM reader_apparatus_items
                WHERE media_id = :mid
            """),
            {"mid": media.id},
        ).fetchall()
        assert Counter(row[0] for row in rows) == {
            "bibliography_entry": 17,
            "bibliography_ref": 15,
            "footnote": 1,
        }
        assert Counter(row[1] for row in rows) == {
            "latex_biblatex_bibliography": 17,
            "latex_biblatex_citation": 15,
            "latex_footnote": 1,
        }
        assert {row[2] for row in rows} == {"missing"}
        assert {row[3]["format"] for row in rows} == {"arxiv_source"}
        assert {row[3]["arxiv_id"] for row in rows} == {"2606.01109"}
        assert {row[3]["sha256_hex"] for row in rows} == {hashlib.sha256(source_bytes).hexdigest()}

    def test_extract_pdf_artifacts_records_unsafe_arxiv_source_package_without_failing_pdf(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Unsafe arxiv source package")
        media = _create_pdf_media(db_session, storage, pdf_bytes)
        source_bytes = _tar_bytes([("../main.tex", b"\\begin{document}\\cite{a}\\end{document}")])
        source_path = f"media/{media.id}/source/source-package.tar"
        storage.put_object(source_path, source_bytes, "application/x-tar")

        result = extract_pdf_artifacts(
            db_session,
            media.id,
            storage,
            source_package=PdfSourcePackageArtifact(
                storage_path=source_path,
                content_type="application/x-tar",
                size_bytes=len(source_bytes),
                sha256_hex=hashlib.sha256(source_bytes).hexdigest(),
                source_url="https://arxiv.org/e-print/2606.01109",
                source_kind="arxiv_source",
                source_ref={"arxiv_id": "2606.01109"},
            ),
        )

        assert isinstance(result, PdfExtractionResult)
        refreshed = db_session.get(Media, media.id)
        assert refreshed.page_count == 1
        assert refreshed.plain_text is not None
        apparatus_state = db_session.execute(
            text("""
                SELECT status, item_count, edge_count, diagnostics
                FROM reader_apparatus_states
                WHERE media_id = :mid
            """),
            {"mid": media.id},
        ).one()
        assert tuple(apparatus_state[:3]) == ("empty", 0, 0)
        assert apparatus_state[3]["arxiv_source_package"] == {
            "status": "unsafe_archive",
            "storage_path": source_path,
            "source_url": "https://arxiv.org/e-print/2606.01109",
            "reason": "path_traversal",
        }
        assert (
            db_session.execute(
                text("SELECT count(*) FROM reader_apparatus_items WHERE media_id = :mid"),
                {"mid": media.id},
            ).scalar_one()
            == 0
        )
        assert (
            db_session.execute(
                text("SELECT count(*) FROM reader_apparatus_edges WHERE media_id = :mid"),
                {"mid": media.id},
            ).scalar_one()
            == 0
        )

    def test_extract_pdf_artifacts_handles_image_only_pdf_without_quote_text_artifacts(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_image_only_pdf()
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionResult)
        assert result.page_count >= 1
        assert result.has_text is False

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

    def test_extract_pdf_artifacts_password_protected_pdf_returns_terminal_error(
        self, db_session: Session
    ):
        storage = FakeStorageClient()
        pdf_bytes = _make_password_pdf()
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = extract_pdf_artifacts(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionError)
        assert result.error_code == ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value
        assert result.terminal is True

    def test_extract_pdf_artifacts_invalid_pdf_returns_parser_agnostic_error(
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

    def test_run_pdf_ingest_sync_returns_pdf_extraction_result(self, db_session: Session):
        storage = FakeStorageClient()
        pdf_bytes = _make_simple_pdf("Sync test")
        media = _create_pdf_media(db_session, storage, pdf_bytes)

        result = run_pdf_ingest_sync(db_session, media.id, storage)

        assert isinstance(result, PdfExtractionResult)
        assert result.has_text is True


@pytest.mark.unit
def test_pdf_legal_footnote_apparatus_extracts_paired_geometry_fixture():
    pdf_bytes = (Path(__file__).parent / "fixtures/pdf/law-review-footnotes.pdf").read_bytes()

    result = _extract_pdf_legal_footnote_apparatus(pdf_bytes, media_id=uuid4())

    assert result.status == "ready"
    assert Counter(item["kind"] for item in result.items) == {
        "footnote": 10,
        "footnote_ref": 10,
    }
    assert Counter(item["confidence"] for item in result.items) == {"strong": 20}
    assert Counter(item["extraction_method"] for item in result.items) == {
        "pdf_legal_footnote_target": 10,
        "pdf_legal_footnote_marker": 10,
    }
    assert Counter(edge["relation"] for edge in result.edges) == {"points_to_note": 10}
    assert Counter(edge["extraction_method"] for edge in result.edges) == {
        "pdf_legal_footnote_pair": 10
    }
    assert {item["locator"]["type"] for item in result.items if item.get("locator")} == {
        "pdf_page_geometry"
    }
    assert result.diagnostics["pdf_legal_footnotes"]["status"] == "targets_materialized"


@pytest.mark.unit
def test_pdf_native_link_apparatus_keeps_marker_rows_when_targets_do_not_materialize():
    result = _extract_pdf_native_link_apparatus(
        _make_native_link_partial_marker_pdf(),
        media_id=uuid4(),
    )

    assert result.status == "partial"
    assert Counter(item["kind"] for item in result.items) == {"bibliography_ref": 2}
    assert Counter(item["extraction_method"] for item in result.items) == {"pdf_native_link": 2}
    assert {str(item["label"]) for item in result.items} == {"[U]", "[X]"}
    assert result.edges == []

    source_refs = {str(item["label"]): item["source_ref"] for item in result.items}
    assert source_refs["[U]"]["named_destination"] == "cite.unresolved"
    assert source_refs["[X]"]["named_destination"] == "cite.outsideColumn"
    assert source_refs["[U]"]["destination_page_number"] == 2
    assert source_refs["[X]"]["destination_page_number"] == 2

    diagnostics = result.diagnostics["pdf_native_link"]
    assert diagnostics == {
        "status": "target_materialization_partial",
        "marker_count": 2,
        "target_count": 0,
        "edge_count": 0,
        "unresolved_marker_count": 2,
        "total_link_count": 2,
        "internal_link_count": 2,
        "citation_link_count": 2,
        "skipped": {"missing_reference_target": 2},
    }


@pytest.mark.unit
def test_pdf_reference_block_for_destination_rejects_ambiguous_vertical_target():
    import fitz

    doc = fitz.open()
    doc.new_page(width=612, height=792)
    try:
        target = _pdf_reference_block_for_destination(
            doc=doc,
            destination_page_index=0,
            destination_point=fitz.Point(80, 692),
            reference_blocks=[
                PdfReferenceBlock(
                    page_index=0,
                    label="[1]",
                    label_number=1,
                    body_text="[1] First reference.",
                    rect_coords=(72, 100.0, 180, 110),
                ),
                PdfReferenceBlock(
                    page_index=0,
                    label="[2]",
                    label_number=2,
                    body_text="[2] Second reference.",
                    rect_coords=(72, 100.1, 180, 110.1),
                ),
            ],
        )
    finally:
        doc.close()

    assert target is None


@pytest.mark.unit
def test_pdf_legal_footnote_apparatus_rejects_unpaired_marker():
    result = _extract_pdf_legal_footnote_apparatus(_make_unpaired_marker_pdf(), media_id=uuid4())

    assert result.status == "empty"
    assert result.items == []
    assert result.edges == []
    assert result.diagnostics["pdf_legal_footnotes"]["status"] == "no_supported_legal_footnotes"


@pytest.mark.unit
def test_pdf_legal_footnote_apparatus_rejects_lower_page_numbered_legend():
    result = _extract_pdf_legal_footnote_apparatus(
        _make_numbered_lower_page_legend_pdf(),
        media_id=uuid4(),
    )

    assert result.status == "empty"
    assert result.items == []
    assert result.edges == []
    diagnostics = result.diagnostics["pdf_legal_footnotes"]
    assert diagnostics["status"] == "no_supported_legal_footnotes"
    assert diagnostics["skipped"]["target_body_not_footnote_style"] >= 1


@pytest.mark.unit
def test_pdf_legal_footnote_apparatus_rejects_non_contiguous_labels():
    result = _extract_pdf_legal_footnote_apparatus(
        _make_non_contiguous_legal_footnote_pdf(),
        media_id=uuid4(),
    )

    assert result.status == "empty"
    assert result.items == []
    assert result.edges == []
    diagnostics = result.diagnostics["pdf_legal_footnotes"]
    assert diagnostics["status"] == "ambiguous_target_labels"
    assert diagnostics["skipped"] == {"non_contiguous_target_labels": 1}


@pytest.mark.unit
def test_pdf_legal_footnote_apparatus_rejects_duplicate_markers():
    result = _extract_pdf_legal_footnote_apparatus(
        _make_duplicate_marker_legal_footnote_pdf(),
        media_id=uuid4(),
    )

    assert result.status == "empty"
    assert result.items == []
    assert result.edges == []
    diagnostics = result.diagnostics["pdf_legal_footnotes"]
    assert diagnostics["status"] == "ambiguous_marker_targets"
    assert diagnostics["skipped"] == {"ambiguous_marker": 1}


@pytest.mark.unit
def test_pdf_legal_footnote_apparatus_rejects_same_line_target_body():
    result = _extract_pdf_legal_footnote_apparatus(
        _make_same_line_target_legal_footnote_pdf(),
        media_id=uuid4(),
    )

    assert result.status == "empty"
    assert result.items == []
    assert result.edges == []
    assert result.diagnostics["pdf_legal_footnotes"]["status"] == "no_supported_legal_footnotes"


class TestBuildPdfAuthorObservation:
    """`build_pdf_author_observation` — the PDF `author` observation (D-31).

    D-31 reverses the old comma-splitting: `Last, First` is ONE name and only
    semicolons separate people. These assert observation *shape* — the values
    the runner hands to the author facade — not any DB effect.
    """

    @staticmethod
    def _observe(pdf_author: str | None):
        from nexus.services.pdf_metadata import build_pdf_author_observation

        return build_pdf_author_observation(PdfExtractionResult(pdf_author=pdf_author))

    def test_last_comma_first_is_one_name(self):
        from nexus.services.contributor_taxonomy import ObservedRoleSlices

        batch, truncated = self._observe("Melville, Herman")
        assert isinstance(batch, ObservedRoleSlices)
        assert batch.managed_roles == frozenset({"author"})
        assert [c.credited_name for c in batch.credits] == ["Melville, Herman"]
        assert all(c.role == "author" for c in batch.credits)
        assert truncated == {}

    def test_semicolons_separate_people_and_preserve_commas(self):
        from nexus.services.contributor_taxonomy import ObservedRoleSlices

        batch, _ = self._observe("Smith, John; Doe, Jane")
        assert isinstance(batch, ObservedRoleSlices)
        assert [c.credited_name for c in batch.credits] == ["Smith, John", "Doe, Jane"]

    def test_duplicate_names_dedupe(self):
        from nexus.services.contributor_taxonomy import ObservedRoleSlices

        batch, _ = self._observe("Ada Lovelace; ada lovelace")
        assert isinstance(batch, ObservedRoleSlices)
        assert [c.credited_name for c in batch.credits] == ["Ada Lovelace"]

    def test_no_author_is_not_observed(self):
        from nexus.services.contributor_taxonomy import NotObserved

        for value in (None, "", "   ", ";  ; "):
            batch, truncated = self._observe(value)
            assert isinstance(batch, NotObserved)
            assert truncated == {}

    def test_over_twenty_authors_truncate_with_count_only(self):
        from nexus.services.contributor_taxonomy import ObservedRoleSlices

        raw = "; ".join(f"Author {i:02d}" for i in range(25))
        batch, truncated = self._observe(raw)
        assert isinstance(batch, ObservedRoleSlices)
        assert len(batch.credits) == 20
        assert truncated == {"author": 5}

    def test_no_identity_key(self):
        from nexus.services.contributor_taxonomy import ObservedRoleSlices

        batch, _ = self._observe("Grace Hopper")
        assert isinstance(batch, ObservedRoleSlices)
        assert batch.credits[0].identity_key is None
