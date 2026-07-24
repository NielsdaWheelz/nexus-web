"""PDF extraction domain service.

Owns deterministic PDF artifact production: page_count, normalized plain_text,
and pdf_page_text_spans. Parser-specific behavior (PyMuPDF) is isolated here
behind parser-agnostic typed outcomes.

Does NOT own lifecycle transitions or background-job dispatch.
"""

import hashlib
import re
import tarfile
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
from nexus.services.latex_apparatus import (
    LatexSourceArchiveUnsafe,
    extract_latex_biblatex_apparatus_from_archive,
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
    except RuntimeError as exc:
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
            source_byte_length=len(pdf_bytes),
            pdf_title=pdf_title,
            pdf_author=pdf_author,
            pdf_subject=pdf_subject,
            pdf_creation_date=pdf_creation_date,
        )
    finally:
        doc.close()


def _extract_pdf_native_link_apparatus(
    pdf_bytes: bytes,
    *,
    media_id: UUID,
) -> PdfApparatusResult:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return PdfApparatusResult(
            diagnostics={"pdf_native_link": {"status": "pymupdf_unavailable"}}
        )

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except RuntimeError as exc:
        return PdfApparatusResult(
            diagnostics={
                "pdf_native_link": {
                    "status": "open_failed",
                    "error": str(exc),
                }
            }
        )

    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    total_links = 0
    internal_links = 0
    citation_link_count = 0
    skipped: dict[str, int] = {}
    try:
        reference_blocks = _pdf_reference_blocks(doc)
        target_key_by_destination: dict[str, str] = {}
        target_key_by_block: dict[str, str] = {}
        for page_index in range(len(doc)):
            page = doc[page_index]
            for link_index, link in enumerate(page.get_links()):
                total_links += 1
                if "page" in link:
                    internal_links += 1
                name = str(link.get("nameddest") or "")
                if not name.startswith("cite."):
                    _increment(skipped, "non_citation_destination")
                    continue
                if "uri" in link:
                    _increment(skipped, "external_uri")
                    continue
                if "page" not in link:
                    _increment(skipped, "missing_destination_page")
                    continue
                rect = link.get("from")
                rect_coords = _pdf_rect_coords(rect)
                if rect_coords is None:
                    _increment(skipped, "missing_source_rect")
                    continue
                exact = _pdf_link_text(page, rect).strip()
                if not exact:
                    _increment(skipped, "missing_marker_text")
                    continue
                try:
                    validate_exact_length(exact)
                    geometry = canonicalize_geometry(
                        page_index + 1,
                        [_quad_from_rect_coords(rect_coords)],
                    )
                except GeometryValidationError:
                    _increment(skipped, "invalid_geometry")
                    continue

                citation_link_count += 1
                stable_key = (
                    "pdf:native-citation-ref:"
                    f"{page_index + 1:04d}:{link_index:04d}:{_stable_token(name)}"
                )
                locator = {
                    "type": "pdf_page_geometry",
                    "media_id": str(media_id),
                    "page_number": page_index + 1,
                    "quads": [_quad_json(quad) for quad in geometry.quads],
                    "exact": exact,
                    "text_quote_selector": {"exact": exact},
                }
                marker_source_ref = {
                    "format": "pdf",
                    "page_number": page_index + 1,
                    "link_index": link_index,
                    "link_xref": link.get("xref"),
                    "named_destination": name,
                    "destination_page_number": int(link["page"]) + 1,
                    "destination_point": _pdf_point_json(link.get("to")),
                    "source_rect": {
                        "left": rect_coords[0],
                        "top": rect_coords[1],
                        "right": rect_coords[2],
                        "bottom": rect_coords[3],
                    },
                }
                items.append(
                    {
                        "stable_key": stable_key,
                        "kind": "bibliography_ref",
                        "label": exact,
                        "body_text": None,
                        "body_html_sanitized": None,
                        "locator": locator,
                        "locator_status": "exact",
                        "confidence": "exact",
                        "extraction_method": "pdf_native_link",
                        "source_ref": marker_source_ref,
                        "sort_key": f"{page_index + 1:04d}.{link_index:04d}.marker",
                    }
                )
                target_key = target_key_by_destination.get(name)
                if target_key is None:
                    target_block = _pdf_reference_block_for_destination(
                        doc=doc,
                        destination_page_index=int(link["page"]),
                        destination_point=link.get("to"),
                        reference_blocks=reference_blocks,
                    )
                    if target_block is None:
                        _increment(skipped, "missing_reference_target")
                    else:
                        block_key = _pdf_reference_block_key(target_block)
                        target_key = target_key_by_block.get(block_key)
                        if target_key is None:
                            target_item = _pdf_native_link_target_item(
                                media_id=media_id,
                                destination_name=name,
                                destination_point=link.get("to"),
                                target=target_block,
                                skipped=skipped,
                            )
                            if target_item is not None:
                                target_key = str(target_item["stable_key"])
                                target_key_by_block[block_key] = target_key
                                items.append(target_item)
                        if target_key is not None:
                            target_key_by_destination[name] = target_key
                if target_key is None:
                    continue
                edges.append(
                    {
                        "stable_key": f"{stable_key}->{target_key}",
                        "from_stable_key": stable_key,
                        "to_stable_key": target_key,
                        "relation": "cites_bibliography_entry",
                        "confidence": "exact",
                        "extraction_method": "pdf_native_link_target",
                        "source_ref": marker_source_ref,
                        "sort_key": f"{page_index + 1:04d}.{link_index:04d}.edge",
                    }
                )
    finally:
        doc.close()

    unresolved_marker_count = citation_link_count - len(edges)
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
                "marker_count": citation_link_count,
                "target_count": len(target_key_by_block),
                "edge_count": len(edges),
                "unresolved_marker_count": unresolved_marker_count,
                "total_link_count": total_links,
                "internal_link_count": internal_links,
                "citation_link_count": citation_link_count,
                "skipped": skipped,
            }
        },
    )


