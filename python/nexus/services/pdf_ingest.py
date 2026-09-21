"""PDF extraction: page text, page spans, and native-link citation apparatus.

Parser-specific behaviour (PyMuPDF) is isolated behind typed outcomes. Owns no
lifecycle transition and no job dispatch.
"""

import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from nexus.db.models import Media, PdfPageTextSpan
from nexus.errors import ApiErrorCode, NotFoundError, ResourceFailureDimension
from nexus.logging import get_logger
from nexus.services.parser_temp import (
    StorageObjectIntegrityError,
    nested_utf8_byte_length,
    parser_attempt_directory,
    stream_storage_object_to_file,
    utf8_byte_length,
)
from nexus.services.pdf_highlight_geometry import (
    MAX_EXACT_CODEPOINTS,
    GeometryValidationError,
    canonicalize_geometry,
    validate_exact_length,
)
from nexus.services.reader_apparatus import replace_media_apparatus, stable_token
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
    page_count: int = 0
    plain_text: str = ""
    page_spans: list[PdfPageSpan] = field(default_factory=list)
    has_text: bool = False
    source_byte_length: int = 0
    pdf_title: str | None = None
    pdf_author: str | None = None
    pdf_subject: str | None = None


@dataclass(frozen=True)
class PdfExtractionError:
    error_code: str = ""
    error_message: str = ""
    terminal: bool = False
    resource_limit_dimension: ResourceFailureDimension | None = None


@dataclass(frozen=True)
class PdfApparatusResult:
    status: str = "empty"
    items: list[dict[str, object]] = field(default_factory=list)
    edges: list[dict[str, object]] = field(default_factory=list)


@dataclass(frozen=True)
class PdfExtractionPlan:
    result: PdfExtractionResult
    apparatus: PdfApparatusResult
    storage_path: str
    source_size_bytes: int
    source_sha256_hex: str


@dataclass(frozen=True)
class _PdfParsedSource:
    result: PdfExtractionResult
    apparatus: PdfApparatusResult


@dataclass
class _PdfPageTextSnapshot:
    """The sole page-local PyMuPDF text representation for one extraction pass."""

    plain_text: str
    blocks: list[tuple[float, float, float, float, str]]
    lines: list[dict[str, Any]]


@dataclass(frozen=True)
class PdfReferenceBlock:
    page_index: int
    label: str
    label_number: int
    body_text: str
    rect_coords: tuple[float, float, float, float]


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


@dataclass
class _PdfApparatusScan:
    in_references: bool = False
    reference_blocks: list[PdfReferenceBlock] = field(default_factory=list)
    native_links: list[_PdfNativeCitationLink] = field(default_factory=list)
    page_heights: list[float | None] = field(default_factory=list)
    retained_item_count: int = 0
    retained_utf8_bytes: int = 0


class _PdfResourceLimitExceeded(Exception):
    """A declared PDF parser budget breach, named by the site that detects it."""

    def __init__(self, message: str, *, dimension: ResourceFailureDimension) -> None:
        super().__init__(message)
        self.dimension: ResourceFailureDimension = dimension


def _pdf_resource_limit_error(
    message: str, *, dimension: ResourceFailureDimension
) -> PdfExtractionError:
    return PdfExtractionError(
        error_code=ApiErrorCode.E_RESOURCE_LIMIT.value,
        error_message=message,
        terminal=True,
        resource_limit_dimension=dimension,
    )


def normalize_pdf_text(raw_text: str) -> str:
    """CRLF and CR to LF, form feed to a blank line, NBSP to space, NUL dropped,
    intra-line whitespace collapsed, three or more newlines to two, then trimmed."""
    normalized = raw_text.replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.replace("\f", "\n\n").replace(" ", " ").replace("\x00", "")
    normalized = re.sub(r"[^\S\n]+", " ", normalized)
    return re.sub(r"\n{3,}", "\n\n", normalized).strip()


