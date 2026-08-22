"""PDF extraction domain service.

Owns deterministic PDF artifact production: page_count, normalized plain_text,
and pdf_page_text_spans. Parser-specific behavior (PyMuPDF) is isolated here
behind parser-agnostic typed outcomes.

Does NOT own lifecycle transitions or background-job dispatch.
"""

import re
import tarfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    Media,
    PdfPageTextSpan,
)
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger
from nexus.services.latex_apparatus import (
    LatexSourceArchiveUnsafe,
    extract_latex_biblatex_apparatus_from_archive,
)
from nexus.services.parser_temp import (
    nested_utf8_byte_length,
    parser_attempt_directory,
    stream_storage_object_to_file,
    utf8_byte_length,
)
from nexus.services.pdf_highlight_geometry import (
    GeometryValidationError,
    canonicalize_geometry,
    validate_exact_length,
)
from nexus.services.reader_apparatus import (
    replace_media_apparatus,
    source_fingerprint,
)
from nexus.storage.client import StorageError
from nexus.text import normalize_whitespace

logger = get_logger(__name__)

PDF_EXTRACTED_TEXT_MAX_BYTES = 32 * 1024 * 1024
PDF_MAX_PAGES = 10_000
PDF_APPARATUS_MAX_ITEMS = 2_000
PDF_APPARATUS_MAX_EDGES = 2_000
PDF_APPARATUS_MAX_RETAINED_UTF8_BYTES = 8 * 1024 * 1024

_PDF_REFERENCE_LINK_Y_TOLERANCE_PT = 5.0
_PDF_REFERENCE_LINK_X_TOLERANCE_PT = 2.0
_PDF_REFERENCE_LINK_AMBIGUOUS_DELTA_PT = 0.25
_PDF_LEGAL_FOOTNOTE_BAND_TOP_RATIO = 0.55
_PDF_LEGAL_FOOTNOTE_LABEL_X_MAX = 120.0
_PDF_LEGAL_FOOTNOTE_LINE_Y_TOLERANCE_PT = 3.0
_PDF_LEGAL_FOOTNOTE_MARKER_SIZE_RATIO = 0.75
_PDF_LEGAL_FOOTNOTE_TARGET_SIZE_RATIO = 0.75

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

    page_count: int = 0
    plain_text: str = ""
    page_spans: list[PdfPageSpan] = field(default_factory=list)
    has_text: bool = False
    source_byte_length: int = 0
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

    error_code: str = ""
    error_message: str = ""
    terminal: bool = False


@dataclass(frozen=True)
class PdfApparatusResult:
    status: str = "empty"
    items: list[dict[str, object]] = field(default_factory=list)
    edges: list[dict[str, object]] = field(default_factory=list)
    diagnostics: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class PdfSourcePackageArtifact:
    storage_path: str
    content_type: str
    size_bytes: int
    sha256_hex: str
    source_url: str
    source_kind: str
    source_ref: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class PdfExtractionPlan:
    result: PdfExtractionResult
    apparatus: PdfApparatusResult
    storage_path: str
    source_size_bytes: int
    source_sha256_hex: str
    source_package: PdfSourcePackageArtifact | None
    source_package_diagnostics: dict[str, object] | None


@dataclass(frozen=True)
class PdfReferenceBlock:
    page_index: int
    label: str
    label_number: int
    body_text: str
    rect_coords: tuple[float, float, float, float]


@dataclass(frozen=True)
class PdfLegalFootnoteTarget:
    label_number: int
    page_index: int
    body_text: str
    body_rect_coords: tuple[float, float, float, float]
    label_rect_coords: tuple[float, float, float, float]


@dataclass(frozen=True)
class PdfLegalFootnoteMarker:
    label_number: int
    page_index: int
    rect_coords: tuple[float, float, float, float]


@dataclass(frozen=True)
class _PdfParsedSource:
    result: PdfExtractionResult
    apparatus: PdfApparatusResult


@dataclass(frozen=True)
class _PdfNativeCitationLink:
    page_index: int
    link_index: int
    name: str
    destination_page_index: int
    destination_point: tuple[float, float] | None
    source_rect: tuple[float, float, float, float]
    exact: str
    link_xref: int | None


class _PdfResourceLimitExceeded(Exception):
    pass


@dataclass
class _PdfApparatusScan:
    in_references: bool = False
    reference_blocks: list[PdfReferenceBlock] = field(default_factory=list)
    native_links: list[_PdfNativeCitationLink] = field(default_factory=list)
    native_total_links: int = 0
    native_internal_links: int = 0
    native_skipped: dict[str, int] = field(default_factory=dict)
    legal_targets: list[PdfLegalFootnoteTarget] = field(default_factory=list)
    legal_marker_candidates: dict[int, list[PdfLegalFootnoteMarker]] = field(default_factory=dict)
    legal_skipped: dict[str, int] = field(default_factory=dict)
    page_heights: list[float | None] = field(default_factory=list)
    retained_item_count: int = 0
    retained_utf8_bytes: int = 0


# ---------------------------------------------------------------------------
# Plain-text normalization
# ---------------------------------------------------------------------------


