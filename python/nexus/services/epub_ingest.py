"""EPUB extraction: one archive into chapter fragments, navigation, notes and assets.

`prepare_epub_source` parses outside any transaction and writes every referenced image
before the plan names it (an image whose plan never publishes is the storage sweep's).
`publish_epub_plan` installs the plan inside the caller's publication, which refuses a
second one: an epub publishes once. A refused source raises `ApiError` with its code, a
breached budget `ResourceLimitError` with its dimension; anything else is the queue's.
"""

from __future__ import annotations

import json
import math
import posixpath
import re
import sqlite3
import time
import unicodedata
import zipfile
from collections.abc import Callable, Iterator, Sequence
from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from html.entities import name2codepoint
from pathlib import Path
from typing import BinaryIO, Literal, cast
from urllib.parse import unquote, urlparse
from uuid import UUID, uuid5
from xml.etree import ElementTree as ET

from defusedxml import ElementTree as DefusedET
from defusedxml.common import DefusedXmlException, DTDForbidden
from defusedxml.ElementTree import DefusedXMLParser
from lxml.etree import LxmlError
from lxml.html import Element, HtmlElement
from sqlalchemy.orm import Session

from nexus import web_paths
from nexus.db.models import (
    EpubFragmentSource,
    EpubNavLocation,
    EpubResource,
    EpubTocNode,
    Fragment,
    Media,
)
from nexus.errors import ApiError, ApiErrorCode, ResourceLimitError
from nexus.ids import new_uuid7
from nexus.logging import get_logger
from nexus.schemas.isbn import Isbn13, normalize_source_isbn
from nexus.schemas.publication_dates import PublicationDate, normalize_source_publication_date
from nexus.schemas.reader_apparatus import NoteRegion, NotesGroup
from nexus.schemas.source_issues import (
    MissingImage,
    SourceIssue,
    UnresolvedNavigationTarget,
    source_issues_payload,
)
from nexus.services.canonicalize import canonicalize_structure
from nexus.services.contributor_taxonomy import (
    MAX_CONTRIBUTOR_NAME_CODE_POINTS,
    MAX_CREDITS_PER_MANAGED_ROLE,
    MAX_RAW_ROLE_LENGTH,
    NOT_OBSERVED,
    ContributorObservation,
    ContributorObservationBatch,
    ObservedRoleSlices,
    clean_contributor_display,
    contributor_match_key,
)
from nexus.services.epub_structure import (
    EpubStructureFragment,
    EpubStructureSection,
    EpubStructureTocNode,
    bind_epub_source_structure,
    build_epub_structure,
)
from nexus.services.fragment_blocks import (
    FragmentBlockSpec,
    insert_fragment_blocks,
    parse_fragment_blocks,
)
from nexus.services.html_apparatus import (
    HtmlApparatusEntryOpener,
    accepted_apparatus_spans,
    attach_fragment_locators,
    collect_html_apparatus_candidate_backlinks,
    collect_html_apparatus_marker_backlinks,
    collect_html_apparatus_targets,
    confirm_html_apparatus_target_refs,
    derive_fragment_note_groups,
    extract_html_apparatus,
    prepare_apparatus_bodies,
)
from nexus.services.html_tree import inner_html, parse_html_document
from nexus.services.image_placeholder import replace_image_with_placeholder
from nexus.services.parser_temp import (
    StorageObjectIntegrityError,
    parser_attempt_directory,
    stream_storage_object_to_file,
    utf8_byte_length,
)
from nexus.services.reader_apparatus import note_regions_from_publication, replace_media_apparatus
from nexus.services.reader_structure import DocumentPoint, DomCut, SectionProof
from nexus.services.sanitize_html import (
    element_id,
    local_name,
    normalized_attr_name,
    sanitize_epub_chapter,
    sanitize_svg_asset_element,
)
from nexus.services.source_outcome import (
    SourceDiagnostics,
    SourceRunOutcome,
    source_contributor_observations,
)
from nexus.storage.client import StorageClient, get_storage_client
from nexus.storage.paths import build_epub_attempt_asset_storage_path

logger = get_logger(__name__)

EPUB_RENDERED_TEXT_MAX_BYTES = 64 * 1024 * 1024
EPUB_XHTML_MAX_DECODED_BYTES = 16 * 1024 * 1024
EPUB_APPARATUS_MAX_TARGETS = 10_000
EPUB_APPARATUS_MAX_BACKLINKS = 10_000
EPUB_APPARATUS_MAX_RETAINED_UTF8_BYTES = 8 * 1024 * 1024
EPUB_APPARATUS_MAX_CANDIDATE_INDEX_PAGES = 16_384
_ARCHIVE_MAX_ENTRIES = 10_000
_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024
_ARCHIVE_MAX_ENTRY_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
_ARCHIVE_MAX_COMPRESSION_RATIO = 100
_ARCHIVE_MAX_PARSE_MS = 30_000

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
_SVG_DEFINITION_TAGS = frozenset({"defs", "symbol", "clippath", "lineargradient", "radialgradient"})
_SVG_INVALID_USE_TARGETS = frozenset({"defs", "clippath", "lineargradient", "radialgradient"})

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
class EpubContributorIssue:
    code: Literal["unrepresentable_entity", "unobserved_role"]
    detail: str


@dataclass(frozen=True)
class _OpfMetadata:
    title: str
    publisher: str | None
    language: str | None
    description: str | None
    edition_published_date: PublicationDate | None
    edition_isbn: Isbn13 | None
    contributor_observation: ContributorObservationBatch
    contributor_issues: tuple[EpubContributorIssue, ...]


@dataclass(frozen=True)
class _ManifestItem:
    manifest_id: str
    href: str
    media_type: str


@dataclass(frozen=True)
class _SpineItem:
    idref: str
    itemref_id: str | None


@dataclass(frozen=True)
class _ChapterSpec:
    spine_idx: int
    manifest_id: str
    itemref_id: str | None
    href: str


@dataclass(frozen=True)
class _AssetEntry:
    epub_path: str
    asset_key: str
    content_type: str
    size_bytes: int


@dataclass(frozen=True)
class _WrittenAsset:
    """One referenced image as written: an `epub_resources` row's values."""

    entry: _AssetEntry
    storage_path: str
    size_bytes: int  # as written: an svg's is its sanitized size


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
class _MissingImageRef:
    marker_ordinal: int
    resource_path: str


@dataclass(frozen=True)
class _PlannedFragment:
    id: UUID
    idx: int
    href: str
    html_sanitized: str
    canonical_text: str
    blocks: list[FragmentBlockSpec]
    apparatus_edges: list[dict[str, object]]


@dataclass(frozen=True)
class EpubPlan:
    """Every row one publication installs, prepared outside any transaction."""

    storage_path: str
    created_at: datetime
    metadata: _OpfMetadata
    fragments: tuple[_PlannedFragment, ...]
    toc_nodes: tuple[EpubStructureTocNode, ...]
    sections: tuple[EpubStructureSection, ...]
    apparatus_items: tuple[dict[str, object], ...]
    note_groups: tuple[NotesGroup, ...]
    assets: tuple[_WrittenAsset, ...]
    source_issues: tuple[SourceIssue, ...]


type _TocEntry = tuple[ET.Element, str, str | None, str | None, str]


@dataclass(frozen=True)
class _TocWalk:
    """Everything one navigation walk holds constant across its recursion."""

    entries: Callable[[ET.Element], Iterator[_TocEntry]]
    nav_type: str
    base_href: str
    href_to_frag_idx: dict[str, int]
    media_id: UUID
    nodes: list[EpubStructureTocNode]
    auxiliary_nodes: dict[tuple[str, str, str, str, str | None], EpubStructureTocNode]
    node_ids: set[str]


class _InvalidEpub(Exception):
    """The archive's content is unusable; `prepare_epub_source` reports E_INVALID_FILE_TYPE."""


