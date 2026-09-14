"""Pure construction and verification helpers for offline-reading schema-two ZIPs."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
import struct
import zipfile
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO
from urllib.parse import unquote, urlsplit
from uuid import UUID

import lxml.etree as etree
from pydantic import ValidationError

from nexus.config import ReaderPublicationLimits
from nexus.schemas.offline_reading_package import (
    OFFLINE_READING_MAX_ARCHIVE_BYTES,
    OFFLINE_READING_MAX_EXPANDED_BYTES,
    OFFLINE_READING_MAX_MANIFEST_JSON_BYTES,
    OFFLINE_READING_READER_CONTRACT_VERSION,
    OFFLINE_READING_URL_ATTRIBUTES,
    OfflineReadingEntry,
    OfflineReadingManifest,
    parse_offline_reading_manifest,
    parse_strict_json_object,
)
from nexus.schemas.offline_reading_preparation import (
    OFFLINE_ARCHIVE_SCHEMA_VERSION,
    OFFLINE_PACKAGE_FAILURE_CODES,
    OfflinePackageFailureReason,
)
from nexus.schemas.reader import ReaderEpubTarget
from nexus.schemas.reader_publication import (
    PUBLICATION_DESCRIPTOR,
    READER_PUBLICATION_MOUNT_NODES,
    ReaderPublicationCapturedAsset,
    ReaderPublicationDescriptor,
    ReaderPublicationIndexPage,
    ReaderPublicationLocalFragment,
    ReaderPublicationMemberRef,
    ReaderPublicationPdfDescriptor,
    ReaderPublicationRenderElement,
    ReaderPublicationRenderNode,
    ReaderPublicationSourceRange,
    ReaderPublicationUnitBody,
)
from nexus.services.media_document_metrics import (
    canonical_word_boundary_ordinal,
    is_canonical_word_separator,
)
from nexus.services.reader_publication_render import (
    canonical_element_ids_from_render_nodes,
    canonical_text_from_render_nodes,
)
from nexus.services.svg_paint import project_svg_paint

OFFLINE_READING_REVISION_DOMAIN = b"NexusOfflineReadingRevision\0"
OFFLINE_READING_ZIP_MEDIA_TYPE = "application/vnd.nexus.offline-reading+zip"
OFFLINE_READING_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
OFFLINE_READING_ZIP_COMPRESSION_LEVEL = 9
OFFLINE_READING_ZIP_MODE = stat.S_IFREG | 0o644

_ASSET_MEDIA_TYPES = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".otf": "font/otf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
_SVG_FORBIDDEN_TAGS = frozenset(
    {
        "animate",
        "animatemotion",
        "animatetransform",
        "discard",
        "foreignobject",
        "iframe",
        "script",
        "set",
        "style",
    }
)
_SVG_URL_ATTRIBUTES = frozenset({"href", "src"})
_REMOTE_OR_EXECUTABLE_URL = re.compile(
    r"(?:https?|ftp|file|data|javascript|vbscript):|//",
    re.IGNORECASE,
)


class OfflineReadingPackageError(ValueError):
    """The package is not one exact, self-contained retained reading projection.

    The reason is the preparation job's recorded failure classification. It
    defaults to `Integrity` because that is what this class means: the retained
    publication does not verify. Raise sites that detect a different permanent
    condition name it.
    """

    def __init__(self, message: str, *, reason: OfflinePackageFailureReason = "Integrity") -> None:
        super().__init__(message)
        self.reason = reason
        self.error_code = OFFLINE_PACKAGE_FAILURE_CODES[reason]


@dataclass(frozen=True, slots=True)
class VerifiedOfflineReadingPackage:
    manifest: OfflineReadingManifest
    reader_document: ReaderPublicationDescriptor
    expanded_length: int


def build_offline_reading_manifest_from_entries(
    *,
    media_id: UUID | str,
    media_kind: str,
    title: str,
    reader_generation: int,
    entries: Iterable[OfflineReadingEntry],
) -> OfflineReadingManifest:
    """Build the sole manifest from already-digested, immutable member files."""
    ordered = sorted(entries, key=lambda entry: entry.path.encode("utf-8"))
    revision_key = compute_reader_revision_key(reader_generation, ordered)
    return OfflineReadingManifest.model_validate(
        {
            "packageSchemaVersion": OFFLINE_ARCHIVE_SCHEMA_VERSION,
            "readerContractVersion": OFFLINE_READING_READER_CONTRACT_VERSION,
            "minimumReaderBundleVersion": OFFLINE_ARCHIVE_SCHEMA_VERSION,
            "mediaId": str(media_id),
            "mediaKind": media_kind,
            "title": title,
            "readerGeneration": reader_generation,
            "readerRevisionKey": revision_key,
            "entries": ordered,
        }
    )


def compute_reader_revision_key(
    reader_generation: int,
    entries: Sequence[OfflineReadingEntry],
) -> str:
    """Compute the cross-language revision identity with explicit-width fields."""
    if type(reader_generation) is not int or not 1 <= reader_generation <= (1 << 64) - 1:
        raise OfflineReadingPackageError("reader generation is outside UINT64")
    ordered = sorted(entries, key=lambda entry: entry.path.encode("utf-8"))
    paths = [entry.path for entry in ordered]
    if len(paths) != len(set(paths)):
        raise OfflineReadingPackageError("revision entries contain duplicate paths")

    digest = hashlib.sha256()
    digest.update(OFFLINE_READING_REVISION_DOMAIN)
    digest.update(struct.pack(">Q", reader_generation))
    for entry in ordered:
        path_bytes = entry.path.encode("utf-8")
        media_type_bytes = entry.media_type.encode("ascii")
        digest.update(struct.pack(">I", len(path_bytes)))
        digest.update(path_bytes)
        digest.update(bytes.fromhex(entry.sha256))
        digest.update(struct.pack(">Q", entry.size_bytes))
        digest.update(struct.pack(">H", len(media_type_bytes)))
        digest.update(media_type_bytes)
    return digest.hexdigest()


def serialize_offline_reading_manifest(manifest: OfflineReadingManifest) -> bytes:
    """Emit the one deterministic manifest representation."""
    return json.dumps(
        manifest.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def verify_offline_reading_package(
    manifest: OfflineReadingManifest,
    entry_bodies: Mapping[str, bytes],
    *,
    publication_limits: ReaderPublicationLimits | None = None,
) -> VerifiedOfflineReadingPackage:
    """Verify manifest/member integrity and the retained publication's identity."""
    try:
        manifest = OfflineReadingManifest.model_validate(
            manifest.model_dump(mode="json", by_alias=True)
        )
    except (AttributeError, ValidationError) as exc:
        raise OfflineReadingPackageError("manifest violates the strict schema") from exc
    declared_paths = tuple(entry.path for entry in manifest.entries)
    actual_paths = tuple(entry_bodies)
    if set(declared_paths) != set(actual_paths) or len(actual_paths) != len(set(actual_paths)):
        raise OfflineReadingPackageError(
            "ZIP members must be exactly the entries declared by the manifest"
        )

    for entry in manifest.entries:
        body = entry_bodies[entry.path]
        if not isinstance(body, bytes):
            raise OfflineReadingPackageError(f"member {entry.path!r} must be bytes")
        if len(body) != entry.size_bytes:
            raise OfflineReadingPackageError(f"member {entry.path!r} size does not match manifest")
        if hashlib.sha256(body).hexdigest() != entry.sha256:
            raise OfflineReadingPackageError(
                f"member {entry.path!r} digest does not match manifest"
            )

    expected_revision = compute_reader_revision_key(
        manifest.reader_generation,
        manifest.entries,
    )
    if manifest.reader_revision_key != expected_revision:
        raise OfflineReadingPackageError("reader revision key does not match declared entries")

    descriptor = _verify_publication_members(
        manifest,
        read_body=lambda entry: entry_bodies[entry.path],
        verify_asset=lambda entry: _verify_asset_signature(
            entry.path, entry.media_type, entry_bodies[entry.path]
        ),
        limits=publication_limits,
    )
    return VerifiedOfflineReadingPackage(
        manifest=manifest,
        reader_document=descriptor,
        expanded_length=sum(entry.size_bytes for entry in manifest.entries),
    )