def normalize_pdf_text(raw_text: str) -> str:
    """Apply the PDF text normalization contract to raw PDF text.

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
    pdf_path: Path,
    *,
    media_id: UUID,
    source_byte_length: int,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
) -> _PdfParsedSource | PdfExtractionError:
    """Extract bounded text from a file-backed PDF using PyMuPDF.

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
        doc = fitz.open(pdf_path)
    except RuntimeError as exc:
        err_str = str(exc).lower()
        if "password" in err_str or "encrypted" in err_str:
            return PdfExtractionError(
                error_code=ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value,
                error_message="PDF is password-protected or encrypted",
                terminal=True,
            )
        return PdfExtractionError(
            error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
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
                error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
                error_message="PDF has zero pages",
                terminal=False,
            )
        if page_count > PDF_MAX_PAGES:
            return _pdf_resource_limit_error(
                f"PDF has {page_count} pages; limit is {PDF_MAX_PAGES}"
            )

        normalized_pages: list[str] = []
        page_labels: list[str | None] = []
        page_sizes: list[tuple[float, float] | None] = []
        page_rotations: list[int | None] = []
        normalized_text_bytes = 0
        nonempty_page_count = 0
        apparatus_scan = _PdfApparatusScan()
        record_progress(0, page_count, "Page")
        for page_num in range(page_count):
            try:
                page = doc[page_num]
            except (RuntimeError, AttributeError, ValueError):
                page = None
            if page is None:
                page_text = ""
                page_label = None
                page_size = None
                page_rotation = None
                apparatus_scan.page_heights.append(None)
            else:
                try:
                    _scan_pdf_page_apparatus(apparatus_scan, page, page_num)
                except _PdfResourceLimitExceeded as exc:
                    return _pdf_resource_limit_error(str(exc))
                try:
                    page_text = str(page.get_text("text") or "")
                    try:
                        raw_page_label = page.get_label()
                    except (AttributeError, RuntimeError):
                        raw_page_label = None
                    page_label = (
                        raw_page_label.strip()
                        if isinstance(raw_page_label, str) and raw_page_label.strip()
                        else None
                    )
                    page_rect = page.rect
                    page_size = (float(page_rect.width), float(page_rect.height))
                    page_rotation = int(page.rotation or 0)
                except (RuntimeError, AttributeError, ValueError):
                    page_text = ""
                    page_label = None
                    page_size = None
                    page_rotation = None
            normalized_page = normalize_pdf_text(page_text)
            if normalized_page:
                if nonempty_page_count:
                    normalized_text_bytes += 2
                normalized_text_bytes += utf8_byte_length(normalized_page)
                nonempty_page_count += 1
            if normalized_text_bytes > PDF_EXTRACTED_TEXT_MAX_BYTES:
                return PdfExtractionError(
                    error_code=ApiErrorCode.E_SOURCE_TOO_LARGE.value,
                    error_message="PDF extracted text exceeds the 32 MiB limit",
                    terminal=True,
                )
            normalized_pages.append(normalized_page)
            page_labels.append(page_label)
            page_sizes.append(page_size)
            page_rotations.append(page_rotation)
            completed = page_num + 1
            if completed % 10 == 0 or completed == page_count:
                record_progress(completed, page_count, "Page")

        normalized = "\n\n".join(page for page in normalized_pages if page)

        if not normalized:
            result = PdfExtractionResult(
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
                source_byte_length=source_byte_length,
                pdf_title=pdf_title,
                pdf_author=pdf_author,
                pdf_subject=pdf_subject,
                pdf_creation_date=pdf_creation_date,
            )

        else:
            result = PdfExtractionResult(
                page_count=page_count,
                plain_text=normalized,
                page_spans=_build_page_spans(
                    normalized_pages,
                    normalized,
                    page_count,
                    page_labels,
                    page_sizes,
                    page_rotations,
                ),
                has_text=True,
                source_byte_length=source_byte_length,
                pdf_title=pdf_title,
                pdf_author=pdf_author,
                pdf_subject=pdf_subject,
                pdf_creation_date=pdf_creation_date,
            )
        try:
            apparatus = _merge_pdf_apparatus_results(
                _materialize_pdf_native_link_apparatus(apparatus_scan, media_id=media_id),
                _materialize_pdf_legal_footnote_apparatus(apparatus_scan, media_id=media_id),
            )
            _validate_pdf_apparatus_budget(apparatus)
        except _PdfResourceLimitExceeded as exc:
            return _pdf_resource_limit_error(str(exc))
        return _PdfParsedSource(result=result, apparatus=apparatus)
    finally:
        doc.close()


def _scan_pdf_page_apparatus(scan: _PdfApparatusScan, page, page_index: int) -> None:
    try:
        page_height = float(page.rect.height)
    except (AttributeError, TypeError, ValueError):
        page_height = None
    scan.page_heights.append(page_height)

    try:
        raw_page_blocks = page.get_text("blocks")
        if len(raw_page_blocks) > PDF_APPARATUS_MAX_ITEMS:
            raise _PdfResourceLimitExceeded("PDF page block count exceeds apparatus limit")
        page_blocks = sorted(raw_page_blocks, key=lambda block: (float(block[1]), float(block[0])))
    except (RuntimeError, TypeError, ValueError, IndexError):
        page_blocks = []
    for block in page_blocks:
        text_value = _normalize_pdf_block_text(str(block[4] or ""))
        if not text_value:
            continue
        if text_value == "References":
            scan.in_references = True
            continue
        if not scan.in_references:
            continue
        match = re.match(r"^\[(\d+)\]\s+", text_value)
        coords = _pdf_block_rect_coords(block)
        if match is None or coords is None:
            continue
        reference = PdfReferenceBlock(
            page_index=page_index,
            label=f"[{int(match.group(1))}]",
            label_number=int(match.group(1)),
            body_text=text_value,
            rect_coords=coords,
        )
        _retain_pdf_scan_item(scan, reference.label, reference.body_text)
        scan.reference_blocks.append(reference)

    try:
        links = page.get_links()
    except (RuntimeError, ValueError, AttributeError):
        links = []
    if len(links) > PDF_APPARATUS_MAX_ITEMS:
        raise _PdfResourceLimitExceeded("PDF page link count exceeds apparatus limit")
    for link_index, link in enumerate(links):
        scan.native_total_links += 1
        if "page" in link:
            scan.native_internal_links += 1
        name = str(link.get("nameddest") or "")
        if not name.startswith("cite."):
            _increment(scan.native_skipped, "non_citation_destination")
            continue
        if "uri" in link:
            _increment(scan.native_skipped, "external_uri")
            continue
        if "page" not in link:
            _increment(scan.native_skipped, "missing_destination_page")
            continue
        source_rect = _pdf_rect_coords(link.get("from"))
        if source_rect is None:
            _increment(scan.native_skipped, "missing_source_rect")
            continue
        exact = _pdf_link_text(page, link.get("from")).strip()
        if not exact:
            _increment(scan.native_skipped, "missing_marker_text")
            continue
        try:
            validate_exact_length(exact)
            canonicalize_geometry(page_index + 1, [_quad_from_rect_coords(source_rect)])
            destination_page_index = int(link["page"])
        except (GeometryValidationError, TypeError, ValueError):
            _increment(scan.native_skipped, "invalid_geometry")
            continue
        destination_point = _pdf_point_coords(link.get("to"))
        citation_link = _PdfNativeCitationLink(
            page_index=page_index,
            link_index=link_index,
            name=name,
            destination_page_index=destination_page_index,
            destination_point=destination_point,
            source_rect=source_rect,
            exact=exact,
            link_xref=(int(link["xref"]) if isinstance(link.get("xref"), int) else None),
        )
        _retain_pdf_scan_item(scan, citation_link.name, citation_link.exact)
        scan.native_links.append(citation_link)

    try:
        lines = _pdf_text_lines(page)
        if len(lines) > PDF_APPARATUS_MAX_ITEMS:
            raise _PdfResourceLimitExceeded("PDF page line count exceeds apparatus limit")
        body_font_size = _pdf_body_font_size(page, lines)
        page_targets = _pdf_legal_footnote_targets_for_page(
            page,
            page_index,
            lines,
            body_font_size=body_font_size,
            skipped=scan.legal_skipped,
        )
        for target in page_targets:
            _retain_pdf_scan_item(scan, target.body_text)
            scan.legal_targets.append(target)
        target_labels = {target.label_number for target in page_targets}
        for marker in _pdf_legal_footnote_markers_for_page(
            page,
            page_index,
            lines,
            target_labels=target_labels,
            body_font_size=body_font_size,
        ):
            _retain_pdf_scan_item(scan)
            scan.legal_marker_candidates.setdefault(marker.label_number, []).append(marker)
    except (RuntimeError, ValueError, AttributeError, TypeError, IndexError):
        _increment(scan.legal_skipped, "page_parse_failed")