@dataclass(frozen=True)
class RetainedEpubFragment:
    fragment_id: UUID
    fragment_idx: int
    package_href: str
    html_sanitized: str
    canonical_text: str


def derive_epub_section_witnesses(
    *,
    epub_path: Path,
    media_id: UUID,
    fragments: Sequence[RetainedEpubFragment],
    sections: Sequence[SectionProof],
    note_regions: Sequence[NoteRegion],
) -> dict[str, tuple[DomCut | None, DomCut | None]]:
    """Reprove retained sections from verified package bytes, without reimporting.

    The caller verifies stored size/hash before opening this path. Existing
    archive/parser limits apply. Only exact identity, ancestry and coordinate
    matches receive witnesses; detector differences remain unavailable.
    """
    started = time.monotonic()
    with zipfile.ZipFile(epub_path) as zf:
        _check_archive_safety(zf)
        opf_path = _find_opf_path(zf)
        if opf_path is None:
            raise ApiError(ApiErrorCode.E_INVALID_FILE_TYPE, "Cannot locate OPF rootfile")
        opf = _parse_xml_entry(zf, opf_path, decoded_bytes_limit=None)
        if opf is None:
            raise ApiError(ApiErrorCode.E_INVALID_FILE_TYPE, "Failed to parse OPF")
        manifest = _parse_manifest(opf, posixpath.dirname(opf_path))
        href_to_idx = {fragment.package_href: fragment.fragment_idx for fragment in fragments}
        toc = _materialize_toc(zf, opf, manifest, href_to_idx, media_id, opf_path)
        retained: list[EpubStructureFragment] = []
        rendered_bytes = 0
        for fragment in fragments:
            if (time.monotonic() - started) * 1000 > _ARCHIVE_MAX_PARSE_MS:
                raise ResourceLimitError(
                    "Section preparation exceeded archive parse time", dimension="Time"
                )
            if zf.getinfo(fragment.package_href).file_size > EPUB_XHTML_MAX_DECODED_BYTES:
                raise ResourceLimitError(_XHTML_DECODED_BYTES_MESSAGE, dimension="Output")
            rendered_bytes += utf8_byte_length(fragment.html_sanitized) + utf8_byte_length(
                fragment.canonical_text
            )
            if rendered_bytes > EPUB_RENDERED_TEXT_MAX_BYTES:
                raise ResourceLimitError(
                    "Section preparation exceeds rendered text limit", dimension="Output"
                )
            canonical = canonicalize_structure(fragment.html_sanitized)
            if canonical.text != fragment.canonical_text:
                raise ValueError("Retained EPUB canonical text disagrees with its rich body")
            canonical = bind_epub_source_structure(
                structure=canonical,
                source_html=_decode_epub_text(zf.read(fragment.package_href)),
            )
            retained.append(
                EpubStructureFragment(
                    fragment.fragment_id, fragment.fragment_idx, fragment.package_href, canonical
                )
            )
        detected = build_epub_structure(
            media_id=media_id, fragments=retained, toc_nodes=toc, note_regions=note_regions
        )
    existing = {section.section_id: section for section in sections}
    detected_by_id = {section.location_id: section for section in detected.sections}
    result: dict[str, tuple[DomCut | None, DomCut | None]] = {}
    for section in detected.sections:
        current: EpubStructureSection | None = section
        while current is not None:
            previous = existing.get(current.location_id)
            if previous is None or (
                previous.parent_section_id != current.parent_section_id
                or previous.start != DocumentPoint(current.fragment_idx, current.start_offset)
                or previous.end != current.end
            ):
                break
            current = (
                detected_by_id[current.parent_section_id] if current.parent_section_id else None
            )
        else:
            result[section.location_id] = section.start_cut, section.end_cut
    return result


def prepare_epub_source(
    *,
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    source_size_bytes: int,
    expected_source_sha256: str,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
) -> EpubPlan:
    """Materialize and parse one immutable EPUB, then write its images; no transaction."""
    storage_client = get_storage_client()
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
        except StorageObjectIntegrityError as exc:
            raise ApiError(
                ApiErrorCode.E_SOURCE_INTEGRITY,
                "Stored EPUB bytes do not match the immutable source identity",
            ) from exc
        try:
            zf = zipfile.ZipFile(epub_path)
        except zipfile.BadZipFile as exc:
            raise ApiError(ApiErrorCode.E_INVALID_FILE_TYPE, f"Invalid ZIP: {exc}") from exc
        with zf:
            try:
                return _parse(
                    zf,
                    media_id=media_id,
                    attempt_id=attempt_id,
                    storage_path=storage_path,
                    storage_client=storage_client,
                    record_progress=record_progress,
                    attempt_directory=attempt_directory,
                )
            except _InvalidEpub as exc:
                raise ApiError(
                    ApiErrorCode.E_INVALID_FILE_TYPE, f"Extraction failed: {exc}"
                ) from exc


