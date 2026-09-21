"""EPUB extraction: one archive into chapter fragments, navigation, and assets.

Deterministic and transport-free: the lifecycle boundary calls in, and the plan
this builds is published inside the caller's fenced transaction.
"""

from __future__ import annotations

import posixpath
import re
import time
import unicodedata
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from html.entities import name2codepoint
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO, Literal, cast
from urllib.parse import unquote, urlparse
from uuid import UUID, uuid5
from xml.etree import ElementTree as ET

from defusedxml import ElementTree as DefusedET
from defusedxml.common import DefusedXmlException, DTDForbidden
from defusedxml.ElementTree import DefusedXMLParser
from lxml.etree import LxmlError
from lxml.html import HtmlElement
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus import web_paths
from nexus.config import Settings, get_settings
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
from nexus.services.epub_sanitize import (
    local_name,
    materialize_epub_body_anchor,
    normalized_attr_name,
    sanitize_epub_chapter,
    sanitize_svg_asset_element,
)
from nexus.services.epub_structure import (
    EpubStructureFragment,
    EpubStructureSection,
    EpubStructureTocNode,
    build_epub_structure,
)
from nexus.services.fragment_blocks import (
    FragmentBlockSpec,
    insert_fragment_blocks,
    parse_fragment_blocks,
)
from nexus.services.html_apparatus import (
    HtmlApparatusTargetLimitExceeded,
    attach_fragment_locators,
    collect_html_apparatus_targets,
    extract_html_apparatus,
)
from nexus.services.html_tree import inner_html, parse_html_document
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

EPUB_RENDERED_TEXT_MAX_BYTES = 64 * 1024 * 1024
EPUB_XHTML_MAX_DECODED_BYTES = 16 * 1024 * 1024
EPUB_APPARATUS_MAX_TARGETS = 10_000
EPUB_APPARATUS_MAX_BACKLINKS = 10_000
EPUB_APPARATUS_MAX_RETAINED_UTF8_BYTES = 8 * 1024 * 1024

_XHTML_DECODED_BYTES_MESSAGE = "EPUB XHTML decoded bytes exceed the 16 MiB per-entry limit"

# XHTML 1.x content documents and NCX navigation files reference the HTML named
# entities their (never fetched) external DTD would declare. Resolving them from
# this fixed local table keeps every reference a single bounded substitution.
_XHTML_NAMED_ENTITIES = {name: chr(codepoint) for name, codepoint in name2codepoint.items()}

_READABLE_MEDIA_TYPES = frozenset(
    "application/xhtml+xml application/xml text/html text/xml".split()
)
_NCX_MEDIA_TYPE = "application/x-dtbncx+xml"
_ZIP_ENTRY_READ_ERRORS = (KeyError, NotImplementedError, RuntimeError, zipfile.BadZipFile)
_XML_ENTRY_READ_ERRORS = (*_ZIP_ENTRY_READ_ERRORS, ET.ParseError)
_RESOURCE_ATTRS = frozenset({"src", "href", "xlink:href", "poster"})
_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"})
_SVG_IMAGE_TYPE = "image/svg+xml"

# The one stored `epub_resources.content_type` vocabulary: this is the write gate.
SUPPORTED_IMAGE_TYPES = frozenset("image/png image/jpeg image/gif image/svg+xml image/webp".split())

_NS = {
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
    "ncx": "http://www.daisy.org/z3986/2005/ncx/",
    "xhtml": "http://www.w3.org/1999/xhtml",
    "epub": "http://www.idpf.org/2007/ops",
}
_SLUG_RE = re.compile(r"[^a-z0-9]+")


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


@dataclass(frozen=True)
class _ManifestItem:
    manifest_id: str
    href: str
    media_type: str


@dataclass(frozen=True)
class _SpineItem:
    idref: str
    itemref_id: str | None
    linear: bool


@dataclass(frozen=True)
class _ChapterSpec:
    spine_idx: int
    manifest_id: str
    itemref_id: str | None
    href: str
    media_type: str
    linear: bool


@dataclass
class _AssetEntry:
    epub_path: str
    asset_key: str
    content_type: str
    size_bytes: int


@dataclass(frozen=True)
class _Package:
    """The archive-wide context every chapter rewrite reads and appends to."""

    zf: zipfile.ZipFile
    media_id: UUID
    manifest: dict[str, _ManifestItem]
    readable_paths: set[str]
    asset_entries: list[_AssetEntry]
    asset_key_map: dict[str, str]


@dataclass(frozen=True)
class _FragmentSpec:
    fragment: Fragment
    chapter: _ChapterSpec
    apparatus_items: list[dict[str, object]]
    apparatus_edges: list[dict[str, object]]


@dataclass(frozen=True)
class EpubExtractionPlan:
    result: EpubExtractionResult
    now: datetime
    storage_path: str
    source_size_bytes: int
    fragment_specs: tuple[_FragmentSpec, ...]
    all_block_specs: tuple[list[FragmentBlockSpec], ...]
    toc_nodes: tuple[EpubStructureTocNode, ...]
    nav_locations: tuple[EpubStructureSection, ...]
    asset_entries: tuple[_AssetEntry, ...]
    asset_storage_paths: dict[str, str]


type _TocEntry = tuple[ET.Element, str, str | None, str | None]


@dataclass(frozen=True)
class _TocWalk:
    """Everything one navigation walk holds constant across its recursion."""

    entries: Callable[[ET.Element], Iterator[_TocEntry]]
    nav_type: str
    base_dir: str
    href_to_frag_idx: dict[str, int]
    media_id: UUID
    nodes: list[EpubStructureTocNode]