def _retain_pdf_scan_item(scan: _PdfApparatusScan, *text_values: str) -> None:
    next_count = scan.retained_item_count + 1
    if next_count > PDF_APPARATUS_MAX_ITEMS:
        raise _PdfResourceLimitExceeded("PDF apparatus retained item count exceeds limit")
    next_bytes = scan.retained_utf8_bytes + sum(utf8_byte_length(value) for value in text_values)
    if next_bytes > PDF_APPARATUS_MAX_RETAINED_UTF8_BYTES:
        raise _PdfResourceLimitExceeded("PDF apparatus retained text exceeds 8 MiB limit")
    scan.retained_item_count = next_count
    scan.retained_utf8_bytes = next_bytes


def _materialize_pdf_native_link_apparatus(
    scan: _PdfApparatusScan,
    *,
    media_id: UUID,
) -> PdfApparatusResult:
    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    target_key_by_destination: dict[str, str] = {}
    target_key_by_block: dict[str, str] = {}
    for link in scan.native_links:
        stable_key = (
            "pdf:native-citation-ref:"
            f"{link.page_index + 1:04d}:{link.link_index:04d}:{_stable_token(link.name)}"
        )
        geometry = canonicalize_geometry(
            link.page_index + 1,
            [_quad_from_rect_coords(link.source_rect)],
        )
        marker_source_ref = {
            "format": "pdf",
            "page_number": link.page_index + 1,
            "link_index": link.link_index,
            "link_xref": link.link_xref,
            "named_destination": link.name,
            "destination_page_number": link.destination_page_index + 1,
            "destination_point": _pdf_point_json(link.destination_point),
            "source_rect": _pdf_rect_json(link.source_rect),
        }
        items.append(
            {
                "stable_key": stable_key,
                "kind": "bibliography_ref",
                "label": link.exact,
                "body_text": None,
                "body_html_sanitized": None,
                "locator": {
                    "type": "pdf_page_geometry",
                    "media_id": str(media_id),
                    "page_number": link.page_index + 1,
                    "quads": [_quad_json(quad) for quad in geometry.quads],
                    "exact": link.exact,
                    "text_quote_selector": {"exact": link.exact},
                },
                "locator_status": "exact",
                "confidence": "exact",
                "extraction_method": "pdf_native_link",
                "source_ref": marker_source_ref,
                "sort_key": f"{link.page_index + 1:04d}.{link.link_index:04d}.marker",
            }
        )
        target_key = target_key_by_destination.get(link.name)
        if target_key is None:
            target = _pdf_reference_block_for_destination(
                destination_page_index=link.destination_page_index,
                destination_point=link.destination_point,
                reference_blocks=scan.reference_blocks,
                page_heights=scan.page_heights,
            )
            if target is None:
                _increment(scan.native_skipped, "missing_reference_target")
            else:
                block_key = _pdf_reference_block_key(target)
                target_key = target_key_by_block.get(block_key)
                if target_key is None:
                    target_item = _pdf_native_link_target_item(
                        media_id=media_id,
                        destination_name=link.name,
                        destination_point=link.destination_point,
                        target=target,
                        skipped=scan.native_skipped,
                    )
                    if target_item is not None:
                        target_key = str(target_item["stable_key"])
                        target_key_by_block[block_key] = target_key
                        items.append(target_item)
                if target_key is not None:
                    target_key_by_destination[link.name] = target_key
        if target_key is not None:
            edges.append(
                {
                    "stable_key": f"{stable_key}->{target_key}",
                    "from_stable_key": stable_key,
                    "to_stable_key": target_key,
                    "relation": "cites_bibliography_entry",
                    "confidence": "exact",
                    "extraction_method": "pdf_native_link_target",
                    "source_ref": marker_source_ref,
                    "sort_key": f"{link.page_index + 1:04d}.{link.link_index:04d}.edge",
                }
            )

    unresolved_marker_count = len(scan.native_links) - len(edges)
    if not items:
        state_status = "empty"
        status = "no_supported_citation_links"
    elif unresolved_marker_count == 0 and edges:
        state_status = "ready"
        status = "targets_materialized"
    else:
        state_status = "partial"
        status = "target_materialization_partial"
    return PdfApparatusResult(
        status=state_status,
        items=items,
        edges=edges,
        diagnostics={
            "pdf_native_link": {
                "status": status,
                "marker_count": len(scan.native_links),
                "target_count": len(target_key_by_block),
                "edge_count": len(edges),
                "unresolved_marker_count": unresolved_marker_count,
                "total_link_count": scan.native_total_links,
                "internal_link_count": scan.native_internal_links,
                "citation_link_count": len(scan.native_links),
                "skipped": scan.native_skipped,
            }
        },
    )


