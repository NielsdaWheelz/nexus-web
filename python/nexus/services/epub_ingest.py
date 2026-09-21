"""EPUB extraction domain service.

Deterministic extraction of chapter fragments, TOC snapshots, title, and
internal assets from EPUB archives.  No route bindings; invoked by task
wrappers and orchestrated by lifecycle endpoints.

Reuses existing sanitization/canonicalization/fragment-block primitives.
"""

from __future__ import annotations

import codecs
import logging
import posixpath
import re
import time
import unicodedata
import zipfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from html.entities import name2codepoint
from html.parser import HTMLParser
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO, Literal, cast
from urllib.parse import unquote, urlparse
from uuid import UUID, uuid5
from xml.etree import ElementTree as ET

from defusedxml import ElementTree as DefusedET
from defusedxml.common import DefusedXmlException, DTDForbidden
from defusedxml.ElementTree import DefusedXMLParser
from lxml.etree import LxmlError
from lxml.html import Element, HtmlElement
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus import web_paths
from nexus.config import get_settings
from nexus.db.models import (
    EpubFragmentSource,
    EpubNavLocation,
    EpubResource,
    EpubTocNode,
    Fragment,
)
from nexus.errors import ApiErrorCode, ResourceFailureDimension
from nexus.ids import new_uuid7
from nexus.schemas.presence import Presence, Present, absent, nullable_from_presence, present
from nexus.schemas.publication_dates import PublicationDate, normalize_source_publication_date
from nexus.services.canonicalize import canonicalize_structure
from nexus.services.epub_structure import (
    EpubStructureFragment,
    EpubStructureSection,
    EpubStructureTocNode,
    build_epub_structure,
)
from nexus.services.fragment_blocks import insert_fragment_blocks, parse_fragment_blocks
from nexus.services.html5_shape import normalize_html5_shape
from nexus.services.html_apparatus import (
    HtmlApparatusTargetLimitExceeded,
    attach_fragment_locators,
    collect_html_apparatus_targets,
    extract_html_apparatus,
)
from nexus.services.html_tree import (
    inner_html,
    parse_html_document,
    serialize_html,
)
from nexus.services.parser_temp import (
    StorageObjectIntegrityError,
    parser_attempt_directory,
    stream_storage_object_to_file,
    utf8_byte_length,
)
from nexus.services.reader_apparatus import replace_media_apparatus
from nexus.storage.client import StorageError
from nexus.storage.paths import build_epub_attempt_asset_storage_path
from nexus.tasks.storage_object_cleanup import reserve_storage_object_write

if TYPE_CHECKING:
    from nexus.storage.client import StorageClient

logger = logging.getLogger(__name__)

EPUB_RENDERED_TEXT_MAX_BYTES = 64 * 1024 * 1024
EPUB_APPARATUS_MAX_TARGETS = 10_000
EPUB_APPARATUS_MAX_BACKLINKS = 10_000
EPUB_APPARATUS_MAX_RETAINED_UTF8_BYTES = 8 * 1024 * 1024
EPUB_XHTML_MAX_DECODED_BYTES = 16 * 1024 * 1024
EPUB_XML_MAX_DEPTH = 128
EPUB_XML_MAX_ELEMENTS_PER_ENTRY = 100_000
EPUB_XML_MAX_ELEMENTS_PER_BOOK = 1_000_000
EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT = 64
EPUB_XML_MAX_ATTRIBUTES_PER_BOOK = 1_000_000

_XHTML_DECODED_BYTES_MESSAGE = "EPUB XHTML decoded bytes exceed the 16 MiB per-entry limit"
_XHTML_SCAN_CHUNK_BYTES = 64 * 1024

# XHTML 1.x content documents and NCX navigation files reference the HTML named
# entities their (never fetched) external DTD would declare. Resolving them from
# this fixed local table keeps every reference a single bounded substitution.
_XHTML_NAMED_ENTITIES = {name: chr(codepoint) for name, codepoint in name2codepoint.items()}

# Void elements have no end tag, so they never open a nesting level.
_HTML_VOID_TAGS = frozenset(
    {
        "area",
        "base",
        "br",
        "col",
        "embed",
        "hr",
        "img",
        "input",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
    }
)

# ---------------------------------------------------------------------------
# Public result types
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EpubExtractionResult:
    fragment_count: int = 0
    toc_node_count: int = 0
    asset_count: int = 0
    title: str | None = None
    creators: list[str] = field(default_factory=list)
    publisher: str | None = None
    language: str | None = None
    description: str | None = None
    edition_published_date: Presence[PublicationDate] = field(default_factory=absent)
    edition_isbn: Presence[str] = field(default_factory=absent)


@dataclass(frozen=True)
class EpubExtractionError:
    error_code: str = ""
    error_message: str = ""
    terminal: bool = False
    resource_limit_dimension: ResourceFailureDimension | None = None


# ---------------------------------------------------------------------------
# Internal parsing types
# ---------------------------------------------------------------------------

_READABLE_MEDIA_TYPES = frozenset(
    {
        "application/xhtml+xml",
        "application/xml",
        "text/html",
        "text/xml",
    }
)

_NCX_MEDIA_TYPES = frozenset({"application/x-dtbncx+xml"})
_ZIP_ENTRY_READ_ERRORS = (
    KeyError,
    NotImplementedError,
    RuntimeError,
    zipfile.BadZipFile,
)
_XML_ENTRY_READ_ERRORS = (*_ZIP_ENTRY_READ_ERRORS, ET.ParseError)

_NS = {
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "xhtml": "http://www.w3.org/1999/xhtml",
    "epub": "http://www.idpf.org/2007/ops",
}

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_EPUB_ALLOWED_HTML_TAGS = frozenset(
    {
        "p",
        "br",
        "strong",
        "em",
        "b",
        "i",
        "u",
        "s",
        "blockquote",
        "pre",
        "code",
        "ul",
        "ol",
        "li",
        "dl",
        "dt",
        "dd",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "a",
        "img",
        "table",
        "thead",
        "tbody",
        "tfoot",
        "tr",
        "th",
        "td",
        "sup",
        "sub",
        "xref",
        "div",
        "span",
        "section",
        "article",
        "header",
        "footer",
        "nav",
        "aside",
        "figure",
        "figcaption",
        "main",
    }
)

_EPUB_ALLOWED_SVG_TAGS = frozenset(
    {
        "svg",
        "g",
        "image",
        "path",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "rect",
        "use",
        "defs",
        "symbol",
        "title",
        "desc",
        "clippath",
        "lineargradient",
        "radialgradient",
        "stop",
    }
)

_EPUB_GLOBAL_ATTRS = frozenset(
    {
        "id",
        "title",
        "lang",
        "dir",
        "xml:lang",
        "hidden",
        "aria-hidden",
        "aria-labelledby",
        "data-reader-apparatus-item-id",
        "data-reader-apparatus-kind",
        "data-reader-apparatus-confidence",
    }
)
_EPUB_ALLOWED_ATTRS = {
    "a": {"href", "title", "name"},
    "img": {"src", "srcset", "alt", "title", "width", "height"},
    "th": {"colspan", "rowspan", "scope"},
    "td": {"colspan", "rowspan"},
}
_EPUB_ALLOWED_SVG_ATTRS = {
    "svg": {
        "viewbox",
        "width",
        "height",
        "preserveaspectratio",
        "xmlns",
        "xmlns:xlink",
        "version",
    },
    "g": {"transform", "fill", "stroke", "stroke-width", "opacity", "clip-path"},
    "path": {
        "d",
        "transform",
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-dasharray",
        "stroke-dashoffset",
        "fill-rule",
        "opacity",
        "clip-path",
    },
    "circle": {"cx", "cy", "r", "fill", "stroke", "stroke-width", "opacity", "transform"},
    "ellipse": {"cx", "cy", "rx", "ry", "fill", "stroke", "stroke-width", "opacity"},
    "line": {
        "x1",
        "y1",
        "x2",
        "y2",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "opacity",
        "transform",
    },
    "polyline": {
        "points",
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "opacity",
        "transform",
    },
    "polygon": {
        "points",
        "fill",
        "stroke",
        "stroke-width",
        "stroke-linejoin",
        "opacity",
        "transform",
    },
    "rect": {
        "x",
        "y",
        "width",
        "height",
        "rx",
        "ry",
        "fill",
        "stroke",
        "stroke-width",
        "opacity",
        "transform",
    },
    "image": {
        "href",
        "xlink:href",
        "x",
        "y",
        "width",
        "height",
        "preserveAspectRatio",
        "transform",
        "opacity",
    },
    "use": {"href", "xlink:href", "x", "y", "width", "height", "transform"},
    "defs": set(),
    "symbol": {"viewBox", "preserveAspectRatio"},
    "title": set(),
    "desc": set(),
    "clippath": {"id"},
    "lineargradient": {"id", "x1", "x2", "y1", "y2", "gradientunits", "gradienttransform"},
    "radialgradient": {
        "id",
        "cx",
        "cy",
        "r",
        "fx",
        "fy",
        "gradientunits",
        "gradienttransform",
    },
    "stop": {"offset", "stop-color", "stop-opacity"},
}
_FORBIDDEN_URL_SCHEMES = frozenset({"javascript", "vbscript", "data", "file"})
_EVENT_HANDLER_RE = re.compile(r"^on", re.IGNORECASE)
_RESOURCE_ATTRS = frozenset({"src", "href", "xlink:href", "poster"})
_SUPPORTED_SVG_IMAGE_TYPE = "image/svg+xml"
_SUPPORTED_IMAGE_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/svg+xml",
        "image/webp",
    }
)
_SVG_FORBIDDEN_TAGS = frozenset(
    {
        "script",
        "animate",
        "animatemotion",
        "animatetransform",
        "set",
        "foreignobject",
        "iframe",
        "object",
        "embed",
        "audio",
        "video",
        "source",
        "track",
        "style",
    }
)