def _parse(
    zf: zipfile.ZipFile,
    *,
    media_id: UUID,
    attempt_id: UUID,
    storage_path: str,
    storage_client: StorageClient,
    record_progress: Callable[[int, int, Literal["Page", "Chapter"]], None],
    attempt_directory: Path,
) -> EpubPlan:
    """Parse one opened archive, then write the images it references and plan them."""
    started = time.monotonic()

    def within_budget() -> None:
        # Wall clock, as before; checked per chapter so a slow book stops when it is over.
        elapsed_ms = int((time.monotonic() - started) * 1000)
        if elapsed_ms > _ARCHIVE_MAX_PARSE_MS:
            raise ResourceLimitError(
                f"Parse time {elapsed_ms}ms exceeded limit {_ARCHIVE_MAX_PARSE_MS}ms",
                dimension="Time",
            )

    _check_archive_safety(zf)
    opf_path = _find_opf_path(zf)
    if opf_path is None:
        raise ApiError(ApiErrorCode.E_INVALID_FILE_TYPE, "Cannot locate OPF rootfile")
    opf = _parse_xml_entry(zf, opf_path, decoded_bytes_limit=None)
    if opf is None:
        raise ApiError(ApiErrorCode.E_INVALID_FILE_TYPE, "Failed to parse OPF")
    manifest = _parse_manifest(opf, posixpath.dirname(opf_path))
    metadata = _extract_opf_metadata(opf, storage_path)
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

    staged, external_targets = _stage_epub_chapters(
        package,
        _collect_readable_chapters(zf, manifest, _parse_spine(opf)),
        staging_directory=attempt_directory,
        within_budget=within_budget,
    )
    if not staged:
        raise ApiError(
            ApiErrorCode.E_SOURCE_NOT_READABLE, "Zero renderable XHTML spine items after extraction"
        )
    confirmed_target_refs: set[str] = set()
    for chapter, html_path, _missing_refs in staged:
        within_budget()
        confirmed_target_refs.update(
            confirm_html_apparatus_target_refs(
                html_path.read_text(encoding="utf-8"),
                document_href=chapter.href,
                external_targets=external_targets,
            )
        )
    external_targets = {
        key: target
        for key, target in external_targets.items()
        if target["extraction_method"] != "html_note_boundary" or key in confirmed_target_refs
    }
    chapter_total = len(staged)
    record_progress(0, chapter_total, "Chapter")

    sanitized: list[
        tuple[
            _ChapterSpec,
            str,
            list[dict[str, object]],
            list[dict[str, object]],
            list[_MissingImageRef],
        ]
    ] = []
    rendered_text_bytes = 0
    for chapter_index, (chapter, html_path, missing_refs) in enumerate(staged, start=1):
        within_budget()
        html_with_apparatus, apparatus_items, apparatus_edges = extract_html_apparatus(
            html_path.read_text(encoding="utf-8"),
            source_kind=f"epub:{chapter.spine_idx}",
            document_href=chapter.href,
            external_targets=external_targets,
            confirmed_target_refs=confirmed_target_refs,
            source_ref=_chapter_source_ref(chapter),
        )
        prepare_apparatus_bodies(apparatus_items, sanitize=sanitize_epub_chapter, media_kind="epub")
        try:
            html_sanitized = sanitize_epub_chapter(html_with_apparatus)
        except (ValueError, LxmlError) as exc:
            raise ApiError(
                ApiErrorCode.E_SANITIZATION_FAILED,
                f"Sanitization failed for spine item {chapter.spine_idx}: {exc}",
            ) from exc
        del html_with_apparatus
        if not html_sanitized.strip():
            record_progress(chapter_index, chapter_total, "Chapter")
            continue
        rendered_text_bytes += utf8_byte_length(html_sanitized)
        if rendered_text_bytes > EPUB_RENDERED_TEXT_MAX_BYTES:
            raise ResourceLimitError(
                "EPUB rendered text exceeds the 64 MiB limit", dimension="Output"
            )
        sanitized.append((chapter, html_sanitized, apparatus_items, apparatus_edges, missing_refs))
        record_progress(chapter_index, chapter_total, "Chapter")

    if not sanitized:
        raise ApiError(
            ApiErrorCode.E_SOURCE_NOT_READABLE, "Zero renderable chapters after sanitization"
        )
    href_to_frag_idx = {chapter.href: index for index, (chapter, *_rest) in enumerate(sanitized)}
    try:
        toc_nodes = _materialize_toc(zf, opf, manifest, href_to_frag_idx, media_id, opf_path)
    except _InvalidEpub:
        # Optional navigation cannot make readable content unusable. A broken
        # declaration supplies no replacement authority.
        toc_nodes = []

    created_at = datetime.now(UTC)
    fragments: list[_PlannedFragment] = []
    fragment_items: list[list[dict[str, object]]] = []
    structure_fragments: list[EpubStructureFragment] = []
    source_issues: list[SourceIssue] = []
    readable_source = False
    for fragment_idx, (
        chapter,
        html_sanitized,
        apparatus_items,
        apparatus_edges,
        missing_refs,
    ) in enumerate(sanitized):
        within_budget()
        try:
            canonical = canonicalize_structure(html_sanitized)
        except ValueError as exc:
            raise ApiError(
                ApiErrorCode.E_SANITIZATION_FAILED,
                f"Canonicalization failed for spine item {chapter.spine_idx}: {exc}",
            ) from exc
        try:
            canonical = bind_epub_source_structure(
                structure=canonical,
                source_html=_decode_epub_text(zf.read(chapter.href)),
            )
        except ValueError as exc:
            raise ApiError(ApiErrorCode.E_SOURCE_NOT_READABLE, str(exc)) from exc
        rendered_text_bytes += utf8_byte_length(canonical.text)
        if rendered_text_bytes > EPUB_RENDERED_TEXT_MAX_BYTES:
            raise ResourceLimitError(
                "EPUB rendered text exceeds the 64 MiB limit", dimension="Output"
            )
        fragment = _PlannedFragment(
            id=new_uuid7(),
            idx=fragment_idx,
            href=chapter.href,
            html_sanitized=html_sanitized,
            canonical_text=canonical.text,
            blocks=parse_fragment_blocks(canonical.text),
            apparatus_edges=apparatus_edges,
        )
        fragments.append(fragment)
        fragment_items.append(apparatus_items)
        retained_image, warning_markers = _retained_image_and_warning_markers(html_sanitized)
        source_issues.extend(
            MissingImage(
                fragment_id=fragment.id,
                marker_ordinal=ref.marker_ordinal,
                resource_path=ref.resource_path,
            )
            for ref in missing_refs
            if ref.marker_ordinal in warning_markers
        )
        readable_source |= bool(canonical.text.strip()) or retained_image
        structure_fragments.append(
            EpubStructureFragment(fragment.id, fragment_idx, chapter.href, canonical)
        )

    if not readable_source:
        raise ApiError(ApiErrorCode.E_SOURCE_NOT_READABLE, "No surviving source text or image")
    del external_targets

    apparatus_items: list[dict[str, object]] = []
    note_groups: list[NotesGroup] = []
    for fragment, items, structure_fragment, (chapter, *_rest) in zip(
        fragments, fragment_items, structure_fragments, sanitized, strict=True
    ):
        within_budget()
        structure = structure_fragment.canonical
        accepted_spans = accepted_apparatus_spans(structure, fragment.canonical_text)
        apparatus_items.extend(
            attach_fragment_locators(
                media_id=media_id,
                fragment_id=fragment.id,
                media_kind="epub",
                canonical_text=fragment.canonical_text,
                items=items,
                accepted_spans=accepted_spans,
                html_sanitized=fragment.html_sanitized,
            )
        )
        note_groups.extend(
            derive_fragment_note_groups(
                fragment.html_sanitized,
                fragment.canonical_text,
                fragment.id,
                structure=structure,
                accepted_spans=accepted_spans,
                source_html=(attempt_directory / f"chapter-{chapter.spine_idx}.html").read_text(
                    encoding="utf-8"
                ),
            )
        )

    try:
        structure = build_epub_structure(
            media_id=media_id,
            fragments=structure_fragments,
            toc_nodes=toc_nodes,
            note_regions=note_regions_from_publication(apparatus_items, note_groups),
        )
        toc_nodes.extend(structure.supplemental_toc_nodes)
    except ValueError as exc:
        raise ApiError(ApiErrorCode.E_SOURCE_NOT_READABLE, str(exc)) from exc

    source_issues.extend(
        UnresolvedNavigationTarget(node_id=node.node_id, href=node.href)
        for node in toc_nodes
        if node.href is not None and not urlparse(node.href).scheme and node.target_offset is None
    )
    if len(source_issues) > 10_000:
        raise ResourceLimitError("EPUB source issues exceed 10000 records", dimension="Output")
    rendered_text_bytes += len(
        json.dumps(source_issues_payload(tuple(source_issues)), ensure_ascii=False).encode("utf-8")
    )
    if rendered_text_bytes > EPUB_RENDERED_TEXT_MAX_BYTES:
        raise ResourceLimitError("EPUB output exceeds the 64 MiB limit", dimension="Output")
    within_budget()

    assets = _write_epub_assets(
        package,
        attempt_id=attempt_id,
        storage_client=storage_client,
        attempt_directory=attempt_directory,
    )
    return EpubPlan(
        storage_path=storage_path,
        created_at=created_at,
        metadata=metadata,
        fragments=tuple(fragments),
        toc_nodes=tuple(toc_nodes),
        sections=tuple(structure.sections),
        apparatus_items=tuple(apparatus_items),
        note_groups=tuple(note_groups),
        assets=assets,
        source_issues=tuple(source_issues),
    )


