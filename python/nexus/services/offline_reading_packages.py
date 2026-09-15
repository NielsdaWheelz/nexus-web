"""Pure construction and verification helpers for offline-reading V1 ZIPs."""

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
from uuid import UUID

import lxml.etree as etree
from pydantic import ValidationError

from nexus.schemas.offline_reading_package import (
    OFFLINE_READING_MAX_ARCHIVE_BYTES,
    OFFLINE_READING_MAX_EXPANDED_BYTES,
    OFFLINE_READING_MAX_MANIFEST_JSON_BYTES,
    OFFLINE_READING_PACKAGE_SCHEMA_VERSION,
    OFFLINE_READING_READER_BUNDLE_VERSION,
    OFFLINE_READING_READER_CONTRACT_VERSION,
    EpubOfflineReaderDocument,
    OfflineReaderDocument,
    OfflineReadingEntry,
    OfflineReadingManifest,
    PdfOfflineReaderDocument,
    WebArticleOfflineReaderDocument,
    parse_offline_reader_document,
    parse_offline_reading_manifest,
)

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
    """The package is not one exact, self-contained V1 reading projection."""


@dataclass(frozen=True, slots=True)
class OfflineReadingPackageMember:
    path: str
    media_type: str
    body: bytes


@dataclass(frozen=True, slots=True)
class VerifiedOfflineReadingPackage:
    manifest: OfflineReadingManifest
    reader_document: OfflineReaderDocument
    expanded_length: int


def build_offline_reading_manifest(
    *,
    media_id: UUID | str,
    media_kind: str,
    title: str,
    reader_generation: int,
    members: Iterable[OfflineReadingPackageMember],
) -> tuple[OfflineReadingManifest, dict[str, bytes]]:
    """Build the sole V1 manifest from immutable member bytes."""
    materialized = tuple(members)
    entries = sorted(
        (
            OfflineReadingEntry(
                path=member.path,
                media_type=member.media_type,
                size_bytes=len(member.body),
                sha256=hashlib.sha256(member.body).hexdigest(),
            )
            for member in materialized
        ),
        key=lambda entry: entry.path.encode("utf-8"),
    )
    bodies = {member.path: member.body for member in materialized}
    if len(bodies) != len(materialized):
        raise OfflineReadingPackageError("package member paths must be unique")
    manifest = build_offline_reading_manifest_from_entries(
        media_id=media_id,
        media_kind=media_kind,
        title=title,
        reader_generation=reader_generation,
        entries=entries,
    )
    verify_offline_reading_package(manifest, bodies)
    return manifest, bodies