class _EpubExtractionFailure(Exception):
    """Modeled failure caused by the EPUB payload, not service infrastructure."""


class _EpubResourceLimitExceeded(_EpubExtractionFailure):
    def __init__(self, message: str, *, dimension: ResourceFailureDimension):
        super().__init__(message)
        self.dimension: ResourceFailureDimension = dimension


def _error(code: ApiErrorCode, message: str, *, terminal: bool = False) -> EpubExtractionError:
    return EpubExtractionError(error_code=code.value, error_message=message, terminal=terminal)


def _resource_limit(message: str, *, dimension: ResourceFailureDimension) -> EpubExtractionError:
    return EpubExtractionError(
        error_code=ApiErrorCode.E_RESOURCE_LIMIT.value,
        error_message=message,
        terminal=True,
        resource_limit_dimension=dimension,
    )


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
            return _error(
                ApiErrorCode.E_SOURCE_INTEGRITY,
                "Stored EPUB bytes do not match the immutable source identity",
                terminal=True,
            )
        try:
            zf = zipfile.ZipFile(epub_path)
        except zipfile.BadZipFile as exc:
            return _error(ApiErrorCode.E_INVALID_FILE_TYPE, f"Invalid ZIP: {exc}")
        try:
            return _build_plan(
                zf,
                session_factory=session_factory,
                media_id=media_id,
                attempt_id=attempt_id,
                storage_path=storage_path,
                source_size_bytes=source_size_bytes,
                storage_client=storage_client,
                record_progress=record_progress,
                attempt_directory=attempt_directory,
                now=now or datetime.now(UTC),
            )
        except _EpubResourceLimitExceeded as exc:
            return _resource_limit(str(exc), dimension=exc.dimension)
        except _EpubExtractionFailure as exc:
            return _error(ApiErrorCode.E_INVALID_FILE_TYPE, f"Extraction failed: {exc}")
        finally:
            zf.close()


def extract_epub_metadata(epub_path: Path) -> EpubExtractionResult | EpubExtractionError:
    """Read OPF metadata only, retaining archive bounds without publishing content."""
    try:
        with zipfile.ZipFile(epub_path) as zf:
            package_document = _open_package_document(zf, get_settings())
            if isinstance(package_document, EpubExtractionError):
                return package_document
            return _extract_opf_metadata(package_document[1])
    except zipfile.BadZipFile as exc:
        return _error(ApiErrorCode.E_INVALID_FILE_TYPE, f"Invalid ZIP: {exc}")
    except _EpubResourceLimitExceeded as exc:
        return _resource_limit(str(exc), dimension=exc.dimension)


def _open_package_document(
    zf: zipfile.ZipFile, settings: Settings
) -> tuple[str, ET.Element] | EpubExtractionError:
    """Check the archive, locate the OPF rootfile, and parse it."""
    safety_error = _check_archive_safety(zf, settings)
    if safety_error is not None:
        return safety_error
    opf_path = _find_opf_path(zf)
    if opf_path is None:
        return _error(ApiErrorCode.E_INVALID_FILE_TYPE, "Cannot locate OPF rootfile")
    opf = _parse_xml_entry(zf, opf_path, decoded_bytes_limit=None)
    if opf is None:
        return _error(ApiErrorCode.E_INVALID_FILE_TYPE, "Failed to parse OPF")
    return opf_path, opf