def _extract_pdf_legal_footnote_apparatus(
    pdf_bytes: bytes,
    *,
    media_id: UUID,
) -> PdfApparatusResult:
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return PdfApparatusResult(
            diagnostics={"pdf_legal_footnotes": {"status": "pymupdf_unavailable"}}
        )

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except RuntimeError as exc:
        return PdfApparatusResult(
            diagnostics={
                "pdf_legal_footnotes": {
                    "status": "open_failed",
                    "error": str(exc),
                }
            }
        )

    skipped: dict[str, int] = {}
    try:
        targets: list[PdfLegalFootnoteTarget] = []
        marker_candidates: dict[int, list[PdfLegalFootnoteMarker]] = {}
        for page_index in range(len(doc)):
            page = doc[page_index]
            lines = _pdf_text_lines(page)
            body_font_size = _pdf_body_font_size(page, lines)
            page_targets = _pdf_legal_footnote_targets_for_page(
                page,
                page_index,
                lines,
                body_font_size=body_font_size,
                skipped=skipped,
            )
            targets.extend(page_targets)
            target_labels = {target.label_number for target in page_targets}
            for marker in _pdf_legal_footnote_markers_for_page(
                page,
                page_index,
                lines,
                target_labels=target_labels,
                body_font_size=body_font_size,
            ):
                marker_candidates.setdefault(marker.label_number, []).append(marker)

        if not targets:
            return PdfApparatusResult(
                diagnostics={
                    "pdf_legal_footnotes": {
                        "status": "no_supported_legal_footnotes",
                        "adapter_version": "pdf_legal_footnotes_v1",
                        "page_count": len(doc),
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
                "ambiguous_target_labels",
                skipped,
                page_count=len(doc),
            )

        expected_labels = list(range(1, len(targets) + 1))
        if sorted(targets_by_label) != expected_labels:
            _increment(skipped, "non_contiguous_target_labels")
            return _empty_pdf_legal_footnote_result(
                "ambiguous_target_labels",
                skipped,
                page_count=len(doc),
            )

        markers_by_label: dict[int, PdfLegalFootnoteMarker] = {}
        for label in expected_labels:
            candidates = marker_candidates.get(label, [])
            if len(candidates) != 1:
                _increment(skipped, "missing_marker" if not candidates else "ambiguous_marker")
                return _empty_pdf_legal_footnote_result(
                    "ambiguous_marker_targets",
                    skipped,
                    page_count=len(doc),
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
                    "invalid_geometry",
                    skipped,
                    page_count=len(doc),
                )
            target_key_by_label[target.label_number] = str(target_item["stable_key"])
            items.append(target_item)

        for label in expected_labels:
            marker = markers_by_label[label]
            marker_item = _pdf_legal_footnote_marker_item(media_id=media_id, marker=marker)
            if marker_item is None:
                _increment(skipped, "invalid_marker_geometry")
                return _empty_pdf_legal_footnote_result(
                    "invalid_geometry",
                    skipped,
                    page_count=len(doc),
                )
            marker_key = str(marker_item["stable_key"])
            target_key = target_key_by_label[label]
            items.append(marker_item)
            marker_source_ref = dict(marker_item["source_ref"])
            edges.append(
                {
                    "stable_key": f"{marker_key}->{target_key}",
                    "from_stable_key": marker_key,
                    "to_stable_key": target_key,
                    "relation": "points_to_note",
                    "confidence": "strong",
                    "extraction_method": "pdf_legal_footnote_pair",
                    "source_ref": marker_source_ref,
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
                    "page_count": len(doc),
                    "marker_count": len(markers_by_label),
                    "target_count": len(targets),
                    "edge_count": len(edges),
                    "unresolved_marker_count": 0,
                    "unpaired_target_count": 0,
                    "skipped": skipped,
                }
            },
        )
    finally:
        doc.close()


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


def _extract_pdf_source_package_apparatus(
    *,
    storage_client,
    media_id: UUID,
    source_package: PdfSourcePackageArtifact | None,
    source_package_diagnostics: dict[str, object] | None,
) -> PdfApparatusResult:
    diagnostics: dict[str, object] = {}
    if source_package_diagnostics:
        diagnostics["arxiv_source_package"] = dict(source_package_diagnostics)
    if source_package is None:
        return PdfApparatusResult(diagnostics=diagnostics)

    try:
        source_bytes = b"".join(storage_client.stream_object(source_package.storage_path))
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
            source_bytes,
            source_kind=f"pdf:{media_id}:source-package",
            source_ref=source_ref,
        )
    except LatexSourceArchiveUnsafe as exc:
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
    lines: list[dict[str, object]],
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
    label_rows: list[tuple[int, dict[str, object]]] = []
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
        body_lines: list[dict[str, object]] = []
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
    lines: list[dict[str, object]],
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
) -> dict[str, object] | None:
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
) -> dict[str, object] | None:
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