def build_pdf_extraction_plan(
    *,
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    expected_source_sha256: str,
    storage_client,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
) -> PdfExtractionPlan | PdfExtractionError:
    """Acquire and parse immutable PDF input without opening a DB transaction."""
    started = time.monotonic()
    with parser_attempt_directory(attempt_id) as attempt_directory:
        pdf_path = attempt_directory / "source.pdf"
        try:
            source_sha256_hex = stream_storage_object_to_file(
                storage_client,
                storage_path=storage_path,
                destination=pdf_path,
                expected_size_bytes=source_size_bytes,
                expected_source_sha256=expected_source_sha256,
            )
        except StorageObjectIntegrityError:
            return PdfExtractionError(
                error_code=ApiErrorCode.E_SOURCE_INTEGRITY.value,
                error_message="Stored PDF bytes do not match the immutable source identity",
                terminal=True,
            )
        parsed = _extract_with_pymupdf(
            pdf_path,
            media_id=media_id,
            source_byte_length=source_size_bytes,
            record_progress=record_progress,
        )
        elapsed_ms = int((time.monotonic() - started) * 1000)
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
        return PdfExtractionPlan(
            result=parsed.result,
            apparatus=parsed.apparatus,
            storage_path=storage_path,
            source_size_bytes=source_size_bytes,
            source_sha256_hex=source_sha256_hex,
        )


def _extract_with_pymupdf(
    pdf_path: Path,
    *,
    media_id: UUID,
    source_byte_length: int,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
) -> _PdfParsedSource | PdfExtractionError:
    """Decode one `rawdict` snapshot per page into text, spans, and apparatus."""
    import fitz  # PyMuPDF

    try:
        doc = fitz.open(pdf_path)
    except RuntimeError as exc:
        message = str(exc).lower()
        if "password" in message or "encrypted" in message:
            return PdfExtractionError(
                error_code=ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value,
                error_message="PDF is password-protected or encrypted",
                terminal=True,
            )
        return PdfExtractionError(
            error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
            error_message=f"Failed to open PDF: {exc}",
        )

    if doc.needs_pass:
        doc.close()
        return PdfExtractionError(
            error_code=ApiErrorCode.E_PDF_PASSWORD_REQUIRED.value,
            error_message="PDF is password-protected or encrypted",
            terminal=True,
        )

    raw_meta = doc.metadata or {}
    try:
        page_count = len(doc)
        if page_count < 1:
            return PdfExtractionError(
                error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
                error_message="PDF has zero pages",
            )
        if page_count > PDF_MAX_PAGES:
            return _pdf_resource_limit_error(
                f"PDF has {page_count} pages; limit is {PDF_MAX_PAGES}", dimension="Structure"
            )

        normalized_pages: list[str] = []
        page_labels: list[str | None] = []
        page_sizes: list[tuple[float, float] | None] = []
        page_rotations: list[int | None] = []
        normalized_text_bytes = 0
        nonempty_page_count = 0
        scan = _PdfApparatusScan()
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
                scan.page_heights.append(None)
            else:
                # One recorded height per page, before any page-local scan can
                # fail: `page_heights` is addressed by page index.
                scan.page_heights.append(_pdf_page_height(page))
                snapshot: _PdfPageTextSnapshot | None = None
                try:
                    snapshot = _pdf_page_text_snapshot(page)
                    _scan_pdf_page_apparatus(scan, page, page_num, snapshot)
                    page_text = snapshot.plain_text
                    try:
                        raw_page_label = page.get_label()
                    except (AttributeError, RuntimeError):
                        raw_page_label = None
                    page_label = (
                        raw_page_label.strip()
                        if isinstance(raw_page_label, str) and raw_page_label.strip()
                        else None
                    )
                    page_size = (float(page.rect.width), float(page.rect.height))
                    page_rotation = int(page.rotation or 0)
                except _PdfResourceLimitExceeded as exc:
                    return _pdf_resource_limit_error(str(exc), dimension=exc.dimension)
                except (RuntimeError, AttributeError, ValueError):
                    page_text = ""
                    page_label = None
                    page_size = None
                    page_rotation = None
                finally:
                    # PyMuPDF pages retain substantial decoded state; a
                    # document-wide loop must not hold page-local snapshots.
                    del snapshot
                    del page
            normalized_page = normalize_pdf_text(page_text)
            if normalized_page:
                if nonempty_page_count:
                    normalized_text_bytes += 2
                normalized_text_bytes += utf8_byte_length(normalized_page)
                nonempty_page_count += 1
            if normalized_text_bytes > PDF_EXTRACTED_TEXT_MAX_BYTES:
                return _pdf_resource_limit_error(
                    "PDF extracted text exceeds the 32 MiB limit", dimension="Output"
                )
            normalized_pages.append(normalized_page)
            page_labels.append(page_label)
            page_sizes.append(page_size)
            page_rotations.append(page_rotation)
            completed = page_num + 1
            if completed % 10 == 0 or completed == page_count:
                record_progress(completed, page_count, "Page")

        normalized = "\n\n".join(page for page in normalized_pages if page)
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
            has_text=bool(normalized),
            source_byte_length=source_byte_length,
            pdf_title=(raw_meta.get("title") or "").strip() or None,
            pdf_author=(raw_meta.get("author") or "").strip() or None,
            pdf_subject=(raw_meta.get("subject") or "").strip() or None,
        )
        try:
            apparatus = _materialize_pdf_native_link_apparatus(scan, media_id=media_id)
            _validate_pdf_apparatus_budget(apparatus)
        except _PdfResourceLimitExceeded as exc:
            return _pdf_resource_limit_error(str(exc), dimension=exc.dimension)
        return _PdfParsedSource(result=result, apparatus=apparatus)
    finally:
        doc.close()