def _build_plan(
    zf: zipfile.ZipFile,
    *,
    session_factory: sessionmaker[Session],
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    storage_client: StorageClient,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
    attempt_directory: Path,
    now: datetime,
) -> EpubExtractionPlan | EpubExtractionError:
    """Parse one opened archive and stage its attempt-owned assets."""
    settings = get_settings()
    started = time.monotonic()

    package_document = _open_package_document(zf, settings)
    if isinstance(package_document, EpubExtractionError):
        return package_document
    opf_path, opf = package_document

    manifest = _parse_manifest(opf, posixpath.dirname(opf_path))
    title = _resolve_title(opf, storage_path)
    opf_meta = _extract_opf_metadata(opf)
    package = _Package(
        zf=zf,
        media_id=media_id,
        manifest=manifest,
        readable_paths={
            item.href for item in manifest.values() if item.media_type in _READABLE_MEDIA_TYPES
        },
        asset_entries=[],
        asset_key_map={},
    )

    try:
        staged, external_targets = _stage_epub_chapters(
            package,
            _collect_readable_chapters(zf, manifest, _parse_spine(opf)),
            staging_directory=attempt_directory,
        )
    except HtmlApparatusTargetLimitExceeded as exc:
        return _resource_limit(
            f"EPUB apparatus exceeds its bounded index: {exc}", dimension=exc.dimension
        )
    if not staged:
        return _error(
            ApiErrorCode.E_SOURCE_NOT_READABLE, "Zero renderable XHTML spine items after extraction"
        )
    chapter_total = len(staged)
    record_progress(0, chapter_total, "Chapter")

    sanitized: list[tuple[_ChapterSpec, str, list[dict[str, object]], list[dict[str, object]]]] = []
    rendered_text_bytes = 0
    for chapter_index, (chapter, html_path) in enumerate(staged, start=1):
        html_with_apparatus, apparatus_items, apparatus_edges = extract_html_apparatus(
            html_path.read_text(encoding="utf-8"),
            source_kind=f"epub:{chapter.spine_idx}",
            document_href=chapter.href,
            external_targets=external_targets,
            source_ref=_chapter_source_ref(chapter),
        )
        try:
            html_sanitized = sanitize_epub_chapter(html_with_apparatus)
        except (ValueError, LxmlError) as exc:
            return _error(
                ApiErrorCode.E_SANITIZATION_FAILED,
                f"Sanitization failed for spine item {chapter.spine_idx}: {exc}",
            )
        del html_with_apparatus
        if not html_sanitized.strip():
            record_progress(chapter_index, chapter_total, "Chapter")
            continue
        rendered_text_bytes += utf8_byte_length(html_sanitized)
        if rendered_text_bytes > EPUB_RENDERED_TEXT_MAX_BYTES:
            return _resource_limit(
                "EPUB rendered text exceeds the 64 MiB limit", dimension="Output"
            )
        sanitized.append((chapter, html_sanitized, apparatus_items, apparatus_edges))
        record_progress(chapter_index, chapter_total, "Chapter")

    if not sanitized:
        return _error(
            ApiErrorCode.E_SOURCE_NOT_READABLE, "Zero renderable chapters after sanitization"
        )
    del external_targets

    # Keep the first mapping if a malformed book repeats an href.
    href_to_frag_idx: dict[str, int] = {}
    for fragment_idx, (chapter, _html, _items, _edges) in enumerate(sanitized):
        href_to_frag_idx.setdefault(chapter.href, fragment_idx)
    toc_nodes = _materialize_toc(zf, opf, manifest, href_to_frag_idx, media_id)

    fragment_specs: list[_FragmentSpec] = []
    structure_fragments: list[EpubStructureFragment] = []
    all_block_specs: list[list[FragmentBlockSpec]] = []
    for fragment_idx, (chapter, html_sanitized, apparatus_items, apparatus_edges) in enumerate(
        sanitized
    ):
        try:
            canonical = canonicalize_structure(html_sanitized)
        except ValueError as exc:
            return _error(
                ApiErrorCode.E_SANITIZATION_FAILED,
                f"Canonicalization failed for spine item {chapter.spine_idx}: {exc}",
            )
        rendered_text_bytes += utf8_byte_length(canonical.text)
        if rendered_text_bytes > EPUB_RENDERED_TEXT_MAX_BYTES:
            return _resource_limit(
                "EPUB rendered text exceeds the 64 MiB limit", dimension="Output"
            )
        fragment = Fragment(
            id=new_uuid7(),
            media_id=media_id,
            idx=fragment_idx,
            html_sanitized=html_sanitized,
            canonical_text=canonical.text,
            created_at=now,
        )
        fragment_specs.append(_FragmentSpec(fragment, chapter, apparatus_items, apparatus_edges))
        structure_fragments.append(
            EpubStructureFragment(fragment.id, fragment_idx, chapter.href, canonical)
        )
        all_block_specs.append(parse_fragment_blocks(canonical.text))

    try:
        nav_locations = build_epub_structure(
            media_id=media_id, fragments=structure_fragments, toc_nodes=toc_nodes
        )
    except ValueError as exc:
        return _error(ApiErrorCode.E_SOURCE_NOT_READABLE, str(exc))

    elapsed_ms = int((time.monotonic() - started) * 1000)
    if elapsed_ms > settings.max_epub_archive_parse_time_ms:
        return _resource_limit(
            f"Parse time {elapsed_ms}ms exceeded limit {settings.max_epub_archive_parse_time_ms}ms",
            dimension="Time",
        )

    asset_storage_paths = _write_epub_assets(
        package,
        session_factory=session_factory,
        attempt_id=attempt_id,
        storage_client=storage_client,
        attempt_directory=attempt_directory,
    )
    return EpubExtractionPlan(
        result=EpubExtractionResult(
            fragment_count=len(fragment_specs),
            toc_node_count=len(toc_nodes),
            asset_count=len(package.asset_entries),
            title=title,
            creators=opf_meta.creators,
            publisher=opf_meta.publisher,
            language=opf_meta.language,
            description=opf_meta.description,
            edition_published_date=opf_meta.edition_published_date,
            edition_isbn=opf_meta.edition_isbn,
        ),
        now=now,
        storage_path=storage_path,
        source_size_bytes=source_size_bytes,
        fragment_specs=tuple(fragment_specs),
        all_block_specs=tuple(all_block_specs),
        toc_nodes=tuple(toc_nodes),
        nav_locations=tuple(nav_locations),
        asset_entries=tuple(package.asset_entries),
        asset_storage_paths=asset_storage_paths,
    )


def _chapter_source_ref(chapter: _ChapterSpec) -> dict[str, object]:
    return {
        "format": "xhtml",
        "package_href": chapter.href,
        "manifest_id": chapter.manifest_id,
        "spine_index": chapter.spine_idx,
        "spine_itemref_id": chapter.itemref_id,
    }


