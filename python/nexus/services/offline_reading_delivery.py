"""Compose one immutable Reader publication into the sole offline package."""

from __future__ import annotations

import base64
import hashlib
import os
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import UUID

import lxml.etree as etree
from lxml import html
from sqlalchemy.orm import Session, sessionmaker

from nexus.schemas.offline_reading_package import (
    OFFLINE_READING_MAX_EXPANDED_BYTES,
    OFFLINE_READING_READER_CONTRACT_VERSION,
    OFFLINE_READING_URL_ATTRIBUTES,
    EpubOfflineFragment,
    EpubOfflineReaderDocument,
    OfflineReadingEntry,
    PdfOfflineReaderDocument,
    WebArticleOfflineReaderDocument,
    WebOfflineFragment,
    validate_safe_package_path,
)
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.epub_read import rewrite_epub_fragment_links
from nexus.services.offline_reading_packages import (
    OFFLINE_READING_ZIP_MEDIA_TYPE,
    assemble_offline_reading_zip_from_files,
    build_offline_reading_manifest_from_entries,
    serialize_offline_reader_document,
)
from nexus.services.reader_publication import (
    ReaderPublicationObjectReader,
    ReaderPublicationObjectReference,
    ReaderPublicationProjection,
    capture_current,
)

_DROP_ELEMENTS = frozenset(
    {
        "applet",
        "audio",
        "base",
        "embed",
        "form",
        "frame",
        "frameset",
        "iframe",
        "input",
        "link",
        "meta",
        "object",
        "picture",
        "script",
        "source",
        "style",
        "template",
        "track",
        "video",
    }
)
_INERT_EXTERNAL_ELEMENTS = frozenset(
    {"applet", "audio", "embed", "iframe", "object", "picture", "video"}
)
# The package schema owns the closed set of dereferenceable URL attributes; the
# projection strips exactly what that boundary refuses to accept.
_URL_ATTRIBUTES = OFFLINE_READING_URL_ATTRIBUTES
# Retain source anchors, visibility, and accessible labels without resource URLs.
_RETAINED_IMAGE_ATTRIBUTES = ("alt", "title", "id", "name", "hidden", "aria-hidden")


@dataclass(frozen=True, slots=True)
class OfflineReadingArchive:
    media_type: str
    compressed_length: int
    account_independent_digest: str
    content_digest: str
    expanded_length: int
    reader_generation: int
    reader_revision_key: str


class OfflineReadingAssemblyTimeout(TimeoutError):
    """Package assembly exceeded its deadline or was cancelled by the route."""


@dataclass(frozen=True, slots=True)
class _ProjectedExternalMember:
    path: str
    media_type: str
    reference: ReaderPublicationObjectReference


@dataclass(frozen=True, slots=True)
class _ProjectedPackage:
    reader_body: bytes
    external_members: tuple[_ProjectedExternalMember, ...]