def _build_page_spans(
    normalized_pages: list[str],
    full_normalized: str,
    page_count: int,
    page_labels: list[str | None],
    page_sizes: list[tuple[float, float] | None],
    page_rotations: list[int | None],
) -> list[PdfPageSpan]:
    """One span per page over `plain_text`; a page with no text gets a zero-width one."""
    spans: list[PdfPageSpan] = []
    offset = 0
    for index in range(page_count):
        page_text = normalized_pages[index] if index < len(normalized_pages) else ""
        page_size = page_sizes[index] if index < len(page_sizes) else None
        spans.append(
            PdfPageSpan(
                page_number=index + 1,
                start_offset=offset,
                end_offset=offset + len(page_text),
                page_label=page_labels[index] if index < len(page_labels) else None,
                page_width=page_size[0] if page_size else None,
                page_height=page_size[1] if page_size else None,
                page_rotation_degrees=(
                    page_rotations[index] if index < len(page_rotations) else None
                ),
            )
        )
        offset += len(page_text)
        if page_text and index < len(normalized_pages) - 1:
            # Skip exactly the separator newlines the join actually wrote.
            while offset < len(full_normalized) and full_normalized[offset] == "\n":
                offset += 1
    return spans


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
    db.execute(
        text("SELECT id FROM media WHERE id = :media_id FOR UPDATE"), {"media_id": media_id}
    ).scalar()
    media = db.get(Media, media_id)
    if media is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")

    media.page_count = result.page_count
    media.plain_text = result.plain_text if result.has_text else None
    db.execute(delete(PdfPageTextSpan).where(PdfPageTextSpan.media_id == media_id))
    if result.has_text:
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

    replace_media_apparatus(
        db,
        media_id=media_id,
        items=plan.apparatus.items,
        edges=plan.apparatus.edges,
        status=plan.apparatus.status,
    )
    return result


# ---------------------------------------------------------------------------
# Native-link citation apparatus (stable keys and dict shapes frozen under #364)
# ---------------------------------------------------------------------------


def _pdf_page_height(page: Any) -> float | None:
    try:
        return float(page.rect.height)
    except (AttributeError, TypeError, ValueError):
        return None


