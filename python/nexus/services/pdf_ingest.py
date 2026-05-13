"""PDF extraction domain service (S6 PR-03).

Owns deterministic PDF artifact production: page_count, normalized plain_text,
and pdf_page_text_spans. Parser-specific behavior (PyMuPDF) is isolated here
behind parser-agnostic typed outcomes.

Does NOT own lifecycle transitions or background-job dispatch.
"""

import hashlib
import re
import time
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Media,
    PdfPageTextSpan,
)
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

TEXT_EXTRACT_VERSION = 1


# ---------------------------------------------------------------------------
# Parser-agnostic typed outcomes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PdfPageSpan:
    page_number: int
    start_offset: int
    end_offset: int
    page_label: str | None = None
    page_width: float | None = None
    page_height: float | None = None
    page_rotation_degrees: int | None = None


@dataclass(frozen=True)
class PdfExtractionResult:
    """Successful PDF extraction outcome."""

    status: str = "success"
    page_count: int = 0
    plain_text: str = ""
    page_spans: list[PdfPageSpan] = field(default_factory=list)
    has_text: bool = False
    source_fingerprint: str | None = None
    source_byte_length: int = 0
    text_extract_version: int = TEXT_EXTRACT_VERSION
    extraction_method: str = "digital_text"
    ocr_engine: str | None = None
    ocr_engine_version: str | None = None
    ocr_confidence: float | None = None
    pdf_title: str | None = None
    pdf_author: str | None = None
    pdf_subject: str | None = None
    pdf_creation_date: str | None = None


@dataclass(frozen=True)
class PdfExtractionError:
    """Deterministic PDF extraction failure."""

    status: str = "error"
    error_code: str = ""
    error_message: str = ""
    terminal: bool = False


# ---------------------------------------------------------------------------
# S6 plain_text normalization (spec Section 2.1)
# ---------------------------------------------------------------------------


