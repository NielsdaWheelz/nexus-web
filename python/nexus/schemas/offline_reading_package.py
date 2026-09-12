"""Archive grammar V1 carrying the strict V2 reader document contract."""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from lxml import html
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from nexus.schemas.media import EpubFragmentOut, MediaNavigationOut, NavigationTextPointOut

OFFLINE_READING_PACKAGE_SCHEMA_VERSION = 1
OFFLINE_READING_READER_CONTRACT_VERSION = 2
OFFLINE_READING_READER_BUNDLE_VERSION = 2

# V1's single bounds owner. Other language implementations mirror these values.
OFFLINE_READING_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
OFFLINE_READING_MAX_EXPANDED_BYTES = 512 * 1024 * 1024
OFFLINE_READING_MAX_ENTRY_BYTES = 512 * 1024 * 1024
OFFLINE_READING_MAX_ENTRIES = 4096
OFFLINE_READING_MAX_PATH_BYTES = 512
OFFLINE_READING_MAX_TITLE_CODEPOINTS = 512
OFFLINE_READING_MAX_MEDIA_TYPE_BYTES = 127
OFFLINE_READING_MAX_MANIFEST_JSON_BYTES = 4 * 1024 * 1024
# Canonical EPUB rendering is already bounded at 64 MiB. Keeping the sole
# materialized JSON member at the same ceiling prevents one package request
# from exceeding the API container while object members remain file-streamed.
OFFLINE_READING_MAX_READER_JSON_BYTES = 64 * 1024 * 1024
OFFLINE_READING_MAX_SVG_BYTES = 8 * 1024 * 1024

_SHA256_HEX = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_MEDIA_TYPE = re.compile(
    r"[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*\Z",
    re.ASCII,
)
_SAFE_PATH_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z", re.ASCII)
_REMOTE_OR_EXECUTABLE_URL = re.compile(
    r"(?:https?|ftp|file|data|javascript|vbscript):|//",
    re.IGNORECASE,
)
_NESTED_ARCHIVE_SUFFIXES = frozenset(
    {".7z", ".apk", ".bz2", ".epub", ".gz", ".jar", ".rar", ".tar", ".xz", ".zip"}
)
_EXECUTABLE_TAGS = frozenset(
    {
        "applet",
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
        "script",
        "style",
        "template",
    }
)
_SUBRESOURCE_TAGS = frozenset({"audio", "img", "picture", "source", "track", "video"})
# The closed V1 rule for attributes that carry a URL a renderer may dereference.
# `ping` belongs here because activating a link with it issues a background POST
# to that URL, which is exactly the remote contact an offline package forbids.
# The delivery projection strips these; this schema rejects any that survive.
OFFLINE_READING_URL_ATTRIBUTES = frozenset(
    {
        "action",
        "background",
        "cite",
        "formaction",
        "href",
        "ping",
        "poster",
        "src",
        "srcset",
        "xlink:href",
    }
)


class OfflineReadingSchemaModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        strict=True,
    )


def validate_safe_package_path(path: str) -> str:
    """Return one canonical, platform-neutral member path or reject it."""
    if not isinstance(path, str):
        raise ValueError("package path must be a string")
    if not path or len(path.encode("utf-8")) > OFFLINE_READING_MAX_PATH_BYTES:
        raise ValueError("package path is empty or exceeds the V1 UTF-8 byte bound")
    if unicodedata.normalize("NFC", path) != path:
        raise ValueError("package path must be NFC normalized")
    if path.startswith("/") or "\\" in path or path == "manifest.json":
        raise ValueError("package path is absolute, reserved, or contains a backslash")
    segments = path.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ValueError("package path contains an empty, dot, or traversal segment")
    if any(_SAFE_PATH_SEGMENT.fullmatch(segment) is None for segment in segments):
        raise ValueError("package path contains a non-portable segment")
    lowercase_path = path.lower()
    if any(lowercase_path.endswith(suffix) for suffix in _NESTED_ARCHIVE_SUFFIXES):
        raise ValueError("nested archive members are forbidden")
    return path