def _materialize_pdf_legal_footnote_apparatus(
    scan: _PdfApparatusScan,
    *,
    media_id: UUID,
) -> PdfApparatusResult:
    targets = scan.legal_targets
    skipped = scan.legal_skipped
    page_count = len(scan.page_heights)
    if not targets:
        return PdfApparatusResult(
            diagnostics={
                "pdf_legal_footnotes": {
                    "status": "no_supported_legal_footnotes",
                    "adapter_version": "pdf_legal_footnotes_v1",
                    "page_count": page_count,
                    "marker_count": 0,
                    "target_count": 0,
                    "edge_count": 0,
                    "unresolved_marker_count": 0,
                    "unpaired_target_count": 0,
                    "skipped": skipped,
                }
            }
        )
    targets_by_label = {target.label_number: target for target in targets}
    if len(targets_by_label) != len(targets):
        _increment(skipped, "duplicate_target_label")
        return _empty_pdf_legal_footnote_result(
            "ambiguous_target_labels", skipped, page_count=page_count
        )
    expected_labels = list(range(1, len(targets) + 1))
    if sorted(targets_by_label) != expected_labels:
        _increment(skipped, "non_contiguous_target_labels")
        return _empty_pdf_legal_footnote_result(
            "ambiguous_target_labels", skipped, page_count=page_count
        )
    markers_by_label: dict[int, PdfLegalFootnoteMarker] = {}
    for label in expected_labels:
        candidates = scan.legal_marker_candidates.get(label, [])
        if len(candidates) != 1:
            _increment(skipped, "missing_marker" if not candidates else "ambiguous_marker")
            return _empty_pdf_legal_footnote_result(
                "ambiguous_marker_targets", skipped, page_count=page_count
            )
        markers_by_label[label] = candidates[0]

    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    target_key_by_label: dict[int, str] = {}
    for target in sorted(targets, key=lambda row: row.label_number):
        target_item = _pdf_legal_footnote_target_item(media_id=media_id, target=target)
        if target_item is None:
            _increment(skipped, "invalid_target_geometry")
            return _empty_pdf_legal_footnote_result(
                "invalid_geometry", skipped, page_count=page_count
            )
        target_key_by_label[target.label_number] = str(target_item["stable_key"])
        items.append(target_item)
    for label in expected_labels:
        marker = markers_by_label[label]
        marker_item = _pdf_legal_footnote_marker_item(media_id=media_id, marker=marker)
        if marker_item is None:
            _increment(skipped, "invalid_marker_geometry")
            return _empty_pdf_legal_footnote_result(
                "invalid_geometry", skipped, page_count=page_count
            )
        marker_key = str(marker_item["stable_key"])
        target_key = target_key_by_label[label]
        items.append(marker_item)
        edges.append(
            {
                "stable_key": f"{marker_key}->{target_key}",
                "from_stable_key": marker_key,
                "to_stable_key": target_key,
                "relation": "points_to_note",
                "confidence": "strong",
                "extraction_method": "pdf_legal_footnote_pair",
                "source_ref": dict(marker_item["source_ref"]),
                "sort_key": f"{marker.page_index + 1:04d}.{label:04d}.edge",
            }
        )
    return PdfApparatusResult(
        status="ready",
        items=items,
        edges=edges,
        diagnostics={
            "pdf_legal_footnotes": {
                "status": "targets_materialized",
                "adapter_version": "pdf_legal_footnotes_v1",
                "page_count": page_count,
                "marker_count": len(markers_by_label),
                "target_count": len(targets),
                "edge_count": len(edges),
                "unresolved_marker_count": 0,
                "unpaired_target_count": 0,
                "skipped": skipped,
            }
        },
    )


def _empty_pdf_legal_footnote_result(
    status: str,
    skipped: dict[str, int],
    *,
    page_count: int,
) -> PdfApparatusResult:
    return PdfApparatusResult(
        diagnostics={
            "pdf_legal_footnotes": {
                "status": status,
                "adapter_version": "pdf_legal_footnotes_v1",
                "page_count": page_count,
                "marker_count": 0,
                "target_count": 0,
                "edge_count": 0,
                "unresolved_marker_count": 0,
                "unpaired_target_count": 0,
                "skipped": skipped,
            }
        }
    )


def _merge_pdf_apparatus_results(*results: PdfApparatusResult) -> PdfApparatusResult:
    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    diagnostics: dict[str, object] = {}
    statuses = [result.status for result in results]
    for result in results:
        items.extend(result.items)
        edges.extend(result.edges)
        diagnostics.update(result.diagnostics)
    if not items:
        status = "empty"
    elif "partial" in statuses:
        status = "partial"
    else:
        status = "ready"
    return PdfApparatusResult(status=status, items=items, edges=edges, diagnostics=diagnostics)


def _validate_pdf_apparatus_budget(result: PdfApparatusResult) -> None:
    if len(result.items) > PDF_APPARATUS_MAX_ITEMS:
        raise _PdfResourceLimitExceeded("PDF apparatus item count exceeds limit")
    if len(result.edges) > PDF_APPARATUS_MAX_EDGES:
        raise _PdfResourceLimitExceeded("PDF apparatus edge count exceeds limit")
    retained_bytes = sum(nested_utf8_byte_length(item) for item in result.items)
    retained_bytes += sum(nested_utf8_byte_length(edge) for edge in result.edges)
    if retained_bytes > PDF_APPARATUS_MAX_RETAINED_UTF8_BYTES:
        raise _PdfResourceLimitExceeded("PDF apparatus output exceeds 8 MiB retained-text limit")


def _pdf_resource_limit_error(message: str) -> PdfExtractionError:
    return PdfExtractionError(
        error_code=ApiErrorCode.E_SOURCE_TOO_LARGE.value,
        error_message=message,
        terminal=True,
    )


