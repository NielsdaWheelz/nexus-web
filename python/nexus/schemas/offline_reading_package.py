"""Strict wire schemas for verified schema-two offline-reading packages."""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

OFFLINE_READING_READER_CONTRACT_VERSION = 1

# The single bounds owner. Other language implementations mirror these values.
OFFLINE_READING_MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
OFFLINE_READING_MAX_EXPANDED_BYTES = 512 * 1024 * 1024
OFFLINE_READING_MAX_ENTRY_BYTES = 512 * 1024 * 1024
OFFLINE_READING_MAX_ENTRIES = 4096
OFFLINE_READING_MAX_PATH_BYTES = 512
OFFLINE_READING_MAX_TITLE_CODEPOINTS = 512
OFFLINE_READING_MAX_MEDIA_TYPE_BYTES = 127
OFFLINE_READING_MAX_MANIFEST_JSON_BYTES = 4 * 1024 * 1024
# An SVG asset is parsed whole to reject executable content, so it carries its
# own residency ceiling while every other member stays file-streamed.
OFFLINE_READING_MAX_SVG_BYTES = 8 * 1024 * 1024

_SHA256_HEX = re.compile(r"[0-9a-f]{64}\Z", re.ASCII)
_MEDIA_TYPE = re.compile(
    r"[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*\Z",
    re.ASCII,
)
_SAFE_PATH_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z", re.ASCII)
_NESTED_ARCHIVE_SUFFIXES = frozenset(
    {".7z", ".apk", ".bz2", ".epub", ".gz", ".jar", ".rar", ".tar", ".xz", ".zip"}
)
# The closed rule for attributes that carry a URL a renderer may dereference.
# `ping` belongs here because activating a link with it issues a background POST
# to that URL, which is exactly the remote contact an offline package forbids.
# The publication projection strips these; verification rejects any that survive.
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
        raise ValueError("package path is empty or exceeds the UTF-8 byte bound")
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


def parse_strict_json_object(payload: bytes, *, maximum_bytes: int, name: str) -> dict[str, Any]:
    if not isinstance(payload, bytes):
        raise ValueError(f"{name} must be bytes")
    if len(payload) > maximum_bytes:
        raise ValueError(f"{name} exceeds its byte bound")
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
        if self.media_type == "image/svg+xml" and self.size_bytes > OFFLINE_READING_MAX_SVG_BYTES:
            raise ValueError("SVG members exceed the parse-memory bound")
        return self


class OfflineReadingManifest(OfflineReadingSchemaModel):
    package_schema_version: Literal[2]
    reader_contract_version: Literal[1]
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
        if "descriptor.json" not in paths:
            raise ValueError("descriptor.json must be declared")
        if sum(entry.size_bytes for entry in self.entries) > OFFLINE_READING_MAX_EXPANDED_BYTES:
            raise ValueError("declared entries exceed the expanded byte bound")
        return self


def parse_offline_reading_manifest(payload: bytes) -> OfflineReadingManifest:
    value = parse_strict_json_object(
        payload,
        maximum_bytes=OFFLINE_READING_MAX_MANIFEST_JSON_BYTES,
        name="manifest.json",
    )
    return OfflineReadingManifest.model_validate(value, by_alias=True, by_name=False)