def _scan_pdf_page_apparatus(
    scan: _PdfApparatusScan,
    page,
    page_index: int,
    snapshot: _PdfPageTextSnapshot,
) -> None:
    if len(snapshot.blocks) > PDF_APPARATUS_MAX_ITEMS:
        raise _PdfResourceLimitExceeded(
            "PDF page block count exceeds apparatus limit", dimension="Structure"
        )
    for block in snapshot.blocks:
        text_value = re.sub(r"\s+", " ", str(block[4] or "")).strip()
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
        raise _PdfResourceLimitExceeded(
            "PDF page link count exceeds apparatus limit", dimension="Structure"
        )
    for link_index, link in enumerate(links):
        name = str(link.get("nameddest") or "")
        if not name.startswith("cite.") or "uri" in link or "page" not in link:
            continue
        source_rect = _pdf_rect_coords(link.get("from"))
        if source_rect is None:
            continue
        exact = _pdf_link_text_from_snapshot(snapshot, source_rect)
        if not exact:
            continue
        try:
            validate_exact_length(exact)
            canonicalize_geometry(page_index + 1, [_quad_from_rect_coords(source_rect)])
            destination_page_index = int(link["page"])
        except (GeometryValidationError, TypeError, ValueError):
            continue
        citation_link = _PdfNativeCitationLink(
            page_index=page_index,
            link_index=link_index,
            name=name,
            destination_page_index=destination_page_index,
            destination_point=_pdf_point_coords(link.get("to")),
            source_rect=source_rect,
            exact=exact,
            link_xref=(int(link["xref"]) if isinstance(link.get("xref"), int) else None),
        )
        _retain_pdf_scan_item(scan, citation_link.name, citation_link.exact)
        scan.native_links.append(citation_link)

    if len(snapshot.lines) > PDF_APPARATUS_MAX_ITEMS:
        raise _PdfResourceLimitExceeded(
            "PDF page line count exceeds apparatus limit", dimension="Structure"
        )