def _extract_pdf_source_package_apparatus(
    *,
    storage_client,
    attempt_directory: Path,
    media_id: UUID,
    source_package: PdfSourcePackageArtifact | None,
    source_package_diagnostics: dict[str, object] | None,
) -> PdfApparatusResult | PdfExtractionError:
    diagnostics: dict[str, object] = {}
    if source_package_diagnostics:
        diagnostics["arxiv_source_package"] = dict(source_package_diagnostics)
    if source_package is None:
        return PdfApparatusResult(diagnostics=diagnostics)

    try:
        source_path = attempt_directory / "source-package.tar"
        source_package_sha256_hex = stream_storage_object_to_file(
            storage_client,
            storage_path=source_package.storage_path,
            destination=source_path,
            expected_size_bytes=source_package.size_bytes,
        )
        if source_package_sha256_hex != source_package.sha256_hex.lower():
            raise AssertionError("PDF source package SHA-256 differs from persisted metadata")
    except StorageError as exc:
        return PdfApparatusResult(
            diagnostics={
                **diagnostics,
                "arxiv_source_package": {
                    "status": "storage_missing",
                    "storage_path": source_package.storage_path,
                    "error": str(exc),
                },
            }
        )

    source_ref = {
        "format": source_package.source_kind,
        "media_id": str(media_id),
        "source_url": source_package.source_url,
        "storage_path": source_package.storage_path,
        "content_type": source_package.content_type,
        "size_bytes": source_package.size_bytes,
        "sha256_hex": source_package.sha256_hex,
        **source_package.source_ref,
    }
    try:
        result = extract_latex_biblatex_apparatus_from_archive(
            source_path,
            source_kind=f"pdf:{media_id}:source-package",
            source_ref=source_ref,
        )
    except LatexSourceArchiveUnsafe as exc:
        if exc.resource_limit:
            return _pdf_resource_limit_error(f"PDF source package exceeds limits: {exc}")
        return PdfApparatusResult(
            diagnostics={
                **diagnostics,
                "arxiv_source_package": {
                    "status": "unsafe_archive",
                    "storage_path": source_package.storage_path,
                    "source_url": source_package.source_url,
                    "reason": exc.reason,
                },
            }
        )
    except (tarfile.TarError, UnicodeError, ValueError, OSError) as exc:
        return PdfApparatusResult(
            diagnostics={
                **diagnostics,
                "arxiv_source_package": {
                    "status": "parse_failed",
                    "storage_path": source_package.storage_path,
                    "source_url": source_package.source_url,
                    "error": str(exc),
                },
            }
        )
    return PdfApparatusResult(
        status=result.status,
        items=result.items,
        edges=result.edges,
        diagnostics={**diagnostics, **result.diagnostics},
    )


def _pdf_legal_footnote_targets_for_page(
    page,
    page_index: int,
    lines: list[dict[str, Any]],
    *,
    body_font_size: float | None,
    skipped: dict[str, int],
) -> list[PdfLegalFootnoteTarget]:
    if body_font_size is None:
        return []
    band_top = float(page.rect.height) * _PDF_LEGAL_FOOTNOTE_BAND_TOP_RATIO
    lower_lines = sorted(
        [line for line in lines if float(line["top"]) >= band_top],
        key=lambda line: (float(line["top"]), float(line["left"])),
    )
    label_rows: list[tuple[int, dict[str, Any]]] = []
    for line in lower_lines:
        label = _numeric_label(str(line["text"]))
        if label is None:
            continue
        if float(line["left"]) > _PDF_LEGAL_FOOTNOTE_LABEL_X_MAX:
            continue
        label_rows.append((label, line))

    targets: list[PdfLegalFootnoteTarget] = []
    for index, (label, label_line) in enumerate(label_rows):
        next_label_line = label_rows[index + 1][1] if index + 1 < len(label_rows) else None
        body_lines: list[dict[str, Any]] = []
        for line in lower_lines:
            if line is label_line:
                continue
            if (
                float(line["top"])
                < float(label_line["top"]) - _PDF_LEGAL_FOOTNOTE_LINE_Y_TOLERANCE_PT
            ):
                continue
            if next_label_line is not None and (
                float(line["top"])
                >= float(next_label_line["top"]) - _PDF_LEGAL_FOOTNOTE_LINE_Y_TOLERANCE_PT
            ):
                continue
            if float(line["left"]) <= float(label_line["right"]):
                continue
            body_lines.append(line)
        body_text = normalize_whitespace(" ".join(str(line["text"]) for line in body_lines))
        if not body_text:
            continue
        if not _pdf_legal_footnote_target_has_note_style(
            label_line,
            body_lines,
            body_font_size=body_font_size,
        ):
            _increment(skipped, "target_body_not_footnote_style")
            continue
        targets.append(
            PdfLegalFootnoteTarget(
                label_number=label,
                page_index=page_index,
                body_text=body_text,
                body_rect_coords=_pdf_union_rect(body_lines),
                label_rect_coords=(
                    float(label_line["left"]),
                    float(label_line["top"]),
                    float(label_line["right"]),
                    float(label_line["bottom"]),
                ),
            )
        )
    return targets


def _pdf_legal_footnote_markers_for_page(
    page,
    page_index: int,
    lines: list[dict[str, Any]],
    *,
    target_labels: set[int],
    body_font_size: float | None,
) -> list[PdfLegalFootnoteMarker]:
    if not target_labels or body_font_size is None:
        return []
    band_top = float(page.rect.height) * _PDF_LEGAL_FOOTNOTE_BAND_TOP_RATIO
    max_marker_size = body_font_size * _PDF_LEGAL_FOOTNOTE_MARKER_SIZE_RATIO
    markers: list[PdfLegalFootnoteMarker] = []
    for line in lines:
        if float(line["top"]) >= band_top:
            continue
        for span in line["spans"]:
            text_value = str(span["text"]).strip()
            label = _numeric_label(text_value)
            if label is None or label not in target_labels:
                continue
            if float(span["size"]) > max_marker_size:
                continue
            if not _pdf_span_is_raised_marker(span, line, lines):
                continue
            markers.append(
                PdfLegalFootnoteMarker(
                    label_number=label,
                    page_index=page_index,
                    rect_coords=(
                        float(span["left"]),
                        float(span["top"]),
                        float(span["right"]),
                        float(span["bottom"]),
                    ),
                )
            )
    return markers