def assemble_offline_reading_zip_from_files(
    manifest: OfflineReadingManifest,
    members: Mapping[str, Path],
    path: str | os.PathLike[str],
    *,
    publication_limits: ReaderPublicationLimits | None = None,
) -> int:
    """Verify staged files and stream one deterministic ZIP without retaining bodies."""
    verified = verify_offline_reading_package_files(
        manifest, members, publication_limits=publication_limits
    )
    with open(path, "w+b") as output:
        _write_zip_from_files(verified.manifest, members, output)
        output.flush()
        os.fsync(output.fileno())
        archive_size = output.tell()
    if archive_size > OFFLINE_READING_MAX_ARCHIVE_BYTES:
        raise OfflineReadingPackageError(
            "compressed package exceeds the archive byte bound", reason="TooLarge"
        )
    return archive_size


def verify_offline_reading_package_files(
    manifest: OfflineReadingManifest,
    members: Mapping[str, Path],
    *,
    publication_limits: ReaderPublicationLimits | None = None,
) -> VerifiedOfflineReadingPackage:
    """Verify staged package files with bounded per-member memory."""
    try:
        manifest = OfflineReadingManifest.model_validate(
            manifest.model_dump(mode="json", by_alias=True)
        )
    except (AttributeError, ValidationError) as exc:
        raise OfflineReadingPackageError("manifest violates the strict schema") from exc
    declared_paths = tuple(entry.path for entry in manifest.entries)
    if set(declared_paths) != set(members) or len(members) != len(set(members)):
        raise OfflineReadingPackageError(
            "staged members must be exactly the entries declared by the manifest"
        )
    for entry in manifest.entries:
        source = members[entry.path]
        digest = hashlib.sha256()
        length = 0
        with source.open("rb") as member_file:
            for chunk in iter(lambda: member_file.read(1024 * 1024), b""):
                length += len(chunk)
                digest.update(chunk)
        if length != entry.size_bytes:
            raise OfflineReadingPackageError(f"member {entry.path!r} size does not match manifest")
        if digest.hexdigest() != entry.sha256:
            raise OfflineReadingPackageError(
                f"member {entry.path!r} digest does not match manifest"
            )

    expected_revision = compute_reader_revision_key(
        manifest.reader_generation,
        manifest.entries,
    )
    if manifest.reader_revision_key != expected_revision:
        raise OfflineReadingPackageError("reader revision key does not match declared entries")
    descriptor = _verify_publication_members(
        manifest,
        read_body=lambda entry: members[entry.path].read_bytes(),
        verify_asset=lambda entry: _verify_asset_file_signature(
            entry.path, entry.media_type, members[entry.path]
        ),
        limits=publication_limits,
    )
    return VerifiedOfflineReadingPackage(
        manifest=manifest,
        reader_document=descriptor,
        expanded_length=sum(entry.size_bytes for entry in manifest.entries),
    )