@dataclass
class _ManifestItem:
    manifest_id: str
    href: str
    media_type: str


@dataclass
class _SpineItem:
    idref: str
    itemref_id: str | None
    linear: bool


@dataclass
class _ChapterSpec:
    spine_idx: int
    manifest_id: str
    itemref_id: str | None
    href: str
    media_type: str
    linear: bool


@dataclass(frozen=True)
class _StagedChapter:
    chapter: _ChapterSpec
    html_path: Path


@dataclass
class _AssetEntry:
    epub_path: str
    asset_key: str
    content_type: str
    size_bytes: int


@dataclass
class _ArchiveSafetyConfig:
    max_entries: int
    max_total_uncompressed_bytes: int
    max_single_entry_uncompressed_bytes: int
    max_compression_ratio: int
    max_parse_time_ms: int


@dataclass(frozen=True)
class EpubExtractionPlan:
    result: EpubExtractionResult
    now: datetime
    storage_path: str
    source_size_bytes: int
    fragment_specs: tuple[
        tuple[
            Fragment,
            _ChapterSpec,
            list[dict[str, object]],
            list[dict[str, object]],
        ],
        ...,
    ]
    all_block_specs: tuple[list, ...]
    toc_nodes: tuple[EpubStructureTocNode, ...]
    nav_locations: tuple[EpubStructureSection, ...]
    asset_entries: tuple[_AssetEntry, ...]
    asset_storage_paths: dict[str, str]


class _EpubExtractionFailure(Exception):
    """Modeled failure caused by the EPUB payload, not service infrastructure."""


class _EpubResourceLimitExceeded(_EpubExtractionFailure):
    dimension: ResourceFailureDimension

    def __init__(self, message: str, *, dimension: ResourceFailureDimension):
        super().__init__(message)
        self.dimension = dimension


@dataclass
class _XmlStructuralBudget:
    element_count: int = 0
    attribute_count: int = 0


def _epub_resource_limit_error(
    message: str,
    *,
    dimension: ResourceFailureDimension,
) -> EpubExtractionError:
    return EpubExtractionError(
        error_code=ApiErrorCode.E_RESOURCE_LIMIT.value,
        error_message=message,
        terminal=True,
        resource_limit_dimension=dimension,
    )


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


def build_epub_extraction_plan(
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    expected_source_sha256: str,
    storage_client: StorageClient,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
    now: datetime | None = None,
) -> EpubExtractionPlan | EpubExtractionError:
    """Materialize and parse one immutable EPUB without retaining source bytes."""
    with parser_attempt_directory(attempt_id) as attempt_directory:
        epub_path = attempt_directory / "source.epub"
        try:
            stream_storage_object_to_file(
                storage_client,
                storage_path=storage_path,
                destination=epub_path,
                expected_size_bytes=source_size_bytes,
                expected_source_sha256=expected_source_sha256,
            )
        except StorageObjectIntegrityError:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_SOURCE_INTEGRITY.value,
                error_message="Stored EPUB bytes do not match the immutable source identity",
                terminal=True,
            )
        return _build_epub_extraction_plan_from_file(
            session_factory=session_factory,
            media_id=media_id,
            attempt_id=attempt_id,
            storage_path=storage_path,
            source_size_bytes=source_size_bytes,
            storage_client=storage_client,
            record_progress=record_progress,
            epub_path=epub_path,
            attempt_directory=attempt_directory,
            now=now,
        )


def extract_epub_metadata(epub_path: Path) -> EpubExtractionResult | EpubExtractionError:
    """Read OPF metadata only, retaining archive/XML bounds without publishing content."""
    settings = get_settings()
    structural_budget = _XmlStructuralBudget()
    try:
        with zipfile.ZipFile(epub_path) as zf:
            safety_error = _check_archive_safety(
                zf,
                _ArchiveSafetyConfig(
                    max_entries=settings.max_epub_archive_entries,
                    max_total_uncompressed_bytes=settings.max_epub_archive_total_uncompressed_bytes,
                    max_single_entry_uncompressed_bytes=settings.max_epub_archive_single_entry_uncompressed_bytes,
                    max_compression_ratio=settings.max_epub_archive_compression_ratio,
                    max_parse_time_ms=settings.max_epub_archive_parse_time_ms,
                ),
            )
            if safety_error is not None:
                return safety_error
            opf_path = _find_opf_path(zf, structural_budget)
            if opf_path is None:
                return EpubExtractionError(
                    error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
                    error_message="Cannot locate OPF rootfile",
                )
            opf = _parse_xml_entry(zf, opf_path, structural_budget, decoded_bytes_limit=None)
            if opf is None:
                return EpubExtractionError(
                    error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
                    error_message="Failed to parse OPF",
                )
            return _extract_opf_metadata(opf)
    except zipfile.BadZipFile as exc:
        return EpubExtractionError(
            error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
            error_message=f"Invalid ZIP: {exc}",
        )
    except _EpubResourceLimitExceeded as exc:
        return _epub_resource_limit_error(str(exc), dimension=exc.dimension)