def _pdf_text_lines(page) -> list[dict[str, object]]:
    lines: list[dict[str, object]] = []
    text_dict = page.get_text("dict")
    for block in text_dict.get("blocks", []):
        for line in block.get("lines", []):
            raw_spans = line.get("spans", [])
            spans: list[dict[str, object]] = []
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


def _pdf_body_font_size(page, lines: list[dict[str, object]]) -> float | None:
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
    label_line: dict[str, object],
    body_lines: list[dict[str, object]],
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
    span: dict[str, object],
    line: dict[str, object],
    lines: list[dict[str, object]],
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
    span: dict[str, object],
    line: dict[str, object],
    lines: list[dict[str, object]],
) -> list[dict[str, object]]:
    marker_top = float(span["top"])
    marker_bottom = float(span["bottom"])
    marker_left = float(span["left"])
    marker_right = float(span["right"])
    candidates: list[dict[str, object]] = []
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


def _pdf_line_max_font_size(line: dict[str, object]) -> float:
    return max(float(span["size"]) for span in line["spans"])


def _numeric_label(value: str) -> int | None:
    text_value = value.strip()
    if not re.fullmatch(r"[1-9]\d{0,2}", text_value):
        return None
    return int(text_value)


def _pdf_union_rect(lines: list[dict[str, object]]) -> tuple[float, float, float, float]:
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


def _build_page_texts_from_raw(raw_page_texts: list[str]) -> list[str]:
    """Normalize each page text individually for span offset construction."""
    result = []
    for raw in raw_page_texts:
        normed = normalize_pdf_text(raw)
        result.append(normed)
    return result


def _increment(counter: dict[str, int], key: str) -> None:
    counter[key] = counter.get(key, 0) + 1


def _stable_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return token[:96] or "item"


def _pdf_reference_blocks(doc) -> list[PdfReferenceBlock]:
    blocks: list[PdfReferenceBlock] = []
    in_references = False
    for page_index in range(len(doc)):
        page = doc[page_index]
        page_blocks = sorted(
            page.get_text("blocks"),
            key=lambda block: (float(block[1]), float(block[0])),
        )
        for block in page_blocks:
            text_value = _normalize_pdf_block_text(str(block[4] or ""))
            if not text_value:
                continue
            if text_value == "References":
                in_references = True
                continue
            if not in_references:
                continue
            match = re.match(r"^\[(\d+)\]\s+", text_value)
            if not match:
                continue
            coords = _pdf_block_rect_coords(block)
            if coords is None:
                continue
            blocks.append(
                PdfReferenceBlock(
                    page_index=page_index,
                    label=f"[{int(match.group(1))}]",
                    label_number=int(match.group(1)),
                    body_text=text_value,
                    rect_coords=coords,
                )
            )
    return blocks