def _retain_pdf_scan_item(scan: _PdfApparatusScan, *text_values: str) -> None:
    next_count = scan.retained_item_count + 1
    if next_count > PDF_APPARATUS_MAX_ITEMS:
        raise _PdfResourceLimitExceeded(
            "PDF apparatus retained item count exceeds limit", dimension="Output"
        )
    next_bytes = scan.retained_utf8_bytes + sum(utf8_byte_length(value) for value in text_values)
    if next_bytes > PDF_APPARATUS_MAX_RETAINED_UTF8_BYTES:
        raise _PdfResourceLimitExceeded(
            "PDF apparatus retained text exceeds 8 MiB limit", dimension="Output"
        )
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
            f"{link.page_index + 1:04d}:{link.link_index:04d}:{stable_token(link.name)}"
        )
        geometry = canonicalize_geometry(
            link.page_index + 1, [_quad_from_rect_coords(link.source_rect)]
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
            target_key = _pdf_target_key_for_link(
                link, media_id=media_id, scan=scan, items=items, keys_by_block=target_key_by_block
            )
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

    if not items:
        status = "empty"
    elif edges and len(edges) == len(scan.native_links):
        status = "ready"
    else:
        # Some marker found no reference block to point at.
        status = "partial"
    return PdfApparatusResult(status=status, items=items, edges=edges)


def _pdf_target_key_for_link(
    link: _PdfNativeCitationLink,
    *,
    media_id: UUID,
    scan: _PdfApparatusScan,
    items: list[dict[str, object]],
    keys_by_block: dict[str, str],
) -> str | None:
    """The reference block this link lands on, materialised once per distinct block."""
    target = _pdf_reference_block_for_destination(
        destination_page_index=link.destination_page_index,
        destination_point=link.destination_point,
        reference_blocks=scan.reference_blocks,
        page_heights=scan.page_heights,
    )
    if target is None:
        return None
    left, top, right, bottom = target.rect_coords
    block_key = (
        f"{target.page_index}:{target.label_number}:{left:.3f}:{top:.3f}:{right:.3f}:{bottom:.3f}"
    )
    target_key = keys_by_block.get(block_key)
    if target_key is not None:
        return target_key
    target_item = _pdf_native_link_target_item(
        media_id=media_id,
        destination_name=link.name,
        destination_point=link.destination_point,
        target=target,
    )
    if target_item is None:
        return None
    target_key = str(target_item["stable_key"])
    keys_by_block[block_key] = target_key
    items.append(target_item)
    return target_key


def _pdf_native_link_target_item(
    *,
    media_id: UUID,
    destination_name: str,
    destination_point: tuple[float, float] | None,
    target: PdfReferenceBlock,
) -> dict[str, Any] | None:
    try:
        validate_exact_length(target.body_text)
        geometry = canonicalize_geometry(
            target.page_index + 1, [_quad_from_rect_coords(target.rect_coords)]
        )
    except GeometryValidationError:
        return None
    return {
        "stable_key": (
            "pdf:native-citation-target:"
            f"{target.page_index + 1:04d}:{target.label_number:04d}:"
            f"{stable_token(destination_name)}"
        ),
        "kind": "bibliography_entry",
        "label": target.label,
        "body_text": target.body_text,
        "locator": {
            "type": "pdf_page_geometry",
            "media_id": str(media_id),
            "page_number": target.page_index + 1,
            "quads": [_quad_json(quad) for quad in geometry.quads],
            "exact": target.body_text,
            "text_quote_selector": {"exact": target.body_text},
        },
        "locator_status": "exact",
        "confidence": "exact",
        "extraction_method": "pdf_native_link_target",
        "source_ref": {
            "format": "pdf",
            "named_destination": destination_name,
            "target_label": target.label,
            "target_page_number": target.page_index + 1,
            "destination_point": _pdf_point_json(destination_point),
            "reference_block": _pdf_rect_json(target.rect_coords),
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
    """Resolve a named destination onto one reference block, or nothing if ambiguous."""
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
    ranked = sorted(candidates, key=lambda block: abs(block.rect_coords[1] - destination_top))
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


def _validate_pdf_apparatus_budget(result: PdfApparatusResult) -> None:
    if len(result.items) > PDF_APPARATUS_MAX_ITEMS:
        raise _PdfResourceLimitExceeded(
            "PDF apparatus item count exceeds limit", dimension="Output"
        )
    if len(result.edges) > PDF_APPARATUS_MAX_EDGES:
        raise _PdfResourceLimitExceeded(
            "PDF apparatus edge count exceeds limit", dimension="Output"
        )
    retained_bytes = sum(nested_utf8_byte_length(item) for item in result.items)
    retained_bytes += sum(nested_utf8_byte_length(edge) for edge in result.edges)
    if retained_bytes > PDF_APPARATUS_MAX_RETAINED_UTF8_BYTES:
        raise _PdfResourceLimitExceeded(
            "PDF apparatus output exceeds 8 MiB retained-text limit", dimension="Output"
        )


# ---------------------------------------------------------------------------
# PyMuPDF page decoding
# ---------------------------------------------------------------------------


def _pdf_page_text_snapshot(page: Any) -> _PdfPageTextSnapshot:
    """Decode one PyMuPDF ``rawdict`` and derive every page text view from it.

    ``rawdict`` is ``dict`` plus each character's own box, which is what a link
    rectangle must be clipped against; taking it once keeps the single page
    representation this parser is allowed to hold.
    """
    text_dict = page.get_text("rawdict")
    if not isinstance(text_dict, dict):
        raise ValueError("PDF text representation must be a dictionary")
    blocks: list[tuple[float, float, float, float, str]] = []
    plain_blocks: list[str] = []
    for block in text_dict.get("blocks", []):
        if not isinstance(block, dict):
            continue
        raw_lines = block.get("lines", [])
        line_texts: list[str] = []
        for line in raw_lines if isinstance(raw_lines, list) else []:
            if not isinstance(line, dict):
                continue
            text_value = "".join(
                _pdf_span_text(_pdf_span_chars(span))
                for span in line.get("spans", [])
                if isinstance(span, dict)
            )
            if text_value:
                line_texts.append(text_value)
        block_text = "\n".join(line_texts)
        if block_text:
            plain_blocks.append(block_text)
        bbox = block.get("bbox") or (0, 0, 0, 0)
        try:
            blocks.append(
                (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]), block_text)
            )
        except (TypeError, ValueError, IndexError):
            continue
    blocks.sort(key=lambda block: (block[1], block[0]))
    return _PdfPageTextSnapshot(
        plain_text="\n".join(plain_blocks),
        blocks=blocks,
        lines=_pdf_text_lines(text_dict),
    )


def _pdf_span_chars(span: dict[str, Any]) -> list[tuple[float, float, float, float, str]]:
    """Return one span's characters with their own boxes, in reading order."""
    chars: list[tuple[float, float, float, float, str]] = []
    for char in span.get("chars", []):
        if not isinstance(char, dict):
            continue
        bbox = char.get("bbox") or (0, 0, 0, 0)
        try:
            chars.append(
                (
                    float(bbox[0]),
                    float(bbox[1]),
                    float(bbox[2]),
                    float(bbox[3]),
                    str(char.get("c") or ""),
                )
            )
        except (TypeError, ValueError, IndexError):
            continue
    return chars


def _pdf_span_text(chars: list[tuple[float, float, float, float, str]]) -> str:
    return "".join(char[4] for char in chars)


def _pdf_text_lines(text_dict: dict[str, Any]) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for block in text_dict.get("blocks", []):
        for line in block.get("lines", []):
            spans: list[dict[str, Any]] = []
            for span in line.get("spans", []):
                span_chars = _pdf_span_chars(span)
                text_value = _pdf_span_text(span_chars)
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
                        "chars": span_chars,
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
            lines.append(
                {
                    "text": text_value,
                    "left": min(float(span["left"]) for span in spans),
                    "top": min(float(span["top"]) for span in spans),
                    "right": max(float(span["right"]) for span in spans),
                    "bottom": max(float(span["bottom"]) for span in spans),
                    "spans": spans,
                }
            )
    return lines


def _pdf_link_text_from_snapshot(
    snapshot: _PdfPageTextSnapshot,
    source_rect: tuple[float, float, float, float],
) -> str:
    """Clip the sole page text representation to one link rectangle.

    The marker text anchors the same rectangle that is persisted as geometry, so
    it is the characters inside that rectangle, not every span it touches.
    """
    left, top, right, bottom = source_rect
    line_texts: list[str] = []
    text_codepoints = 0
    for line in snapshot.lines:
        clipped: list[str] = []
        for span in line["spans"]:
            for char_left, char_top, char_right, char_bottom, char in span["chars"]:
                if (
                    char_right <= left
                    or char_left >= right
                    or char_bottom <= top
                    or char_top >= bottom
                ):
                    continue
                text_codepoints += 1
                if text_codepoints > MAX_EXACT_CODEPOINTS:
                    return ""
                clipped.append(char)
        if clipped:
            line_texts.append("".join(clipped))
    return normalize_whitespace("\n".join(line_texts))


def _pdf_block_rect_coords(block: Any) -> tuple[float, float, float, float] | None:
    try:
        left, top, right, bottom = (
            float(block[0]),
            float(block[1]),
            float(block[2]),
            float(block[3]),
        )
    except (TypeError, ValueError, IndexError):
        return None
    return None if right <= left or bottom <= top else (left, top, right, bottom)


def _pdf_rect_coords(rect: Any) -> tuple[float, float, float, float] | None:
    try:
        left, top, right, bottom = float(rect.x0), float(rect.y0), float(rect.x1), float(rect.y1)
    except (TypeError, ValueError, AttributeError):
        return None
    return None if right <= left or bottom <= top else (left, top, right, bottom)


def _pdf_point_coords(point: Any) -> tuple[float, float] | None:
    if point is None:
        return None
    try:
        return float(point.x), float(point.y)
    except (TypeError, ValueError, AttributeError):
        return None


def _pdf_rect_json(coords: tuple[float, float, float, float]) -> dict[str, float]:
    return {"left": coords[0], "top": coords[1], "right": coords[2], "bottom": coords[3]}


def _pdf_point_json(point: tuple[float, float] | None) -> dict[str, float] | None:
    return None if point is None else {"x": float(point[0]), "y": float(point[1])}


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