def _build_epub_extraction_plan_from_file(
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    storage_client: StorageClient,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
    epub_path: Path,
    attempt_directory: Path,
    now: datetime | None,
) -> EpubExtractionPlan | EpubExtractionError:
    """Acquire, parse, and stage immutable attempt-owned EPUB assets."""
    if now is None:
        now = datetime.now(UTC)

    settings = get_settings()
    structural_budget = _XmlStructuralBudget()
    safety_cfg = _ArchiveSafetyConfig(
        max_entries=settings.max_epub_archive_entries,
        max_total_uncompressed_bytes=settings.max_epub_archive_total_uncompressed_bytes,
        max_single_entry_uncompressed_bytes=settings.max_epub_archive_single_entry_uncompressed_bytes,
        max_compression_ratio=settings.max_epub_archive_compression_ratio,
        max_parse_time_ms=settings.max_epub_archive_parse_time_ms,
    )

    # ---- parse OPF ---------------------------------------------------------
    t_start = time.monotonic()
    try:
        zf = zipfile.ZipFile(epub_path)
    except zipfile.BadZipFile as exc:
        return EpubExtractionError(
            error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
            error_message=f"Invalid ZIP: {exc}",
        )

    try:
        safety_err = _check_archive_safety(zf, safety_cfg)
        if safety_err is not None:
            return safety_err
        opf_path = _find_opf_path(zf, structural_budget)
        if opf_path is None:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
                error_message="Cannot locate OPF rootfile",
            )

        opf_dir = posixpath.dirname(opf_path)
        opf_tree = _parse_xml_entry(zf, opf_path, structural_budget, decoded_bytes_limit=None)
        if opf_tree is None:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_INVALID_FILE_TYPE.value,
                error_message="Failed to parse OPF",
            )

        manifest = _parse_manifest(opf_tree, opf_dir)
        spine_items = _parse_spine(opf_tree)

        # ---- title resolution ----------------------------------------------
        title = _resolve_title(opf_tree, storage_path)

        # ---- OPF metadata extraction --------------------------------------
        opf_meta = _extract_opf_metadata(opf_tree)

        # ---- extract readable chapters -------------------------------------
        chapter_specs = _collect_readable_chapters(zf, manifest, spine_items)
        asset_entries: list[_AssetEntry] = []
        asset_key_map: dict[str, str] = {}
        readable_paths = {
            item.href for item in manifest.values() if item.media_type in _READABLE_MEDIA_TYPES
        }
        try:
            staged_chapters, external_apparatus_targets = _stage_epub_chapters(
                zf,
                chapter_specs,
                staging_directory=attempt_directory,
                media_id=media_id,
                manifest=manifest,
                asset_entries=asset_entries,
                asset_key_map=asset_key_map,
                readable_paths=readable_paths,
                structural_budget=structural_budget,
            )
        except HtmlApparatusTargetLimitExceeded as exc:
            return _epub_resource_limit_error(
                f"EPUB apparatus exceeds its bounded index: {exc}",
                dimension=exc.dimension,
            )
        if not staged_chapters:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_SOURCE_NOT_READABLE.value,
                error_message="Zero renderable XHTML spine items after extraction",
            )
        chapter_total = len(staged_chapters)
        record_progress(0, chapter_total, "Chapter")

        # ---- sanitize chapters ----------------------------------------------
        sanitized_chapters: list[
            tuple[
                _ChapterSpec,
                str,
                list[dict[str, object]],
                list[dict[str, object]],
            ]
        ] = []
        all_block_specs: list[list] = []
        retained_hrefs: list[str] = []
        rendered_text_bytes = 0

        for chapter_index, staged in enumerate(staged_chapters, start=1):
            ch = staged.chapter
            html_with_apparatus, apparatus_items, apparatus_edges = extract_html_apparatus(
                staged.html_path.read_text(encoding="utf-8"),
                source_kind=f"epub:{ch.spine_idx}",
                document_href=ch.href,
                external_targets=external_apparatus_targets,
                source_ref={
                    "format": "xhtml",
                    "package_href": ch.href,
                    "manifest_id": ch.manifest_id,
                    "spine_index": ch.spine_idx,
                    "spine_itemref_id": ch.itemref_id,
                },
            )
            try:
                html_sanitized = _epub_sanitize(html_with_apparatus)
            except (ValueError, LxmlError) as exc:
                return EpubExtractionError(
                    error_code=ApiErrorCode.E_SANITIZATION_FAILED.value,
                    error_message=f"Sanitization failed for spine item {ch.spine_idx}: {exc}",
                )
            del html_with_apparatus

            if not html_sanitized.strip():
                record_progress(chapter_index, chapter_total, "Chapter")
                continue
            rendered_text_bytes += utf8_byte_length(html_sanitized)
            if rendered_text_bytes > EPUB_RENDERED_TEXT_MAX_BYTES:
                return _epub_resource_limit_error(
                    "EPUB rendered text exceeds the 64 MiB limit",
                    dimension="Output",
                )
            sanitized_chapters.append((ch, html_sanitized, apparatus_items, apparatus_edges))
            retained_hrefs.append(ch.href)
            record_progress(chapter_index, chapter_total, "Chapter")

        if not sanitized_chapters:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_SOURCE_NOT_READABLE.value,
                error_message="Zero renderable chapters after sanitization",
            )
        del external_apparatus_targets

        # build href -> fragment_idx lookup
        href_to_frag_idx = _build_href_to_frag_idx(retained_hrefs)

        # ---- TOC materialization -------------------------------------------
        toc_nodes = _materialize_toc(
            zf,
            opf_tree,
            manifest,
            href_to_frag_idx,
            structural_budget,
            media_id,
        )
        # ---- canonicalize once with exact source structure -----------------
        fragment_specs: list[
            tuple[
                Fragment,
                _ChapterSpec,
                list[dict[str, object]],
                list[dict[str, object]],
            ]
        ] = []
        structure_fragments: list[EpubStructureFragment] = []
        for fragment_idx, (ch, html_sanitized, apparatus_items, apparatus_edges) in enumerate(
            sanitized_chapters
        ):
            try:
                canonical = canonicalize_structure(html_sanitized)
                canonical_text = canonical.text
            except ValueError as exc:
                return EpubExtractionError(
                    error_code=ApiErrorCode.E_SANITIZATION_FAILED.value,
                    error_message=f"Canonicalization failed for spine item {ch.spine_idx}: {exc}",
                )
            rendered_text_bytes += utf8_byte_length(canonical_text)
            if rendered_text_bytes > EPUB_RENDERED_TEXT_MAX_BYTES:
                return _epub_resource_limit_error(
                    "EPUB rendered text exceeds the 64 MiB limit",
                    dimension="Output",
                )
            fragment = Fragment(
                id=new_uuid7(),
                media_id=media_id,
                idx=fragment_idx,
                html_sanitized=html_sanitized,
                canonical_text=canonical_text,
                created_at=now,
            )
            fragment_specs.append((fragment, ch, apparatus_items, apparatus_edges))
            structure_fragments.append(
                EpubStructureFragment(fragment.id, fragment_idx, ch.href, canonical)
            )
            all_block_specs.append(parse_fragment_blocks(canonical_text))

        fragments = [frag for frag, _ch, _items, _edges in fragment_specs]
        try:
            nav_locations = build_epub_structure(
                media_id=media_id,
                fragments=structure_fragments,
                toc_nodes=toc_nodes,
                existing_location_ids={},
            )
        except ValueError as exc:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_SOURCE_NOT_READABLE.value,
                error_message=str(exc),
            )

        # ---- check parse-time budget ---------------------------------------
        elapsed_ms = int((time.monotonic() - t_start) * 1000)
        if elapsed_ms > safety_cfg.max_parse_time_ms:
            return _epub_resource_limit_error(
                f"Parse time {elapsed_ms}ms exceeded limit {safety_cfg.max_parse_time_ms}ms",
                dimension="Time",
            )

        asset_storage_paths: dict[str, str] = {}
        for asset_index, ae in enumerate(asset_entries):
            asset_storage_key = build_epub_attempt_asset_storage_path(
                media_id,
                attempt_id,
                ae.asset_key,
            )
            reservation_db = session_factory()
            try:
                reserve_storage_object_write(
                    reservation_db,
                    media_id=media_id,
                    storage_path=asset_storage_key,
                )
            finally:
                reservation_db.close()
            try:
                with zf.open(ae.epub_path) as asset_stream:
                    if ae.content_type == _SUPPORTED_SVG_IMAGE_TYPE:
                        sanitized_path = attempt_directory / f"asset-{asset_index}.svg"
                        with sanitized_path.open("w+b") as sanitized_stream:
                            _write_sanitized_svg_asset(
                                cast(BinaryIO, asset_stream),
                                sanitized_stream,
                                ae.epub_path,
                                structural_budget,
                            )
                            ae.size_bytes = sanitized_stream.tell()
                            sanitized_stream.seek(0)
                            storage_client.put_object_stream(
                                asset_storage_key,
                                sanitized_stream,
                                ae.content_type,
                            )
                    else:
                        storage_client.put_object_stream(
                            asset_storage_key,
                            cast(BinaryIO, asset_stream),
                            ae.content_type,
                        )
                asset_storage_paths[ae.asset_key] = asset_storage_key
            except StorageError as exc:
                raise StorageError(exc.message, exc.code) from exc

        result = EpubExtractionResult(
            fragment_count=len(fragments),
            toc_node_count=len(toc_nodes),
            asset_count=len(asset_entries),
            title=title,
            creators=opf_meta.creators,
            publisher=opf_meta.publisher,
            language=opf_meta.language,
            description=opf_meta.description,
            edition_published_date=opf_meta.edition_published_date,
            edition_isbn=opf_meta.edition_isbn,
        )
        return EpubExtractionPlan(
            result=result,
            now=now,
            storage_path=storage_path,
            source_size_bytes=source_size_bytes,
            fragment_specs=tuple(fragment_specs),
            all_block_specs=tuple(all_block_specs),
            toc_nodes=tuple(toc_nodes),
            nav_locations=tuple(nav_locations),
            asset_entries=tuple(asset_entries),
            asset_storage_paths=asset_storage_paths,
        )

    except _EpubResourceLimitExceeded as exc:
        return _epub_resource_limit_error(str(exc), dimension=exc.dimension)
    except _EpubExtractionFailure as exc:
        error_code = ApiErrorCode.E_INVALID_FILE_TYPE.value
        return EpubExtractionError(
            error_code=error_code,
            error_message=f"Extraction failed: {exc}",
        )
    finally:
        zf.close()