def build_offline_reading_archive_file(
    session_factory: sessionmaker[Session],
    *,
    media_id,
    path: str | os.PathLike[str],
    deadline_monotonic: float | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> OfflineReadingArchive:
    """Capture, project, verify, and encode one current publication to a scoped file."""
    checkpoint = _assembly_checkpoint(
        deadline_monotonic=deadline_monotonic,
        cancelled=cancelled,
    )
    with tempfile.TemporaryDirectory(prefix="nexus-offline-reading-members-") as directory:
        captured = capture_current(
            session_factory,
            media_id=media_id,
            assemble=lambda projection, objects: _assemble_publication_to_file(
                projection,
                objects,
                output_path=Path(path),
                staging_parent=Path(directory),
                checkpoint=checkpoint,
            ),
        )
    manifest, compressed_length = captured.value
    digest = hashlib.sha256()
    with Path(path).open("rb") as package_file:
        for chunk in iter(lambda: package_file.read(1024 * 1024), b""):
            checkpoint()
            digest.update(chunk)
    digest_bytes = digest.digest()
    return OfflineReadingArchive(
        media_type=OFFLINE_READING_ZIP_MEDIA_TYPE,
        compressed_length=compressed_length,
        account_independent_digest=digest_bytes.hex(),
        content_digest=f"sha-256=:{base64.b64encode(digest_bytes).decode('ascii')}:",
        expanded_length=sum(entry.size_bytes for entry in manifest.entries),
        reader_generation=captured.generation,
        reader_revision_key=manifest.reader_revision_key,
    )


def _assemble_publication_to_file(
    projection: ReaderPublicationProjection,
    objects: ReaderPublicationObjectReader,
    *,
    output_path: Path,
    staging_parent: Path,
    checkpoint: Callable[[], None],
):
    checkpoint()
    projected = _project_package(projection)
    declared_expanded = len(projected.reader_body) + sum(
        member.reference.size_bytes for member in projected.external_members
    )
    if declared_expanded > OFFLINE_READING_MAX_EXPANDED_BYTES:
        raise ValueError("captured publication exceeds the offline-reading expanded bound")
    with tempfile.TemporaryDirectory(dir=staging_parent, prefix="attempt-") as attempt:
        attempt_path = Path(attempt)
        entries: list[OfflineReadingEntry] = []
        members: dict[str, Path] = {}
        reader_entry, reader_path = _stage_bytes(
            attempt_path,
            path="reader.json",
            media_type="application/json",
            body=projected.reader_body,
        )
        entries.append(reader_entry)
        members[reader_entry.path] = reader_path
        for member in projected.external_members:
            checkpoint()
            entry, member_path = _stage_reference(
                attempt_path,
                objects,
                member,
                checkpoint=checkpoint,
            )
            if entry.path in members:
                raise ValueError("captured publication projects a duplicate package member")
            entries.append(entry)
            members[entry.path] = member_path
        manifest = build_offline_reading_manifest_from_entries(
            media_id=projection.media_id,
            media_kind={"pdf": "Pdf", "epub": "Epub", "web_article": "WebArticle"}[projection.kind],
            title=projection.title,
            reader_generation=projection.generation,
            entries=entries,
        )
        compressed_length = assemble_offline_reading_zip_from_files(
            manifest,
            members,
            output_path,
            checkpoint=checkpoint,
        )
    return manifest, compressed_length


def _project_package(
    projection: ReaderPublicationProjection,
) -> _ProjectedPackage:
    reader, external_members = _project_reader(projection)
    return _ProjectedPackage(
        reader_body=serialize_offline_reader_document(reader),
        external_members=external_members,
    )


def _project_reader(
    projection: ReaderPublicationProjection,
):
    if projection.kind == "pdf":
        source = _one_reference(projection, role="source")
        reader = PdfOfflineReaderDocument.model_validate(
            {
                "readerContractVersion": OFFLINE_READING_READER_CONTRACT_VERSION,
                "mediaId": str(projection.media_id),
                "mediaKind": "Pdf",
                "title": projection.title,
                "documentPath": "document.pdf",
            }
        )
        return reader, (
            _ProjectedExternalMember(
                path="document.pdf",
                media_type="application/pdf",
                reference=source,
            ),
        )

    if projection.navigation.kind == "Absent":
        # justify-defect: document publications capture their complete navigation.
        raise AssertionError("Text publication has no canonical navigation")

    if projection.kind == "web_article":
        fragments = [
            WebOfflineFragment(
                fragment_id=str(fragment.fragment_id),
                fragment_idx=fragment.idx,
                html_sanitized=_offline_html(fragment.html_sanitized, text_only=True),
                canonical_text=fragment.canonical_text,
                created_at=fragment.created_at,
            )
            for fragment in projection.fragments
        ]
        if any(
            generate_canonical_text(fragment.html_sanitized) != fragment.canonical_text
            for fragment in fragments
        ):
            # justify-defect: offline projection must preserve its captured canonical coordinates.
            raise AssertionError("Offline web projection changed canonical text")
        return (
            WebArticleOfflineReaderDocument.model_validate(
                {
                    "readerContractVersion": OFFLINE_READING_READER_CONTRACT_VERSION,
                    "mediaId": str(projection.media_id),
                    "mediaKind": "WebArticle",
                    "title": projection.title,
                    "navigation": projection.navigation.value.model_dump(mode="json"),
                    "fragments": [
                        fragment.model_dump(mode="json", by_alias=True) for fragment in fragments
                    ],
                }
            ),
            (),
        )

    if projection.kind != "epub":
        raise AssertionError("reader publication kind is outside the closed document union")
    return _project_epub_reader(projection)


def _project_epub_reader(
    projection: ReaderPublicationProjection,
):
    if projection.navigation.kind == "Absent":
        # justify-defect: document publications capture their complete navigation.
        raise AssertionError("EPUB publication has no canonical navigation")
    asset_by_key = {
        reference.asset_key: reference
        for reference in projection.object_references
        if reference.role == "epub_asset" and reference.asset_key is not None
    }
    source_by_idx = {source.fragment_idx: source for source in projection.epub_fragment_sources}
    fragment_ids_by_path = {
        source_by_idx[fragment.idx].package_href: fragment.fragment_id
        for fragment in projection.fragments
    }
    referenced_assets: dict[str, ReaderPublicationObjectReference] = {}
    fragments: list[EpubOfflineFragment] = []
    word_start = 0
    for fragment in projection.fragments:
        href_path = source_by_idx[fragment.idx].package_href
        rendered, assets = _offline_epub_html(
            fragment.html_sanitized,
            media_id=str(projection.media_id),
            asset_by_key=asset_by_key,
            source_href_path=href_path,
            fragment_ids_by_path=fragment_ids_by_path,
        )
        referenced_assets.update(assets)
        if generate_canonical_text(rendered) != fragment.canonical_text:
            # justify-defect: offline projection must preserve its captured canonical coordinates.
            raise AssertionError("Offline EPUB projection changed canonical text")
        fragments.append(
            EpubOfflineFragment(
                fragment_id=fragment.fragment_id,
                fragment_idx=fragment.idx,
                href_path=href_path,
                generation=projection.generation,
                char_count=len(fragment.canonical_text),
                word_count=fragment.word_count,
                document_word_start=word_start,
                created_at=fragment.created_at,
                html_sanitized=rendered,
                canonical_text=fragment.canonical_text,
                asset_paths=sorted(assets, key=lambda path: path.encode("utf-8")),
            )
        )
        word_start += fragment.word_count
    reader = EpubOfflineReaderDocument.model_validate(
        {
            "readerContractVersion": OFFLINE_READING_READER_CONTRACT_VERSION,
            "mediaId": str(projection.media_id),
            "mediaKind": "Epub",
            "title": projection.title,
            "navigation": projection.navigation.value.model_dump(mode="json"),
            "fragments": [fragment.model_dump(mode="json") for fragment in fragments],
        }
    )
    members = tuple(
        _ProjectedExternalMember(
            path=path,
            media_type=reference.content_type,
            reference=reference,
        )
        for path, reference in referenced_assets.items()
    )
    return reader, members


def _offline_html(raw: str, *, text_only: bool) -> str:
    roots = html.fragments_fromstring(raw)
    container = html.Element("div")
    for root in roots:
        if isinstance(root, str):
            if container.text is None:
                container.text = root
            else:
                container.text += root
        else:
            container.append(root)
    for element in tuple(container.iterdescendants()):
        if not isinstance(element.tag, str):
            element.drop_tree()
            continue
        tag = element.tag.rsplit("}", 1)[-1].lower()
        if tag == "img" and text_only:
            _replace_image_with_placeholder(element)
            continue
        if text_only and tag in _INERT_EXTERNAL_ELEMENTS:
            element.drop_tag()
            continue
        if text_only and tag == "form":
            element.drop_tag()
            continue
        if tag in _DROP_ELEMENTS or (text_only and tag == "img"):
            element.drop_tree()
            continue
        for attribute in tuple(element.attrib):
            name = attribute.rsplit("}", 1)[-1].lower()
            if name.startswith("on") or name in {"style", "srcdoc"}:
                del element.attrib[attribute]
            elif name in _URL_ATTRIBUTES and not (
                tag == "a" and name == "href" and element.attrib[attribute].startswith("#")
            ):
                del element.attrib[attribute]
    return _inner_html(container)


def _replace_image_with_placeholder(element) -> None:
    """Expose absent image text without adding words to the source coordinate space."""
    replacement = html.Element("span")
    for name in ("id", "name", "hidden", "aria-hidden"):
        if name in element.attrib:
            replacement.set(name, element.attrib[name])
    label = element.get("alt") or ""
    if label:
        replacement.set("role", "img")
        replacement.set("aria-label", label)
        decoration = etree.SubElement(replacement, "span")
        decoration.set("aria-hidden", "true")
        decoration.text = label
    replacement.tail = element.tail
    element.getparent().replace(element, replacement)


def _offline_epub_html(
    raw: str,
    *,
    media_id: str,
    asset_by_key: dict[str, ReaderPublicationObjectReference],
    source_href_path: str,
    fragment_ids_by_path: dict[str, UUID],
) -> tuple[str, dict[str, ReaderPublicationObjectReference]]:
    roots = html.fragments_fromstring(
        rewrite_epub_fragment_links(
            raw, href_path=source_href_path, fragment_ids_by_path=fragment_ids_by_path
        )
    )
    container = html.Element("div")
    for root in roots:
        if isinstance(root, str):
            container.text = (container.text or "") + root
        else:
            container.append(root)
    referenced: dict[str, ReaderPublicationObjectReference] = {}
    for element in tuple(container.iterdescendants()):
        if not isinstance(element.tag, str):
            element.drop_tree()
            continue
        tag = element.tag.rsplit("}", 1)[-1].lower()
        if tag in _INERT_EXTERNAL_ELEMENTS or tag == "form":
            element.drop_tag()
            continue
        if tag in _DROP_ELEMENTS:
            element.drop_tree()
            continue
        if tag == "img":
            source = element.get("src")
            asset_key = _asset_key_from_url(source, media_id=media_id)
            reference = asset_by_key.get(asset_key) if asset_key is not None else None
            if reference is None:
                _replace_image_with_placeholder(element)
                continue
            package_path = f"assets/{reference.asset_key}"
            # Preserve source anchors and accessible labels; drop executable/URL attributes.
            retained = {
                name: element.attrib[name]
                for name in _RETAINED_IMAGE_ATTRIBUTES
                if name in element.attrib
            }
            element.attrib.clear()
            element.set("src", package_path)
            for name, value in retained.items():
                element.set(name, value)
            referenced[package_path] = reference
            continue
        for attribute in tuple(element.attrib):
            name = attribute.rsplit("}", 1)[-1].lower()
            value = element.attrib[attribute]
            if name.startswith("on") or name in {"style", "srcdoc"}:
                del element.attrib[attribute]
                continue
            if name not in _URL_ATTRIBUTES:
                continue
            if (
                tag == "a"
                and name == "href"
                and value == "#"
                and element.get("data-nexus-fragment-id")
            ):
                continue
            del element.attrib[attribute]
    return _inner_html(container), referenced


def _asset_key_from_url(value: str | None, *, media_id: str) -> str | None:
    if value is None:
        return None
    prefix = f"/api/media/{media_id}/assets/"
    parsed = urlparse(value)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith(prefix):
        return None
    key = unquote(parsed.path[len(prefix) :])
    return key or None


def _one_reference(
    projection: ReaderPublicationProjection,
    *,
    role: str,
) -> ReaderPublicationObjectReference:
    references = [reference for reference in projection.object_references if reference.role == role]
    if len(references) != 1:
        raise AssertionError(f"ready {projection.kind} publication must have one {role} object")
    return references[0]


def _stage_reference(
    root: Path,
    objects: ReaderPublicationObjectReader,
    member: _ProjectedExternalMember,
    *,
    checkpoint: Callable[[], None],
) -> tuple[OfflineReadingEntry, Path]:
    path = validate_safe_package_path(member.path)
    # Validate declared type and per-entry bounds before opening storage or disk.
    OfflineReadingEntry(
        path=path,
        media_type=member.media_type,
        size_bytes=member.reference.size_bytes,
        sha256="0" * 64,
    )
    destination = root.joinpath(*path.split("/"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    length = 0
    with destination.open("xb") as output:
        for chunk in objects.stream(member.reference):
            checkpoint()
            if not isinstance(chunk, bytes):
                raise AssertionError("storage stream yielded a non-bytes chunk")
            length += len(chunk)
            if length > member.reference.size_bytes:
                raise AssertionError("captured object length exceeds its publication metadata")
            output.write(chunk)
            digest.update(chunk)
        output.flush()
        os.fsync(output.fileno())
    if length != member.reference.size_bytes:
        raise AssertionError("captured object length differs from its publication metadata")
    return (
        OfflineReadingEntry(
            path=path,
            media_type=member.media_type,
            size_bytes=length,
            sha256=digest.hexdigest(),
        ),
        destination,
    )


def _stage_bytes(
    root: Path,
    *,
    path: str,
    media_type: str,
    body: bytes,
) -> tuple[OfflineReadingEntry, Path]:
    safe_path = validate_safe_package_path(path)
    entry = OfflineReadingEntry(
        path=safe_path,
        media_type=media_type,
        size_bytes=len(body),
        sha256=hashlib.sha256(body).hexdigest(),
    )
    destination = root.joinpath(*safe_path.split("/"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as output:
        output.write(body)
        output.flush()
        os.fsync(output.fileno())
    return entry, destination


def _assembly_checkpoint(
    *,
    deadline_monotonic: float | None,
    cancelled: Callable[[], bool] | None,
) -> Callable[[], None]:
    def checkpoint() -> None:
        if (cancelled is not None and cancelled()) or (
            deadline_monotonic is not None and time.monotonic() >= deadline_monotonic
        ):
            raise OfflineReadingAssemblyTimeout(
                "offline-reading package assembly exceeded its bounded lifetime"
            )

    return checkpoint


def _inner_html(container) -> str:
    pieces: list[str] = []
    if container.text:
        pieces.append(container.text)
    pieces.extend(etree.tostring(child, encoding="unicode", method="html") for child in container)
    return "".join(pieces)