def publish_epub_plan(db: Session, media: Media, plan: EpubPlan) -> SourceRunOutcome:
    """Install the plan's rows and metadata inside the caller's publication.

    An epub publishes once (`replace_reader_publication` refuses a second), so there is
    nothing to replace: every row is new, and so is every apparatus item id.
    """
    for fragment in plan.fragments:
        db.add(
            Fragment(
                id=fragment.id,
                media_id=media.id,
                idx=fragment.idx,
                html_sanitized=fragment.html_sanitized,
                canonical_text=fragment.canonical_text,
                created_at=plan.created_at,
            )
        )
    db.flush()
    for fragment in plan.fragments:
        insert_fragment_blocks(db, fragment.id, fragment.blocks)
        db.add(
            EpubFragmentSource(
                media_id=media.id,
                fragment_id=fragment.id,
                package_href=fragment.href,
                created_at=plan.created_at,
            )
        )
    for node in plan.toc_nodes:  # the structure's toc node is the row's column set
        db.add(EpubTocNode(media_id=media.id, created_at=plan.created_at, **vars(node)))
    for asset in plan.assets:
        db.add(
            EpubResource(
                media_id=media.id,
                package_href=asset.entry.epub_path,
                asset_key=asset.entry.asset_key,
                storage_path=asset.storage_path,
                content_type=asset.entry.content_type,
                size_bytes=asset.size_bytes,
                created_at=plan.created_at,
            )
        )
    db.flush()
    for ordinal, nav in enumerate(plan.sections):
        db.add(
            EpubNavLocation(
                media_id=media.id,
                location_id=nav.location_id,
                ordinal=ordinal,
                label=nav.label,
                fragment_idx=nav.fragment_idx,
                href_path=nav.href_path,
                href_fragment=nav.href_fragment,
                start_offset=nav.start_offset,
                parent_section_id=nav.parent_section_id,
                end_fragment_idx=nav.end.fragment_idx if nav.end is not None else None,
                end_offset=nav.end.offset if nav.end is not None else None,
                source=nav.source,
                start_dom_path=list(nav.start_cut.path) if nav.start_cut is not None else None,
                start_dom_edge=nav.start_cut.edge if nav.start_cut is not None else None,
                end_dom_path=list(nav.end_cut.path) if nav.end_cut is not None else None,
                end_dom_edge=nav.end_cut.edge if nav.end_cut is not None else None,
                created_at=plan.created_at,
            )
        )
    db.flush()
    replace_media_apparatus(
        db,
        media_id=media.id,
        items=list(plan.apparatus_items),
        edges=[edge for fragment in plan.fragments for edge in fragment.apparatus_edges],
        note_groups=list(plan.note_groups),
        status="ready" if plan.apparatus_items else "empty",
    )
    metadata = plan.metadata
    media.title = metadata.title
    if metadata.publisher and not media.publisher:
        media.publisher = metadata.publisher[:255]
    if metadata.language and not media.language:
        media.language = metadata.language[:32]
    if metadata.description and not media.description:
        media.description = metadata.description[:2000]
    if metadata.edition_published_date is not None:
        media.edition_published_date = metadata.edition_published_date
    if metadata.edition_isbn is not None:
        media.edition_isbn = metadata.edition_isbn
    db.flush()
    diagnostics: SourceDiagnostics = {
        "status": "success",
        "fragment_count": len(plan.fragments),
        "toc_node_count": len(plan.toc_nodes),
        "asset_count": len(plan.assets),
        "title": metadata.title,
    }
    for issue in metadata.contributor_issues:
        logger.warning(
            "epub_contributor_observation_unrepresentable",
            media_id=str(media.id),
            code=issue.code,
            detail=issue.detail,
        )
    if metadata.contributor_issues:
        diagnostics["contributor_issues"] = [
            {"code": issue.code, "detail": issue.detail} for issue in metadata.contributor_issues
        ]
    return SourceRunOutcome(
        diagnostics=diagnostics,
        observations=source_contributor_observations(
            media_id=media.id, observation=metadata.contributor_observation, source="epub_opf"
        ),
        metadata_enrichment=True,
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
    attempt_id: UUID,
    storage_client: StorageClient,
    attempt_directory: Path,
) -> tuple[_WrittenAsset, ...]:
    """Write every referenced image before the plan names it; an svg is written sanitized."""
    written: list[_WrittenAsset] = []
    for asset_index, asset in enumerate(package.asset_entries):
        path = build_epub_attempt_asset_storage_path(package.media_id, attempt_id, asset.asset_key)
        with package.zf.open(asset.epub_path) as asset_stream:
            if asset.content_type != _SVG_IMAGE_TYPE:
                storage_client.put_object(path, cast(BinaryIO, asset_stream), asset.content_type)
                written.append(_WrittenAsset(asset, path, asset.size_bytes))
                continue
            sanitized_path = attempt_directory / f"asset-{asset_index}.svg"
            with sanitized_path.open("w+b") as sanitized_stream:
                _write_sanitized_svg_asset(
                    cast(BinaryIO, asset_stream), sanitized_stream, asset.epub_path
                )
                written.append(_WrittenAsset(asset, path, sanitized_stream.tell()))
                sanitized_stream.seek(0)
                storage_client.put_object(path, sanitized_stream, asset.content_type)
    return tuple(written)