def publish_epub_extraction_plan(
    db: Session,
    *,
    media_id: UUID,
    plan: EpubExtractionPlan,
) -> tuple[EpubExtractionResult, list[str]]:
    """Atomically replace all EPUB rows from an immutable prepared plan."""
    old_storage_paths = [
        str(value)
        for value in db.scalars(
            text(
                """
                SELECT storage_path
                FROM epub_resources
                WHERE media_id = :media_id
                ORDER BY storage_path
                """
            ),
            {"media_id": media_id},
        ).all()
    ]
    db.execute(
        text("DELETE FROM epub_resources WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM epub_fragment_sources WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM epub_nav_locations WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM epub_toc_nodes WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM fragment_blocks
            WHERE fragment_id IN (
                SELECT id FROM fragments WHERE media_id = :media_id
            )
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM fragments WHERE media_id = :media_id"),
        {"media_id": media_id},
    )

    fragments: list[Fragment] = []
    for template, _chapter, _items, _edges in plan.fragment_specs:
        fragment = Fragment(
            id=template.id,
            media_id=media_id,
            idx=template.idx,
            html_sanitized=template.html_sanitized,
            canonical_text=template.canonical_text,
            created_at=plan.now,
        )
        fragments.append(fragment)
        db.add(fragment)
    db.flush()
    for fragment in fragments:
        if 0 <= fragment.idx < len(plan.all_block_specs):
            insert_fragment_blocks(
                db,
                fragment.id,
                plan.all_block_specs[fragment.idx],
            )

    for fragment, (_template, chapter, _items, _edges) in zip(
        fragments,
        plan.fragment_specs,
        strict=True,
    ):
        db.add(
            EpubFragmentSource(
                media_id=media_id,
                fragment_id=fragment.id,
                package_href=chapter.href,
                manifest_item_id=chapter.manifest_id,
                spine_itemref_id=chapter.itemref_id,
                media_type=chapter.media_type,
                linear=chapter.linear,
                reading_order=chapter.spine_idx,
                created_at=plan.now,
            )
        )
    for node in plan.toc_nodes:
        db.add(
            EpubTocNode(
                media_id=media_id,
                node_id=node.node_id,
                nav_type=node.nav_type,
                parent_node_id=node.parent_node_id,
                label=node.label,
                href=node.href,
                fragment_idx=node.fragment_idx,
                depth=node.depth,
                order_key=node.order_key,
                target_offset=node.target_offset,
                created_at=plan.now,
            )
        )
    for asset in plan.asset_entries:
        db.add(
            EpubResource(
                media_id=media_id,
                package_href=asset.epub_path,
                asset_key=asset.asset_key,
                storage_path=plan.asset_storage_paths[asset.asset_key],
                content_type=asset.content_type,
                size_bytes=asset.size_bytes,
                created_at=plan.now,
            )
        )
    db.flush()
    for ordinal, nav in enumerate(plan.nav_locations):
        db.add(
            EpubNavLocation(
                media_id=media_id,
                location_id=nav.location_id,
                ordinal=ordinal,
                source_node_id=nullable_from_presence(nav.source_node_id),
                label=nav.label,
                fragment_idx=nav.fragment_idx,
                href_path=nav.href_path,
                href_fragment=nullable_from_presence(nav.href_fragment),
                start_offset=nav.start_offset,
                parent_section_id=nullable_from_presence(nav.parent_section_id),
                end_fragment_idx=nav.end.value.fragment_idx
                if isinstance(nav.end, Present)
                else None,
                end_offset=nav.end.value.offset if isinstance(nav.end, Present) else None,
                source=nav.source,
                created_at=plan.now,
            )
        )
    db.flush()

    apparatus_items: list[dict[str, object]] = []
    apparatus_edges: list[dict[str, object]] = []
    for fragment, (_template, _chapter, fragment_items, fragment_edges) in zip(
        fragments,
        plan.fragment_specs,
        strict=True,
    ):
        apparatus_items.extend(
            attach_fragment_locators(
                media_id=media_id,
                fragment_id=fragment.id,
                media_kind="epub",
                canonical_text=fragment.canonical_text,
                items=fragment_items,
                html_sanitized=fragment.html_sanitized,
            )
        )
        apparatus_edges.extend(fragment_edges)
    replace_media_apparatus(
        db,
        media_id=media_id,
        items=apparatus_items,
        edges=apparatus_edges,
        status="ready" if apparatus_items else "empty",
    )
    return plan.result, old_storage_paths


# ---------------------------------------------------------------------------
# Archive safety
# ---------------------------------------------------------------------------


def _check_archive_safety(
    zf: zipfile.ZipFile,
    cfg: _ArchiveSafetyConfig,
) -> EpubExtractionError | None:
    """Validate an already file-backed EPUB archive before reading entries."""
    infos = zf.infolist()

    if len(infos) > cfg.max_entries:
        return _epub_resource_limit_error(
            f"Archive has {len(infos)} entries (limit {cfg.max_entries})",
            dimension="Structure",
        )

    total_uncompressed = 0
    seen_names: set[str] = set()
    for info in infos:
        # path safety: reject absolute, traversal, drive-qualified
        name = info.filename
        if name.startswith("/") or name.startswith("\\"):
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=f"Absolute path in archive: {name}",
                terminal=True,
            )
        if ".." in name.split("/"):
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=f"Path traversal in archive: {name}",
                terminal=True,
            )
        if len(name) > 1 and name[1] == ":":
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=f"Drive-qualified path in archive: {name}",
                terminal=True,
            )

        if name in seen_names:
            return EpubExtractionError(
                error_code=ApiErrorCode.E_ARCHIVE_UNSAFE.value,
                error_message=f"Duplicate path in archive: {name}",
                terminal=True,
            )
        seen_names.add(name)

        uncompressed = info.file_size
        compressed = info.compress_size

        if uncompressed > cfg.max_single_entry_uncompressed_bytes:
            return _epub_resource_limit_error(
                (
                    f"Entry '{name}' uncompressed size {uncompressed} "
                    f"exceeds limit {cfg.max_single_entry_uncompressed_bytes}"
                ),
                dimension="Output",
            )

        total_uncompressed += uncompressed

        if compressed > 0 and uncompressed / compressed > cfg.max_compression_ratio:
            return _epub_resource_limit_error(
                (
                    f"Entry '{name}' compression ratio {uncompressed / compressed:.1f} "
                    f"exceeds limit {cfg.max_compression_ratio}"
                ),
                dimension="Output",
            )

    if total_uncompressed > cfg.max_total_uncompressed_bytes:
        return _epub_resource_limit_error(
            (
                f"Total uncompressed {total_uncompressed} "
                f"exceeds limit {cfg.max_total_uncompressed_bytes}"
            ),
            dimension="Output",
        )

    return None


# ---------------------------------------------------------------------------
# OPF / Manifest / Spine parsing
# ---------------------------------------------------------------------------


def _find_opf_path(zf: zipfile.ZipFile, structural_budget: _XmlStructuralBudget) -> str | None:
    container = _parse_xml_entry(
        zf,
        "META-INF/container.xml",
        structural_budget,
        decoded_bytes_limit=None,
    )
    if container is None:
        return None
    rootfile = container.find(
        ".//container:rootfile[@media-type='application/oebps-package+xml']",
        _NS,
    )
    if rootfile is None:
        rootfile = container.find(".//container:rootfile", _NS)
    if rootfile is not None:
        full_path = rootfile.get("full-path") or ""
        return _resolve_epub_path("", full_path)
    return None


def _parse_xml_entry(
    zf: zipfile.ZipFile,
    path: str,
    structural_budget: _XmlStructuralBudget,
    *,
    decoded_bytes_limit: int | None,
) -> ET.Element | None:
    """Preflight XML structure before any full tree is materialized.

    DefusedXML disables entity expansion and external resolution. The streaming
    pass bounds entry-local shape and book-wide cumulative structure before the
    ordinary ElementTree consumer receives a DOM. An absent or malformed entry
    is absence; only a declared budget breach escapes.
    """
    try:
        _preflight_xml_entry(
            zf,
            path,
            structural_budget,
            decoded_bytes_limit=decoded_bytes_limit,
        )
        with zf.open(path) as source:
            return DefusedET.parse(
                source,
                parser=_new_safe_doctype_parser(),
            ).getroot()
    # justify-ignore-error: absent or malformed optional EPUB XML entries are absence.
    except _XML_ENTRY_READ_ERRORS:
        return None
    # justify-ignore-error: an entry declaring DTD entities is not a usable XML entry.
    except DefusedXmlException:
        return None


def _preflight_xml_entry(
    zf: zipfile.ZipFile,
    path: str,
    structural_budget: _XmlStructuralBudget,
    *,
    decoded_bytes_limit: int | None,
) -> None:
    """Bound one strict XML entry's decoded size and shape before a DOM exists."""
    info = zf.getinfo(path)
    if decoded_bytes_limit is not None and info.file_size > decoded_bytes_limit:
        raise _EpubResourceLimitExceeded(_XHTML_DECODED_BYTES_MESSAGE, dimension="Output")
    with zf.open(info) as source:
        _scan_xml_stream(cast(BinaryIO, source), structural_budget)


def _scan_xml_stream(source: BinaryIO, structural_budget: _XmlStructuralBudget) -> None:
    """Charge one strict XML stream against the declared structural budgets."""
    depth = 0
    entry_elements = 0
    for event, element in DefusedET.iterparse(
        source,
        events=("start", "end"),
        parser=_new_safe_doctype_parser(),
    ):
        if event == "start":
            depth += 1
            entry_elements += 1
            _charge_structural_budget(
                structural_budget,
                depth=depth,
                entry_elements=entry_elements,
                attributes=len(element.attrib),
            )
        else:
            depth -= 1
            element.clear()


def _preflight_xhtml_entry(
    zf: zipfile.ZipFile,
    path: str,
    structural_budget: _XmlStructuralBudget,
) -> None:
    """Bound one content document's decoded size and shape before any rewrite.

    Content documents are rendered by the recovering HTML parser, so this pass
    scans the same tolerant grammar: markup that is not well-formed XML stays
    as readable as it was, while its shape stays inside the declared budgets.
    """
    # `zipfile` hands out at most the declared uncompressed size and fails the
    # entry's CRC otherwise, so the declared size is the decoded-byte bound and
    # the entry never has to be inflated to learn it is too large.
    info = zf.getinfo(path)
    if info.file_size > EPUB_XHTML_MAX_DECODED_BYTES:
        raise _EpubResourceLimitExceeded(_XHTML_DECODED_BYTES_MESSAGE, dimension="Output")
    scan = _XhtmlStructureScan(structural_budget)
    with zf.open(info) as source:
        decoder: codecs.IncrementalDecoder | None = None
        while chunk := source.read(_XHTML_SCAN_CHUNK_BYTES):
            if decoder is None:
                decoder = _incremental_epub_text_decoder(chunk)
            scan.feed(decoder.decode(chunk))
    scan.close()


class _XhtmlStructureScan(HTMLParser):
    """Charge a streamed content document's elements against the same budgets."""

    def __init__(self, structural_budget: _XmlStructuralBudget) -> None:
        super().__init__(convert_charrefs=True)
        self._structural_budget = structural_budget
        self._open_tags: list[str] = []
        self._entry_elements = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._charge_element(tag, len(attrs), closes_itself=tag in _HTML_VOID_TAGS)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._charge_element(tag, len(attrs), closes_itself=True)

    def handle_endtag(self, tag: str) -> None:
        for position in range(len(self._open_tags) - 1, -1, -1):
            if self._open_tags[position] == tag:
                del self._open_tags[position:]
                return

    def handle_decl(self, decl: str) -> None:
        if "[" in decl:
            raise _EpubExtractionFailure("EPUB XML entities and external resolution are disabled")

    def _charge_element(self, tag: str, attributes: int, *, closes_itself: bool) -> None:
        self._entry_elements += 1
        _charge_structural_budget(
            self._structural_budget,
            depth=len(self._open_tags) + 1,
            entry_elements=self._entry_elements,
            attributes=attributes,
        )
        if not closes_itself:
            self._open_tags.append(tag)


