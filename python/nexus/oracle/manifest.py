"""Strict desired-state identity for the live Oracle corpus."""

from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class OraclePassageSelector(BaseModel):
    kind: Literal["text_quote"]
    exact: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid", strict=True)


class OracleCorpusManifestAnchor(BaseModel):
    passage_key: str = Field(min_length=1, max_length=160)
    display_label: str = Field(min_length=1)
    selector: OraclePassageSelector
    tags: list[str] = Field(default_factory=list)
    phase_hints: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid", strict=True)


class OracleCorpusManifestWork(BaseModel):
    work_key: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1)
    author_text: str = Field(min_length=1)
    source_repository: str = Field(min_length=1)
    source_url: str = Field(min_length=1)
    source_download_url: str = Field(min_length=1)
    source_media_kind: Literal["epub", "web_article", "pdf"]
    display_order: int
    passage_anchors: list[OracleCorpusManifestAnchor] = Field(min_length=1)

    model_config = ConfigDict(extra="forbid", strict=True)

    @field_validator("source_url", "source_download_url")
    @classmethod
    def _urls_are_public_http(cls, value: str) -> str:
        return _require_http_url(value)

    @model_validator(mode="after")
    def _passage_keys_are_unique(self) -> OracleCorpusManifestWork:
        keys = [anchor.passage_key for anchor in self.passage_anchors]
        if len(keys) != len(set(keys)):
            raise ValueError(f"Oracle work {self.work_key!r} has duplicate passage keys")
        return self


class OraclePlateManifestEntry(BaseModel):
    source_repository: str = Field(min_length=1)
    source_url: str = Field(min_length=1)
    license_text: str = Field(default="public domain", min_length=1)
    artist: str = Field(min_length=1)
    work_title: str = Field(min_length=1)
    year: str | None = None
    attribution_text: str = Field(min_length=1)
    resolved_source_url: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="forbid", strict=True)

    @field_validator("source_url", "resolved_source_url")
    @classmethod
    def _urls_are_public_http(cls, value: str) -> str:
        return _require_http_url(value)


class OracleManifest(BaseModel):
    schema_version: Literal[1] = 1
    works: list[OracleCorpusManifestWork] = Field(min_length=1)
    plates: list[OraclePlateManifestEntry] = Field(min_length=1)

    model_config = ConfigDict(extra="forbid", strict=True)

    @model_validator(mode="after")
    def _keys_are_unique(self) -> OracleManifest:
        work_keys = [work.work_key for work in self.works]
        if len(work_keys) != len(set(work_keys)):
            raise ValueError("Oracle manifest has duplicate work keys")
        plate_urls = [plate.resolved_source_url for plate in self.plates]
        if len(plate_urls) != len(set(plate_urls)):
            raise ValueError("Oracle manifest has duplicate resolved plate URLs")
        plate_slugs = [_plate_storage_slug(plate.source_url) for plate in self.plates]
        if len(plate_slugs) != len(set(plate_slugs)):
            raise ValueError("Oracle manifest has duplicate plate storage slugs")
        return self

    @property
    def manifest_digest(self) -> str:
        payload = self.model_dump(mode="json")
        encoded = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        ).encode("utf-8")
        return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def load_oracle_manifest(manifest_directory: Path) -> OracleManifest:
    """Load the two exact live inputs; caller owns the environment-specific path."""
    works = _load_strict_json(manifest_directory / "manifest_works.json")
    plates = _load_strict_json(manifest_directory / "manifest_plates.json")
    return OracleManifest.model_validate({"schema_version": 1, "works": works, "plates": plates})


def oracle_plate_storage_slug(entry: OraclePlateManifestEntry) -> str:
    return _plate_storage_slug(entry.source_url)


def _plate_storage_slug(source_url: str) -> str:
    parsed = urllib.parse.urlparse(source_url)
    source_name = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
    if source_name.startswith("File:"):
        source_name = source_name.removeprefix("File:")
    stem = source_name.rsplit(".", 1)[0]
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    if not slug:
        raise ValueError(f"Could not derive Oracle plate storage slug from {source_url!r}")
    return slug


def _require_http_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("Oracle manifest URLs must be absolute public HTTP(S) URLs")
    return value


def _load_strict_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_closed_json_object)


def _closed_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result