def build_offline_reading_manifest_from_entries(
    *,
    media_id: UUID | str,
    media_kind: str,
    title: str,
    reader_generation: int,
    entries: Iterable[OfflineReadingEntry],
) -> OfflineReadingManifest:
    """Build the V1 manifest from already-digested, immutable member files."""
    ordered = sorted(entries, key=lambda entry: entry.path.encode("utf-8"))
    revision_key = compute_reader_revision_key(reader_generation, ordered)
    return OfflineReadingManifest.model_validate(
        {
            "packageSchemaVersion": OFFLINE_READING_PACKAGE_SCHEMA_VERSION,
            "readerContractVersion": OFFLINE_READING_READER_CONTRACT_VERSION,
            "minimumReaderBundleVersion": OFFLINE_READING_READER_BUNDLE_VERSION,
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
    """Emit the one deterministic V1 manifest representation."""
    return json.dumps(
        manifest.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")


def serialize_offline_reader_document(reader: OfflineReaderDocument) -> bytes:
    """Emit deterministic reader.json bytes and retain the strict schema boundary."""
    encoded = json.dumps(
        reader.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    parse_offline_reader_document(encoded)
    return encoded


def verify_offline_reading_package(
    manifest: OfflineReadingManifest,
    entry_bodies: Mapping[str, bytes],
) -> VerifiedOfflineReadingPackage:
    """Verify manifest/member integrity and the reader projection's identity."""
    try:
        manifest = OfflineReadingManifest.model_validate(
            manifest.model_dump(mode="json", by_alias=True)
        )
    except (AttributeError, ValidationError) as exc:
        raise OfflineReadingPackageError("manifest violates the strict V1 schema") from exc
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

    entry_by_path = {entry.path: entry for entry in manifest.entries}
    reader_entry = entry_by_path["reader.json"]
    if reader_entry.media_type != "application/json":
        raise OfflineReadingPackageError("reader.json must have media type application/json")
    try:
        reader = parse_offline_reader_document(entry_bodies["reader.json"])
    except (ValidationError, ValueError) as exc:
        raise OfflineReadingPackageError("reader.json violates the V2 reader contract") from exc

    if (
        reader.reader_contract_version != manifest.reader_contract_version
        or reader.media_id != manifest.media_id
        or reader.media_kind != manifest.media_kind
        or reader.title != manifest.title
        or (
            not isinstance(reader, PdfOfflineReaderDocument)
            and reader.navigation.generation != manifest.reader_generation
        )
    ):
        raise OfflineReadingPackageError("reader.json identity does not match manifest")

    _verify_kind_members(reader, entry_by_path, entry_bodies)
    return VerifiedOfflineReadingPackage(
        manifest=manifest,
        reader_document=reader,
        expanded_length=sum(entry.size_bytes for entry in manifest.entries),
    )


def assemble_offline_reading_zip(
    manifest: OfflineReadingManifest,
    entry_bodies: Mapping[str, bytes],
) -> bytes:
    """Validate and assemble an exact deterministic in-memory V1 ZIP."""
    verified = verify_offline_reading_package(manifest, entry_bodies)
    archive_bytes = _encode_zip(verified.manifest, entry_bodies)
    if len(archive_bytes) > OFFLINE_READING_MAX_ARCHIVE_BYTES:
        raise OfflineReadingPackageError("compressed package exceeds the V1 byte bound")
    return archive_bytes


def assemble_offline_reading_zip_file(
    manifest: OfflineReadingManifest,
    entry_bodies: Mapping[str, bytes],
    path: str | os.PathLike[str],
) -> int:
    """Validate and atomically finish one deterministic V1 ZIP at a scoped path."""
    verified = verify_offline_reading_package(manifest, entry_bodies)
    with open(path, "w+b") as output:
        _write_zip(verified.manifest, entry_bodies, output)
        output.flush()
        os.fsync(output.fileno())
        archive_size = output.tell()
    if archive_size > OFFLINE_READING_MAX_ARCHIVE_BYTES:
        raise OfflineReadingPackageError("compressed package exceeds the V1 byte bound")
    return archive_size


def assemble_offline_reading_zip_from_files(
    manifest: OfflineReadingManifest,
    members: Mapping[str, Path],
    path: str | os.PathLike[str],
    *,
    checkpoint: Callable[[], None] | None = None,
) -> int:
    """Verify staged files and stream one deterministic ZIP without retaining bodies."""
    verified = verify_offline_reading_package_files(manifest, members, checkpoint=checkpoint)
    with open(path, "w+b") as output:
        _write_zip_from_files(
            verified.manifest,
            members,
            output,
            checkpoint=checkpoint,
        )
        output.flush()
        os.fsync(output.fileno())
        archive_size = output.tell()
    if archive_size > OFFLINE_READING_MAX_ARCHIVE_BYTES:
        raise OfflineReadingPackageError("compressed package exceeds the V1 byte bound")
    return archive_size


def verify_offline_reading_package_files(
    manifest: OfflineReadingManifest,
    members: Mapping[str, Path],
    *,
    checkpoint: Callable[[], None] | None = None,
) -> VerifiedOfflineReadingPackage:
    """Verify staged package files with bounded per-member memory."""
    try:
        manifest = OfflineReadingManifest.model_validate(
            manifest.model_dump(mode="json", by_alias=True)
        )
    except (AttributeError, ValidationError) as exc:
        raise OfflineReadingPackageError("manifest violates the strict V1 schema") from exc
    declared_paths = tuple(entry.path for entry in manifest.entries)
    if set(declared_paths) != set(members) or len(members) != len(set(members)):
        raise OfflineReadingPackageError(
            "staged members must be exactly the entries declared by the manifest"
        )
    for entry in manifest.entries:
        _checkpoint(checkpoint)
        source = members[entry.path]
        digest = hashlib.sha256()
        length = 0
        with source.open("rb") as member_file:
            for chunk in iter(lambda: member_file.read(1024 * 1024), b""):
                _checkpoint(checkpoint)
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
    reader_path = members["reader.json"]
    reader_body = reader_path.read_bytes()
    try:
        reader = parse_offline_reader_document(reader_body)
    except (ValidationError, ValueError) as exc:
        raise OfflineReadingPackageError("reader.json violates the V2 reader contract") from exc
    if (
        reader.reader_contract_version != manifest.reader_contract_version
        or reader.media_id != manifest.media_id
        or reader.media_kind != manifest.media_kind
        or reader.title != manifest.title
        or (
            not isinstance(reader, PdfOfflineReaderDocument)
            and reader.navigation.generation != manifest.reader_generation
        )
    ):
        raise OfflineReadingPackageError("reader.json identity does not match manifest")
    _verify_kind_member_files(
        reader,
        {entry.path: entry for entry in manifest.entries},
        members,
    )
    return VerifiedOfflineReadingPackage(
        manifest=manifest,
        reader_document=reader,
        expanded_length=sum(entry.size_bytes for entry in manifest.entries),
    )


def verify_offline_reading_zip(payload: bytes) -> VerifiedOfflineReadingPackage:
    """Verify exact ZIP grammar, manifest, entries, MIME, and reader identity."""
    if not isinstance(payload, bytes):
        raise OfflineReadingPackageError("offline-reading ZIP must be bytes")
    if len(payload) > OFFLINE_READING_MAX_ARCHIVE_BYTES:
        raise OfflineReadingPackageError("compressed package exceeds the V1 byte bound")

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
                raise OfflineReadingPackageError("ZIP expanded bytes exceed the V1 bound")
            if infos[0].file_size > OFFLINE_READING_MAX_MANIFEST_JSON_BYTES:
                raise OfflineReadingPackageError("manifest.json exceeds its V1 byte bound")
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

    verified = verify_offline_reading_package(manifest, entry_bodies)
    if _encode_zip(manifest, entry_bodies) != payload:
        raise OfflineReadingPackageError("ZIP bytes are not the deterministic V1 representation")
    return verified


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
    *,
    checkpoint: Callable[[], None] | None,
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
            _checkpoint(checkpoint)
            info = _zip_info(entry.path)
            with archive.open(info, "w", force_zip64=False) as destination:
                with members[entry.path].open("rb") as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b""):
                        _checkpoint(checkpoint)
                        destination.write(chunk)


def _write_zip_member(archive: zipfile.ZipFile, path: str, body: bytes) -> None:
    info = _zip_info(path)
    archive.writestr(info, body, compresslevel=OFFLINE_READING_ZIP_COMPRESSION_LEVEL)


def _zip_info(path: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(path, date_time=OFFLINE_READING_ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
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


def _verify_kind_members(
    reader: OfflineReaderDocument,
    entries: Mapping[str, OfflineReadingEntry],
    bodies: Mapping[str, bytes],
) -> None:
    if isinstance(reader, PdfOfflineReaderDocument):
        if set(entries) != {"reader.json", reader.document_path}:
            raise OfflineReadingPackageError(
                "PDF packages contain only reader.json and documentPath"
            )
        document_entry = entries[reader.document_path]
        if (
            reader.document_path.lower().endswith(".pdf") is False
            or document_entry.media_type != "application/pdf"
            or not bodies[reader.document_path].startswith(b"%PDF-")
        ):
            raise OfflineReadingPackageError("PDF document path, MIME, or signature is invalid")
        return

    if isinstance(reader, WebArticleOfflineReaderDocument):
        if set(entries) != {"reader.json"}:
            raise OfflineReadingPackageError("web-article packages must be text-only")
        return

    if not isinstance(reader, EpubOfflineReaderDocument):  # pragma: no cover - closed union
        raise OfflineReadingPackageError("unknown reader document kind")
    referenced_assets = {path for fragment in reader.fragments for path in fragment.asset_paths}
    if set(entries) != {"reader.json", *referenced_assets}:
        raise OfflineReadingPackageError("EPUB package assets must exactly match reader.json")
    for path in referenced_assets:
        suffix = "." + path.rsplit(".", 1)[-1].lower() if "." in path else ""
        expected_media_type = _ASSET_MEDIA_TYPES.get(suffix)
        if expected_media_type is None or entries[path].media_type != expected_media_type:
            raise OfflineReadingPackageError(
                f"EPUB asset {path!r} has an unsupported or false MIME"
            )
        _verify_asset_signature(path, expected_media_type, bodies[path])


def _verify_kind_member_files(
    reader: OfflineReaderDocument,
    entries: Mapping[str, OfflineReadingEntry],
    members: Mapping[str, Path],
) -> None:
    if isinstance(reader, PdfOfflineReaderDocument):
        if set(entries) != {"reader.json", reader.document_path}:
            raise OfflineReadingPackageError(
                "PDF packages contain only reader.json and documentPath"
            )
        document_entry = entries[reader.document_path]
        with members[reader.document_path].open("rb") as document:
            signature = document.read(5)
        if (
            not reader.document_path.lower().endswith(".pdf")
            or document_entry.media_type != "application/pdf"
            or signature != b"%PDF-"
        ):
            raise OfflineReadingPackageError("PDF document path, MIME, or signature is invalid")
        return

    if isinstance(reader, WebArticleOfflineReaderDocument):
        if set(entries) != {"reader.json"}:
            raise OfflineReadingPackageError("web-article packages must be text-only")
        return

    if not isinstance(reader, EpubOfflineReaderDocument):  # pragma: no cover - closed union
        raise OfflineReadingPackageError("unknown reader document kind")
    referenced_assets = {path for fragment in reader.fragments for path in fragment.asset_paths}
    if set(entries) != {"reader.json", *referenced_assets}:
        raise OfflineReadingPackageError("EPUB package assets must exactly match reader.json")
    for path in referenced_assets:
        suffix = "." + path.rsplit(".", 1)[-1].lower() if "." in path else ""
        expected_media_type = _ASSET_MEDIA_TYPES.get(suffix)
        if expected_media_type is None or entries[path].media_type != expected_media_type:
            raise OfflineReadingPackageError(
                f"EPUB asset {path!r} has an unsupported or false MIME"
            )
        _verify_asset_file_signature(path, expected_media_type, members[path])


def _checkpoint(callback: Callable[[], None] | None) -> None:
    if callback is not None:
        callback()


def _verify_asset_signature(path: str, media_type: str, body: bytes) -> None:
    valid = True
    if media_type == "image/png":
        valid = body.startswith(b"\x89PNG\r\n\x1a\n")
    elif media_type == "image/jpeg":
        valid = body.startswith(b"\xff\xd8\xff")
    elif media_type == "image/gif":
        valid = body.startswith((b"GIF87a", b"GIF89a"))
    elif media_type == "image/webp":
        valid = len(body) >= 12 and body[:4] == b"RIFF" and body[8:12] == b"WEBP"
    elif media_type == "image/avif":
        valid = len(body) >= 12 and body[4:8] == b"ftyp" and b"avif" in body[8:32]
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