def _check_archive_safety(zf: zipfile.ZipFile) -> None:
    """Refuse unsafe entry paths and over-budget archives before reading entries."""
    infos = zf.infolist()
    if len(infos) > _ARCHIVE_MAX_ENTRIES:
        raise ResourceLimitError(
            f"Archive has {len(infos)} entries (limit {_ARCHIVE_MAX_ENTRIES})",
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
            raise ApiError(ApiErrorCode.E_ARCHIVE_UNSAFE, unsafe)
        seen_names.add(name)

        if info.file_size > _ARCHIVE_MAX_ENTRY_UNCOMPRESSED_BYTES:
            raise ResourceLimitError(
                f"Entry '{name}' uncompressed size {info.file_size} exceeds limit "
                f"{_ARCHIVE_MAX_ENTRY_UNCOMPRESSED_BYTES}",
                dimension="Output",
            )
        total_uncompressed += info.file_size
        ratio = info.file_size / info.compress_size if info.compress_size > 0 else 0
        if ratio > _ARCHIVE_MAX_COMPRESSION_RATIO:
            raise ResourceLimitError(
                f"Entry '{name}' compression ratio {ratio:.1f} exceeds limit "
                f"{_ARCHIVE_MAX_COMPRESSION_RATIO}",
                dimension="Output",
            )

    if total_uncompressed > _ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES:
        raise ResourceLimitError(
            f"Total uncompressed {total_uncompressed} exceeds limit "
            f"{_ARCHIVE_MAX_TOTAL_UNCOMPRESSED_BYTES}",
            dimension="Output",
        )


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
            raise ResourceLimitError(_XHTML_DECODED_BYTES_MESSAGE, dimension="Output")
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


def _extract_opf_metadata(opf: ET.Element, storage_path: str) -> _OpfMetadata:
    """Read Dublin Core metadata, keeping only unambiguous dates and ISBNs."""
    observation, issues = _extract_opf_contributors(opf)
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
        if normalized is not None:
            publication_dates.add(normalized)

    isbns: set[str] = set()
    primary_isbns: set[str] = set()
    primary_id = opf.get("unique-identifier")
    for identifier in opf.findall(".//opf:metadata/dc:identifier", _NS):
        value = normalize_source_isbn(identifier.text or "")
        if value is None:
            continue
        isbns.add(value)
        if primary_id is not None and identifier.get("id") == primary_id:
            primary_isbns.add(value)
    selected = primary_isbns or isbns

    return _OpfMetadata(
        title=_resolve_title(opf, storage_path),
        contributor_observation=observation,
        contributor_issues=issues,
        publisher=publisher.strip() or None if publisher is not None else None,
        language=language.strip() or None if language is not None else None,
        description=description.strip() or None if description is not None else None,
        edition_published_date=next(iter(publication_dates))
        if len(publication_dates) == 1
        else None,
        edition_isbn=next(iter(selected)) if len(selected) == 1 else None,
    )


_MARC_CONTRIBUTOR_ROLES = {
    "aut": "author",
    "edt": "editor",
    "trl": "translator",
    "hst": "host",
    "gst": "guest",
    "nrt": "narrator",
    "cre": "creator",
    "pro": "producer",
    "pbl": "publisher",
}


def _extract_opf_contributors(
    opf: ET.Element,
) -> tuple[ContributorObservationBatch, tuple[EpubContributorIssue, ...]]:
    """One DC element is one entity; explicit role evidence overrides creator defaults."""
    metadata = opf.find("opf:metadata", _NS)
    if metadata is None:
        return NOT_OBSERVED, ()
    entries = [
        element
        for element in metadata
        if element.tag in {f"{{{_NS['dc']}}}creator", f"{{{_NS['dc']}}}contributor"}
    ]
    id_counts: dict[str, int] = {}
    for element in opf.iter():
        if identifier := element.get("id"):
            id_counts[identifier] = id_counts.get(identifier, 0) + 1
    refinements: dict[str, list[tuple[str, str]]] = {}
    for element in metadata.findall("opf:meta", _NS):
        if element.get("property") == "role" and (refines := element.get("refines", "")).startswith(
            "#"
        ):
            refinements.setdefault(refines[1:], []).append(
                (
                    element.get("scheme", "marc:relators"),
                    clean_contributor_display(element.text or ""),
                )
            )

    entities: list[tuple[ContributorObservation, ...]] = []
    issues: list[EpubContributorIssue] = []
    for ordinal, element in enumerate(entries, 1):
        name = clean_contributor_display(element.text or "")
        if not name:
            continue
        if len(name) > MAX_CONTRIBUTOR_NAME_CODE_POINTS:
            issues.append(
                EpubContributorIssue(
                    "unrepresentable_entity",
                    f"entity {ordinal}: credited name exceeds 200 characters",
                )
            )
            continue
        identifier = element.get("id", "")
        if id_counts.get(identifier, 0) > 1 and identifier in refinements:
            issues.append(
                EpubContributorIssue(
                    "unrepresentable_entity",
                    f"entity {ordinal}: duplicate id makes role refinements ambiguous",
                )
            )
            continue
        roles: list[tuple[str, str]] = []
        raw_role = element.get(f"{{{_NS['opf']}}}role")
        if raw_role is not None:
            roles.append(("marc:relators", clean_contributor_display(raw_role)))
        roles.extend(refinements.get(identifier, []))
        by_role: dict[str, list[str]] = {}
        for scheme, raw_role in roles:
            label = raw_role if scheme == "marc:relators" else f"{scheme}:{raw_role}"
            role = (
                _MARC_CONTRIBUTOR_ROLES.get(raw_role, "unknown")
                if scheme == "marc:relators"
                else "unknown"
            )
            labels = by_role.setdefault(role, [])
            if label not in labels:
                labels.append(label)
        if not roles:
            by_role["author" if element.tag.endswith("}creator") else "unknown"] = []
        if any(not label for _, label in roles) or any(
            len("; ".join(labels)) > MAX_RAW_ROLE_LENGTH or any(not label for label in labels)
            for labels in by_role.values()
        ):
            issues.append(
                EpubContributorIssue(
                    "unrepresentable_entity",
                    f"entity {ordinal}: role evidence cannot fit its 80-character contract",
                )
            )
            continue
        entities.append(
            tuple(
                ContributorObservation(name, role, "; ".join(labels) or None, None)
                for role, labels in by_role.items()
            )
        )

    credits: list[ContributorObservation] = []
    seen: set[tuple[str, str]] = set()
    for entity in entities:
        for credit in entity:
            pair = (credit.role, contributor_match_key(credit.credited_name))
            if pair not in seen:
                seen.add(pair)
                credits.append(credit)
    role_counts: dict[str, int] = {}
    for credit in credits:
        role_counts[credit.role] = role_counts.get(credit.role, 0) + 1
    overflow_roles = {
        role for role, count in role_counts.items() if count > MAX_CREDITS_PER_MANAGED_ROLE
    }
    for role in sorted(overflow_roles):
        issues.append(
            EpubContributorIssue(
                "unobserved_role",
                f"{role}: {role_counts[role]} credits exceed the 20-credit contract",
            )
        )
    credits = [credit for credit in credits if credit.role not in overflow_roles]
    observation = (
        ObservedRoleSlices(frozenset(credit.role for credit in credits), tuple(credits))
        if credits
        else NOT_OBSERVED
    )
    return observation, tuple(issues)


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
    seen: set[str] = set()
    for spine_idx, spine_item in enumerate(spine_items):
        entry = manifest.get(spine_item.idref)
        if entry is None or entry.media_type not in _READABLE_MEDIA_TYPES:
            continue
        if entry.href in seen:
            continue  # a repeated document is read once, at its first position
        seen.add(entry.href)
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


def _candidate_backlink_exists(
    candidates: sqlite3.Connection,
    target_ref: str,
    marker_id: str,
    source_href: str,
    require_note_context: bool,
) -> bool:
    target_href = target_ref.partition("#")[0]
    qualified = f"{source_href}#{marker_id}"
    local = f"#{marker_id}" if target_href == source_href else qualified
    return (
        candidates.execute(
            "SELECT 1 FROM backlinks WHERE target_ref = ? AND href IN (?, ?) "
            "AND (? = 0 OR has_note_context = 1) LIMIT 1",
            (target_ref, local, qualified, require_note_context),
        ).fetchone()
        is not None
    )


def _stage_epub_chapters(
    package: _Package,
    chapter_specs: list[_ChapterSpec],
    *,
    staging_directory: Path,
    within_budget: Callable[[], None],
) -> tuple[list[tuple[_ChapterSpec, Path, list[_MissingImageRef]]], dict[str, dict[str, object]]]:
    """Rewrite each readable spine item, then index reciprocal apparatus targets.

    Rewritten chapter HTML is spilled to the attempt directory so the later
    marker pass reads exactly the package-relative links indexed here.
    """
    staged: list[tuple[_ChapterSpec, Path, list[_MissingImageRef]]] = []
    targets: dict[str, dict[str, object]] = {}
    target_count = 0
    retained_utf8_bytes = 0
    backlink_count = 0
    marker_backlinks: dict[str, set[str]] = {}
    entry_openers: dict[str, dict[str, HtmlApparatusEntryOpener]] = {}
    marker_count = 0
    marker_bytes = 0
    for chapter in chapter_specs:
        within_budget()
        try:
            # `zipfile` hands out at most the declared uncompressed size and fails
            # the entry's CRC otherwise, so the header bounds the decoded bytes.
            if package.zf.getinfo(chapter.href).file_size > EPUB_XHTML_MAX_DECODED_BYTES:
                raise ResourceLimitError(_XHTML_DECODED_BYTES_MESSAGE, dimension="Output")
            raw = package.zf.read(chapter.href)
        # justify-ignore-error: an unreadable spine entry is not a renderable chapter.
        except _ZIP_ENTRY_READ_ERRORS:
            continue
        rewritten_html, missing_refs = _rewrite_chapter_resources(
            _decode_epub_text(raw), chapter.href, package
        )
        del raw
        html_path = staging_directory / f"chapter-{chapter.spine_idx}.html"
        html_path.write_text(rewritten_html, encoding="utf-8")
        staged.append((chapter, html_path, missing_refs))
        del rewritten_html
    target_hrefs = {chapter.href for chapter, _path, _missing in staged}
    with closing(sqlite3.connect(staging_directory / "apparatus-candidates.sqlite3")) as candidates:
        candidates.execute("PRAGMA page_size = 4096")
        candidates.execute("PRAGMA journal_mode = OFF")
        candidates.execute(f"PRAGMA max_page_count = {EPUB_APPARATUS_MAX_CANDIDATE_INDEX_PAGES}")
        candidates.execute(
            "CREATE TABLE backlinks (target_ref TEXT NOT NULL, href TEXT NOT NULL, "
            "has_note_context INTEGER NOT NULL, "
            "PRIMARY KEY (target_ref, href)) WITHOUT ROWID"
        )

        def record_candidate(target_ref: str, hrefs: Iterator[str], has_note_context: bool) -> None:
            try:
                candidates.execute("DELETE FROM backlinks WHERE target_ref = ?", (target_ref,))
                candidates.executemany(
                    "INSERT OR IGNORE INTO backlinks (target_ref, href, has_note_context) "
                    "VALUES (?, ?, ?)",
                    ((target_ref, href, has_note_context) for href in hrefs),
                )
            except sqlite3.OperationalError as exc:
                pages = candidates.execute("PRAGMA page_count").fetchone()
                if (
                    str(exc) == "database or disk is full"
                    and pages
                    and pages[0] >= EPUB_APPARATUS_MAX_CANDIDATE_INDEX_PAGES
                ):
                    raise ResourceLimitError(
                        "EPUB apparatus candidate index exceeded 64 MiB", dimension="Output"
                    ) from exc
                raise

        for chapter, html_path, _missing in staged:
            within_budget()
            collect_html_apparatus_candidate_backlinks(
                html_path.read_text(encoding="utf-8"),
                document_href=chapter.href,
                record_candidate=record_candidate,
            )
        candidates.commit()

        def candidate_backlink_exists(
            target_ref: str, marker_id: str, source_href: str, require_note_context: bool
        ) -> bool:
            return _candidate_backlink_exists(
                candidates, target_ref, marker_id, source_href, require_note_context
            )

        for chapter, html_path, _missing in staged:
            within_budget()
            added, added_bytes = collect_html_apparatus_marker_backlinks(
                html_path.read_text(encoding="utf-8"),
                document_href=chapter.href,
                target_hrefs=target_hrefs,
                candidate_backlink_exists=candidate_backlink_exists,
                marker_backlinks=marker_backlinks,
                entry_openers=entry_openers,
                max_markers=EPUB_APPARATUS_MAX_BACKLINKS - marker_count,
                max_retained_utf8_bytes=EPUB_APPARATUS_MAX_RETAINED_UTF8_BYTES - marker_bytes,
            )
            marker_count += added
            marker_bytes += added_bytes
    for chapter, html_path, _missing in staged:
        within_budget()
        (
            chapter_targets,
            chapter_target_count,
            chapter_retained_utf8_bytes,
            chapter_backlink_count,
        ) = collect_html_apparatus_targets(
            html_path.read_text(encoding="utf-8"),
            document_href=chapter.href,
            source_kind=f"epub:{chapter.spine_idx}",
            source_ref=_chapter_source_ref(chapter),
            extraction_method="epub_noteref",
            max_targets=EPUB_APPARATUS_MAX_TARGETS - target_count,
            max_backlinks=EPUB_APPARATUS_MAX_BACKLINKS - backlink_count,
            max_retained_utf8_bytes=EPUB_APPARATUS_MAX_RETAINED_UTF8_BYTES - retained_utf8_bytes,
            marker_backlinks=marker_backlinks,
            entry_openers=entry_openers,
        )
        targets.update(chapter_targets)
        target_count += chapter_target_count
        retained_utf8_bytes += chapter_retained_utf8_bytes
        backlink_count += chapter_backlink_count
    return staged, targets


def _rewrite_chapter_resources(
    html: str, chapter_href: str, package: _Package
) -> tuple[str, list[_MissingImageRef]]:
    """Point package-local images at the asset route and drop every other link."""
    chapter_dir = posixpath.dirname(chapter_href)
    try:
        doc = parse_html_document(html)
    except LxmlError as exc:
        raise _InvalidEpub(f"Failed to parse EPUB chapter resources: {chapter_href}") from exc

    if doc.body is not None and (body_id := element_id(doc.body)) is not None:
        # The source body is the first browser target for its id: keep that identity on a
        # marker before apparatus extracts its contents, never a descendant's collision.
        for element in doc.body.iterdescendants():
            for attr, value in list(element.attrib.items()):
                if normalized_attr_name(attr) == "id" and value == body_id:
                    del element.attrib[attr]
        marker = Element("span", id=body_id)
        marker.tail = doc.body.text
        doc.body.text = None
        doc.body.insert(0, marker)
    missing_refs: list[_MissingImageRef] = []
    missing_svgs: dict[HtmlElement, int] = {}
    next_marker = 0
    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        tag = local_name(element.tag)
        for attr in list(element.attrib):
            if normalized_attr_name(attr) == "data-reader-source-warning":
                del element.attrib[attr]
        missing_paths: list[str] = []
        for attr in list(element.attrib):
            name = normalized_attr_name(attr)
            value = element.attrib.get(attr, "")
            if tag == "img" and name == "srcset":
                rewritten = _rewrite_srcset(value, chapter_dir, package, missing_paths) or None
            elif (tag == "img" and name == "src") or (
                tag == "image" and name in {"href", "xlink:href"}
            ):
                rewritten = _rewrite_image_resource_url(value, chapter_dir, package, missing_paths)
            elif name in _RESOURCE_ATTRS:
                rewritten = _rewrite_resource_url(value, name, chapter_dir, package.readable_paths)
            else:
                continue
            if rewritten is None:
                del element.attrib[attr]
            else:
                element.attrib[attr] = rewritten

        if tag == "img" and missing_paths:
            element.set("data-reader-source-warning", str(next_marker))
            missing_refs.extend(
                _MissingImageRef(next_marker, path) for path in dict.fromkeys(missing_paths)
            )
            next_marker += 1
            if not element.get("src") and not element.get("srcset"):
                replace_image_with_placeholder(element)
        elif tag == "image" and missing_paths:
            # an inline svg that cannot show an image becomes the placeholder whole, as an img
            # does; replaced once the walk, which is inside it, is done
            svgs = [
                ancestor
                for ancestor in element.iterancestors()
                if local_name(ancestor.tag) == "svg"
            ]
            svg = svgs[-1] if svgs else element
            if svg not in missing_svgs:
                missing_svgs[svg] = next_marker
                next_marker += 1
            missing_refs.extend(_MissingImageRef(missing_svgs[svg], path) for path in missing_paths)
    for svg, marker in missing_svgs.items():
        svg.set("data-reader-source-warning", str(marker))
        replace_image_with_placeholder(svg)

    body = doc.body if doc.body is not None else doc
    return inner_html(body), list(dict.fromkeys(missing_refs))


def _retained_image_and_warning_markers(html: str) -> tuple[bool, set[int]]:
    doc = parse_html_document(html)
    retained_image = False
    warning_markers: set[int] = set()
    state: dict[HtmlElement, tuple[bool, bool, bool]] = {}
    svg_targets: dict[str, HtmlElement] = {}
    visible_uses: list[HtmlElement] = []
    for element in doc.iter():
        if not isinstance(element, HtmlElement):
            continue
        marker = element.get("data-reader-source-warning")
        if marker is not None:
            warning_markers.add(int(marker))
        parent_visible, parent_svg, parent_definition = state.get(
            element.getparent(), (True, False, False)
        )
        visible = (
            parent_visible
            and "hidden" not in element.attrib
            and element.get("aria-hidden", "").lower() != "true"
        )
        tag = local_name(element.tag)
        in_svg = parent_svg or tag == "svg"
        in_definition = parent_definition or tag in _SVG_DEFINITION_TAGS
        state[element] = (visible, in_svg, in_definition)
        if in_svg and element.get("id"):
            svg_targets.setdefault(element.get("id", ""), element)
        if not visible:
            continue
        if tag == "img" and (element.get("src") or element.get("srcset")):
            retained_image = True
        elif in_svg and not in_definition:
            if _svg_element_has_image(element):
                retained_image = True
            elif tag == "use":
                visible_uses.append(element)

    def referenced_image(target: HtmlElement, seen: set[str]) -> bool:
        pending = [(target, True)]
        while pending:
            element, reference_root = pending.pop()
            if not state[element][0]:
                continue
            tag = local_name(element.tag)
            if not reference_root and tag in _SVG_DEFINITION_TAGS:
                continue
            if _svg_element_has_image(element):
                return True
            if tag == "use":
                href = element.get("href") or element.get("xlink:href") or ""
                if href.startswith("#") and href not in seen:
                    seen.add(href)
                    nested = svg_targets.get(href[1:])
                    if (
                        nested is not None
                        and local_name(nested.tag) not in _SVG_INVALID_USE_TARGETS
                    ):
                        pending.append((nested, True))
            pending.extend((child, False) for child in element if isinstance(child, HtmlElement))
        return False

    if not retained_image:
        # A local target's drawable content is independent of which use references it.
        seen_refs: set[str] = set()
        for element in visible_uses:
            href = element.get("href") or element.get("xlink:href") or ""
            if href in seen_refs:
                continue
            seen_refs.add(href)
            target = svg_targets.get(href[1:]) if href.startswith("#") else None
            if target is not None and local_name(target.tag) not in _SVG_INVALID_USE_TARGETS:
                if referenced_image(target, seen_refs):
                    retained_image = True
                    break
    return retained_image, warning_markers


def _svg_element_has_image(element: HtmlElement) -> bool:
    """Require retained drawing data; this does not evaluate SVG paint or layout."""
    tag = local_name(element.tag)
    if tag == "image":
        return bool(element.get("href") or element.get("xlink:href"))
    if tag == "path":
        return bool(element.get("d", "").strip())
    if tag == "circle":
        return bool(element.get("r", "").strip())
    if tag == "ellipse":
        return bool(element.get("rx", "").strip() and element.get("ry", "").strip())
    if tag == "rect":
        return bool(element.get("width", "").strip() and element.get("height", "").strip())
    if tag == "line":
        return any(element.get(attr, "").strip() for attr in ("x1", "y1", "x2", "y2"))
    if tag in {"polyline", "polygon"}:
        return bool(element.get("points", "").strip())
    return False


def _rewrite_image_resource_url(
    raw_url: str, base_dir: str, package: _Package, missing_paths: list[str]
) -> str | None:
    if not raw_url or raw_url.startswith("#"):
        return None
    parsed = urlparse(raw_url)
    if parsed.scheme or raw_url.startswith("//"):
        return None
    resolved = _resolve_epub_path(base_dir, parsed.path or "")
    if resolved is None:
        return None
    key = _ensure_asset_entry(resolved, package, missing_paths)
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


def _rewrite_srcset(value: str, base_dir: str, package: _Package, missing_paths: list[str]) -> str:
    parts: list[str] = []
    for url, descriptor in srcset_candidates(value):
        rewritten = _rewrite_image_resource_url(url, base_dir, package, missing_paths)
        if rewritten:
            parts.append(f"{rewritten} {descriptor}" if descriptor else rewritten)
    return ", ".join(parts)


def srcset_candidates(value: str) -> Iterator[tuple[str, str]]:
    """Read HTML image candidates; commas inside a URL are not separators."""
    whitespace = "\t\n\f\r "
    position = 0
    while position < len(value):
        while position < len(value) and value[position] in whitespace + ",":
            position += 1
        if position == len(value):
            break
        start = position
        while position < len(value) and value[position] not in whitespace:
            position += 1
        url = value[start:position]
        if url.endswith(","):
            url = url.rstrip(",")
            if url:
                yield url, ""
            continue

        while position < len(value) and value[position] in whitespace:
            position += 1
        start = position
        parentheses = 0
        while position < len(value):
            char = value[position]
            if char == "(":
                parentheses += 1
            elif char == ")" and parentheses:
                parentheses -= 1
            elif char == "," and not parentheses:
                break
            position += 1
        descriptor = value[start:position].strip()
        if position < len(value):
            position += 1
        if descriptor and not _valid_srcset_descriptor(descriptor):
            continue
        yield url, descriptor


def _valid_srcset_descriptor(value: str) -> bool:
    if re.fullmatch(r"[0-9]+w", value):
        try:
            return int(value[:-1]) > 0
        except ValueError:
            return False
    if not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?x", value):
        return False
    try:
        density = float(value[:-1])
    except ValueError:
        return False
    return math.isfinite(density) and density > 0


def _ensure_asset_entry(epub_path: str, package: _Package, missing_paths: list[str]) -> str | None:
    """Record one referenced package image, deriving its stable asset key once."""
    if epub_path in package.asset_key_map:
        return package.asset_key_map[epub_path]
    manifest_item = next(
        (item for item in package.manifest.values() if item.href == epub_path), None
    )
    if manifest_item is None:
        if posixpath.splitext(epub_path)[1].lower() in _IMAGE_EXTENSIONS:
            if epub_path.lower().endswith(".svg"):
                raise _InvalidEpub(
                    f"Referenced EPUB image asset missing from OPF manifest: {epub_path}"
                )
            missing_paths.append(epub_path)
        return None
    if manifest_item.media_type not in SUPPORTED_IMAGE_TYPES:
        return None
    try:
        info = package.zf.getinfo(epub_path)
    except KeyError as exc:
        if manifest_item.media_type == _SVG_IMAGE_TYPE:
            raise _InvalidEpub(
                f"Referenced EPUB image asset missing from archive: {epub_path}"
            ) from exc
        missing_paths.append(epub_path)
        return None

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
        raise _InvalidEpub(f"Referenced SVG asset cannot be parsed: {epub_path}") from exc
    if root is None or local_name(root.tag) != "svg":
        raise _InvalidEpub(f"Referenced SVG asset is not an SVG document: {epub_path}")
    sanitize_svg_asset_element(root)
    ET.ElementTree(root).write(destination, encoding="utf-8", xml_declaration=True)


def _materialize_toc(
    zf: zipfile.ZipFile,
    opf: ET.Element,
    manifest: dict[str, _ManifestItem],
    href_to_frag_idx: dict[str, int],
    media_id: UUID,
    opf_path: str,
) -> list[EpubStructureTocNode]:
    """Select declared contents; compose independently authored auxiliary roles.

    A lone declared NAV or NCX is authoritative. With both, package versions
    1/2 choose NCX and version 3 chooses NAV. An unknown dual-source version
    has no proved authority. Invalid declarations never select another source.
    """
    manifest_elements = opf.findall(".//opf:manifest/opf:item", _NS)
    nav_elements = [
        item for item in manifest_elements if "nav" in item.get("properties", "").split()
    ]
    if len(nav_elements) > 1:
        raise _InvalidEpub("EPUB declares multiple navigation documents")
    spines = opf.findall(".//opf:spine", _NS)
    if len(spines) > 1:
        raise _InvalidEpub("EPUB declares multiple spines")
    ncx_id = spines[0].get("toc") if spines else None
    if ncx_id is not None:
        ncx_elements = [item for item in manifest_elements if item.get("id") == ncx_id]
        if len(ncx_elements) != 1 or ncx_elements[0].get("media-type") != _NCX_MEDIA_TYPE:
            raise _InvalidEpub("EPUB spine names an invalid NCX declaration")
    else:
        ncx_elements = [
            item for item in manifest_elements if item.get("media-type") == _NCX_MEDIA_TYPE
        ]
        if len(ncx_elements) > 1:
            raise _InvalidEpub("EPUB has no unique declared NCX")

    nav_href: str | None = None
    ncx_href: str | None = None
    for kind, elements in (("NAV", nav_elements), ("NCX", ncx_elements)):
        if not elements:
            continue
        declaration = elements[0]
        item_id = declaration.get("id")
        item = manifest.get(item_id) if item_id is not None else None
        if (
            item is None
            or sum(element.get("id") == item_id for element in manifest_elements) != 1
            or (kind == "NAV" and item.media_type not in _READABLE_MEDIA_TYPES)
        ):
            raise _InvalidEpub(f"EPUB has an invalid {kind} manifest declaration")
        if kind == "NAV":
            nav_href = item.href
        else:
            ncx_href = item.href

    major = opf.get("version", "").split(".", 1)[0]
    if nav_href is not None and ncx_href is not None and major not in {"1", "2", "3"}:
        raise _InvalidEpub("EPUB dual navigation has no declared contents authority")
    nav_contents = nav_href is not None and (ncx_href is None or major == "3")
    nodes: list[EpubStructureTocNode] = []
    auxiliary_nodes: dict[tuple[str, str, str, str, str | None], EpubStructureTocNode] = {}
    node_ids: set[str] = set()

    if nav_href is not None:
        nav_tree = _parse_xml_entry(zf, nav_href, decoded_bytes_limit=EPUB_XHTML_MAX_DECODED_BYTES)
        if nav_tree is None or not _is_tag(nav_tree, "html"):
            raise _InvalidEpub("Declared EPUB navigation document cannot be parsed")
        lists: dict[str, ET.Element] = {}
        for element in nav_tree.iter():
            if not _is_tag(element, "nav"):
                continue
            tokens = (
                element.get("{http://www.idpf.org/2007/ops}type", "") or element.get("type", "")
            ).split()
            roles = {
                "page_list" if token in {"page-list", "pagebreak"} else token
                for token in tokens
                if token in {"toc", "landmarks", "page-list", "pagebreak"}
            }
            if not roles:
                continue
            if len(roles) != 1:
                raise _InvalidEpub("EPUB navigation list declares conflicting roles")
            nav_type = roles.pop()
            if nav_type in lists:
                raise _InvalidEpub(f"EPUB declares multiple {nav_type} navigation lists")
            lists[nav_type] = element
        if nav_contents and "toc" not in lists:
            raise _InvalidEpub("Declared EPUB navigation has no contents list")
        for nav_type, element in lists.items():
            if nav_type == "toc" and not nav_contents:
                continue
            before_count = len(nodes)
            _walk_toc(
                _TocWalk(
                    _nav_entries,
                    nav_type,
                    nav_href,
                    href_to_frag_idx,
                    media_id,
                    nodes,
                    auxiliary_nodes,
                    node_ids,
                ),
                element,
            )
            if nav_type == "toc" and len(nodes) == before_count:
                raise _InvalidEpub("Declared EPUB navigation has empty contents")

    if ncx_href is not None:
        ncx_tree = _parse_xml_entry(zf, ncx_href, decoded_bytes_limit=EPUB_XHTML_MAX_DECODED_BYTES)
        if ncx_tree is None or not _is_tag(ncx_tree, "ncx"):
            raise _InvalidEpub("Declared EPUB NCX cannot be parsed")
        for element_name, nav_type in (("navMap", "toc"), ("pageList", "page_list")):
            elements = [element for element in ncx_tree if _is_tag(element, element_name)]
            if len(elements) > 1:
                raise _InvalidEpub(f"EPUB NCX declares multiple {element_name} lists")
            if nav_type == "toc":
                if nav_contents:
                    continue
                if not elements:
                    raise _InvalidEpub("Declared EPUB NCX has no contents map")
            if elements:
                before_count = len(nodes)
                _walk_toc(
                    _TocWalk(
                        _ncx_entries,
                        nav_type,
                        ncx_href,
                        href_to_frag_idx,
                        media_id,
                        nodes,
                        auxiliary_nodes,
                        node_ids,
                    ),
                    elements[0],
                )
                if nav_type == "toc" and len(nodes) == before_count:
                    raise _InvalidEpub("Declared EPUB NCX has empty contents")

    for guide in opf.findall(".//opf:guide", _NS):
        _walk_toc(
            _TocWalk(
                _guide_entries,
                "landmarks",
                opf_path,
                href_to_frag_idx,
                media_id,
                nodes,
                auxiliary_nodes,
                node_ids,
            ),
            guide,
        )
    return nodes


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
        role = ""
        for child in li:
            if _is_tag(child, "a") or _is_tag(child, "span"):
                label = _text_content(child).strip()
                href = child.get("href") if _is_tag(child, "a") else None
                nav_id = child.get("id")
                role = " ".join(
                    sorted(
                        (
                            child.get("{http://www.idpf.org/2007/ops}type", "")
                            or child.get("type", "")
                        ).split()
                    )
                )
                break
        if not label:
            raise _InvalidEpub("EPUB navigation entry has no direct label")
        yield li, label, href, nav_id, role


def _ncx_entries(parent: ET.Element) -> Iterator[_TocEntry]:
    """Yield directly labelled NCX contents or page entries."""
    for nav_point in parent:
        if not (_is_tag(nav_point, "navPoint") or _is_tag(nav_point, "pageTarget")):
            continue
        nav_label = next((child for child in nav_point if _is_tag(child, "navLabel")), None)
        label_element = (
            next((child for child in nav_label if _is_tag(child, "text")), None)
            if nav_label is not None
            else None
        )
        label = _text_content(label_element).strip() if label_element is not None else ""
        content = next((child for child in nav_point if _is_tag(child, "content")), None)
        href = content.get("src") if content is not None else None
        if not label or not href:
            raise _InvalidEpub("EPUB NCX entry has no direct label or target")
        yield nav_point, label, href, nav_point.get("id"), nav_point.get("type", "")


def _guide_entries(parent: ET.Element) -> Iterator[_TocEntry]:
    for reference in parent:
        if not _is_tag(reference, "reference"):
            continue
        role = reference.get("type", "").strip()
        href = reference.get("href")
        if not role or not href:
            raise _InvalidEpub("EPUB guide has an invalid reference")
        label = reference.get("title", "").strip()
        yield reference, label, href, f"guide-{role}-{href}", role


def _walk_toc(
    walk: _TocWalk,
    parent: ET.Element,
    *,
    parent_path: str | None = None,
    depth: int = 0,
    prefix: str = "",
) -> None:
    """Preserve authored order/hierarchy; coalesce exact auxiliary identities."""
    start = (
        sum(node.nav_type == walk.nav_type and node.parent_node_id is None for node in walk.nodes)
        if parent_path is None
        else 0
    )
    for ordinal, (element, label, href, nav_id, role) in enumerate(
        walk.entries(parent), start=start
    ):
        canonical_href, fragment_idx = _resolve_nav_target(
            href, walk.base_href, walk.href_to_frag_idx
        )
        raw_id = _node_id_token(nav_id, href, label)
        if walk.nav_type != "toc" and role:
            raw_id = f"{_slug(role)}-{raw_id}"
        node_path = f"{parent_path}/{raw_id}" if parent_path else f"{walk.nav_type}/{raw_id}"
        order_key = f"{prefix}{ordinal:04d}" if not prefix else f"{prefix}.{ordinal:04d}"
        parent_id = _enforce_id_length(walk.media_id, parent_path) if parent_path else None
        auxiliary_key = (
            (walk.nav_type, role, canonical_href, label, parent_id)
            if walk.nav_type != "toc" and canonical_href is not None
            else None
        )
        existing = walk.auxiliary_nodes.get(auxiliary_key) if auxiliary_key is not None else None
        if existing is not None:
            _walk_toc(
                walk,
                element,
                parent_path=existing.node_id,
                depth=existing.depth + 1,
                prefix=existing.order_key,
            )
            continue
        node_id = _enforce_id_length(walk.media_id, node_path)
        suffix = 0
        while node_id in walk.node_ids:
            suffix += 1
            node_path = (
                f"{parent_path}/{raw_id}~{suffix}"
                if parent_path
                else f"{walk.nav_type}/{raw_id}~{suffix}"
            )
            node_id = _enforce_id_length(walk.media_id, node_path)
        walk.node_ids.add(node_id)
        node = EpubStructureTocNode(
            nav_type=walk.nav_type,
            node_id=node_id,
            parent_node_id=parent_id,
            label=label[:512],
            href=canonical_href,
            fragment_idx=fragment_idx,
            depth=depth,
            order_key=order_key,
        )
        walk.nodes.append(node)
        if auxiliary_key is not None:
            walk.auxiliary_nodes[auxiliary_key] = node
        _walk_toc(walk, element, parent_path=node_path, depth=depth + 1, prefix=order_key)


def _resolve_nav_target(
    href: str | None, base_href: str, href_to_frag_idx: dict[str, int]
) -> tuple[str | None, int | None]:
    if not href:
        return None, None
    parsed = urlparse(href)
    if parsed.scheme:
        return href, None
    if parsed.netloc:
        return None, None
    resolved_path = (
        _resolve_epub_path(posixpath.dirname(base_href), parsed.path) if parsed.path else base_href
    )
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


def _enforce_id_length(media_id: UUID, node_id: str) -> str:
    return node_id if len(node_id) <= 255 else str(uuid5(media_id, node_id))


def _text_content(element: ET.Element) -> str:
    parts = [element.text or ""]
    for child in element:
        parts.append(_text_content(child))
        parts.append(child.tail or "")
    return "".join(parts)