def validate_safe_epub_href_path(path: str) -> str:
    """Return one canonical EPUB-relative path suitable for a reader locator."""
    if not isinstance(path, str):
        raise ValueError("hrefPath must be a string")
    if not path or len(path.encode("utf-8")) > 2048:
        raise ValueError("hrefPath is empty or exceeds the V1 UTF-8 byte bound")
    if unicodedata.normalize("NFC", path) != path:
        raise ValueError("hrefPath must be NFC normalized")
    if path.startswith(("/", "\\")) or "\\" in path:
        raise ValueError("hrefPath must be an EPUB-relative forward-slash path")
    if "?" in path or "#" in path or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", path):
        raise ValueError("hrefPath must not contain an origin, query, or fragment")
    segments = path.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ValueError("hrefPath contains an empty, dot, or traversal segment")
    return path


def _canonical_uuid(value: object) -> UUID:
    if not isinstance(value, str):
        raise ValueError("mediaId must be a canonical UUID string")
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValueError("mediaId must be a canonical UUID string") from exc
    if str(parsed) != value:
        raise ValueError("mediaId must be a canonical lowercase UUID string")
    return parsed


def _nonblank(value: str, field_name: str) -> str:
    if not value or value.isspace():
        raise ValueError(f"{field_name} must contain visible text")
    return value