def _pdf_legal_footnote_target_item(
    *,
    media_id: UUID,
    target: PdfLegalFootnoteTarget,
) -> dict[str, Any] | None:
    try:
        validate_exact_length(target.body_text)
        geometry = canonicalize_geometry(
            target.page_index + 1,
            [_quad_from_rect_coords(target.body_rect_coords)],
        )
    except GeometryValidationError:
        return None
    target_key = f"pdf:legal-footnote-target:{target.page_index + 1:04d}:{target.label_number:04d}"
    return {
        "stable_key": target_key,
        "kind": "footnote",
        "label": str(target.label_number),
        "body_text": target.body_text,
        "body_html_sanitized": None,
        "locator": {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": target.page_index + 1,
            "quads": [_quad_json(quad) for quad in geometry.quads],
            "exact": target.body_text,
            "text_quote_selector": {"exact": target.body_text},
        },
        "locator_status": "exact",
        "confidence": "strong",
        "extraction_method": "pdf_legal_footnote_target",
        "source_ref": {
            "format": "pdf",
            "page_number": target.page_index + 1,
            "target_label": str(target.label_number),
            "target_body_rect": _pdf_rect_json(target.body_rect_coords),
            "target_label_rect": _pdf_rect_json(target.label_rect_coords),
        },
        "sort_key": f"{target.page_index + 1:04d}.{target.label_number:04d}.target",
    }


def _pdf_legal_footnote_marker_item(
    *,
    media_id: UUID,
    marker: PdfLegalFootnoteMarker,
) -> dict[str, Any] | None:
    label = str(marker.label_number)
    try:
        validate_exact_length(label)
        geometry = canonicalize_geometry(
            marker.page_index + 1,
            [_quad_from_rect_coords(marker.rect_coords)],
        )
    except GeometryValidationError:
        return None
    marker_key = f"pdf:legal-footnote-ref:{marker.page_index + 1:04d}:{marker.label_number:04d}"
    return {
        "stable_key": marker_key,
        "kind": "footnote_ref",
        "label": label,
        "body_text": None,
        "body_html_sanitized": None,
        "locator": {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": marker.page_index + 1,
            "quads": [_quad_json(quad) for quad in geometry.quads],
            "exact": label,
            "text_quote_selector": {"exact": label},
        },
        "locator_status": "exact",
        "confidence": "strong",
        "extraction_method": "pdf_legal_footnote_marker",
        "source_ref": {
            "format": "pdf",
            "page_number": marker.page_index + 1,
            "marker_label": label,
            "source_rect": _pdf_rect_json(marker.rect_coords),
        },
        "sort_key": f"{marker.page_index + 1:04d}.{marker.label_number:04d}.marker",
    }


def _pdf_text_lines(page) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    text_dict = page.get_text("dict")
    for block in text_dict.get("blocks", []):
        for line in block.get("lines", []):
            raw_spans = line.get("spans", [])
            spans: list[dict[str, Any]] = []
            for span in raw_spans:
                text_value = str(span.get("text") or "")
                bbox = span.get("bbox") or (0, 0, 0, 0)
                try:
                    left, top, right, bottom = (
                        float(bbox[0]),
                        float(bbox[1]),
                        float(bbox[2]),
                        float(bbox[3]),
                    )
                    size = float(span.get("size") or 0)
                except (TypeError, ValueError, IndexError):
                    continue
                if not text_value.strip() or right <= left or bottom <= top or size <= 0:
                    continue
                spans.append(
                    {
                        "text": text_value,
                        "size": size,
                        "left": left,
                        "top": top,
                        "right": right,
                        "bottom": bottom,
                    }
                )
            if not spans:
                continue
            text_value = normalize_whitespace("".join(str(span["text"]) for span in spans))
            if not text_value:
                continue
            left = min(float(span["left"]) for span in spans)
            top = min(float(span["top"]) for span in spans)
            right = max(float(span["right"]) for span in spans)
            bottom = max(float(span["bottom"]) for span in spans)
            lines.append(
                {
                    "text": text_value,
                    "left": left,
                    "top": top,
                    "right": right,
                    "bottom": bottom,
                    "spans": spans,
                }
            )
    return lines