def _pdf_native_link_target_item(
    *,
    media_id: UUID,
    destination_name: str,
    destination_point: object,
    target: PdfReferenceBlock,
    skipped: dict[str, int],
) -> dict[str, object] | None:
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
    doc,
    destination_page_index: int,
    destination_point: object,
    reference_blocks: list[PdfReferenceBlock],
) -> PdfReferenceBlock | None:
    try:
        page = doc[destination_page_index]
        destination_top = float(page.rect.height) - float(destination_point.y)
    except (IndexError, TypeError, ValueError, AttributeError):
        return None
    candidates = [block for block in reference_blocks if block.page_index == destination_page_index]
    if not candidates:
        return None
    try:
        destination_x = float(destination_point.x)
    except (TypeError, ValueError, AttributeError):
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


def _pdf_block_rect_coords(block: object) -> tuple[float, float, float, float] | None:
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


def _pdf_rect_coords(rect: object) -> tuple[float, float, float, float] | None:
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


def _quad_json(quad) -> dict[str, float]:
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


def _pdf_link_text(page, rect: object) -> str:
    try:
        return str(page.get_textbox(rect) or "")
    except (RuntimeError, ValueError, TypeError):
        return ""


def _pdf_point_json(point: object) -> dict[str, float] | None:
    if point is None:
        return None
    try:
        return {"x": float(point.x), "y": float(point.y)}
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


def extract_pdf_artifacts(
    db: Session,
    media_id: UUID,
    storage_client,
    *,
    source_package: PdfSourcePackageArtifact | None = None,
    source_package_diagnostics: dict[str, object] | None = None,
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
    except StorageError as exc:
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

    # Serialize publication of the complete PDF artifact set against anonymous
    # readers, which hold Media FOR SHARE while resolving a projection.
    locked_media_id = db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"),
        {"media_id": media_id},
    ).scalar()
    if locked_media_id is None:
        return PdfExtractionError(
            error_code=ApiErrorCode.E_MEDIA_NOT_FOUND.value,
            error_message="Media row not found before PDF publication",
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

    pdf_apparatus = _merge_pdf_apparatus_results(
        _extract_pdf_native_link_apparatus(pdf_bytes, media_id=media_id),
        _extract_pdf_legal_footnote_apparatus(pdf_bytes, media_id=media_id),
        _extract_pdf_source_package_apparatus(
            storage_client=storage_client,
            media_id=media_id,
            source_package=source_package,
            source_package_diagnostics=source_package_diagnostics,
        ),
    )
    replace_media_apparatus(
        db,
        media_id=media_id,
        media_kind="pdf",
        source_fingerprint_value=source_fingerprint(
            "pdf",
            media_file.storage_path,
            media_file.size_bytes,
            hashlib.sha256(pdf_bytes).hexdigest(),
            source_package.storage_path if source_package else None,
            source_package.size_bytes if source_package else None,
            source_package.sha256_hex if source_package else None,
            source_package.source_url if source_package else None,
            source_package_diagnostics or {},
            result.page_count,
            result.source_byte_length,
        ),
        items=pdf_apparatus.items,
        edges=pdf_apparatus.edges,
        status=pdf_apparatus.status,
        diagnostics=pdf_apparatus.diagnostics,
    )
    return result


# ---------------------------------------------------------------------------
# Invalidation helpers
# ---------------------------------------------------------------------------


def invalidate_pdf_quote_match_metadata(db: Session, media_id: UUID) -> int:
    """Reset PDF quote-match metadata for all highlights on a media.

    Sets plain_text_match_status='pending', clears offsets, and clears
    prefix/suffix on the parent highlights row.
    Preserves geometry and exact text.

    Returns the count of invalidated highlight_pdf_anchors rows.
    """
    result = db.execute(
        text("""
            UPDATE highlight_pdf_anchors
            SET plain_text_match_status = 'pending',
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

    Used before text-rebuild retry paths. Apparatus remains until the rebuild
    reconciles it by stable key.
    """
    from nexus.services.content_indexing import (
        IndexOwner,
        deactivate_content_index,
    )

    deactivate_content_index(db, owner=IndexOwner("media", media_id), reason="pdf_text_rebuild")
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