def _charge_structural_budget(
    structural_budget: _XmlStructuralBudget,
    *,
    depth: int,
    entry_elements: int,
    attributes: int,
) -> None:
    """Charge one opening element against the entry-local and book-wide budgets."""
    structural_budget.element_count += 1
    structural_budget.attribute_count += attributes
    if depth > EPUB_XML_MAX_DEPTH:
        raise _EpubResourceLimitExceeded(
            "EPUB XML depth exceeds the 128-level limit",
            dimension="Structure",
        )
    if entry_elements > EPUB_XML_MAX_ELEMENTS_PER_ENTRY:
        raise _EpubResourceLimitExceeded(
            "EPUB XML elements exceed the per-entry limit",
            dimension="Structure",
        )
    if structural_budget.element_count > EPUB_XML_MAX_ELEMENTS_PER_BOOK:
        raise _EpubResourceLimitExceeded(
            "EPUB XML elements exceed the per-book limit",
            dimension="Structure",
        )
    if attributes > EPUB_XML_MAX_ATTRIBUTES_PER_ELEMENT:
        raise _EpubResourceLimitExceeded(
            "EPUB XML attributes exceed the per-element limit",
            dimension="Structure",
        )
    if structural_budget.attribute_count > EPUB_XML_MAX_ATTRIBUTES_PER_BOOK:
        raise _EpubResourceLimitExceeded(
            "EPUB XML attributes exceed the per-book limit",
            dimension="Structure",
        )


def _incremental_epub_text_decoder(prefix: bytes) -> codecs.IncrementalDecoder:
    """Pick the codec `_decode_epub_text` would pick, on a stream read once."""
    if prefix.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return codecs.getincrementaldecoder("utf-16")(errors="replace")
    return codecs.getincrementaldecoder("utf-8-sig")(errors="replace")


def _new_safe_doctype_parser() -> DefusedXMLParser:
    """Read an inert external DTD declaration without ever resolving one.

    Expat reads an external subset only when parameter-entity parsing is
    enabled, which ElementTree never enables, and ``forbid_external`` refuses
    any external reference that would still be attempted. An internal subset is
    the one doctype form that can declare entities here, so it stays refused,
    and the XHTML named entities a conformant content document may reference
    resolve from this parser's own fixed table.
    """
    parser = DefusedXMLParser(
        forbid_dtd=False,
        forbid_entities=True,
        forbid_external=True,
    )

    def reject_internal_subset(
        name: str,
        system_id: str | None,
        public_id: str | None,
        has_internal_subset: bool,
    ) -> None:
        if has_internal_subset:
            raise DTDForbidden(name, system_id, public_id)

    parser.parser.StartDoctypeDeclHandler = reject_internal_subset
    parser.entity.update(_XHTML_NAMED_ENTITIES)
    return parser


def _parse_manifest(
    opf: ET.Element,
    opf_dir: str,
) -> dict[str, _ManifestItem]:
    """Return OPF manifest items keyed by manifest id."""
    result: dict[str, _ManifestItem] = {}
    for item in opf.findall(".//opf:manifest/opf:item", _NS):
        item_id = item.get("id", "")
        href = item.get("href", "")
        mtype = item.get("media-type", "")
        if item_id and href:
            resolved = _resolve_epub_path(opf_dir, href)
            if resolved is not None:
                result[item_id] = _ManifestItem(
                    manifest_id=item_id,
                    href=resolved,
                    media_type=mtype,
                )
    return result


def _parse_spine(opf: ET.Element) -> list[_SpineItem]:
    refs: list[_SpineItem] = []
    for itemref in opf.findall(".//opf:spine/opf:itemref", _NS):
        idref = itemref.get("idref", "")
        if idref:
            refs.append(
                _SpineItem(
                    idref=idref,
                    itemref_id=itemref.get("id") or None,
                    linear=itemref.get("linear", "yes").lower() != "no",
                )
            )
    return refs


# ---------------------------------------------------------------------------
# Title resolution
# ---------------------------------------------------------------------------


def _resolve_title(opf: ET.Element, storage_path: str) -> str:
    # dc:title
    dc_title = opf.find(".//opf:metadata/dc:title", _NS)
    if dc_title is not None and dc_title.text and dc_title.text.strip():
        return _normalize_title(dc_title.text.strip())

    # <title> (non-namespaced fallback)
    for tag_path in [".//opf:metadata/title", ".//title"]:
        title_el = opf.find(tag_path, _NS)
        if title_el is not None and title_el.text and title_el.text.strip():
            return _normalize_title(title_el.text.strip())

    # filename sans extension
    filename = _filename_from_storage_path(storage_path)
    if filename:
        return _normalize_title(filename)

    return "Untitled EPUB"


def _normalize_title(raw: str) -> str:
    t = re.sub(r"\s+", " ", raw).strip()
    if not t:
        return "Untitled EPUB"
    return t[:255]


def _extract_opf_metadata(opf: ET.Element) -> EpubExtractionResult:
    """Extract Dublin Core metadata from OPF document."""
    creators = [
        el.text.strip()
        for el in opf.findall(".//opf:metadata/dc:creator", _NS)
        if el.text and el.text.strip()
    ]
    publisher = opf.findtext(".//opf:metadata/dc:publisher", namespaces=_NS)
    language = opf.findtext(".//opf:metadata/dc:language", namespaces=_NS)
    description = opf.findtext(".//opf:metadata/dc:description", namespaces=_NS)
    date_elements = opf.findall(".//opf:metadata/dc:date", _NS)
    publication_elements = [
        element
        for element in date_elements
        if element.get(f"{{{_NS['opf']}}}event") == "publication"
    ]
    if not publication_elements:
        publication_elements = [
            element for element in date_elements if element.get(f"{{{_NS['opf']}}}event") is None
        ]
    publication_dates: set[str] = set()
    for element in publication_elements:
        normalized = normalize_source_publication_date(element.text)
        if isinstance(normalized, Present):
            publication_dates.add(normalized.value)
    isbns: set[str] = set()
    primary_isbns: set[str] = set()
    primary_id = opf.get("unique-identifier")
    for identifier in opf.findall(".//opf:metadata/dc:identifier", _NS):
        raw = re.sub(
            r"^(?:urn:isbn:|isbn(?:-1[03])?:?)[ \t]*",
            "",
            (identifier.text or "").strip(),
            flags=re.IGNORECASE,
        )
        value = re.sub(r"[\s-]", "", raw).upper()
        if re.fullmatch(r"[0-9]{9}[0-9X]", value):
            digits = [10 if char == "X" else int(char) for char in value]
            if sum((10 - index) * digit for index, digit in enumerate(digits)) % 11:
                continue
            body = "978" + value[:9]
            checksum = sum(
                int(char) * (1 if index % 2 == 0 else 3) for index, char in enumerate(body)
            )
            value = body + str((-checksum) % 10)
        elif re.fullmatch(r"97[89][0-9]{10}", value):
            checksum = sum(
                int(char) * (1 if index % 2 == 0 else 3) for index, char in enumerate(value)
            )
            if checksum % 10:
                continue
        else:
            continue
        isbns.add(value)
        if primary_id is not None and identifier.get("id") == primary_id:
            primary_isbns.add(value)
    selected = primary_isbns if primary_isbns else isbns
    return EpubExtractionResult(
        creators=creators,
        publisher=publisher.strip() or None if publisher is not None else None,
        language=language.strip() or None if language is not None else None,
        description=description.strip() or None if description is not None else None,
        edition_published_date=present(next(iter(publication_dates)))
        if len(publication_dates) == 1
        else absent(),
        edition_isbn=present(next(iter(selected))) if len(selected) == 1 else absent(),
    )


def _filename_from_storage_path(path: str) -> str:
    base = posixpath.basename(path)
    if "." in base:
        name = base.rsplit(".", 1)[0]
        name = name.strip()
        if name and name.lower() != "original":
            return name
    return ""


def _resolve_epub_path(base_dir: str, href: str) -> str | None:
    decoded = unquote((href or "").split("#", 1)[0]).strip()
    if not decoded:
        return None
    parsed = urlparse(decoded)
    if parsed.scheme or decoded.startswith("/"):
        return None
    resolved = posixpath.normpath(posixpath.join(base_dir, decoded)) if base_dir else decoded
    if resolved in {"", "."} or resolved.startswith("../") or resolved == "..":
        return None
    return resolved


# ---------------------------------------------------------------------------
# Chapter extraction
# ---------------------------------------------------------------------------


def _collect_readable_chapters(
    zf: zipfile.ZipFile,
    manifest: dict[str, _ManifestItem],
    spine_items: list[_SpineItem],
) -> list[_ChapterSpec]:
    chapters: list[_ChapterSpec] = []
    for spine_idx, spine_item in enumerate(spine_items):
        entry = manifest.get(spine_item.idref)
        if entry is None:
            continue
        if entry.media_type not in _READABLE_MEDIA_TYPES:
            continue
        try:
            info = zf.getinfo(entry.href)
        # justify-ignore-error: unreadable spine entries are not renderable chapters.
        except _ZIP_ENTRY_READ_ERRORS:
            continue
        if info.file_size < 1:
            continue
        chapters.append(
            _ChapterSpec(
                spine_idx=spine_idx,
                manifest_id=spine_item.idref,
                itemref_id=spine_item.itemref_id,
                href=entry.href,
                media_type=entry.media_type,
                linear=spine_item.linear,
            )
        )
    return chapters