def verify_offline_reading_zip(
    payload: bytes, *, publication_limits: ReaderPublicationLimits | None = None
) -> VerifiedOfflineReadingPackage:
    """Verify exact ZIP grammar, manifest, entries, MIME, and publication identity."""
    if not isinstance(payload, bytes):
        raise OfflineReadingPackageError("offline-reading ZIP must be bytes")
    if len(payload) > OFFLINE_READING_MAX_ARCHIVE_BYTES:
        raise OfflineReadingPackageError(
            "compressed package exceeds the archive byte bound", reason="TooLarge"
        )

    try:
        with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
            if archive.comment:
                raise OfflineReadingPackageError("ZIP comments are forbidden")
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if not names or names[0] != "manifest.json":
                raise OfflineReadingPackageError("manifest.json must be the first ZIP member")
            if len(names) != len(set(names)):
                raise OfflineReadingPackageError("ZIP member paths must be unique")
            if sum(info.file_size for info in infos[1:]) > OFFLINE_READING_MAX_EXPANDED_BYTES:
                raise OfflineReadingPackageError(
                    "ZIP expanded bytes exceed their bound", reason="TooLarge"
                )
            if infos[0].file_size > OFFLINE_READING_MAX_MANIFEST_JSON_BYTES:
                raise OfflineReadingPackageError("manifest.json exceeds its byte bound")
            for info in infos:
                _verify_zip_info(info)

            manifest = parse_offline_reading_manifest(archive.read(infos[0]))
            expected_names = ["manifest.json", *(entry.path for entry in manifest.entries)]
            if names != expected_names:
                raise OfflineReadingPackageError(
                    "ZIP order and membership must exactly match sorted manifest entries"
                )
            entry_bodies: dict[str, bytes] = {}
            for info, entry in zip(infos[1:], manifest.entries, strict=True):
                if info.file_size != entry.size_bytes:
                    raise OfflineReadingPackageError(
                        f"ZIP metadata size for {entry.path!r} does not match manifest"
                    )
                entry_bodies[entry.path] = archive.read(info)
    except OfflineReadingPackageError:
        raise
    except (OSError, RuntimeError, ValidationError, ValueError, zipfile.BadZipFile) as exc:
        raise OfflineReadingPackageError("invalid offline-reading ZIP") from exc

    verified = verify_offline_reading_package(
        manifest, entry_bodies, publication_limits=publication_limits
    )
    if _encode_zip(manifest, entry_bodies) != payload:
        raise OfflineReadingPackageError("ZIP bytes are not the deterministic representation")
    return verified


