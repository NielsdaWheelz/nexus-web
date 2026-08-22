"""Strict V1 wire schemas for verified offline-reading packages."""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit
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

OFFLINE_READING_PACKAGE_SCHEMA_VERSION = 1
OFFLINE_READING_READER_CONTRACT_VERSION = 1
OFFLINE_READING_READER_BUNDLE_VERSION = 1

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
    parsed = urlsplit(path)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
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
    reader_contract_version: Literal[1]
    minimum_reader_bundle_version: Literal[1]
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
    reader_contract_version: Literal[1]
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


class EpubOfflineNavigationItem(OfflineReadingSchemaModel):
    section_id: str = Field(min_length=1, max_length=256)
    label: str = Field(min_length=1, max_length=OFFLINE_READING_MAX_TITLE_CODEPOINTS)

    @field_validator("section_id", "label")
    @classmethod
    def validate_nonblank_fields(cls, value: str, info: Any) -> str:
        return _nonblank(value, info.field_name)


class EpubOfflineSection(OfflineReadingSchemaModel):
    section_id: str = Field(min_length=1, max_length=256)
    ordinal: int = Field(ge=0)
    fragment_id: UUID
    fragment_idx: int = Field(ge=0)
    href_path: str
    anchor_id: str | None = Field(default=None, max_length=256)
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    html_sanitized: str
    canonical_text: str
    asset_paths: list[str]

    @field_validator("section_id")
    @classmethod
    def validate_section_id(cls, value: str) -> str:
        return _nonblank(value, "sectionId")

    @field_validator("fragment_id", mode="before")
    @classmethod
    def validate_fragment_id(cls, value: object) -> UUID:
        return _canonical_uuid(value)

    @field_validator("href_path")
    @classmethod
    def validate_href_path(cls, value: str) -> str:
        return validate_safe_epub_href_path(value)

    @field_validator("anchor_id")
    @classmethod
    def validate_anchor_id(cls, value: str | None) -> str | None:
        return _nonblank(value, "anchorId") if value is not None else None

    @field_validator("asset_paths")
    @classmethod
    def validate_assets(cls, value: list[str]) -> list[str]:
        validated = [validate_safe_package_path(path) for path in value]
        if len(validated) != len(set(validated)):
            raise ValueError("assetPaths must be unique")
        if sorted(validated, key=lambda path: path.encode("utf-8")) != validated:
            raise ValueError("assetPaths must be sorted by ascending UTF-8 path bytes")
        if any(not path.startswith("assets/") for path in validated):
            raise ValueError("EPUB assetPaths must live below assets/")
        return validated

    @model_validator(mode="after")
    def validate_html(self) -> EpubOfflineSection:
        if self.end_offset < self.start_offset:
            raise ValueError("EPUB section endOffset must be at or after startOffset")
        if self.end_offset > len(self.canonical_text):
            raise ValueError("EPUB section offsets must be within canonicalText")
        referenced = _validate_sanitized_html(self.html_sanitized, web_text_only=False)
        if referenced != set(self.asset_paths):
            raise ValueError("EPUB HTML asset references must exactly match assetPaths")
        return self


class EpubOfflineReaderDocument(OfflineReaderDocumentBase):
    media_kind: Literal["Epub"]
    navigation: list[EpubOfflineNavigationItem]
    sections: list[EpubOfflineSection] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_order_and_identity(self) -> EpubOfflineReaderDocument:
        section_ids = [item.section_id for item in self.sections]
        navigation_ids = [item.section_id for item in self.navigation]
        if len(section_ids) != len(set(section_ids)) or len(navigation_ids) != len(
            set(navigation_ids)
        ):
            raise ValueError("EPUB section and navigation IDs must be unique")
        if any(item.ordinal != index for index, item in enumerate(self.sections)):
            raise ValueError("EPUB section ordinals must be contiguous and match array order")
        if any(section_id not in set(section_ids) for section_id in navigation_ids):
            raise ValueError("EPUB navigation must reference a declared section")
        return self


class WebOfflineNavigationItem(OfflineReadingSchemaModel):
    fragment_id: str = Field(min_length=1, max_length=256)
    label: str = Field(min_length=1, max_length=OFFLINE_READING_MAX_TITLE_CODEPOINTS)

    @field_validator("fragment_id", "label")
    @classmethod
    def validate_nonblank_fields(cls, value: str, info: Any) -> str:
        return _nonblank(value, info.field_name)


class WebOfflineFragment(OfflineReadingSchemaModel):
    fragment_id: str = Field(min_length=1, max_length=256)
    ordinal: int = Field(ge=0)
    html_sanitized: str
    canonical_text: str

    @field_validator("fragment_id")
    @classmethod
    def validate_fragment_id(cls, value: str) -> str:
        return _nonblank(value, "fragmentId")

    @field_validator("html_sanitized")
    @classmethod
    def validate_html(cls, value: str) -> str:
        _validate_sanitized_html(value, web_text_only=True)
        return value


class WebArticleOfflineReaderDocument(OfflineReaderDocumentBase):
    media_kind: Literal["WebArticle"]
    navigation: list[WebOfflineNavigationItem]
    fragments: list[WebOfflineFragment] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_order_and_identity(self) -> WebArticleOfflineReaderDocument:
        fragment_ids = [item.fragment_id for item in self.fragments]
        navigation_ids = [item.fragment_id for item in self.navigation]
        if len(fragment_ids) != len(set(fragment_ids)) or len(navigation_ids) != len(
            set(navigation_ids)
        ):
            raise ValueError("web fragment and navigation IDs must be unique")
        if any(item.ordinal != index for index, item in enumerate(self.fragments)):
            raise ValueError("web fragment ordinals must be contiguous and match array order")
        if any(fragment_id not in set(fragment_ids) for fragment_id in navigation_ids):
            raise ValueError("web navigation must reference a declared fragment")
        return self


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
    return _READER_DOCUMENT_ADAPTER.validate_python(value, by_alias=True, by_name=False)