def _decode_epub_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-16"):
        try:
            return raw.decode(encoding)
        except UnicodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _stage_epub_chapters(
    zf: zipfile.ZipFile,
    chapter_specs: list[_ChapterSpec],
    *,
    staging_directory: Path,
    media_id: UUID,
    manifest: dict[str, _ManifestItem],
    asset_entries: list[_AssetEntry],
    asset_key_map: dict[str, str],
    readable_paths: set[str],
    structural_budget: _XmlStructuralBudget,
) -> tuple[list[_StagedChapter], dict[str, dict[str, object]]]:
    """Rewrite each readable spine item once and index its apparatus targets.

    Rewritten chapter HTML is spilled to the attempt directory so the later
    marker pass reads exactly the package-relative links indexed here, while
    only one chapter's HTML is retained at a time.
    """
    staged_chapters: list[_StagedChapter] = []
    targets: dict[str, dict[str, object]] = {}
    target_count = 0
    retained_utf8_bytes = 0
    backlink_count = 0
    for ch in chapter_specs:
        try:
            _preflight_xhtml_entry(zf, ch.href, structural_budget)
            raw = zf.read(ch.href)
        # justify-ignore-error: an unreadable spine entry is not a renderable chapter.
        except _ZIP_ENTRY_READ_ERRORS:
            continue
        rewritten_html = _rewrite_chapter_resources(
            _decode_epub_text(raw),
            ch.href,
            zf,
            media_id,
            manifest,
            asset_entries,
            asset_key_map,
            readable_paths,
        )
        del raw
        html_path = staging_directory / f"chapter-{ch.spine_idx}.html"
        html_path.write_text(rewritten_html, encoding="utf-8")
        staged_chapters.append(_StagedChapter(chapter=ch, html_path=html_path))
        (
            chapter_targets,
            chapter_target_count,
            chapter_retained_utf8_bytes,
            chapter_backlink_count,
        ) = collect_html_apparatus_targets(
            rewritten_html,
            document_href=ch.href,
            source_kind=f"epub:{ch.spine_idx}",
            source_ref={
                "format": "xhtml",
                "package_href": ch.href,
                "manifest_id": ch.manifest_id,
                "spine_index": ch.spine_idx,
                "spine_itemref_id": ch.itemref_id,
            },
            extraction_method="epub_noteref",
            max_targets=EPUB_APPARATUS_MAX_TARGETS - target_count,
            max_backlinks=EPUB_APPARATUS_MAX_BACKLINKS - backlink_count,
            max_retained_utf8_bytes=(EPUB_APPARATUS_MAX_RETAINED_UTF8_BYTES - retained_utf8_bytes),
        )
        del rewritten_html
        targets.update(chapter_targets)
        target_count += chapter_target_count
        retained_utf8_bytes += chapter_retained_utf8_bytes
        backlink_count += chapter_backlink_count
    return staged_chapters, targets


# ---------------------------------------------------------------------------
# Resource rewriting
# ---------------------------------------------------------------------------


def _rewrite_chapter_resources(
    html: str,
    chapter_href: str,
    zf: zipfile.ZipFile,
    media_id: UUID,
    manifest: dict[str, _ManifestItem],
    asset_entries: list[_AssetEntry],
    asset_key_map: dict[str, str],
    readable_paths: set[str],
) -> str:
    """Rewrite local resource links in parsed chapter HTML."""
    chapter_dir = posixpath.dirname(chapter_href)
    try:
        doc = parse_html_document(html)
    except LxmlError as exc:
        raise _EpubExtractionFailure(
            f"Failed to parse EPUB chapter resources: {chapter_href}"
        ) from exc

    if doc.body is not None:
        _materialize_epub_body_anchor(doc.body)
    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        tag = _local_name(element.tag)
        for attr in list(element.attrib):
            normalized_attr = _normalized_attr_name(attr)
            value = element.attrib.get(attr, "")
            if tag == "img" and normalized_attr == "srcset":
                rewritten = _rewrite_srcset(
                    value,
                    chapter_dir,
                    zf,
                    media_id,
                    manifest,
                    asset_entries,
                    asset_key_map,
                )
                if rewritten:
                    element.attrib[attr] = rewritten
                else:
                    del element.attrib[attr]
                continue
            if tag == "img" and normalized_attr == "src":
                rewritten = _rewrite_image_resource_url(
                    value,
                    chapter_dir,
                    zf,
                    media_id,
                    manifest,
                    asset_entries,
                    asset_key_map,
                )
                if rewritten is None:
                    del element.attrib[attr]
                else:
                    element.attrib[attr] = rewritten
                continue
            if tag == "image" and normalized_attr in {"href", "xlink:href"}:
                rewritten = _rewrite_image_resource_url(
                    value,
                    chapter_dir,
                    zf,
                    media_id,
                    manifest,
                    asset_entries,
                    asset_key_map,
                )
                if rewritten is None:
                    del element.attrib[attr]
                else:
                    element.attrib[attr] = rewritten
                continue
            if normalized_attr not in _RESOURCE_ATTRS:
                continue
            rewritten = _rewrite_resource_url(
                value,
                normalized_attr,
                chapter_dir,
                readable_paths,
            )
            if rewritten is None:
                del element.attrib[attr]
            else:
                element.attrib[attr] = rewritten

    return _document_body_inner_html(doc)


def _rewrite_image_resource_url(
    raw_url: str,
    base_dir: str,
    zf: zipfile.ZipFile,
    media_id: UUID,
    manifest: dict[str, _ManifestItem],
    asset_entries: list[_AssetEntry],
    asset_key_map: dict[str, str],
) -> str | None:
    if not raw_url or raw_url.startswith("#"):
        return None

    parsed = urlparse(raw_url)
    if parsed.scheme or raw_url.startswith("//"):
        return None

    resolved = _resolve_epub_path(base_dir, parsed.path or "")
    if resolved is None:
        return None

    key = _ensure_asset_entry(
        resolved,
        zf,
        manifest,
        asset_entries,
        asset_key_map,
    )
    if key is None:
        return None
    rewritten = web_paths.media_asset_url(media_id, key)
    return f"{rewritten}#{parsed.fragment}" if parsed.fragment else rewritten


def _rewrite_resource_url(
    raw_url: str,
    attr_name: str,
    base_dir: str,
    readable_paths: set[str],
) -> str | None:
    if not raw_url or raw_url.startswith("#"):
        return raw_url

    parsed = urlparse(raw_url)
    if parsed.scheme or raw_url.startswith("//"):
        return raw_url if attr_name == "href" and parsed.scheme in {"http", "https"} else None

    resolved = _resolve_epub_path(base_dir, parsed.path or "")
    if resolved is None:
        return None

    if attr_name == "href" and resolved in readable_paths:
        return f"{resolved}#{parsed.fragment}" if parsed.fragment else resolved

    return None


def _rewrite_srcset(
    value: str,
    base_dir: str,
    zf: zipfile.ZipFile,
    media_id: UUID,
    manifest: dict[str, _ManifestItem],
    asset_entries: list[_AssetEntry],
    asset_key_map: dict[str, str],
) -> str:
    parts: list[str] = []
    for candidate in value.split(","):
        tokens = candidate.strip().split()
        if not tokens:
            continue
        rewritten = _rewrite_image_resource_url(
            tokens[0],
            base_dir,
            zf,
            media_id,
            manifest,
            asset_entries,
            asset_key_map,
        )
        if rewritten:
            parts.append(" ".join([rewritten, *tokens[1:]]))
    return ", ".join(parts)


def _document_body_inner_html(doc: HtmlElement) -> str:
    body = doc.body
    if body is None:
        body = doc
    return inner_html(body)


def _ensure_asset_entry(
    epub_path: str,
    zf: zipfile.ZipFile,
    manifest: dict[str, _ManifestItem],
    asset_entries: list[_AssetEntry],
    asset_key_map: dict[str, str],
) -> str | None:
    if epub_path in asset_key_map:
        return asset_key_map[epub_path]
    manifest_item = _manifest_item_for_href(epub_path, manifest)
    if manifest_item is None:
        if posixpath.splitext(epub_path)[1].lower() in {
            ".png",
            ".jpg",
            ".jpeg",
            ".gif",
            ".svg",
            ".webp",
        }:
            raise _EpubExtractionFailure(
                f"Referenced EPUB image asset missing from OPF manifest: {epub_path}"
            )
        return None
    if manifest_item.media_type not in _SUPPORTED_IMAGE_TYPES:
        return None

    try:
        info = zf.getinfo(epub_path)
    except KeyError as exc:
        raise _EpubExtractionFailure(
            f"Referenced EPUB image asset missing from archive: {epub_path}"
        ) from exc

    content_type = manifest_item.media_type
    key = _derive_asset_key(epub_path, asset_key_map)
    asset_key_map[epub_path] = key
    asset_entries.append(
        _AssetEntry(
            epub_path=epub_path,
            asset_key=key,
            content_type=content_type,
            size_bytes=info.file_size,
        )
    )
    return key


def _derive_asset_key(epub_path: str, existing: dict[str, str]) -> str:
    """Deterministic asset key from normalized EPUB path."""
    key = epub_path.lstrip("/")
    key = re.sub(r"[^a-zA-Z0-9_./-]", "_", key)
    if not key:
        key = "asset"

    if key not in existing.values():
        return key

    base, ext = posixpath.splitext(key)
    suffix = 2
    while True:
        candidate = f"{base}_{suffix}{ext}"
        if candidate not in existing.values():
            return candidate
        suffix += 1


def _manifest_item_for_href(
    path: str,
    manifest: dict[str, _ManifestItem],
) -> _ManifestItem | None:
    for item in manifest.values():
        if item.href == path:
            return item
    return None


def _write_sanitized_svg_asset(
    source: BinaryIO,
    destination: BinaryIO,
    epub_path: str,
    structural_budget: _XmlStructuralBudget,
) -> None:
    try:
        # SVG is XML too: apply the same entry and book-wide structural limits
        # before DefusedET builds the asset DOM, reading the caller's own entry
        # handle. The XHTML-only decoded-size budget intentionally does not
        # apply to referenced SVG assets.
        _scan_xml_stream(source, structural_budget)
        source.seek(0)
        root = DefusedET.parse(
            source,
            parser=_new_safe_doctype_parser(),
        ).getroot()
    except (ET.ParseError, DefusedXmlException) as exc:
        raise _EpubExtractionFailure(f"Referenced SVG asset cannot be parsed: {epub_path}") from exc

    # `ElementTree.getroot()` is typed as optional, so this states the same
    # rejection for an empty tree and for a non-SVG root.
    if root is None or _local_name(root.tag) != "svg":
        raise _EpubExtractionFailure(f"Referenced SVG asset is not an SVG document: {epub_path}")

    _sanitize_svg_asset_element(root)
    ET.ElementTree(root).write(destination, encoding="utf-8", xml_declaration=True)