def _verify_publication_members(
    manifest: OfflineReadingManifest,
    *,
    read_body: Callable[[OfflineReadingEntry], bytes],
    verify_asset: Callable[[OfflineReadingEntry], None],
    limits: ReaderPublicationLimits | None,
) -> ReaderPublicationDescriptor:
    if limits is None:
        raise OfflineReadingPackageError("schema two requires explicit publication limits")
    entries = {entry.path: entry for entry in manifest.entries}
    visited = {"descriptor.json"}

    def member(ref: ReaderPublicationMemberRef, prefix: str) -> OfflineReadingEntry:
        entry = entries.get(ref.key)
        if (
            entry is None
            or not ref.key.startswith(prefix)
            or entry.size_bytes != ref.bytes
            or entry.sha256 != ref.sha256
        ):
            raise OfflineReadingPackageError("publication member reference does not match manifest")
        visited.add(ref.key)
        return entry

    def json_body(entry: OfflineReadingEntry, maximum: int) -> dict:
        if entry.media_type != "application/json" or entry.size_bytes > maximum:
            raise OfflineReadingPackageError("publication JSON exceeds its declared member bound")
        return parse_strict_json_object(read_body(entry), maximum_bytes=maximum, name=entry.path)

    try:
        descriptor = PUBLICATION_DESCRIPTOR.validate_python(
            json_body(entries["descriptor.json"], limits.descriptor_bytes)
        )
        if (
            descriptor.media_id != manifest.media_id
            or descriptor.reader_generation != manifest.reader_generation
            or descriptor.title != manifest.title
            or {"pdf": "Pdf", "epub": "Epub", "web_article": "WebArticle"}[descriptor.kind]
            != manifest.media_kind
        ):
            raise OfflineReadingPackageError("publication identity does not match manifest")
        if isinstance(descriptor, ReaderPublicationPdfDescriptor):
            document = member(descriptor.document_asset_ref, "assets/")
            if document.media_type != "application/pdf":
                raise OfflineReadingPackageError("publication document is not PDF")
            verify_asset(document)
        else:
            ordinal = 0
            previous_fragment: str | None = None
            previous_fragment_idx = -1
            previous_end = 0
            fragment_document_start = 0
            fragment_length = 0
            document_word_start = 0
            starts_in_word = False
            page_ref: ReaderPublicationMemberRef | None = descriptor.index_ref
            index_keys: set[str] = set()
            unit_keys: set[str] = set()
            unit_extents: dict[str, tuple[str, int, int, int]] = {}
            context_tables: dict[
                tuple[str, int], tuple[int, int, ReaderPublicationSourceRange | None]
            ] = {}
            context_cells: dict[tuple[str, int, int, int], tuple[int, int]] = {}
            caption_ranges = []
            section_ranges = []
            section_ids: dict[str, str] = {}
            declared_anchors: dict[tuple[str, str], tuple[str, int]] = {}
            authored_anchors: dict[tuple[str, str], str] = {}
            epub_targets: dict[str, ReaderEpubTarget] = {}
            navigation_targets: dict[str, ReaderEpubTarget] = {}
            embed_ids: set[UUID] = set()
            embed_keys: set[tuple[str, str]] = set()
            fragments: set[str] = set()
            while page_ref is not None:
                if page_ref.key in index_keys:
                    raise OfflineReadingPackageError("publication index contains a cycle")
                index_keys.add(page_ref.key)
                index = ReaderPublicationIndexPage.model_validate(
                    json_body(member(page_ref, "index/"), limits.index_bytes)
                )
                if index.table_metadata or index.toc:
                    raise OfflineReadingPackageError(
                        "display/context records appear in lookup chain"
                    )
                for anchor in index.anchors:
                    identity = (anchor.href_path, anchor.anchor_id)
                    if identity in declared_anchors:
                        raise OfflineReadingPackageError("publication repeats an authored anchor")
                    declared_anchors[identity] = (anchor.unit_key, anchor.offset_cp)
                for section in index.sections:
                    if section.section_id in section_ids:
                        raise OfflineReadingPackageError("publication repeats a navigation target")
                    section_ids[section.section_id] = hashlib.sha256(
                        section.model_dump_json().encode()
                    ).hexdigest()
                    section_ranges.append(
                        ReaderPublicationSourceRange(
                            unit_key=section.unit_key,
                            fragment_id=section.fragment_id,
                            start_cp=section.start_offset,
                            end_cp=section.end_offset
                            if section.end_offset is not None
                            else section.start_offset,
                        )
                    )
                if descriptor.kind == "epub":
                    for section in index.sections:
                        if section.href_path is None:
                            raise OfflineReadingPackageError("EPUB navigation has no source path")
                        navigation_targets.setdefault(
                            section.fragment_id,
                            ReaderEpubTarget(
                                section_id=section.section_id,
                                href_path=section.href_path,
                                anchor_id=section.anchor_id,
                            ),
                        )
                for position in index.units:
                    if position.member.key in unit_keys or position.ordinal != ordinal:
                        raise OfflineReadingPackageError("publication unit order is not complete")
                    unit_keys.add(position.member.key)
                    if ordinal == 0 and position.member != descriptor.first_unit_ref:
                        raise OfflineReadingPackageError("publication first unit reference differs")
                    ordinal += 1
                    new_fragment = position.fragment_id != previous_fragment
                    if not new_fragment:
                        contiguous = (
                            position.fragment_idx == previous_fragment_idx
                            and position.start_cp == previous_end
                        )
                    else:
                        if position.fragment_id in fragments:
                            raise OfflineReadingPackageError("publication repeats source fragment")
                        fragments.add(position.fragment_id)
                        if previous_fragment is not None:
                            if previous_end != fragment_length:
                                raise OfflineReadingPackageError("publication fragment ends early")
                            fragment_document_start += fragment_length
                        contiguous = (
                            position.fragment_idx > previous_fragment_idx and position.start_cp == 0
                        )
                    if not contiguous:
                        raise OfflineReadingPackageError("publication canonical extents have a gap")
                    previous_fragment = position.fragment_id
                    previous_fragment_idx = position.fragment_idx
                    previous_end = position.end_cp
                    unit = ReaderPublicationUnitBody.model_validate(
                        json_body(member(position.member, "units/"), limits.unit_bytes)
                    )
                    if descriptor.kind == "epub":
                        if unit.epub_target is None:
                            raise OfflineReadingPackageError("EPUB unit has no retained target")
                        previous_target = epub_targets.setdefault(
                            unit.fragment_id, unit.epub_target
                        )
                        if previous_target != unit.epub_target:
                            raise OfflineReadingPackageError("EPUB fragment default target changed")
                    elif unit.epub_target is not None:
                        raise OfflineReadingPackageError("Non-EPUB unit declares an EPUB target")
                    for source in unit.document_embeds:
                        identity = (unit.fragment_id, source.occurrence_key)
                        if source.id in embed_ids or identity in embed_keys:
                            raise OfflineReadingPackageError("publication repeats embed source")
                        embed_ids.add(source.id)
                        embed_keys.add(identity)
                    if new_fragment:
                        starts_in_word = False
                    if (
                        unit.document_word_start != document_word_start
                        or unit.starts_in_word != starts_in_word
                    ):
                        raise OfflineReadingPackageError("publication activity coordinates differ")
                    document_word_start += canonical_word_boundary_ordinal(
                        unit.canonical_text, len(unit.canonical_text), starts_in_word=starts_in_word
                    )
                    if unit.canonical_text:
                        starts_in_word = not is_canonical_word_separator(unit.canonical_text[-1])
                    if unit.fragment_document_start_cp != fragment_document_start:
                        raise OfflineReadingPackageError("publication document offset differs")
                    if new_fragment:
                        fragment_length = unit.fragment_length_cp
                    elif unit.fragment_length_cp != fragment_length:
                        raise OfflineReadingPackageError("publication fragment length differs")
                    if any(
                        getattr(unit, field) != getattr(position, field)
                        for field in ("fragment_id", "fragment_idx", "start_cp", "end_cp")
                    ):
                        raise OfflineReadingPackageError("publication index and unit extent differ")
                    if len(unit.canonical_text) > limits.unit_codepoints:
                        raise OfflineReadingPackageError("publication unit exceeds its text bound")
                    unit_extents[position.member.key] = (
                        unit.fragment_id,
                        unit.start_cp,
                        unit.end_cp,
                        unit.fragment_length_cp,
                    )
                    for table in unit.table_contexts:
                        table_id = (unit.fragment_id, table.table_ordinal)
                        table_shape = (table.row_count, table.column_count, table.caption)
                        if context_tables.setdefault(table_id, table_shape) != table_shape:
                            raise OfflineReadingPackageError(
                                "table continuation changed its source grid"
                            )
                        if table.caption is not None:
                            caption_ranges.append((table.caption, unit.fragment_id))
                        for cell in table.cells:
                            cell_id = (*table_id, cell.row, cell.column)
                            spans = (cell.row_span, cell.column_span)
                            if context_cells.setdefault(cell_id, spans) != spans:
                                raise OfflineReadingPackageError(
                                    "table continuation changed its source cell"
                                )
                    expected_text = unit.canonical_text[
                        unit.render_start_cp - unit.start_cp : unit.render_end_cp - unit.start_cp
                    ]
                    if canonical_text_from_render_nodes(unit.render_nodes) != expected_text:
                        raise OfflineReadingPackageError("publication tree changed canonical text")
                    assets: set[str] = set()
                    unavailable: set[str] = set()
                    for asset in unit.assets:
                        if isinstance(asset, ReaderPublicationCapturedAsset):
                            entry = member(asset.member, "assets/")
                            if entry.media_type != asset.media_type or entry.path in assets:
                                raise OfflineReadingPackageError(
                                    "publication asset identity differs"
                                )
                            assets.add(entry.path)
                            verify_asset(entry)
                        else:
                            if asset.source_url in unavailable:
                                raise OfflineReadingPackageError("publication asset repeats")
                            unavailable.add(asset.source_url)
                    _verify_publication_nodes(unit.render_nodes, assets, unavailable, limits)
                    if unit.epub_target is not None:
                        for anchor_id in canonical_element_ids_from_render_nodes(unit.render_nodes):
                            authored_anchors.setdefault(
                                (unit.epub_target.href_path, anchor_id), position.member.key
                            )

                page_ref = index.next_ref
            # Original canonical offsets belong to the source publisher. A
            # cropped tree trims separators and cannot independently reproduce
            # them. Verify the first visible original occurrence and its extent.
            if {
                identity: value[0] for identity, value in declared_anchors.items()
            } != authored_anchors:
                raise OfflineReadingPackageError(
                    "publication anchor index differs from authored source"
                )
            for key, offset in declared_anchors.values():
                extent = unit_extents[key]
                if not extent[1] <= offset <= extent[2]:
                    raise OfflineReadingPackageError("publication anchor exceeds its source unit")
            if epub_targets != navigation_targets:
                raise OfflineReadingPackageError("EPUB unit target differs from navigation")
            if ordinal != descriptor.unit_count:
                raise OfflineReadingPackageError("publication unit count differs")
            if (
                previous_end != fragment_length
                or fragment_document_start + fragment_length != descriptor.canonical_length
            ):
                raise OfflineReadingPackageError("publication canonical document length differs")

            def validate_source_range(
                source: ReaderPublicationSourceRange, fragment_id: str
            ) -> None:
                target = unit_extents.get(source.unit_key)
                if (
                    target is None
                    or source.fragment_id != fragment_id
                    or target[0] != fragment_id
                    or not target[1] <= source.start_cp <= target[2]
                    or source.end_cp > target[3]
                ):
                    raise OfflineReadingPackageError("table source range is not in its fragment")

            for source in section_ranges:
                validate_source_range(source, source.fragment_id)
            for source, fragment_id in caption_ranges:
                validate_source_range(source, fragment_id)
            contents_ref = descriptor.contents_ref
            contents_kind: str | None = None
            displayed_sections: set[str] = set()
            toc_ids: set[str] = set()
            while contents_ref is not None:
                if contents_ref.key in index_keys:
                    raise OfflineReadingPackageError("contents chain contains a cycle")
                index_keys.add(contents_ref.key)
                contents = ReaderPublicationIndexPage.model_validate(
                    json_body(member(contents_ref, "index/"), limits.index_bytes)
                )
                if (
                    contents.units
                    or contents.anchors
                    or contents.table_metadata
                    or contents.landmarks
                    or contents.page_list
                ):
                    raise OfflineReadingPackageError("contents contains non-display records")
                kind = "toc" if contents.toc else "sections"
                if not (contents.toc or contents.sections) or (contents.toc and contents.sections):
                    raise OfflineReadingPackageError(
                        "contents must have one nonempty display projection"
                    )
                if contents_kind is not None and kind != contents_kind:
                    raise OfflineReadingPackageError(
                        "contents changes its primary display projection"
                    )
                contents_kind = kind
                for section in contents.sections:
                    digest = hashlib.sha256(section.model_dump_json().encode()).hexdigest()
                    if (
                        section.section_id in displayed_sections
                        or section_ids.get(section.section_id) != digest
                    ):
                        raise OfflineReadingPackageError(
                            "contents section differs from retained lookup"
                        )
                    displayed_sections.add(section.section_id)
                for node in contents.toc:
                    if node.id in toc_ids or (
                        node.parent_id is not None and node.parent_id not in toc_ids
                    ):
                        raise OfflineReadingPackageError("contents hierarchy is not ordered")
                    if node.section_id is not None and node.section_id not in section_ids:
                        raise OfflineReadingPackageError("contents target is not retained")
                    toc_ids.add(node.id)
                contents_ref = contents.next_ref
            if contents_kind != "toc" and displayed_sections != section_ids.keys():
                raise OfflineReadingPackageError("contents omits retained section fallback")
            # This verifier runs at the package preparation owner. These scalar
            # source maps are linear in source cells, not expanded header pairs.
            metadata_tables: set[tuple[str, int]] = set()
            metadata_cells: set[tuple[str, int, int, int]] = set()
            explicit_targets: set[tuple[str, int, int, int]] = set()
            current_table = None
            current_cell = None
            current_cell_explicit = False
            current_targets: set[tuple[int, int]] = set()
            last_column_group_end = 0
            cells_started = False
            page_ref = descriptor.table_metadata_ref
            while page_ref is not None:
                if page_ref.key in index_keys:
                    raise OfflineReadingPackageError("table metadata contains a cycle")
                index_keys.add(page_ref.key)
                index = ReaderPublicationIndexPage.model_validate(
                    json_body(member(page_ref, "index/"), limits.index_bytes)
                )
                if not index.table_metadata:
                    raise OfflineReadingPackageError("table metadata page is empty")
                for record in index.table_metadata:
                    identity = (record.fragment_id, record.table_ordinal)
                    if record.kind == "Table":
                        if identity in metadata_tables or context_tables.get(identity) != (
                            record.row_count,
                            record.column_count,
                            record.caption,
                        ):
                            raise OfflineReadingPackageError(
                                "table metadata differs from visible source"
                            )
                        metadata_tables.add(identity)
                        current_table, current_cell = identity, None
                        current_cell_explicit = False
                        last_column_group_end, cells_started = 0, False
                        if record.caption is not None:
                            validate_source_range(record.caption, record.fragment_id)
                        continue
                    if identity != current_table:
                        raise OfflineReadingPackageError("table metadata left its source table")
                    row_count, column_count, _caption = context_tables[identity]
                    if record.kind == "ColumnGroup":
                        if (
                            cells_started
                            or not last_column_group_end
                            <= record.start
                            < record.end
                            <= column_count
                        ):
                            raise OfflineReadingPackageError(
                                "table column groups are not ordered disjoint intervals"
                            )
                        last_column_group_end = record.end
                    elif record.kind == "Cell":
                        cells_started = True
                        current_cell = (*identity, record.row, record.column)
                        if current_cell in metadata_cells or context_cells.get(current_cell) != (
                            record.row_span,
                            record.column_span,
                        ):
                            raise OfflineReadingPackageError(
                                "table metadata cell differs from visible source"
                            )
                        if (
                            record.row + record.row_span > row_count
                            or record.column + record.column_span > column_count
                        ):
                            raise OfflineReadingPackageError(
                                "table metadata cell exceeds its source grid"
                            )
                        validate_source_range(record.range, record.fragment_id)
                        metadata_cells.add(current_cell)
                        current_cell_explicit = record.explicit_headers
                        current_targets = set()
                    else:
                        if (
                            current_cell != (*identity, record.row, record.column)
                            or not current_cell_explicit
                        ):
                            raise OfflineReadingPackageError("explicit header left its source cell")
                        target = (record.target_row, record.target_column)
                        if target in current_targets or target == (record.row, record.column):
                            raise OfflineReadingPackageError(
                                "explicit headers repeat or reference their owner"
                            )
                        current_targets.add(target)
                        explicit_targets.add((*identity, *target))
                page_ref = index.next_ref
            if (
                metadata_tables != context_tables.keys()
                or metadata_cells != context_cells.keys()
                or not explicit_targets <= metadata_cells
            ):
                raise OfflineReadingPackageError("table metadata source closure differs")
        if visited != set(entries):
            raise OfflineReadingPackageError("package contains an unreachable publication member")
        return descriptor
    except (ValidationError, ValueError) as exc:
        if isinstance(exc, OfflineReadingPackageError):
            raise
        raise OfflineReadingPackageError("invalid retained publication member") from exc