def _write_epub_assets(
    package: _Package,
    *,
    session_factory: sessionmaker[Session],
    attempt_id: UUID,
    storage_client: StorageClient,
    attempt_directory: Path,
) -> dict[str, str]:
    """Reserve, then write, every referenced image; the caller finalizes after commit."""
    asset_storage_paths: dict[str, str] = {}
    for asset_index, asset in enumerate(package.asset_entries):
        storage_key = build_epub_attempt_asset_storage_path(
            package.media_id, attempt_id, asset.asset_key
        )
        reservation_db = session_factory()
        try:
            reserve_storage_object_write(
                reservation_db, media_id=package.media_id, storage_path=storage_key
            )
        finally:
            reservation_db.close()
        try:
            with package.zf.open(asset.epub_path) as asset_stream:
                if asset.content_type == _SVG_IMAGE_TYPE:
                    sanitized_path = attempt_directory / f"asset-{asset_index}.svg"
                    with sanitized_path.open("w+b") as sanitized_stream:
                        _write_sanitized_svg_asset(
                            cast(BinaryIO, asset_stream), sanitized_stream, asset.epub_path
                        )
                        asset.size_bytes = sanitized_stream.tell()
                        sanitized_stream.seek(0)
                        storage_client.put_object_stream(
                            storage_key, sanitized_stream, asset.content_type
                        )
                else:
                    storage_client.put_object_stream(
                        storage_key, cast(BinaryIO, asset_stream), asset.content_type
                    )
            asset_storage_paths[asset.asset_key] = storage_key
        except StorageError as exc:
            raise StorageError(exc.message, exc.code) from exc
    return asset_storage_paths


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
                "SELECT storage_path FROM epub_resources "
                "WHERE media_id = :media_id ORDER BY storage_path"
            ),
            {"media_id": media_id},
        ).all()
    ]
    for statement in (
        "DELETE FROM epub_resources WHERE media_id = :media_id",
        "DELETE FROM epub_fragment_sources WHERE media_id = :media_id",
        "DELETE FROM epub_nav_locations WHERE media_id = :media_id",
        "DELETE FROM epub_toc_nodes WHERE media_id = :media_id",
        "DELETE FROM fragment_blocks WHERE fragment_id IN "
        "(SELECT id FROM fragments WHERE media_id = :media_id)",
        "DELETE FROM fragments WHERE media_id = :media_id",
    ):
        db.execute(text(statement), {"media_id": media_id})

    fragments: list[Fragment] = []
    for spec in plan.fragment_specs:
        fragment = Fragment(
            id=spec.fragment.id,
            media_id=media_id,
            idx=spec.fragment.idx,
            html_sanitized=spec.fragment.html_sanitized,
            canonical_text=spec.fragment.canonical_text,
            created_at=plan.now,
        )
        fragments.append(fragment)
        db.add(fragment)
    db.flush()
    for fragment in fragments:
        insert_fragment_blocks(db, fragment.id, plan.all_block_specs[fragment.idx])
    for fragment, spec in zip(fragments, plan.fragment_specs, strict=True):
        db.add(
            EpubFragmentSource(
                media_id=media_id,
                fragment_id=fragment.id,
                package_href=spec.chapter.href,
                manifest_item_id=spec.chapter.manifest_id,
                spine_itemref_id=spec.chapter.itemref_id,
                media_type=spec.chapter.media_type,
                linear=spec.chapter.linear,
                reading_order=spec.chapter.spine_idx,
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
    for fragment, spec in zip(fragments, plan.fragment_specs, strict=True):
        apparatus_items.extend(
            attach_fragment_locators(
                media_id=media_id,
                fragment_id=fragment.id,
                media_kind="epub",
                canonical_text=fragment.canonical_text,
                items=spec.apparatus_items,
                html_sanitized=fragment.html_sanitized,
            )
        )
        apparatus_edges.extend(spec.apparatus_edges)
    replace_media_apparatus(
        db,
        media_id=media_id,
        items=apparatus_items,
        edges=apparatus_edges,
        status="ready" if apparatus_items else "empty",
    )
    return plan.result, old_storage_paths


def _check_archive_safety(zf: zipfile.ZipFile, settings: Settings) -> EpubExtractionError | None:
    """Refuse unsafe entry paths and over-budget archives before reading entries."""
    infos = zf.infolist()
    if len(infos) > settings.max_epub_archive_entries:
        return _resource_limit(
            f"Archive has {len(infos)} entries (limit {settings.max_epub_archive_entries})",
            dimension="Structure",
        )

    total_uncompressed = 0
    seen_names: set[str] = set()
    for info in infos:
        name = info.filename
        unsafe = None
        if name.startswith("/") or name.startswith("\\"):
            unsafe = f"Absolute path in archive: {name}"
        elif ".." in name.split("/"):
            unsafe = f"Path traversal in archive: {name}"
        elif len(name) > 1 and name[1] == ":":
            unsafe = f"Drive-qualified path in archive: {name}"
        elif name in seen_names:
            unsafe = f"Duplicate path in archive: {name}"
        if unsafe is not None:
            return _error(ApiErrorCode.E_ARCHIVE_UNSAFE, unsafe, terminal=True)
        seen_names.add(name)

        limit = settings.max_epub_archive_single_entry_uncompressed_bytes
        if info.file_size > limit:
            return _resource_limit(
                f"Entry '{name}' uncompressed size {info.file_size} exceeds limit {limit}",
                dimension="Output",
            )
        total_uncompressed += info.file_size
        ratio_limit = settings.max_epub_archive_compression_ratio
        if info.compress_size > 0 and info.file_size / info.compress_size > ratio_limit:
            return _resource_limit(
                f"Entry '{name}' compression ratio "
                f"{info.file_size / info.compress_size:.1f} exceeds limit {ratio_limit}",
                dimension="Output",
            )

    if total_uncompressed > settings.max_epub_archive_total_uncompressed_bytes:
        return _resource_limit(
            f"Total uncompressed {total_uncompressed} exceeds limit "
            f"{settings.max_epub_archive_total_uncompressed_bytes}",
            dimension="Output",
        )
    return None


def _new_safe_doctype_parser() -> DefusedXMLParser:
    """Read an inert external DTD declaration without ever resolving one.

    Expat reads an external subset only when parameter-entity parsing is
    enabled, which ElementTree never enables, and ``forbid_external`` refuses
    any external reference that would still be attempted. An internal subset is
    the one doctype form that can declare entities here, so it stays refused,
    and the XHTML named entities a conformant content document may reference
    resolve from this parser's own fixed table.
    """
    parser = DefusedXMLParser(forbid_dtd=False, forbid_entities=True, forbid_external=True)

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


def _parse_xml_entry(
    zf: zipfile.ZipFile,
    path: str,
    *,
    decoded_bytes_limit: int | None,
) -> ET.Element | None:
    """Parse one strict XML entry with entity expansion and resolution disabled.

    An absent or malformed entry is absence; only a declared budget breach
    escapes. The ZIP header's declared size bounds the decode without inflating.
    """
    try:
        info = zf.getinfo(path)
        if decoded_bytes_limit is not None and info.file_size > decoded_bytes_limit:
            raise _EpubResourceLimitExceeded(_XHTML_DECODED_BYTES_MESSAGE, dimension="Output")
        with zf.open(info) as source:
            return DefusedET.parse(source, parser=_new_safe_doctype_parser()).getroot()
    # justify-ignore-error: absent or malformed optional EPUB XML entries are absence.
    except _XML_ENTRY_READ_ERRORS:
        return None
    # justify-ignore-error: an entry declaring DTD entities is not a usable XML entry.
    except DefusedXmlException:
        return None


def _find_opf_path(zf: zipfile.ZipFile) -> str | None:
    container = _parse_xml_entry(zf, "META-INF/container.xml", decoded_bytes_limit=None)
    if container is None:
        return None
    rootfile = container.find(
        ".//container:rootfile[@media-type='application/oebps-package+xml']", _NS
    )
    if rootfile is None:
        rootfile = container.find(".//container:rootfile", _NS)
    if rootfile is None:
        return None
    return _resolve_epub_path("", rootfile.get("full-path") or "")


def _parse_manifest(opf: ET.Element, opf_dir: str) -> dict[str, _ManifestItem]:
    manifest: dict[str, _ManifestItem] = {}
    for item in opf.findall(".//opf:manifest/opf:item", _NS):
        item_id = item.get("id", "")
        href = item.get("href", "")
        if not item_id or not href:
            continue
        resolved = _resolve_epub_path(opf_dir, href)
        if resolved is not None:
            manifest[item_id] = _ManifestItem(
                manifest_id=item_id, href=resolved, media_type=item.get("media-type", "")
            )
    return manifest


def _parse_spine(opf: ET.Element) -> list[_SpineItem]:
    return [
        _SpineItem(
            idref=itemref.get("idref", ""),
            itemref_id=itemref.get("id") or None,
            linear=itemref.get("linear", "yes").lower() != "no",
        )
        for itemref in opf.findall(".//opf:spine/opf:itemref", _NS)
        if itemref.get("idref", "")
    ]


def _resolve_title(opf: ET.Element, storage_path: str) -> str:
    for path in (".//opf:metadata/dc:title", ".//opf:metadata/title", ".//title"):
        element = opf.find(path, _NS)
        if element is not None and element.text and element.text.strip():
            return _normalize_title(element.text.strip())
    base = posixpath.basename(storage_path)
    if "." in base:
        name = base.rsplit(".", 1)[0].strip()
        if name and name.lower() != "original":
            return _normalize_title(name)
    return "Untitled EPUB"


def _normalize_title(raw: str) -> str:
    title = re.sub(r"\s+", " ", raw).strip()
    return title[:255] if title else "Untitled EPUB"


def _extract_opf_metadata(opf: ET.Element) -> EpubExtractionResult:
    """Read Dublin Core metadata, keeping only unambiguous dates and ISBNs."""
    creators = [
        element.text.strip()
        for element in opf.findall(".//opf:metadata/dc:creator", _NS)
        if element.text and element.text.strip()
    ]
    publisher = opf.findtext(".//opf:metadata/dc:publisher", namespaces=_NS)
    language = opf.findtext(".//opf:metadata/dc:language", namespaces=_NS)
    description = opf.findtext(".//opf:metadata/dc:description", namespaces=_NS)

    date_elements = opf.findall(".//opf:metadata/dc:date", _NS)
    publication_elements = [
        element
        for element in date_elements
        if element.get(f"{{{_NS['opf']}}}event") == "publication"
    ] or [element for element in date_elements if element.get(f"{{{_NS['opf']}}}event") is None]
    publication_dates: set[str] = set()
    for element in publication_elements:
        normalized = normalize_source_publication_date(element.text)
        if isinstance(normalized, Present):
            publication_dates.add(normalized.value)

    isbns: set[str] = set()
    primary_isbns: set[str] = set()
    primary_id = opf.get("unique-identifier")
    for identifier in opf.findall(".//opf:metadata/dc:identifier", _NS):
        value = _isbn13(identifier.text or "")
        if value is None:
            continue
        isbns.add(value)
        if primary_id is not None and identifier.get("id") == primary_id:
            primary_isbns.add(value)
    selected = primary_isbns or isbns

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


def _isbn13(raw_identifier: str) -> str | None:
    """Return the checksum-valid ISBN-13 of an identifier, converting ISBN-10."""
    raw = re.sub(
        r"^(?:urn:isbn:|isbn(?:-1[03])?:?)[ \t]*",
        "",
        raw_identifier.strip(),
        flags=re.IGNORECASE,
    )
    value = re.sub(r"[\s-]", "", raw).upper()
    if re.fullmatch(r"[0-9]{9}[0-9X]", value):
        digits = [10 if char == "X" else int(char) for char in value]
        if sum((10 - index) * digit for index, digit in enumerate(digits)) % 11:
            return None
        body = "978" + value[:9]
        checksum = sum(int(char) * (1 if index % 2 == 0 else 3) for index, char in enumerate(body))
        return body + str((-checksum) % 10)
    if re.fullmatch(r"97[89][0-9]{10}", value):
        checksum = sum(int(char) * (1 if index % 2 == 0 else 3) for index, char in enumerate(value))
        return None if checksum % 10 else value
    return None


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


def _collect_readable_chapters(
    zf: zipfile.ZipFile,
    manifest: dict[str, _ManifestItem],
    spine_items: list[_SpineItem],
) -> list[_ChapterSpec]:
    chapters: list[_ChapterSpec] = []
    for spine_idx, spine_item in enumerate(spine_items):
        entry = manifest.get(spine_item.idref)
        if entry is None or entry.media_type not in _READABLE_MEDIA_TYPES:
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
    package: _Package,
    chapter_specs: list[_ChapterSpec],
    *,
    staging_directory: Path,
) -> tuple[list[tuple[_ChapterSpec, Path]], dict[str, dict[str, object]]]:
    """Rewrite each readable spine item once and index its apparatus targets.

    Rewritten chapter HTML is spilled to the attempt directory so the later
    marker pass reads exactly the package-relative links indexed here, while
    only one chapter's HTML is retained at a time.
    """
    staged: list[tuple[_ChapterSpec, Path]] = []
    targets: dict[str, dict[str, object]] = {}
    target_count = 0
    retained_utf8_bytes = 0
    backlink_count = 0
    for chapter in chapter_specs:
        try:
            # `zipfile` hands out at most the declared uncompressed size and fails
            # the entry's CRC otherwise, so the header bounds the decoded bytes.
            if package.zf.getinfo(chapter.href).file_size > EPUB_XHTML_MAX_DECODED_BYTES:
                raise _EpubResourceLimitExceeded(_XHTML_DECODED_BYTES_MESSAGE, dimension="Output")
            raw = package.zf.read(chapter.href)
        # justify-ignore-error: an unreadable spine entry is not a renderable chapter.
        except _ZIP_ENTRY_READ_ERRORS:
            continue
        rewritten_html = _rewrite_chapter_resources(_decode_epub_text(raw), chapter.href, package)
        del raw
        html_path = staging_directory / f"chapter-{chapter.spine_idx}.html"
        html_path.write_text(rewritten_html, encoding="utf-8")
        staged.append((chapter, html_path))
        (
            chapter_targets,
            chapter_target_count,
            chapter_retained_utf8_bytes,
            chapter_backlink_count,
        ) = collect_html_apparatus_targets(
            rewritten_html,
            document_href=chapter.href,
            source_kind=f"epub:{chapter.spine_idx}",
            source_ref=_chapter_source_ref(chapter),
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
    return staged, targets


def _rewrite_chapter_resources(html: str, chapter_href: str, package: _Package) -> str:
    """Point package-local images at the asset route and drop every other link."""
    chapter_dir = posixpath.dirname(chapter_href)
    try:
        doc = parse_html_document(html)
    except LxmlError as exc:
        raise _EpubExtractionFailure(
            f"Failed to parse EPUB chapter resources: {chapter_href}"
        ) from exc

    if doc.body is not None:
        materialize_epub_body_anchor(doc.body)
    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        tag = local_name(element.tag)
        for attr in list(element.attrib):
            name = normalized_attr_name(attr)
            value = element.attrib.get(attr, "")
            if tag == "img" and name == "srcset":
                rewritten = _rewrite_srcset(value, chapter_dir, package) or None
            elif (tag == "img" and name == "src") or (
                tag == "image" and name in {"href", "xlink:href"}
            ):
                rewritten = _rewrite_image_resource_url(value, chapter_dir, package)
            elif name in _RESOURCE_ATTRS:
                rewritten = _rewrite_resource_url(value, name, chapter_dir, package.readable_paths)
            else:
                continue
            if rewritten is None:
                del element.attrib[attr]
            else:
                element.attrib[attr] = rewritten

    body = doc.body if doc.body is not None else doc
    return inner_html(body)


def _rewrite_image_resource_url(raw_url: str, base_dir: str, package: _Package) -> str | None:
    if not raw_url or raw_url.startswith("#"):
        return None
    parsed = urlparse(raw_url)
    if parsed.scheme or raw_url.startswith("//"):
        return None
    resolved = _resolve_epub_path(base_dir, parsed.path or "")
    if resolved is None:
        return None
    key = _ensure_asset_entry(resolved, package)
    if key is None:
        return None
    rewritten = web_paths.media_asset_url(package.media_id, key)
    return f"{rewritten}#{parsed.fragment}" if parsed.fragment else rewritten


def _rewrite_resource_url(
    raw_url: str, attr_name: str, base_dir: str, readable_paths: set[str]
) -> str | None:
    if not raw_url or raw_url.startswith("#"):
        return raw_url
    parsed = urlparse(raw_url)
    if parsed.scheme or raw_url.startswith("//"):
        return raw_url if attr_name == "href" and parsed.scheme in {"http", "https"} else None
    resolved = _resolve_epub_path(base_dir, parsed.path or "")
    if resolved is None or attr_name != "href" or resolved not in readable_paths:
        return None
    return f"{resolved}#{parsed.fragment}" if parsed.fragment else resolved


def _rewrite_srcset(value: str, base_dir: str, package: _Package) -> str:
    parts: list[str] = []
    for candidate in value.split(","):
        tokens = candidate.strip().split()
        if not tokens:
            continue
        rewritten = _rewrite_image_resource_url(tokens[0], base_dir, package)
        if rewritten:
            parts.append(" ".join([rewritten, *tokens[1:]]))
    return ", ".join(parts)


def _ensure_asset_entry(epub_path: str, package: _Package) -> str | None:
    """Record one referenced package image, deriving its stable asset key once."""
    if epub_path in package.asset_key_map:
        return package.asset_key_map[epub_path]
    manifest_item = next(
        (item for item in package.manifest.values() if item.href == epub_path), None
    )
    if manifest_item is None:
        if posixpath.splitext(epub_path)[1].lower() in _IMAGE_EXTENSIONS:
            raise _EpubExtractionFailure(
                f"Referenced EPUB image asset missing from OPF manifest: {epub_path}"
            )
        return None
    if manifest_item.media_type not in SUPPORTED_IMAGE_TYPES:
        return None
    try:
        info = package.zf.getinfo(epub_path)
    except KeyError as exc:
        raise _EpubExtractionFailure(
            f"Referenced EPUB image asset missing from archive: {epub_path}"
        ) from exc

    key = re.sub(r"[^a-zA-Z0-9_./-]", "_", epub_path.lstrip("/")) or "asset"
    if key in package.asset_key_map.values():
        base, ext = posixpath.splitext(key)
        suffix = 2
        while f"{base}_{suffix}{ext}" in package.asset_key_map.values():
            suffix += 1
        key = f"{base}_{suffix}{ext}"
    package.asset_key_map[epub_path] = key
    package.asset_entries.append(
        _AssetEntry(
            epub_path=epub_path,
            asset_key=key,
            content_type=manifest_item.media_type,
            size_bytes=info.file_size,
        )
    )
    return key


def _write_sanitized_svg_asset(source: BinaryIO, destination: BinaryIO, epub_path: str) -> None:
    try:
        root = DefusedET.parse(source, parser=_new_safe_doctype_parser()).getroot()
    except (ET.ParseError, DefusedXmlException) as exc:
        raise _EpubExtractionFailure(f"Referenced SVG asset cannot be parsed: {epub_path}") from exc
    if root is None or local_name(root.tag) != "svg":
        raise _EpubExtractionFailure(f"Referenced SVG asset is not an SVG document: {epub_path}")
    sanitize_svg_asset_element(root)
    ET.ElementTree(root).write(destination, encoding="utf-8", xml_declaration=True)


def _materialize_toc(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    manifest: dict[str, _ManifestItem],
    href_to_frag_idx: dict[str, int],
    media_id: UUID,
) -> list[EpubStructureTocNode]:
    """Parse EPUB 3 navigation, falling back to the NCX every EPUB 2 book carries."""
    nodes = _parse_epub3_nav(zf, opf, manifest, href_to_frag_idx, media_id)
    if any(node.nav_type == "toc" for node in nodes):
        return nodes
    return nodes + _parse_ncx_toc(zf, opf, manifest, href_to_frag_idx, media_id)


def _is_tag(element: ET.Element, name: str) -> bool:
    tag = element.tag if isinstance(element.tag, str) else ""
    return tag == name or tag.endswith(f"}}{name}")


def _nav_entries(parent: ET.Element) -> Iterator[_TocEntry]:
    """Yield the `li` entries of a nav element's own `ol`, labelled and addressed."""
    ol = next((child for child in parent if _is_tag(child, "ol")), None)
    if ol is None:
        return
    for li in ol:
        if not _is_tag(li, "li"):
            continue
        label = ""
        href: str | None = None
        nav_id: str | None = None
        for child in li:
            if _is_tag(child, "a"):
                label = _text_content(child).strip()
                href = child.get("href")
                nav_id = child.get("id")
                break
            if _is_tag(child, "span"):
                label = _text_content(child).strip()
                nav_id = child.get("id")
                break
        if not label:
            label = _text_content(li).strip()
        if label:
            yield li, label, href, nav_id


def _ncx_entries(parent: ET.Element) -> Iterator[_TocEntry]:
    """Yield the `navPoint` children of an NCX element, labelled and addressed."""
    for nav_point in parent:
        if not _is_tag(nav_point, "navPoint"):
            continue
        label_element = nav_point.find("ncx:navLabel/ncx:text", _NS)
        if label_element is None:
            label_element = nav_point.find(".//{http://www.daisy.org/z3986/2005/ncx/}text")
        label = (label_element.text or "").strip() if label_element is not None else ""
        if not label:
            continue
        content = nav_point.find("ncx:content", _NS)
        if content is None:
            content = nav_point.find(".//{http://www.daisy.org/z3986/2005/ncx/}content")
        href = content.get("src") if content is not None else None
        yield nav_point, label, href, nav_point.get("id")


def _walk_toc(
    walk: _TocWalk,
    parent: ET.Element,
    *,
    parent_path: str | None = None,
    depth: int = 0,
    prefix: str = "",
) -> None:
    """Depth-first walk of one navigation format's entries into persisted nodes."""
    sibling_ids: dict[str, int] = {}
    for ordinal, (element, label, href, nav_id) in enumerate(walk.entries(parent)):
        canonical_href, fragment_idx = _resolve_nav_target(
            href, walk.base_dir, walk.href_to_frag_idx
        )
        raw_id = _ensure_sibling_unique(_node_id_token(nav_id, href, label), sibling_ids)
        node_path = f"{parent_path}/{raw_id}" if parent_path else f"{walk.nav_type}/{raw_id}"
        order_key = f"{prefix}{ordinal:04d}" if not prefix else f"{prefix}.{ordinal:04d}"
        walk.nodes.append(
            EpubStructureTocNode(
                nav_type=walk.nav_type,
                node_id=_enforce_id_length(walk.media_id, node_path),
                parent_node_id=(
                    _enforce_id_length(walk.media_id, parent_path) if parent_path else None
                ),
                label=label[:512],
                href=canonical_href,
                fragment_idx=fragment_idx,
                depth=depth,
                order_key=order_key,
            )
        )
        _walk_toc(walk, element, parent_path=node_path, depth=depth + 1, prefix=order_key)


def _parse_epub3_nav(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    manifest: dict[str, _ManifestItem],
    href_to_frag_idx: dict[str, int],
    media_id: UUID,
) -> list[EpubStructureTocNode]:
    nav_id = next(
        (
            item.get("id")
            for item in opf.findall(".//opf:manifest/opf:item", _NS)
            if "nav" in item.get("properties", "").split()
        ),
        None,
    )
    if nav_id is None or nav_id not in manifest:
        return []
    nav_href = manifest[nav_id].href
    nav_tree = _parse_xml_entry(zf, nav_href, decoded_bytes_limit=EPUB_XHTML_MAX_DECODED_BYTES)
    if nav_tree is None:
        return []

    nodes: list[EpubStructureTocNode] = []
    for nav_element in nav_tree.iter():
        if not _is_tag(nav_element, "nav"):
            continue
        tokens = (
            nav_element.get("{http://www.idpf.org/2007/ops}type", "") or nav_element.get("type", "")
        ).split()
        if "toc" in tokens:
            nav_type = "toc"
        elif "landmarks" in tokens:
            nav_type = "landmarks"
        elif "page-list" in tokens or "pagebreak" in tokens:
            nav_type = "page_list"
        elif not nodes:
            nav_type = "toc"
        else:
            continue
        _walk_toc(
            _TocWalk(
                entries=_nav_entries,
                nav_type=nav_type,
                base_dir=posixpath.dirname(nav_href),
                href_to_frag_idx=href_to_frag_idx,
                media_id=media_id,
                nodes=nodes,
            ),
            nav_element,
        )
    return nodes


def _parse_ncx_toc(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    manifest: dict[str, _ManifestItem],
    href_to_frag_idx: dict[str, int],
    media_id: UUID,
) -> list[EpubStructureTocNode]:
    spine = opf.find(".//opf:spine", _NS)
    ncx_id = spine.get("toc") if spine is not None else None
    if ncx_id is None:
        ncx_id = next(
            (item.manifest_id for item in manifest.values() if item.media_type == _NCX_MEDIA_TYPE),
            None,
        )
    if ncx_id is None or ncx_id not in manifest:
        return []
    ncx_href = manifest[ncx_id].href
    ncx_tree = _parse_xml_entry(zf, ncx_href, decoded_bytes_limit=None)
    if ncx_tree is None:
        return []
    nav_map = ncx_tree.find(".//ncx:navMap", _NS)
    if nav_map is None:
        nav_map = ncx_tree.find(".//{http://www.daisy.org/z3986/2005/ncx/}navMap")
    if nav_map is None:
        return []

    nodes: list[EpubStructureTocNode] = []
    _walk_toc(
        _TocWalk(
            entries=_ncx_entries,
            nav_type="toc",
            base_dir=posixpath.dirname(ncx_href),
            href_to_frag_idx=href_to_frag_idx,
            media_id=media_id,
            nodes=nodes,
        ),
        nav_map,
    )
    return nodes


def _resolve_nav_target(
    href: str | None, base_dir: str, href_to_frag_idx: dict[str, int]
) -> tuple[str | None, int | None]:
    if not href:
        return None, None
    parsed = urlparse(href)
    if parsed.scheme:
        return href, None
    resolved_path = _resolve_epub_path(base_dir, parsed.path) if parsed.path else None
    canonical_href = resolved_path
    if canonical_href and parsed.fragment:
        canonical_href = f"{canonical_href}#{parsed.fragment}"
    return canonical_href, href_to_frag_idx.get(resolved_path) if resolved_path else None


def _node_id_token(nav_id: str | None, href: str | None, label: str) -> str:
    """Priority: normalized nav id, then normalized href, then label slug."""
    for candidate in (nav_id, href):
        if candidate and candidate.strip():
            return _slug(candidate.strip())
    return _slug(label) or "node"


def _slug(value: str) -> str:
    slug = _SLUG_RE.sub("-", unicodedata.normalize("NFC", value).lower()).strip("-")
    return slug[:64] if slug else "node"


def _ensure_sibling_unique(raw: str, seen: dict[str, int]) -> str:
    if raw not in seen:
        seen[raw] = 0
        return raw
    seen[raw] += 1
    return f"{raw}~{seen[raw]}"


def _enforce_id_length(media_id: UUID, node_id: str) -> str:
    return node_id if len(node_id) <= 255 else str(uuid5(media_id, node_id))


def _text_content(element: ET.Element) -> str:
    parts = [element.text or ""]
    for child in element:
        parts.append(_text_content(child))
        parts.append(child.tail or "")
    return "".join(parts)