def _sanitize_svg_asset_element(element: ET.Element) -> bool:
    for child in list(element):
        if _sanitize_svg_asset_element(child):
            element.remove(child)

    tag = _local_name(element.tag)
    if tag in _SVG_FORBIDDEN_TAGS:
        return True

    for attr in list(element.attrib):
        normalized_attr = _normalized_attr_name(attr)
        normalized_lower = normalized_attr.lower()
        value = element.attrib.get(attr, "")
        if _EVENT_HANDLER_RE.match(normalized_lower):
            del element.attrib[attr]
            continue
        if normalized_lower == "style":
            del element.attrib[attr]
            continue
        if normalized_attr in {"href", "xlink:href"}:
            if tag == "image":
                if not _is_safe_svg_image_href(value):
                    del element.attrib[attr]
            elif not _is_safe_svg_href(value):
                del element.attrib[attr]
            continue
        if "url(" in value.lower() and not _is_safe_svg_url_reference(value):
            del element.attrib[attr]

    return False


# ---------------------------------------------------------------------------
# Sanitization wrapper for EPUB
# ---------------------------------------------------------------------------


def _epub_sanitize(html: str) -> str:
    """Sanitize EPUB chapter HTML while preserving EPUB-local assets and SVG."""
    if not html or not html.strip():
        return ""

    try:
        doc = parse_html_document(html)
    except LxmlError as exc:
        raise ValueError(f"Failed to parse EPUB HTML: {exc}") from exc

    body = doc.body
    if body is None:
        if isinstance(doc, HtmlElement):
            _sanitize_epub_element(doc)
            return serialize_html(doc)
        return ""

    for child in list(body):
        if isinstance(child, HtmlElement):
            _sanitize_epub_element(child)

    # Emit only shapes libxml2 and HTML5 tree construction read identically, so a
    # later canonicalizing parse of this output agrees with the browser's DOM.
    normalize_html5_shape(body)

    return inner_html(body)


def _sanitize_epub_element(element: HtmlElement) -> None:
    for child in list(element):
        if isinstance(child, HtmlElement):
            _sanitize_epub_element(child)

    tag = _local_name(element.tag)
    blocked_tags = {
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "meta",
        "base",
        "link",
        "style",
        "foreignobject",
        "animate",
        "set",
        "feimage",
    }
    if tag in blocked_tags:
        element.drop_tree()
        return

    if tag not in _EPUB_ALLOWED_HTML_TAGS and tag not in _EPUB_ALLOWED_SVG_TAGS:
        if _element_id(element) is not None:
            element.tag = "span"
            _sanitize_epub_attributes(element, "span")
            return
        if element.getparent() is not None:
            element.drop_tag()
        return

    _sanitize_epub_attributes(element, tag)


def _materialize_epub_body_anchor(body: HtmlElement) -> None:
    """Move a source body ID onto a safe child before apparatus extracts its contents."""
    body_id = _element_id(body)
    if body_id is None:
        return

    # The source body is the first browser target for its ID. Keep that identity
    # on the marker rather than copying a descendant collision into the reader.
    for element in body.iterdescendants():
        for attr, value in list(element.attrib.items()):
            if _normalized_attr_name(attr) == "id" and value == body_id:
                del element.attrib[attr]

    marker = Element("span", id=body_id)
    marker.tail = body.text
    body.text = None
    body.insert(0, marker)


def _element_id(element: HtmlElement) -> str | None:
    for attr, value in element.attrib.items():
        if _normalized_attr_name(attr) == "id" and value.strip():
            return value
    return None


def _sanitize_epub_attributes(element: HtmlElement, tag: str) -> None:
    allowed_attrs = set(_EPUB_GLOBAL_ATTRS)
    if tag in _EPUB_ALLOWED_HTML_TAGS:
        allowed_attrs.update(_EPUB_ALLOWED_ATTRS.get(tag, set()))
    if tag in _EPUB_ALLOWED_SVG_TAGS:
        allowed_attrs.update(_EPUB_ALLOWED_SVG_ATTRS.get(tag, set()))

    for attr in list(element.attrib):
        normalized_attr = _normalized_attr_name(attr)
        normalized_lower = normalized_attr.lower()
        value = element.attrib.get(attr, "")

        if _EVENT_HANDLER_RE.match(normalized_lower):
            del element.attrib[attr]
            continue
        if normalized_lower in {"style", "class"}:
            del element.attrib[attr]
            continue
        if normalized_attr not in allowed_attrs:
            del element.attrib[attr]
            continue
        if normalized_attr in {"id", "name"} and not value.strip():
            del element.attrib[attr]
            continue

    if tag == "a":
        _sanitize_epub_link(element)
    elif tag == "img":
        _sanitize_epub_image(element)

    if tag in _EPUB_ALLOWED_SVG_TAGS:
        _sanitize_svg_attributes(element, tag)


def _sanitize_epub_link(element: HtmlElement) -> None:
    href = element.get("href", "")
    if not href:
        return

    if href.startswith("//"):
        del element.attrib["href"]
        return

    parsed = urlparse(href)
    scheme = parsed.scheme.lower()
    if scheme in _FORBIDDEN_URL_SCHEMES or (scheme and scheme not in {"http", "https"}):
        del element.attrib["href"]
        return

    if scheme in {"http", "https"}:
        existing_rel = element.get("rel", "")
        rel_values = set(existing_rel.split()) if existing_rel else set()
        rel_values.add("noopener")
        rel_values.add("noreferrer")
        element.set("rel", " ".join(sorted(rel_values)))
        element.set("target", "_blank")
        element.set("referrerpolicy", "no-referrer")


def _sanitize_epub_image(element: HtmlElement) -> None:
    src = element.get("src", "")
    if not src:
        return

    if src.startswith("//"):
        del element.attrib["src"]
        return

    parsed = urlparse(src)
    scheme = parsed.scheme.lower()
    if scheme in _FORBIDDEN_URL_SCHEMES:
        del element.attrib["src"]
        return
    if scheme and scheme not in {"http", "https"}:
        del element.attrib["src"]


def _sanitize_svg_attributes(element: HtmlElement, tag: str) -> None:
    for attr in list(element.attrib):
        normalized_attr = _normalized_attr_name(attr)
        value = element.attrib.get(attr, "")

        if normalized_attr in {"href", "xlink:href"}:
            if tag == "image":
                if not _is_safe_svg_image_href(value):
                    del element.attrib[attr]
                    continue
            elif not _is_safe_svg_href(value):
                del element.attrib[attr]
                continue
        if normalized_attr in {"clip-path", "fill", "stroke"} and "url(" in value.lower():
            if not _is_safe_svg_url_reference(value):
                del element.attrib[attr]
                continue


def _is_safe_svg_href(value: str) -> bool:
    return bool(value) and value.startswith("#")


def _is_safe_svg_image_href(value: str) -> bool:
    if not value or value.startswith("//"):
        return False
    parsed = urlparse(value)
    scheme = parsed.scheme.lower()
    if scheme:
        return False
    return web_paths.is_media_asset_path(value)


def _is_safe_svg_url_reference(value: str) -> bool:
    trimmed = value.strip().replace(" ", "")
    return bool(re.fullmatch(r"url\(#[-A-Za-z0-9_:.]+\)", trimmed))


def _normalized_attr_name(attr: str) -> str:
    if attr.startswith("{"):
        namespace, local = attr[1:].split("}", 1)
        if namespace == "http://www.w3.org/1999/xlink":
            return f"xlink:{local.lower()}"
        return local.lower()
    return attr.lower()


def _local_name(name: str | None) -> str:
    if not name:
        return ""
    if "}" in name:
        return name.rsplit("}", 1)[1].lower()
    return name.lower()


# ---------------------------------------------------------------------------
# TOC materialization
# ---------------------------------------------------------------------------


def _materialize_toc(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    manifest: dict[str, _ManifestItem],
    href_to_frag_idx: dict[str, int],
    structural_budget: _XmlStructuralBudget,
    media_id: UUID,
) -> list[EpubStructureTocNode]:
    """Parse EPUB navigation sources into one persisted node list."""
    nodes = _parse_epub3_nav(zf, opf, manifest, href_to_frag_idx, structural_budget, media_id)
    if any(node.nav_type == "toc" for node in nodes):
        return nodes
    return nodes + _parse_ncx_toc(zf, opf, manifest, href_to_frag_idx, structural_budget, media_id)