def _pdf_body_font_size(page, lines: list[dict[str, Any]]) -> float | None:
    band_top = float(page.rect.height) * _PDF_LEGAL_FOOTNOTE_BAND_TOP_RATIO
    sizes: list[float] = []
    for line in lines:
        if float(line["top"]) >= band_top:
            continue
        for span in line["spans"]:
            text_value = str(span["text"]).strip()
            if not re.search(r"[A-Za-z]", text_value):
                continue
            sizes.append(float(span["size"]))
    if not sizes:
        return None
    sizes.sort()
    return sizes[len(sizes) // 2]


def _pdf_legal_footnote_target_has_note_style(
    label_line: dict[str, Any],
    body_lines: list[dict[str, Any]],
    *,
    body_font_size: float,
) -> bool:
    max_note_size = body_font_size * _PDF_LEGAL_FOOTNOTE_TARGET_SIZE_RATIO
    note_lines = [label_line, *body_lines]
    if any(_pdf_line_max_font_size(line) > max_note_size for line in note_lines):
        return False
    body_lefts = {round(float(line["left"]), 1) for line in body_lines}
    if len(body_lefts) > 1:
        return False
    return bool(body_lines)


def _pdf_span_is_raised_marker(
    span: dict[str, Any],
    line: dict[str, Any],
    lines: list[dict[str, Any]],
) -> bool:
    body_spans = _pdf_adjacent_body_spans_for_marker(span, line, lines)
    if not body_spans:
        return False
    sibling_top = min(float(sibling["top"]) for sibling in body_spans)
    sibling_bottom = max(float(sibling["bottom"]) for sibling in body_spans)
    sibling_height = max(sibling_bottom - sibling_top, 1.0)
    return float(span["top"]) <= sibling_top + _PDF_LEGAL_FOOTNOTE_LINE_Y_TOLERANCE_PT and float(
        span["bottom"]
    ) <= sibling_bottom - (sibling_height * 0.25)


def _pdf_adjacent_body_spans_for_marker(
    span: dict[str, Any],
    line: dict[str, Any],
    lines: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    marker_top = float(span["top"])
    marker_bottom = float(span["bottom"])
    marker_left = float(span["left"])
    marker_right = float(span["right"])
    candidates: list[dict[str, Any]] = []
    for candidate_line in lines:
        if abs(float(candidate_line["top"]) - marker_top) > _PDF_LEGAL_FOOTNOTE_LINE_Y_TOLERANCE_PT:
            continue
        if float(candidate_line["bottom"]) < marker_bottom:
            continue
        for candidate in candidate_line["spans"]:
            if candidate is span or not re.search(r"[A-Za-z]", str(candidate["text"])):
                continue
            candidate_left = float(candidate["left"])
            candidate_right = float(candidate["right"])
            touches_marker = (
                abs(candidate_right - marker_left) <= _PDF_LEGAL_FOOTNOTE_LINE_Y_TOLERANCE_PT
                or abs(candidate_left - marker_right) <= _PDF_LEGAL_FOOTNOTE_LINE_Y_TOLERANCE_PT
                or candidate is not span
                and candidate_line is line
            )
            if touches_marker:
                candidates.append(candidate)
    return candidates


def _pdf_line_max_font_size(line: dict[str, Any]) -> float:
    return max(float(span["size"]) for span in line["spans"])


def _numeric_label(value: str) -> int | None:
    text_value = value.strip()
    if not re.fullmatch(r"[1-9]\d{0,2}", text_value):
        return None
    return int(text_value)


def _pdf_union_rect(lines: list[dict[str, Any]]) -> tuple[float, float, float, float]:
    return (
        min(float(line["left"]) for line in lines),
        min(float(line["top"]) for line in lines),
        max(float(line["right"]) for line in lines),
        max(float(line["bottom"]) for line in lines),
    )


def _pdf_rect_json(coords: tuple[float, float, float, float]) -> dict[str, float]:
    return {
        "left": coords[0],
        "top": coords[1],
        "right": coords[2],
        "bottom": coords[3],
    }


def _increment(counter: dict[str, int], key: str) -> None:
    counter[key] = counter.get(key, 0) + 1


def _stable_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return token[:96] or "item"


def _pdf_native_link_target_item(
    *,
    media_id: UUID,
    destination_name: str,
    destination_point: object,
    target: PdfReferenceBlock,
    skipped: dict[str, int],
) -> dict[str, Any] | None:
    try:
        validate_exact_length(target.body_text)
        geometry = canonicalize_geometry(
            target.page_index + 1,
            [_quad_from_rect_coords(target.rect_coords)],
        )
    except GeometryValidationError:
        _increment(skipped, "invalid_reference_geometry")
        return None

    target_key = (
        "pdf:native-citation-target:"
        f"{target.page_index + 1:04d}:{target.label_number:04d}:{_stable_token(destination_name)}"
    )
    locator = {
        "type": "pdf_page_geometry",
        "media_id": str(media_id),
        "page_number": target.page_index + 1,
        "quads": [_quad_json(quad) for quad in geometry.quads],
        "exact": target.body_text,
        "text_quote_selector": {"exact": target.body_text},
    }
    return {
        "stable_key": target_key,
        "kind": "bibliography_entry",
        "label": target.label,
        "body_text": target.body_text,
        "body_html_sanitized": None,
        "locator": locator,
        "locator_status": "exact",
        "confidence": "exact",
        "extraction_method": "pdf_native_link_target",
        "source_ref": {
            "format": "pdf",
            "named_destination": destination_name,
            "target_label": target.label,
            "target_page_number": target.page_index + 1,
            "destination_point": _pdf_point_json(destination_point),
            "reference_block": {
                "left": target.rect_coords[0],
                "top": target.rect_coords[1],
                "right": target.rect_coords[2],
                "bottom": target.rect_coords[3],
            },
        },
        "sort_key": (
            f"{target.page_index + 1:04d}."
            f"{target.rect_coords[1]:09.3f}.{target.label_number:04d}.target"
        ),
    }


def _pdf_reference_block_for_destination(
    *,
    destination_page_index: int,
    destination_point: tuple[float, float] | None,
    reference_blocks: list[PdfReferenceBlock],
    page_heights: list[float | None],
) -> PdfReferenceBlock | None:
    if destination_point is None or not 0 <= destination_page_index < len(page_heights):
        return None
    page_height = page_heights[destination_page_index]
    if page_height is None:
        return None
    destination_x, destination_y = destination_point
    destination_top = page_height - destination_y
    candidates = [block for block in reference_blocks if block.page_index == destination_page_index]
    if not candidates:
        return None
    ranked = sorted(
        candidates,
        key=lambda block: abs(block.rect_coords[1] - destination_top),
    )
    target = ranked[0]
    best_delta = abs(target.rect_coords[1] - destination_top)
    if best_delta > _PDF_REFERENCE_LINK_Y_TOLERANCE_PT:
        return None
    if (
        len(ranked) > 1
        and abs(ranked[1].rect_coords[1] - destination_top) <= _PDF_REFERENCE_LINK_Y_TOLERANCE_PT
        and abs(ranked[1].rect_coords[1] - destination_top) - best_delta
        < _PDF_REFERENCE_LINK_AMBIGUOUS_DELTA_PT
    ):
        return None
    left, _, right, _ = target.rect_coords
    if (
        destination_x < left - _PDF_REFERENCE_LINK_X_TOLERANCE_PT
        or destination_x > right + _PDF_REFERENCE_LINK_X_TOLERANCE_PT
    ):
        return None
    return target


def _pdf_reference_block_key(block: PdfReferenceBlock) -> str:
    left, top, right, bottom = block.rect_coords
    return f"{block.page_index}:{block.label_number}:{left:.3f}:{top:.3f}:{right:.3f}:{bottom:.3f}"


def _pdf_block_rect_coords(block: Any) -> tuple[float, float, float, float] | None:
    try:
        left = float(block[0])
        top = float(block[1])
        right = float(block[2])
        bottom = float(block[3])
    except (TypeError, ValueError, IndexError):
        return None
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _normalize_pdf_block_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _pdf_rect_coords(rect: Any) -> tuple[float, float, float, float] | None:
    try:
        left = float(rect.x0)
        top = float(rect.y0)
        right = float(rect.x1)
        bottom = float(rect.y1)
    except (TypeError, ValueError, AttributeError):
        return None
    if right <= left or bottom <= top:
        return None
    return left, top, right, bottom


def _quad_from_rect_coords(coords: tuple[float, float, float, float]) -> dict[str, float]:
    left, top, right, bottom = coords
    return {
        "x1": left,
        "y1": top,
        "x2": right,
        "y2": top,
        "x3": right,
        "y3": bottom,
        "x4": left,
        "y4": bottom,
    }


def _quad_json(quad: Any) -> dict[str, float]:
    return {
        "x1": float(quad.x1),
        "y1": float(quad.y1),
        "x2": float(quad.x2),
        "y2": float(quad.y2),
        "x3": float(quad.x3),
        "y3": float(quad.y3),
        "x4": float(quad.x4),
        "y4": float(quad.y4),
    }


def _pdf_link_text(page: Any, rect: Any) -> str:
    try:
        return str(page.get_textbox(rect) or "")
    except (RuntimeError, ValueError, TypeError):
        return ""


def _pdf_point_json(point: Any) -> dict[str, float] | None:
    if point is None:
        return None
    if isinstance(point, tuple):
        if len(point) != 2:
            return None
        return {"x": float(point[0]), "y": float(point[1])}
    try:
        return {"x": float(point.x), "y": float(point.y)}
    except (TypeError, ValueError, AttributeError):
        return None


def _pdf_point_coords(point: Any) -> tuple[float, float] | None:
    if point is None:
        return None
    try:
        return float(point.x), float(point.y)
    except (TypeError, ValueError, AttributeError):
        return None


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


def build_pdf_extraction_plan(
    *,
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    storage_client,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
    source_package: PdfSourcePackageArtifact | None = None,
    source_package_diagnostics: dict[str, object] | None = None,
) -> PdfExtractionPlan | PdfExtractionError:
    """Acquire and parse immutable PDF input without opening a DB transaction."""
    t0 = time.monotonic()
    with parser_attempt_directory(attempt_id) as attempt_directory:
        pdf_path = attempt_directory / "source.pdf"
        source_sha256_hex = stream_storage_object_to_file(
            storage_client,
            storage_path=storage_path,
            destination=pdf_path,
            expected_size_bytes=source_size_bytes,
        )
        parsed = _extract_with_pymupdf(
            pdf_path,
            media_id=media_id,
            source_byte_length=source_size_bytes,
            record_progress=record_progress,
        )
        elapsed_ms = int((time.monotonic() - t0) * 1000)

        if isinstance(parsed, PdfExtractionError):
            logger.warning(
                "pdf_extraction_failed",
                media_id=str(media_id),
                error_code=parsed.error_code,
                parser="pymupdf",
                elapsed_ms=elapsed_ms,
                file_size=source_size_bytes,
            )
            return parsed

        result = parsed.result
        logger.info(
            "pdf_extraction_completed",
            media_id=str(media_id),
            page_count=result.page_count,
            has_text=result.has_text,
            plain_text_len=len(result.plain_text),
            parser="pymupdf",
            elapsed_ms=elapsed_ms,
            file_size=source_size_bytes,
        )
        source_apparatus = _extract_pdf_source_package_apparatus(
            storage_client=storage_client,
            attempt_directory=attempt_directory,
            media_id=media_id,
            source_package=source_package,
            source_package_diagnostics=source_package_diagnostics,
        )
        if isinstance(source_apparatus, PdfExtractionError):
            return source_apparatus
        try:
            pdf_apparatus = _merge_pdf_apparatus_results(parsed.apparatus, source_apparatus)
            _validate_pdf_apparatus_budget(pdf_apparatus)
        except _PdfResourceLimitExceeded as exc:
            return _pdf_resource_limit_error(str(exc))
        return PdfExtractionPlan(
            result=result,
            apparatus=pdf_apparatus,
            storage_path=storage_path,
            source_size_bytes=source_size_bytes,
            source_sha256_hex=source_sha256_hex,
            source_package=source_package,
            source_package_diagnostics=source_package_diagnostics,
        )


def publish_pdf_extraction_plan(
    db: Session,
    *,
    media_id: UUID,
    plan: PdfExtractionPlan,
) -> PdfExtractionResult:
    """Replace the complete PDF artifact set in the caller's fenced transaction."""
    result = plan.result
    # Serialize publication of the complete PDF artifact set against anonymous
    # readers, which hold Media FOR SHARE while resolving a projection.
    locked_media_id = db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).scalar()
    if locked_media_id is None:
        raise AssertionError("PDF media disappeared inside its publication fence")
    media = db.get(Media, media_id)
    if media is None:
        raise AssertionError("PDF media disappeared inside its publication fence")

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
            raise AssertionError(f"PDF page span invariant failure: {validation_err}")

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

    replace_media_apparatus(
        db,
        media_id=media_id,
        media_kind="pdf",
        source_fingerprint_value=source_fingerprint(
            "pdf",
            plan.storage_path,
            plan.source_size_bytes,
            plan.source_sha256_hex,
            plan.source_package.storage_path if plan.source_package else None,
            plan.source_package.size_bytes if plan.source_package else None,
            plan.source_package.sha256_hex if plan.source_package else None,
            plan.source_package.source_url if plan.source_package else None,
            plan.source_package_diagnostics or {},
            result.page_count,
            result.source_byte_length,
        ),
        items=plan.apparatus.items,
        edges=plan.apparatus.edges,
        status=plan.apparatus.status,
        diagnostics=plan.apparatus.diagnostics,
    )
    return result