def _verify_publication_nodes(
    nodes: tuple[ReaderPublicationRenderNode, ...],
    assets: set[str],
    unavailable: set[str],
    limits: ReaderPublicationLimits,
) -> None:
    if READER_PUBLICATION_MOUNT_NODES + len(nodes) > limits.unit_dom_nodes:
        raise OfflineReadingPackageError("publication unit exceeds its DOM bound")
    forbidden = {
        "script",
        "style",
        "iframe",
        "frame",
        "frameset",
        "object",
        "embed",
        "applet",
        "base",
        "link",
        "meta",
        "form",
        "input",
        "template",
    }
    for node in nodes:
        if not isinstance(node, ReaderPublicationRenderElement):
            continue
        tag = node.name.lower()
        if tag in forbidden:
            raise OfflineReadingPackageError("publication HTML contains an executable element")
        for attribute in node.attributes:
            name, value = attribute.name.lower(), attribute.value
            if isinstance(value, ReaderPublicationLocalFragment):
                if value.fallback is not None and not isinstance(
                    project_svg_paint(value.fallback), str
                ):
                    raise OfflineReadingPackageError(
                        "publication paint fallback contains a resource"
                    )
                continue
            if node.namespace == "svg" and name in {"fill", "stroke", "clip-path"}:
                if not isinstance(project_svg_paint(value), str):
                    raise OfflineReadingPackageError(
                        "publication literal paint contains a resource"
                    )
            if attribute.namespace is not None:
                name = f"{attribute.namespace}:{name}"
            if name.startswith("on") or name in {"srcdoc", "style", "ping"}:
                raise OfflineReadingPackageError(
                    "publication HTML contains an executable attribute"
                )
            if name not in OFFLINE_READING_URL_ATTRIBUTES:
                continue
            values = (
                [part.strip().split()[0] for part in value.split(",") if part.strip()]
                if name == "srcset"
                else [value]
            )
            for target in values:
                if target.startswith("nexus-reader-member:"):
                    valid = target.removeprefix("nexus-reader-member:").split("#", 1)[0] in assets
                elif target.startswith("nexus-reader-unavailable:"):
                    valid = (
                        node.namespace == "html"
                        and tag == "img"
                        and name == "src"
                        and unquote(
                            target.removeprefix("nexus-reader-unavailable:").split("#", 1)[0]
                        )
                        in unavailable
                    )
                elif target.startswith("#"):
                    valid = True
                elif tag == "a" and name == "href":
                    valid = urlsplit(target).scheme.lower() in {"", "http", "https", "mailto"}
                else:
                    valid = False
                if not valid:
                    raise OfflineReadingPackageError("publication HTML contains a live subresource")