def normalize_pdf_text(raw_text: str) -> str:
    """Apply S6 normalization contract to raw PDF text.

    1. \\r\\n and \\r -> \\n
    2. form-feed (\\f) -> \\n\\n (page separator)
    3. NBSP (\\u00A0) -> space
    4. NUL byte (\\x00) -> removed (PostgreSQL text cannot store NUL)
    5. collapse runs of spaces/tabs within a line to single space
    6. collapse 3+ consecutive newlines to \\n\\n
    7. trim leading/trailing whitespace
    """
    s = raw_text
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("\f", "\n\n")
    s = s.replace("\u00a0", " ")
    s = s.replace("\x00", "")
    s = re.sub(r"[^\S\n]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    s = s.strip()
    return s


# ---------------------------------------------------------------------------
# PDF date parsing
# ---------------------------------------------------------------------------


def _parse_pdf_date(raw: str | None) -> str | None:
    """Normalize PDF date format D:YYYYMMDDHHmmSS... to ISO 8601.

    Common formats:
      D:20230115120000+05'30'
      D:20230115
      2023-01-15
      2023
    Returns None if unparseable.
    """
    if not raw or not raw.strip():
        return None

    s = raw.strip()
    # Strip leading "D:" prefix
    if s.startswith("D:"):
        s = s[2:]

    # Try ISO format with separators first (e.g. "2023-01-15", "2023-01")
    iso_match = re.match(r"^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", s)
    if iso_match and "-" in s[:8]:
        year = iso_match.group(1)
        month = iso_match.group(2)
        day = iso_match.group(3)
        if month:
            m = int(month)
            if m < 1 or m > 12:
                return year
            if day:
                d = int(day)
                if d < 1 or d > 31:
                    return f"{year}-{int(month):02d}"
                return f"{year}-{int(month):02d}-{int(day):02d}"
            return f"{year}-{int(month):02d}"
        return year

    # PDF compact format: YYYYMMDD...
    digits = ""
    for ch in s:
        if ch.isdigit():
            digits += ch
        else:
            break

    if len(digits) < 4:
        return None

    year = digits[:4]
    month = digits[4:6] if len(digits) >= 6 else None
    day = digits[6:8] if len(digits) >= 8 else None

    if month:
        m = int(month)
        if m < 1 or m > 12:
            return year
        if day:
            d = int(day)
            if d < 1 or d > 31:
                return f"{year}-{month}"
            return f"{year}-{month}-{day}"
        return f"{year}-{month}"
    return year


# ---------------------------------------------------------------------------
# PyMuPDF parser adapter
# ---------------------------------------------------------------------------


def _extract_with_pymupdf(
    pdf_bytes: bytes,
) -> PdfExtractionResult | PdfExtractionError:
    """Extract text from PDF bytes using PyMuPDF.

    Returns parser-agnostic typed outcome. All PyMuPDF-specific exceptions
    are caught and mapped here.
    """
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return PdfExtractionError(
            error_code=ApiErrorCode.E_INTERNAL.value,
            error_message="PyMuPDF not installed",
            terminal=False,
        )

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:
        err_str = str(exc).lower()
        if "password" in err_str or "encrypted" in err_str:
            return PdfExtractionError(
                error_code=ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value,
                error_message="PDF is password-protected or encrypted",
                terminal=True,
            )
        return PdfExtractionError(
            error_code=ApiErrorCode.E_INGEST_FAILED.value,
            error_message=f"Failed to open PDF: {exc}",
            terminal=False,
        )

    if doc.needs_pass:
        doc.close()
        return PdfExtractionError(
            error_code=ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value,
            error_message="PDF is password-protected or encrypted",
            terminal=True,
        )

    source_fingerprint = f"sha256:{hashlib.sha256(pdf_bytes).hexdigest()}"

    # Read document metadata
    raw_meta = doc.metadata or {}
    pdf_title = (raw_meta.get("title") or "").strip() or None
    pdf_author = (raw_meta.get("author") or "").strip() or None
    pdf_subject = (raw_meta.get("subject") or "").strip() or None
    pdf_creation_date = _parse_pdf_date(raw_meta.get("creationDate"))

    try:
        page_count = len(doc)
        if page_count < 1:
            return PdfExtractionError(
                error_code=ApiErrorCode.E_INGEST_FAILED.value,
                error_message="PDF has zero pages",
                terminal=False,
            )

        raw_page_texts: list[str] = []
        page_labels: list[str | None] = []
        page_sizes: list[tuple[float, float] | None] = []
        page_rotations: list[int | None] = []
        for page_num in range(page_count):
            try:
                page = doc[page_num]
                page_text = str(page.get_text("text") or "")
                try:
                    raw_page_label = page.get_label()
                except AttributeError:
                    raw_page_label = None
                except RuntimeError:
                    raw_page_label = None
                page_label = (
                    raw_page_label.strip()
                    if isinstance(raw_page_label, str) and raw_page_label.strip()
                    else None
                )
                page_rect = page.rect
                page_size = (float(page_rect.width), float(page_rect.height))
                page_rotation = int(page.rotation or 0)
            except Exception:
                page_text = ""
                page_label = None
                page_size = None
                page_rotation = None
            raw_page_texts.append(page_text)
            page_labels.append(page_label)
            page_sizes.append(page_size)
            page_rotations.append(page_rotation)

        combined_raw = "\f".join(raw_page_texts)
        normalized = normalize_pdf_text(combined_raw)

        normalized_pages = _build_page_texts_from_raw(raw_page_texts)

        if not normalized:
            return PdfExtractionResult(
                page_count=page_count,
                plain_text="",
                page_spans=_build_page_spans(
                    normalized_pages,
                    normalized,
                    page_count,
                    page_labels,
                    page_sizes,
                    page_rotations,
                ),
                has_text=False,
                source_fingerprint=source_fingerprint,
                source_byte_length=len(pdf_bytes),
                pdf_title=pdf_title,
                pdf_author=pdf_author,
                pdf_subject=pdf_subject,
                pdf_creation_date=pdf_creation_date,
            )

        page_spans = _build_page_spans(
            normalized_pages,
            normalized,
            page_count,
            page_labels,
            page_sizes,
            page_rotations,
        )

        return PdfExtractionResult(
            page_count=page_count,
            plain_text=normalized,
            page_spans=page_spans,
            has_text=True,
            source_fingerprint=source_fingerprint,
            source_byte_length=len(pdf_bytes),
            pdf_title=pdf_title,
            pdf_author=pdf_author,
            pdf_subject=pdf_subject,
            pdf_creation_date=pdf_creation_date,
        )
    finally:
        doc.close()


def _build_page_texts_from_raw(raw_page_texts: list[str]) -> list[str]:
    """Normalize each page text individually for span offset construction."""
    result = []
    for raw in raw_page_texts:
        normed = normalize_pdf_text(raw)
        result.append(normed)
    return result


def _build_page_spans(
    normalized_pages: list[str],
    full_normalized: str,
    page_count: int,
    page_labels: list[str | None] | None = None,
    page_sizes: list[tuple[float, float] | None] | None = None,
    page_rotations: list[int | None] | None = None,
) -> list[PdfPageSpan]:
    """Build page-indexed spans over the post-normalization plain_text.

    Reconstructs the full text from normalized pages joined by \\n\\n separators
    (same as normalize_pdf_text produces from \\f joins) and maps offsets.
    """
    spans: list[PdfPageSpan] = []
    offset = 0

    for i, page_text in enumerate(normalized_pages):
        page_len = len(page_text)
        page_size = page_sizes[i] if page_sizes and i < len(page_sizes) else None
        spans.append(
            PdfPageSpan(
                page_number=i + 1,
                start_offset=offset,
                end_offset=offset + page_len,
                page_label=page_labels[i] if page_labels and i < len(page_labels) else None,
                page_width=page_size[0] if page_size else None,
                page_height=page_size[1] if page_size else None,
                page_rotation_degrees=(
                    page_rotations[i] if page_rotations and i < len(page_rotations) else None
                ),
            )
        )
        offset += page_len
        if i < len(normalized_pages) - 1 and page_text:
            sep_len = _separator_len_at(full_normalized, offset)
            offset += sep_len
        elif i < len(normalized_pages) - 1 and not page_text:
            pass

    while len(spans) < page_count:
        page_index = len(spans)
        page_size = page_sizes[page_index] if page_sizes and page_index < len(page_sizes) else None
        spans.append(
            PdfPageSpan(
                page_number=page_index + 1,
                start_offset=offset,
                end_offset=offset,
                page_label=(
                    page_labels[page_index]
                    if page_labels and page_index < len(page_labels)
                    else None
                ),
                page_width=page_size[0] if page_size else None,
                page_height=page_size[1] if page_size else None,
                page_rotation_degrees=(
                    page_rotations[page_index]
                    if page_rotations and page_index < len(page_rotations)
                    else None
                ),
            )
        )

    return spans


def _separator_len_at(text: str, offset: int) -> int:
    """Determine how many separator chars exist at offset in normalized text."""
    count = 0
    while offset + count < len(text) and text[offset + count] == "\n":
        count += 1
    return count


# ---------------------------------------------------------------------------
# Lifecycle-level span validation
# ---------------------------------------------------------------------------


def validate_page_spans(
    page_spans: list[PdfPageSpan],
    page_count: int,
    plain_text_len: int,
) -> str | None:
    """Validate page-span lifecycle invariants.

    Returns None if valid, or an error description string if invalid.
    """
    if len(page_spans) != page_count:
        return f"Expected {page_count} spans, got {len(page_spans)}"

    for i, span in enumerate(page_spans):
        expected_page = i + 1
        if span.page_number != expected_page:
            return f"Span {i} has page_number={span.page_number}, expected {expected_page}"
        if span.start_offset < 0:
            return f"Page {expected_page}: negative start_offset"
        if span.end_offset < span.start_offset:
            return f"Page {expected_page}: end_offset < start_offset"
        if span.end_offset > plain_text_len:
            return (
                f"Page {expected_page}: end_offset {span.end_offset} > text length {plain_text_len}"
            )

    for i in range(1, len(page_spans)):
        prev = page_spans[i - 1]
        curr = page_spans[i]
        if curr.start_offset < prev.end_offset:
            return f"Pages {prev.page_number}-{curr.page_number}: overlapping spans"

    return None


# ---------------------------------------------------------------------------
# Public extraction API (parser-agnostic)
# ---------------------------------------------------------------------------


def extract_pdf_artifacts(
    db: Session,
    media_id: UUID,
    storage_client,
) -> PdfExtractionResult | PdfExtractionError:
    """Extract and persist PDF text artifacts.

    On success with text: persists page_count, plain_text, and pdf_page_text_spans
    atomically. On success without text (scanned): persists page_count only.
    On failure: persists nothing (caller owns failure marking).
    """
    media = db.get(Media, media_id)
    if media is None:
        return PdfExtractionError(
            error_code=ApiErrorCode.E_MEDIA_NOT_FOUND.value,
            error_message="Media not found",
        )

    media_file = media.media_file
    if not media_file:
        return PdfExtractionError(
            error_code=ApiErrorCode.E_STORAGE_MISSING.value,
            error_message="No media file record",
        )

    t0 = time.monotonic()

    try:
        pdf_bytes = b"".join(storage_client.stream_object(media_file.storage_path))
    except Exception as exc:
        return PdfExtractionError(
            error_code=ApiErrorCode.E_STORAGE_ERROR.value,
            error_message=f"Failed to read PDF from storage: {exc}",
        )

    result = _extract_with_pymupdf(pdf_bytes)
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    if isinstance(result, PdfExtractionError):
        logger.warning(
            "pdf_extraction_failed",
            media_id=str(media_id),
            error_code=result.error_code,
            parser="pymupdf",
            elapsed_ms=elapsed_ms,
            file_size=len(pdf_bytes),
        )
        return result

    logger.info(
        "pdf_extraction_completed",
        media_id=str(media_id),
        page_count=result.page_count,
        has_text=result.has_text,
        plain_text_len=len(result.plain_text),
        parser="pymupdf",
        elapsed_ms=elapsed_ms,
        file_size=len(pdf_bytes),
    )

    if result.has_text:
        validation_err = validate_page_spans(
            result.page_spans,
            result.page_count,
            len(result.plain_text),
        )
        if validation_err:
            logger.error(
                "pdf_page_span_invariant_failure",
                media_id=str(media_id),
                reason=validation_err,
            )
            return PdfExtractionError(
                error_code=ApiErrorCode.E_INGEST_FAILED.value,
                error_message=f"Page span invariant failure: {validation_err}",
                terminal=False,
            )

        media.page_count = result.page_count
        media.plain_text = result.plain_text

        db.execute(delete(PdfPageTextSpan).where(PdfPageTextSpan.media_id == media_id))

        for span in result.page_spans:
            db.add(
                PdfPageTextSpan(
                    media_id=media_id,
                    page_number=span.page_number,
                    start_offset=span.start_offset,
                    end_offset=span.end_offset,
                    text_extract_version=TEXT_EXTRACT_VERSION,
                    page_label=span.page_label,
                    page_width=span.page_width,
                    page_height=span.page_height,
                    page_rotation_degrees=span.page_rotation_degrees,
                )
            )
        db.flush()
    else:
        media.page_count = result.page_count
        media.plain_text = None
        db.execute(delete(PdfPageTextSpan).where(PdfPageTextSpan.media_id == media_id))
        db.flush()

    return result


# ---------------------------------------------------------------------------
# Invalidation helpers (S6 Section 2.4 lifecycle step 6)
# ---------------------------------------------------------------------------


def invalidate_pdf_quote_match_metadata(db: Session, media_id: UUID) -> int:
    """Reset PDF quote-match metadata for all highlights on a media.

    Sets plain_text_match_status='pending', clears offsets/version,
    and clears prefix/suffix on the parent highlights row.
    Preserves geometry and exact text.

    Returns the count of invalidated highlight_pdf_anchors rows.
    """
    result = db.execute(
        text("""
            UPDATE highlight_pdf_anchors
            SET plain_text_match_status = 'pending',
                plain_text_match_version = NULL,
                plain_text_start_offset = NULL,
                plain_text_end_offset = NULL
            WHERE media_id = :media_id
              AND plain_text_match_status != 'pending'
            RETURNING highlight_id
        """),
        {"media_id": media_id},
    )
    affected_ids = [row[0] for row in result.fetchall()]

    if affected_ids:
        db.execute(
            text("""
                UPDATE highlights
                SET prefix = '',
                    suffix = '',
                    updated_at = now()
                WHERE id = ANY(:ids)
            """),
            {"ids": affected_ids},
        )

    db.flush()
    return len(affected_ids)


def delete_pdf_text_artifacts(db: Session, media_id: UUID) -> None:
    """Delete PDF text artifacts (plain_text, page_count, pdf_page_text_spans).

    Used before text-rebuild retry paths.
    """
    from nexus.services.content_indexing import deactivate_media_content_index

    deactivate_media_content_index(db, media_id=media_id, reason="pdf_text_rebuild")
    db.execute(delete(PdfPageTextSpan).where(PdfPageTextSpan.media_id == media_id))
    db.execute(
        text("""
            UPDATE media
            SET plain_text = NULL,
                page_count = NULL,
                updated_at = now()
            WHERE id = :media_id
        """),
        {"media_id": media_id},
    )
    db.flush()