def _parse_epub3_nav(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    manifest: dict[str, _ManifestItem],
    href_to_frag_idx: dict[str, int],
    structural_budget: _XmlStructuralBudget,
    media_id: UUID,
) -> list[EpubStructureTocNode]:
    nav_id = None
    for item in opf.findall(".//opf:manifest/opf:item", _NS):
        props = item.get("properties", "")
        if "nav" in props.split():
            nav_id = item.get("id")
            break
    if nav_id is None or nav_id not in manifest:
        return []

    nav_href = manifest[nav_id].href
    nav_tree = _parse_xml_entry(
        zf,
        nav_href,
        structural_budget,
        decoded_bytes_limit=EPUB_XHTML_MAX_DECODED_BYTES,
    )
    if nav_tree is None:
        return []

    nav_dir = posixpath.dirname(nav_href)
    nodes: list[EpubStructureTocNode] = []
    for nav_el in nav_tree.iter():
        tag = nav_el.tag if isinstance(nav_el.tag, str) else ""
        if not (tag == "nav" or tag.endswith("}nav")):
            continue
        raw_type = nav_el.get("{http://www.idpf.org/2007/ops}type", "") or nav_el.get("type", "")
        type_tokens = raw_type.split()
        nav_type = None
        if "toc" in type_tokens:
            nav_type = "toc"
        elif "landmarks" in type_tokens:
            nav_type = "landmarks"
        elif "page-list" in type_tokens or "pagebreak" in type_tokens:
            nav_type = "page_list"
        elif not nodes:
            nav_type = "toc"
        if nav_type is None:
            continue
        _walk_nav_ol(
            nav_el,
            nav_type,
            nav_dir,
            href_to_frag_idx,
            nodes,
            media_id,
            parent_path=None,
            depth=0,
            prefix="",
        )
    return nodes


def _walk_nav_ol(
    parent_el: ET.Element,
    nav_type: str,
    nav_dir: str,
    href_to_frag_idx: dict[str, int],
    nodes: list[EpubStructureTocNode],
    media_id: UUID,
    parent_path: str | None,
    depth: int,
    prefix: str,
) -> None:
    ol = None
    for child in parent_el:
        tag = child.tag if isinstance(child.tag, str) else ""
        if tag == "ol" or tag.endswith("}ol"):
            ol = child
            break
    if ol is None:
        return

    sibling_ids: dict[str, int] = {}
    ordinal = 0

    for li in ol:
        tag = li.tag if isinstance(li.tag, str) else ""
        if not (tag == "li" or tag.endswith("}li")):
            continue

        # find <a> or <span>
        label = ""
        href = None
        nav_id_attr = None
        for el in li:
            el_tag = el.tag if isinstance(el.tag, str) else ""
            if el_tag == "a" or el_tag.endswith("}a"):
                label = _text_content(el).strip()
                href = el.get("href")
                nav_id_attr = el.get("id")
                break
            if el_tag == "span" or el_tag.endswith("}span"):
                label = _text_content(el).strip()
                nav_id_attr = el.get("id")
                break

        if not label:
            label = _text_content(li).strip()
        if not label:
            continue

        canonical_href, frag_idx = _resolve_nav_target(href, nav_dir, href_to_frag_idx)

        # generate node_id
        raw_id = _generate_node_id_token(nav_id_attr, href, label)
        raw_id = _ensure_sibling_unique(raw_id, sibling_ids)
        node_path = f"{parent_path}/{raw_id}" if parent_path else f"{nav_type}/{raw_id}"
        node_id = _enforce_id_length(media_id, node_path)
        parent_id = _enforce_id_length(media_id, parent_path) if parent_path else None

        order_key = f"{prefix}{ordinal:04d}" if not prefix else f"{prefix}.{ordinal:04d}"

        nodes.append(
            EpubStructureTocNode(
                nav_type=nav_type,
                node_id=node_id,
                parent_node_id=parent_id,
                label=label[:512],
                href=canonical_href,
                fragment_idx=frag_idx,
                depth=depth,
                order_key=order_key,
            )
        )

        # recurse into nested ol
        _walk_nav_ol(
            li,
            nav_type,
            nav_dir,
            href_to_frag_idx,
            nodes,
            media_id,
            parent_path=node_path,
            depth=depth + 1,
            prefix=order_key,
        )
        ordinal += 1


def _parse_ncx_toc(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    manifest: dict[str, _ManifestItem],
    href_to_frag_idx: dict[str, int],
    structural_budget: _XmlStructuralBudget,
    media_id: UUID,
) -> list[EpubStructureTocNode]:
    ncx_id = None
    spine = opf.find(".//opf:spine", _NS)
    if spine is not None:
        ncx_id = spine.get("toc")
    if ncx_id is None:
        for item in manifest.values():
            if item.media_type in _NCX_MEDIA_TYPES:
                ncx_id = item.manifest_id
                break
    if ncx_id is None or ncx_id not in manifest:
        return []

    ncx_href = manifest[ncx_id].href
    ncx_tree = _parse_xml_entry(zf, ncx_href, structural_budget, decoded_bytes_limit=None)
    if ncx_tree is None:
        return []

    ncx_dir = posixpath.dirname(ncx_href)
    nav_map = ncx_tree.find(".//ncx:navMap", _NS)
    if nav_map is None:
        nav_map = ncx_tree.find(".//{http://www.daisy.org/z3986/2005/ncx/}navMap")
    if nav_map is None:
        return []

    nodes: list[EpubStructureTocNode] = []
    _walk_ncx_navpoints(
        nav_map,
        ncx_dir,
        href_to_frag_idx,
        nodes,
        media_id,
        nav_type="toc",
        parent_path=None,
        depth=0,
        prefix="",
    )
    return nodes


def _walk_ncx_navpoints(
    parent_el: ET.Element,
    ncx_dir: str,
    href_to_frag_idx: dict[str, int],
    nodes: list[EpubStructureTocNode],
    media_id: UUID,
    nav_type: str,
    parent_path: str | None,
    depth: int,
    prefix: str,
) -> None:
    sibling_ids: dict[str, int] = {}
    ordinal = 0

    for np in parent_el:
        tag = np.tag if isinstance(np.tag, str) else ""
        if not (tag == "navPoint" or tag.endswith("}navPoint")):
            continue

        nav_id_attr = np.get("id")
        label_el = np.find("ncx:navLabel/ncx:text", _NS)
        if label_el is None:
            label_el = np.find(".//{http://www.daisy.org/z3986/2005/ncx/}text")
        label = (label_el.text or "").strip() if label_el is not None else ""
        if not label:
            continue

        content_el = np.find("ncx:content", _NS)
        if content_el is None:
            content_el = np.find(".//{http://www.daisy.org/z3986/2005/ncx/}content")
        href = content_el.get("src") if content_el is not None else None

        canonical_href, frag_idx = _resolve_nav_target(href, ncx_dir, href_to_frag_idx)

        raw_id = _generate_node_id_token(nav_id_attr, href, label)
        raw_id = _ensure_sibling_unique(raw_id, sibling_ids)
        node_path = f"{parent_path}/{raw_id}" if parent_path else f"{nav_type}/{raw_id}"
        node_id = _enforce_id_length(media_id, node_path)
        parent_id = _enforce_id_length(media_id, parent_path) if parent_path else None

        order_key = f"{prefix}{ordinal:04d}" if not prefix else f"{prefix}.{ordinal:04d}"

        nodes.append(
            EpubStructureTocNode(
                nav_type=nav_type,
                node_id=node_id,
                parent_node_id=parent_id,
                label=label[:512],
                href=canonical_href,
                fragment_idx=frag_idx,
                depth=depth,
                order_key=order_key,
            )
        )

        _walk_ncx_navpoints(
            np,
            ncx_dir,
            href_to_frag_idx,
            nodes,
            media_id,
            nav_type=nav_type,
            parent_path=node_path,
            depth=depth + 1,
            prefix=order_key,
        )
        ordinal += 1


def _resolve_nav_target(
    href: str | None,
    base_dir: str,
    href_to_frag_idx: dict[str, int],
) -> tuple[str | None, int | None]:
    if not href:
        return None, None

    parsed = urlparse(href)
    if parsed.scheme:
        return href, None

    path_part = parsed.path or ""
    anchor = parsed.fragment or None
    resolved_path = _resolve_epub_path(base_dir, path_part) if path_part else None
    canonical_href = resolved_path
    if canonical_href and anchor:
        canonical_href = f"{canonical_href}#{anchor}"
    frag_idx = href_to_frag_idx.get(resolved_path) if resolved_path else None
    return canonical_href, frag_idx


# ---------------------------------------------------------------------------
# Node ID helpers
# ---------------------------------------------------------------------------


def _generate_node_id_token(
    nav_id: str | None,
    href: str | None,
    label: str,
) -> str:
    """Priority: normalized nav id -> normalized href -> label slug."""
    if nav_id and nav_id.strip():
        return _slug(nav_id.strip())

    if href and href.strip():
        return _slug(href.strip())

    return _slug(label) or "node"


def _slug(text: str) -> str:
    t = unicodedata.normalize("NFC", text).lower()
    t = _SLUG_RE.sub("-", t).strip("-")
    return t[:64] if t else "node"


def _ensure_sibling_unique(raw: str, seen: dict[str, int]) -> str:
    if raw not in seen:
        seen[raw] = 0
        return raw
    seen[raw] += 1
    return f"{raw}~{seen[raw]}"


def _enforce_id_length(media_id: UUID, node_id: str) -> str:
    if len(node_id) <= 255:
        return node_id
    return str(uuid5(media_id, node_id))


def _text_content(el: ET.Element) -> str:
    parts = []
    if el.text:
        parts.append(el.text)
    for child in el:
        parts.append(_text_content(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


# ---------------------------------------------------------------------------
# href -> fragment_idx mapping
# ---------------------------------------------------------------------------


def _build_href_to_frag_idx(
    retained_hrefs: list[str],
) -> dict[str, int]:
    """Map retained chapter hrefs to contiguous fragment idx.

    The input list must contain hrefs for chapters that survived
    canonicalization in the exact final fragment order.
    """
    result: dict[str, int] = {}
    for idx, href in enumerate(retained_hrefs):
        # Keep first mapping if duplicate href appears in malformed books.
        result.setdefault(href, idx)
    return result