def _encode_zip(manifest: OfflineReadingManifest, entry_bodies: Mapping[str, bytes]) -> bytes:
    output = io.BytesIO()
    _write_zip(manifest, entry_bodies, output)
    return output.getvalue()


def _write_zip(
    manifest: OfflineReadingManifest,
    entry_bodies: Mapping[str, bytes],
    output: BinaryIO,
) -> None:
    with zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=OFFLINE_READING_ZIP_COMPRESSION_LEVEL,
        strict_timestamps=True,
    ) as archive:
        _write_zip_member(archive, "manifest.json", serialize_offline_reading_manifest(manifest))
        for entry in manifest.entries:
            _write_zip_member(archive, entry.path, entry_bodies[entry.path])


def _write_zip_from_files(
    manifest: OfflineReadingManifest,
    members: Mapping[str, Path],
    output: BinaryIO,
) -> None:
    with zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=OFFLINE_READING_ZIP_COMPRESSION_LEVEL,
        strict_timestamps=True,
    ) as archive:
        _write_zip_member(archive, "manifest.json", serialize_offline_reading_manifest(manifest))
        for entry in manifest.entries:
            info = _zip_info(entry.path)
            with archive.open(info, "w", force_zip64=False) as destination:
                with members[entry.path].open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        destination.write(chunk)