def _source_timestamp(value: object) -> datetime:
    if isinstance(value, str):
        value = datetime.fromisoformat(value)
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError("source timestamp must be an ISO timestamp with an offset")
    return value


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value!r} is forbidden")


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _parse_strict_json_object(payload: bytes, *, maximum_bytes: int, name: str) -> dict[str, Any]:
    if not isinstance(payload, bytes):
        raise ValueError(f"{name} must be bytes")
    if len(payload) > maximum_bytes:
        raise ValueError(f"{name} exceeds the V1 byte bound")
    if payload.startswith(b"\xef\xbb\xbf"):
        raise ValueError(f"{name} must not contain a UTF-8 BOM")
    try:
        decoded = payload.decode("utf-8", errors="strict")
        value = json.loads(
            decoded,
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{name} must be strict UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{name} must contain one JSON object")
    return value


class OfflineReadingEntry(OfflineReadingSchemaModel):
    path: str
    media_type: str
    size_bytes: int = Field(ge=0, le=OFFLINE_READING_MAX_ENTRY_BYTES)
    sha256: str

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        return validate_safe_package_path(value)

    @field_validator("media_type")
    @classmethod
    def validate_media_type(cls, value: str) -> str:
        try:
            encoded = value.encode("ascii")
        except UnicodeEncodeError as exc:
            raise ValueError("mediaType must be ASCII") from exc
        if (
            not encoded
            or len(encoded) > OFFLINE_READING_MAX_MEDIA_TYPE_BYTES
            or _MEDIA_TYPE.fullmatch(value) is None
        ):
            raise ValueError("mediaType must be one lowercase MIME type without parameters")
        return value

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if _SHA256_HEX.fullmatch(value) is None:
            raise ValueError("sha256 must be 64 lowercase hexadecimal characters")
        return value

    @model_validator(mode="after")
    def validate_media_specific_size(self) -> OfflineReadingEntry:
        if self.path == "reader.json" and self.size_bytes > OFFLINE_READING_MAX_READER_JSON_BYTES:
            raise ValueError("reader.json exceeds the V1 parse-memory bound")
        if self.media_type == "image/svg+xml" and self.size_bytes > OFFLINE_READING_MAX_SVG_BYTES:
            raise ValueError("SVG members exceed the V1 parse-memory bound")
        return self


class OfflineReadingManifest(OfflineReadingSchemaModel):
    package_schema_version: Literal[1]
    reader_contract_version: Literal[2]
    minimum_reader_bundle_version: Literal[2]
    media_id: UUID
    media_kind: Literal["Pdf", "Epub", "WebArticle"]
    title: str = Field(min_length=1, max_length=OFFLINE_READING_MAX_TITLE_CODEPOINTS)
    reader_generation: int = Field(ge=1, le=(1 << 63) - 1)
    reader_revision_key: str
    entries: list[OfflineReadingEntry] = Field(
        min_length=1,
        max_length=OFFLINE_READING_MAX_ENTRIES,
    )

    @field_validator("media_id", mode="before")
    @classmethod
    def validate_media_id(cls, value: object) -> UUID:
        return _canonical_uuid(value)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        return _nonblank(value, "title")

    @field_validator("reader_revision_key")
    @classmethod
    def validate_revision_key(cls, value: str) -> str:
        if _SHA256_HEX.fullmatch(value) is None:
            raise ValueError("readerRevisionKey must be lowercase SHA-256 hex")
        return value

    @model_validator(mode="after")
    def validate_entries(self) -> OfflineReadingManifest:
        paths = [entry.path for entry in self.entries]
        if paths != sorted(paths, key=lambda path: path.encode("utf-8")):
            raise ValueError("manifest entries must be sorted by ascending UTF-8 path bytes")
        if len(paths) != len(set(paths)):
            raise ValueError("manifest entry paths must be unique")
        if "reader.json" not in paths:
            raise ValueError("reader.json must be declared")
        if sum(entry.size_bytes for entry in self.entries) > OFFLINE_READING_MAX_EXPANDED_BYTES:
            raise ValueError("declared entries exceed the V1 expanded byte bound")
        return self


class OfflineReaderDocumentBase(OfflineReadingSchemaModel):
    reader_contract_version: Literal[2]
    media_id: UUID
    title: str = Field(min_length=1, max_length=OFFLINE_READING_MAX_TITLE_CODEPOINTS)

    @field_validator("media_id", mode="before")
    @classmethod
    def validate_media_id(cls, value: object) -> UUID:
        return _canonical_uuid(value)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        return _nonblank(value, "title")


class PdfOfflineReaderDocument(OfflineReaderDocumentBase):
    media_kind: Literal["Pdf"]
    document_path: Literal["document.pdf"]


class EpubOfflineFragment(EpubFragmentOut):
    """The hosted fragment body plus its closed package asset set."""

    asset_paths: list[str]

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    @field_validator("created_at", mode="before")
    @classmethod
    def validate_created_at(cls, value: object) -> datetime:
        return _source_timestamp(value)

    @field_validator("fragment_id", mode="before")
    @classmethod
    def validate_fragment_id(cls, value: object) -> UUID:
        return value if isinstance(value, UUID) else _canonical_uuid(value)

    @field_validator("href_path")
    @classmethod
    def validate_href_path(cls, value: str) -> str:
        return validate_safe_epub_href_path(value)

    @field_validator("asset_paths")
    @classmethod
    def validate_assets(cls, value: list[str]) -> list[str]:
        paths = [validate_safe_package_path(path) for path in value]
        if len(paths) != len(set(paths)):
            raise ValueError("asset_paths must be unique")
        if sorted(paths, key=lambda path: path.encode("utf-8")) != paths:
            raise ValueError("asset_paths must be sorted by ascending UTF-8 path bytes")
        if any(not path.startswith("assets/") for path in paths):
            raise ValueError("EPUB asset_paths must live below assets/")
        return paths

    @model_validator(mode="after")
    def validate_html(self) -> EpubOfflineFragment:
        if self.char_count != len(self.canonical_text):
            raise ValueError("EPUB char_count must equal canonical_text length")
        referenced = _validate_sanitized_html(self.html_sanitized, web_text_only=False)
        if referenced != set(self.asset_paths):
            raise ValueError("EPUB HTML assets must exactly match asset_paths")
        return self


class EpubOfflineReaderDocument(OfflineReaderDocumentBase):
    media_kind: Literal["Epub"]
    navigation: MediaNavigationOut
    fragments: list[EpubOfflineFragment] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_order_and_identity(self) -> EpubOfflineReaderDocument:
        _validate_navigation_fragments(
            self.navigation,
            media_id=self.media_id,
            kind="epub",
            fragments=[
                (item.fragment_id, item.fragment_idx, item.canonical_text)
                for item in self.fragments
            ],
        )
        word_start = 0
        for fragment in self.fragments:
            if fragment.generation != self.navigation.generation:
                raise ValueError("EPUB fragments and navigation must share one generation")
            if fragment.document_word_start != word_start:
                raise ValueError("EPUB fragment word prefixes must follow document order")
            word_start += fragment.word_count
        return self


class WebOfflineFragment(OfflineReadingSchemaModel):
    fragment_id: UUID
    fragment_idx: int = Field(ge=0)
    html_sanitized: str
    canonical_text: str
    created_at: datetime

    @field_validator("created_at", mode="before")
    @classmethod
    def validate_created_at(cls, value: object) -> datetime:
        return _source_timestamp(value)

    @field_validator("fragment_id", mode="before")
    @classmethod
    def validate_fragment_id(cls, value: object) -> UUID:
        return _canonical_uuid(value)

    @field_validator("html_sanitized")
    @classmethod
    def validate_html(cls, value: str) -> str:
        _validate_sanitized_html(value, web_text_only=True)
        return value


class WebArticleOfflineReaderDocument(OfflineReaderDocumentBase):
    media_kind: Literal["WebArticle"]
    navigation: MediaNavigationOut
    fragments: list[WebOfflineFragment] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_order_and_identity(self) -> WebArticleOfflineReaderDocument:
        _validate_navigation_fragments(
            self.navigation,
            media_id=self.media_id,
            kind="web_article",
            fragments=[
                (item.fragment_id, item.fragment_idx, item.canonical_text)
                for item in self.fragments
            ],
        )
        return self


def _validate_navigation_fragments(
    navigation: MediaNavigationOut,
    *,
    media_id: UUID,
    kind: Literal["epub", "web_article"],
    fragments: list[tuple[UUID, int, str]],
) -> None:
    """Bind untrusted packaged navigation to its unique immutable content."""
    if navigation.media_id != media_id or navigation.kind != kind:
        raise ValueError("navigation identity must match its reader document")
    identifiers = [fragment[0] for fragment in fragments]
    indexes = [fragment[1] for fragment in fragments]
    if len(identifiers) != len(set(identifiers)) or indexes != sorted(set(indexes)):
        raise ValueError("fragments must have unique identities and increasing indexes")
    if [
        (item.fragment_id, item.fragment_idx, item.char_count) for item in navigation.fragments
    ] != [(identifier, index, len(value)) for identifier, index, value in fragments]:
        raise ValueError("navigation fragment lengths and order must match canonical content")
    coordinates: dict[UUID, tuple[int, int]] = {}
    document_offset = 0
    for identifier, _, value in fragments:
        coordinates[identifier] = document_offset, len(value)
        document_offset += len(value)

    def point(value: NavigationTextPointOut) -> int:
        target = coordinates.get(value.fragment_id)
        if target is None or value.offset > target[1]:
            raise ValueError("navigation target must lie within a declared fragment")
        return target[0] + value.offset

    sections = {item.section_id: item for item in navigation.sections}
    if len(sections) != len(navigation.sections):
        raise ValueError("navigation section identities must be unique")
    starts = [point(item.target) for item in navigation.sections]
    if starts != sorted(starts):
        raise ValueError("navigation sections must follow canonical reading order")
    for section in navigation.sections:
        if section.extent.kind == "Present":
            extent = section.extent.value
            if extent.start != section.target or point(extent.end) < point(extent.start):
                raise ValueError(
                    "navigation section extent must start at its target and not run backwards"
                )
        seen = {section.section_id}
        parent = section.parent_section_id
        while parent.kind == "Present":
            if parent.value in seen or parent.value not in sections:
                raise ValueError("navigation parent must form an acyclic declared hierarchy")
            seen.add(parent.value)
            ancestor = sections[parent.value]
            if section.extent.kind == "Present" and ancestor.extent.kind == "Present":
                if point(section.target) < point(ancestor.target) or point(
                    section.extent.value.end
                ) > point(ancestor.extent.value.end):
                    raise ValueError("navigation child extent must lie within its parent extent")
            parent = ancestor.parent_section_id
    toc_ids: set[str] = set()
    pending = list(navigation.toc_nodes)
    while pending:
        node = pending.pop()
        if node.id in toc_ids:
            raise ValueError("navigation outline node identities must be unique")
        toc_ids.add(node.id)
        if node.section_id.kind == "Present" and node.section_id.value not in sections:
            raise ValueError("navigation outline must reference declared sections")
        pending.extend(node.children)
    for location in [*navigation.landmarks, *navigation.page_list]:
        if location.target.kind == "Present":
            point(location.target.value)


OfflineReaderDocument = Annotated[
    PdfOfflineReaderDocument | EpubOfflineReaderDocument | WebArticleOfflineReaderDocument,
    Field(discriminator="media_kind"),
]
_READER_DOCUMENT_ADAPTER = TypeAdapter(OfflineReaderDocument)


def _validate_sanitized_html(value: str, *, web_text_only: bool) -> set[str]:
    try:
        roots = html.fragments_fromstring(value)
    except (ValueError, TypeError) as exc:
        raise ValueError("htmlSanitized must be parseable HTML") from exc

    referenced_assets: set[str] = set()
    for root in roots:
        elements = root.iter() if hasattr(root, "iter") else ()
        for element in elements:
            tag_value = element.tag
            if not isinstance(tag_value, str):
                raise ValueError("offline HTML comments or processing instructions are forbidden")
            tag = tag_value.rsplit("}", 1)[-1].lower()
            if tag in _EXECUTABLE_TAGS or (web_text_only and tag in _SUBRESOURCE_TAGS):
                raise ValueError("offline HTML contains executable or subresource content")
            if not web_text_only and tag in _SUBRESOURCE_TAGS - {"img"}:
                raise ValueError("EPUB HTML supports only declared image subresources")
            for raw_name, raw_value in element.attrib.items():
                name = raw_name.rsplit("}", 1)[-1].lower()
                if name.startswith("on") or name in {"srcdoc", "style"}:
                    raise ValueError("offline HTML contains executable attributes")
                if name not in OFFLINE_READING_URL_ATTRIBUTES:
                    continue
                if _REMOTE_OR_EXECUTABLE_URL.search(raw_value):
                    raise ValueError("offline HTML contains a remote or executable URL")
                if tag == "a" and name == "href" and raw_value.startswith("#"):
                    continue
                if not web_text_only and tag == "img" and name == "src":
                    referenced_assets.add(validate_safe_package_path(raw_value))
                    continue
                raise ValueError(
                    "offline HTML contains an undeclared navigation or subresource URL"
                )
    return referenced_assets


def parse_offline_reading_manifest(payload: bytes) -> OfflineReadingManifest:
    value = _parse_strict_json_object(
        payload,
        maximum_bytes=OFFLINE_READING_MAX_MANIFEST_JSON_BYTES,
        name="manifest.json",
    )
    return OfflineReadingManifest.model_validate(value, by_alias=True, by_name=False)


def parse_offline_reader_document(payload: bytes) -> OfflineReaderDocument:
    value = _parse_strict_json_object(
        payload,
        maximum_bytes=OFFLINE_READING_MAX_READER_JSON_BYTES,
        name="reader.json",
    )
    document = _READER_DOCUMENT_ADAPTER.validate_python(value, by_alias=True, by_name=False)
    if (
        not isinstance(document, PdfOfflineReaderDocument)
        and value["navigation"] != document.navigation.model_dump(mode="json")
    ):
        raise ValueError("packaged navigation must use exact canonical wire values")
    return document