def _write_zip_member(archive: zipfile.ZipFile, path: str, body: bytes) -> None:
    info = _zip_info(path)
    archive.writestr(info, body, compresslevel=OFFLINE_READING_ZIP_COMPRESSION_LEVEL)


def _zip_info(path: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(path, date_time=OFFLINE_READING_ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    # Python 3.12's streaming open does not inherit the archive level for a
    # supplied ZipInfo; this is its only per-member compression-level field.
    info._compresslevel = OFFLINE_READING_ZIP_COMPRESSION_LEVEL
    info.create_system = 3
    info.external_attr = OFFLINE_READING_ZIP_MODE << 16
    return info


def _verify_zip_info(info: zipfile.ZipInfo) -> None:
    if info.filename != "manifest.json":
        # Schema validation owns the detailed path grammar after manifest parsing.
        try:
            OfflineReadingEntry(
                path=info.filename,
                media_type="application/octet-stream",
                size_bytes=info.file_size,
                sha256="0" * 64,
            )
        except ValidationError as exc:
            raise OfflineReadingPackageError(f"unsafe ZIP member path {info.filename!r}") from exc
    if info.is_dir() or info.date_time != OFFLINE_READING_ZIP_TIMESTAMP:
        raise OfflineReadingPackageError(
            "ZIP members must be regular files with the fixed timestamp"
        )
    mode = info.external_attr >> 16
    if info.create_system != 3 or stat.S_IFMT(mode) != stat.S_IFREG or stat.S_IMODE(mode) != 0o644:
        raise OfflineReadingPackageError("ZIP members must have fixed regular-file permissions")
    if info.compress_type != zipfile.ZIP_DEFLATED:
        raise OfflineReadingPackageError("ZIP members must use DEFLATE")
    if info.flag_bits & 0x1 or info.extra or info.comment:
        raise OfflineReadingPackageError(
            "encrypted, extended, or commented ZIP members are forbidden"
        )


def _verify_asset_signature(path: str, media_type: str, body: bytes) -> None:
    valid = True
    if media_type == "application/pdf":
        valid = body.startswith(b"%PDF-")
    elif media_type == "image/png":
        valid = body.startswith(b"\x89PNG\r\n\x1a\n")
    elif media_type == "image/jpeg":
        valid = body.startswith(b"\xff\xd8\xff")
    elif media_type == "image/gif":
        valid = body.startswith((b"GIF87a", b"GIF89a"))
    elif media_type == "image/webp":
        valid = len(body) >= 12 and body[:4] == b"RIFF" and body[8:12] == b"WEBP"
    elif media_type == "image/avif":
        valid = len(body) >= 12 and body[4:8] == b"ftyp" and b"avif" in body[8:32]
    elif media_type == "image/bmp":
        valid = body.startswith(b"BM")
    elif media_type == "image/x-icon":
        valid = len(body) >= 6 and body[:4] == b"\x00\x00\x01\x00"
    elif media_type == "font/woff":
        valid = body.startswith(b"wOFF")
    elif media_type == "font/woff2":
        valid = body.startswith(b"wOF2")
    elif media_type == "font/ttf":
        valid = body.startswith((b"\x00\x01\x00\x00", b"true"))
    elif media_type == "font/otf":
        valid = body.startswith(b"OTTO")
    elif media_type == "image/svg+xml":
        _verify_svg_asset(body)
        return
    else:
        raise OfflineReadingPackageError(f"Publication asset {path!r} has an unsupported MIME")
    if not valid:
        raise OfflineReadingPackageError(f"EPUB asset {path!r} does not match its MIME")


def _verify_asset_file_signature(path: str, media_type: str, source: Path) -> None:
    if media_type == "image/svg+xml":
        _verify_svg_asset(source.read_bytes())
        return
    with source.open("rb") as member_file:
        prefix = member_file.read(32)
    _verify_asset_signature(path, media_type, prefix)


def _verify_svg_asset(body: bytes) -> None:
    if b"<!DOCTYPE" in body.upper() or b"<!ENTITY" in body.upper():
        raise OfflineReadingPackageError("SVG entities and doctypes are forbidden")
    try:
        root = etree.fromstring(
            body,
            parser=etree.XMLParser(
                no_network=True,
                recover=False,
                remove_comments=True,
                resolve_entities=False,
            ),
        )
    except etree.XMLSyntaxError as exc:
        raise OfflineReadingPackageError("SVG asset is not strict XML") from exc
    root_tag = root.tag.rsplit("}", 1)[-1].lower() if isinstance(root.tag, str) else ""
    if root_tag != "svg":
        raise OfflineReadingPackageError("SVG asset root must be an svg element")
    for element in root.iter():
        tag = element.tag.rsplit("}", 1)[-1].lower() if isinstance(element.tag, str) else ""
        if tag in _SVG_FORBIDDEN_TAGS:
            raise OfflineReadingPackageError("SVG asset contains executable content")
        for raw_name, value in element.attrib.items():
            name = raw_name.rsplit("}", 1)[-1].lower()
            if name.startswith("on") or name == "style":
                raise OfflineReadingPackageError("SVG asset contains executable attributes")
            if _REMOTE_OR_EXECUTABLE_URL.search(value):
                raise OfflineReadingPackageError("SVG asset contains a remote or executable URL")
            if name in _SVG_URL_ATTRIBUTES and not value.startswith("#"):
                raise OfflineReadingPackageError("SVG asset contains a non-local subresource")
