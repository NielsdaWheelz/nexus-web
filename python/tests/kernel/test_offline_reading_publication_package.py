"""Schema two preserves exact retained members and rejects broken source bindings."""

import copy
import hashlib
import io
import json
import stat
import struct
import zipfile
import zlib
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from pydantic import ValidationError

from nexus.config import ReaderPublicationLimits
from nexus.schemas.offline_reading_package import (
    OFFLINE_READING_MAX_ENTRIES,
    OFFLINE_READING_MAX_EXPANDED_BYTES,
    OFFLINE_READING_MAX_PATH_BYTES,
    OFFLINE_READING_MAX_SVG_BYTES,
    OfflineReadingEntry,
    OfflineReadingManifest,
    parse_offline_reading_manifest,
)
from nexus.schemas.reader_publication import ReaderPublicationTextDescriptor
from nexus.services.offline_reading_packages import (
    OFFLINE_READING_REVISION_DOMAIN,
    OfflineReadingPackageError,
    assemble_offline_reading_zip_from_files,
    build_offline_reading_manifest_from_entries,
    compute_reader_revision_key,
    verify_offline_reading_package,
    verify_offline_reading_zip,
)

_CORPUS = json.loads(
    (Path(__file__).parents[3] / "testdata/offline-reading-contract-v1.json").read_text(
        encoding="utf-8"
    )
)


def _rewritten_zip(
    original: bytes,
    *,
    target_path: str,
    timestamp: tuple[int, int, int, int, int, int] | None = None,
    symlink: bool = False,
    add_nested_archive: bool = False,
) -> bytes:
    """Re-emit one archive with exactly one member attribute changed."""
    source = zipfile.ZipFile(io.BytesIO(original), "r")
    output = io.BytesIO()
    with source, zipfile.ZipFile(output, "w") as archive:
        for old_info in source.infolist():
            info = zipfile.ZipInfo(
                old_info.filename,
                date_time=timestamp
                if old_info.filename == target_path and timestamp
                else old_info.date_time,
            )
            info.compress_type = old_info.compress_type
            info.create_system = old_info.create_system
            info.external_attr = old_info.external_attr
            if old_info.filename == target_path and symlink:
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, source.read(old_info), compresslevel=9)
        if add_nested_archive:
            archive.writestr(
                "assets/cover.zip", b"not a package member", compress_type=zipfile.ZIP_DEFLATED
            )
    return output.getvalue()


def test_schema_two_packages_keep_exact_members_and_reject_an_unreachable_source(
    tmp_path: Path,
) -> None:
    media_id = UUID("00000000-0000-4000-8000-000000000001")
    document = b"%PDF-1.7\npublication proof\n"
    bodies = {
        "assets/document.pdf": document,
        "descriptor.json": json.dumps(
            {
                "media_id": str(media_id),
                "reader_generation": 7,
                "kind": "pdf",
                "title": "Frozen source",
                "reader_contract_version": 1,
                "document_asset_ref": {
                    "key": "assets/document.pdf",
                    "bytes": len(document),
                    "sha256": hashlib.sha256(document).hexdigest(),
                },
                "page_count": 1,
            },
            separators=(",", ":"),
        ).encode(),
    }
    # These fixture bounds describe only the small proof corpus.
    limits = ReaderPublicationLimits(
        unit_bytes=1100,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=2000,
        descriptor_bytes=1000,
    )

    def assemble() -> bytes:
        entries = []
        members = {}
        for key, body in bodies.items():
            target = tmp_path / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            members[key] = target
            entries.append(
                OfflineReadingEntry(
                    path=key,
                    media_type="application/pdf" if key.endswith(".pdf") else "application/json",
                    size_bytes=len(body),
                    sha256=hashlib.sha256(body).hexdigest(),
                )
            )
        manifest = build_offline_reading_manifest_from_entries(
            media_id=media_id,
            media_kind="Pdf",
            title="Frozen source",
            reader_generation=7,
            entries=entries,
        )
        output = tmp_path / "package.zip"
        assemble_offline_reading_zip_from_files(
            manifest, members, output, publication_limits=limits
        )
        return output.read_bytes()

    archive = assemble()
    result = verify_offline_reading_zip(archive, publication_limits=limits)
    assert result.manifest.package_schema_version == 2
    assert result.manifest.minimum_reader_bundle_version == 2
    assert result.manifest.reader_generation == 7
    assert {entry.path for entry in result.manifest.entries} == set(bodies)
    assert assemble() == archive

    assert _rewritten_zip(archive, target_path="descriptor.json") == archive, (
        "the rewriting helper is not byte-transparent, so its mutations prove nothing"
    )
    for mutated in (
        _rewritten_zip(archive, target_path="descriptor.json", timestamp=(2026, 1, 1, 0, 0, 0)),
        _rewritten_zip(archive, target_path="descriptor.json", symlink=True),
        _rewritten_zip(archive, target_path="descriptor.json", add_nested_archive=True),
    ):
        with pytest.raises(OfflineReadingPackageError):
            verify_offline_reading_zip(mutated, publication_limits=limits)

    bodies["unused.json"] = b"{}"
    with pytest.raises(OfflineReadingPackageError, match="unreachable"):
        assemble()
    del bodies["unused.json"]
    descriptor = json.loads(bodies["descriptor.json"])
    descriptor["reader_generation"] = 8
    bodies["descriptor.json"] = json.dumps(descriptor).encode()
    with pytest.raises(OfflineReadingPackageError, match="identity"):
        assemble()


@pytest.mark.parametrize("fragment_id", ["00000000-0000-4000-8000-000000000008", "fragment-a"])
def test_schema_two_unicode_members_produce_a_cross_language_archive(
    tmp_path: Path,
    fragment_id: str,
) -> None:
    media_id = UUID("00000000-0000-4000-8000-000000000007")
    bodies: dict[str, bytes] = {}

    def member(key: str, value: dict) -> dict:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        bodies[key] = body
        return {"key": key, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}

    def png_chunk(kind: bytes, body: bytes) -> bytes:
        return (
            struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
        )

    asset_key = "assets/web/0123456789abcdef"
    png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00\xff"))
        + png_chunk(b"IEND", b"")
    )
    bodies[asset_key] = png
    asset = {
        "kind": "Captured",
        "member": {"key": asset_key, "bytes": len(png), "sha256": hashlib.sha256(png).hexdigest()},
        "media_type": "image/png",
        "package_href": None,
    }
    first = member(
        f"units/{fragment_id}/0-7-0.json",
        {
            "fragment_id": fragment_id,
            "fragment_idx": 0,
            "fragment_document_start_cp": 0,
            "document_word_start": 0,
            "starts_in_word": False,
            "fragment_length_cp": 10,
            "start_cp": 0,
            "end_cp": 7,
            "render_start_cp": 0,
            "render_end_cp": 6,
            "render_nodes": [
                {
                    "kind": "Element",
                    "parent": None,
                    "namespace": "html",
                    "name": "p",
                    "attributes": [],
                },
                {"kind": "Text", "parent": 0, "text": "café 🧠"},
                {
                    "kind": "Element",
                    "parent": None,
                    "namespace": "html",
                    "name": "img",
                    "attributes": [
                        {
                            "namespace": None,
                            "name": "src",
                            "value": f"nexus-reader-member:{asset_key}",
                        },
                        {"namespace": None, "name": "alt", "value": "red pixel"},
                    ],
                },
            ],
            "canonical_text": "café 🧠\n",
            "word_boundaries": [0, 4, 5, 6, 7],
            "assets": [asset],
            "table_contexts": [],
            "epub_target": None,
            "document_embeds": [],
        },
    )
    second = member(
        f"units/{fragment_id}/7-10-0.json",
        {
            "fragment_id": fragment_id,
            "fragment_idx": 0,
            "fragment_document_start_cp": 0,
            "document_word_start": 2,
            "starts_in_word": False,
            "fragment_length_cp": 10,
            "start_cp": 7,
            "end_cp": 10,
            "render_start_cp": 7,
            "render_end_cp": 10,
            "render_nodes": [
                {
                    "kind": "Element",
                    "parent": None,
                    "namespace": "html",
                    "name": "p",
                    "attributes": [],
                },
                {"kind": "Text", "parent": 0, "text": "cat"},
            ],
            "canonical_text": "cat",
            "word_boundaries": [7, 10],
            "assets": [],
            "table_contexts": [],
            "epub_target": None,
            "document_embeds": [],
        },
    )
    second_page = member(
        "index/1.json",
        {
            "units": [
                {
                    "member": second,
                    "ordinal": 1,
                    "fragment_id": fragment_id,
                    "fragment_idx": 0,
                    "start_cp": 7,
                    "end_cp": 10,
                }
            ],
            "sections": [
                {
                    "unit_key": second["key"],
                    "section_id": "retained-cat",
                    "fragment_id": fragment_id,
                    "fragment_idx": 0,
                    "label": "cat",
                    "ordinal": 0,
                    "level": None,
                    "depth": None,
                    "start_offset": 7,
                    "end_offset": 10,
                    "href_path": None,
                    "href_fragment": None,
                    "anchor_id": None,
                }
            ],
            "toc": [],
            "landmarks": [],
            "page_list": [],
            "table_metadata": [],
            "anchors": [],
            "next_ref": None,
        },
    )
    first_page = member(
        "index/0.json",
        {
            "units": [
                {
                    "member": first,
                    "ordinal": 0,
                    "fragment_id": fragment_id,
                    "fragment_idx": 0,
                    "start_cp": 0,
                    "end_cp": 7,
                }
            ],
            "sections": [],
            "toc": [],
            "landmarks": [],
            "page_list": [],
            "table_metadata": [],
            "anchors": [],
            "next_ref": second_page,
        },
    )
    contents_page = member(
        "index/contents-0.json",
        {
            "units": [],
            "sections": json.loads(bodies["index/1.json"])["sections"],
            "toc": [],
            "landmarks": [],
            "page_list": [],
            "table_metadata": [],
            "anchors": [],
            "next_ref": None,
        },
    )
    member(
        "descriptor.json",
        {
            "media_id": str(media_id),
            "reader_generation": 7,
            "kind": "web_article",
            "title": "café 🧠 — retained seven",
            "reader_contract_version": 1,
            "first_unit_ref": first,
            "index_ref": first_page,
            "contents_ref": contents_page,
            "table_metadata_ref": None,
            "unit_count": 2,
            "canonical_length": 10,
        },
    )
    entries = [
        OfflineReadingEntry(
            path=key,
            media_type="image/png" if key == asset_key else "application/json",
            size_bytes=len(body),
            sha256=hashlib.sha256(body).hexdigest(),
        )
        for key, body in bodies.items()
    ]
    manifest = build_offline_reading_manifest_from_entries(
        media_id=media_id,
        media_kind="WebArticle",
        title="café 🧠 — retained seven",
        reader_generation=7,
        entries=entries,
    )
    files = {}
    for key, body in bodies.items():
        target = tmp_path / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
        files[key] = target
    limits = ReaderPublicationLimits(
        unit_bytes=2000,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    archive_path = tmp_path / "retained-unicode-schema-2.zip"
    assemble_offline_reading_zip_from_files(
        manifest, files, archive_path, publication_limits=limits
    )
    archive = archive_path.read_bytes()
    verified = verify_offline_reading_zip(archive, publication_limits=limits)
    assert verified.manifest.reader_generation == 7
    assert verified.manifest.title == "café 🧠 — retained seven"
    assert {entry.path for entry in verified.manifest.entries} == {
        "descriptor.json",
        "index/0.json",
        "index/1.json",
        "index/contents-0.json",
        asset_key,
        first["key"],
        second["key"],
    }
    assert (
        json.loads(bodies[first["key"]])["canonical_text"]
        + json.loads(bodies[second["key"]])["canonical_text"]
        == "café 🧠\ncat"
    )
    (tmp_path / "retained-unicode-schema-2.json").write_text(
        json.dumps(
            {
                "package_sha256": hashlib.sha256(archive).hexdigest(),
                "expanded_bytes": verified.expanded_length,
                "canonical_text": "café 🧠\ncat",
                "fragment_id": fragment_id,
                "manifest": manifest.model_dump(mode="json", by_alias=True),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )


def test_table_context_pages_are_closed_separate_and_source_bound(tmp_path: Path) -> None:
    fixture = Path(__file__).parents[3] / "testdata/offline-reading/retained-unicode-schema-2.zip"
    with zipfile.ZipFile(fixture) as archive:
        bodies = {key: archive.read(key) for key in archive.namelist() if key != "manifest.json"}
    fragment = "00000000-0000-4000-8000-000000000008"
    first_key = f"units/{fragment}/0-7-0.json"
    second_key = f"units/{fragment}/7-10-0.json"
    context_key = f"index/tables/{fragment}/0/1-0/0.json"
    first = json.loads(bodies[first_key])
    second = json.loads(bodies[second_key])
    asset_key = "assets/web/0123456789abcdef"

    def table_nodes(row: int, cell: str, text: str) -> list[dict]:
        return [
            {
                "kind": "Element",
                "parent": None,
                "namespace": "html",
                "name": "table",
                "attributes": [
                    {"namespace": None, "name": "data-nexus-table", "value": "0"},
                    {"namespace": None, "name": "aria-rowcount", "value": "2"},
                    {"namespace": None, "name": "aria-colcount", "value": "1"},
                ],
            },
            {
                "kind": "Element",
                "parent": 0,
                "namespace": "html",
                "name": "tbody",
                "attributes": [],
            },
            {
                "kind": "Element",
                "parent": 1,
                "namespace": "html",
                "name": "tr",
                "attributes": [{"namespace": None, "name": "aria-rowindex", "value": str(row + 1)}],
            },
            {
                "kind": "Element",
                "parent": 2,
                "namespace": "html",
                "name": cell,
                "attributes": [
                    {"namespace": None, "name": "data-nexus-table", "value": "0"},
                    {"namespace": None, "name": "data-nexus-row", "value": str(row)},
                    {"namespace": None, "name": "data-nexus-column", "value": "0"},
                    {"namespace": None, "name": "aria-colindex", "value": "1"},
                ],
            },
            {"kind": "Text", "parent": 3, "text": text},
        ]

    first["render_nodes"] = table_nodes(0, "th", "café 🧠") + [first["render_nodes"][-1]]
    second["render_nodes"] = table_nodes(1, "td", "cat")
    source_range = {"unit_key": first_key, "fragment_id": fragment, "start_cp": 0, "end_cp": 6}
    context = {
        "units": [],
        "sections": [],
        "toc": [],
        "landmarks": [],
        "page_list": [],
        "table_metadata": [
            {
                "kind": "Table",
                "fragment_id": fragment,
                "table_ordinal": 0,
                "row_count": 2,
                "column_count": 1,
                "caption": None,
            },
            {
                "kind": "Cell",
                "fragment_id": fragment,
                "table_ordinal": 0,
                "row": 0,
                "column": 0,
                "row_span": 1,
                "column_span": 1,
                "row_group": 0,
                "header_kind": "column",
                "empty": False,
                "explicit_headers": False,
                "range": source_range,
            },
            {
                "kind": "Cell",
                "fragment_id": fragment,
                "table_ordinal": 0,
                "row": 1,
                "column": 0,
                "row_span": 1,
                "column_span": 1,
                "row_group": 0,
                "header_kind": "data",
                "empty": False,
                "explicit_headers": True,
                "range": {
                    "unit_key": second_key,
                    "fragment_id": fragment,
                    "start_cp": 7,
                    "end_cp": 10,
                },
            },
        ],
        "anchors": [],
        "next_ref": None,
    }
    limits = ReaderPublicationLimits(
        unit_bytes=2500,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=2000,
        descriptor_bytes=1000,
    )

    def member(key: str, value: dict) -> dict:
        body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
        bodies[key] = body
        return {"key": key, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}

    explicit_key = f"index/tables/{fragment}/0/1-0/1.json"
    explicit_page = {
        "units": [],
        "sections": [],
        "toc": [],
        "landmarks": [],
        "page_list": [],
        "anchors": [],
        "table_metadata": [
            {
                "kind": "ExplicitHeader",
                "fragment_id": fragment,
                "table_ordinal": 0,
                "row": 1,
                "column": 0,
                "target_row": 0,
                "target_column": 0,
            }
        ],
        "next_ref": None,
    }

    def assemble() -> tuple[bytes, OfflineReadingManifest]:
        explicit_ref = member(explicit_key, explicit_page)
        if context["next_ref"] is None or context["next_ref"]["key"] == explicit_key:
            context["next_ref"] = explicit_ref
        header_ref = member(context_key, context)
        for row, unit in enumerate((first, second)):
            unit["table_contexts"] = [
                {
                    "table_ordinal": 0,
                    "row_count": 2,
                    "column_count": 1,
                    "caption": None,
                    "cells": [
                        {
                            "row": row,
                            "column": 0,
                            "row_span": 1,
                            "column_span": 1,
                            "continued_before": False,
                            "continued_after": False,
                        }
                    ],
                }
            ]
        first_ref, second_ref = member(first_key, first), member(second_key, second)
        last_page = json.loads(bodies["index/1.json"])
        last_page["units"][0]["member"] = second_ref
        last_ref = member("index/1.json", last_page)
        first_page = json.loads(bodies["index/0.json"])
        first_page["units"][0]["member"] = first_ref
        first_page["next_ref"] = last_ref
        index_ref = member("index/0.json", first_page)
        descriptor = json.loads(bodies["descriptor.json"])
        descriptor.update(
            first_unit_ref=first_ref, index_ref=index_ref, table_metadata_ref=header_ref
        )
        member("descriptor.json", descriptor)
        entries, files = [], {}
        for key, body in bodies.items():
            target = tmp_path / key
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            files[key] = target
            entries.append(
                OfflineReadingEntry(
                    path=key,
                    media_type="image/png" if key == asset_key else "application/json",
                    size_bytes=len(body),
                    sha256=hashlib.sha256(body).hexdigest(),
                )
            )
        manifest = build_offline_reading_manifest_from_entries(
            media_id=UUID("00000000-0000-4000-8000-000000000007"),
            media_kind="WebArticle",
            title="café 🧠 — retained seven",
            reader_generation=7,
            entries=entries,
        )
        path = tmp_path / "retained-table-context-schema-2.zip"
        assemble_offline_reading_zip_from_files(manifest, files, path, publication_limits=limits)
        return path.read_bytes(), manifest

    payload, manifest = assemble()
    verified = verify_offline_reading_zip(payload, publication_limits=limits)
    assert verified.manifest.reader_generation == 7
    assert isinstance(verified.reader_document, ReaderPublicationTextDescriptor)
    assert verified.reader_document.unit_count == 2
    with zipfile.ZipFile(io.BytesIO(payload)) as packaged:
        published_header = json.loads(packaged.read(context_key))
    assert published_header["table_metadata"][1]["range"] == {
        "unit_key": first_key,
        "fragment_id": fragment,
        "start_cp": 0,
        "end_cp": 6,
    }, "the packaged header cell lost its binding to the first unit's exact extent"
    assert first["canonical_text"] + second["canonical_text"] == "café 🧠\ncat"
    (tmp_path / "retained-table-context-schema-2.json").write_text(
        json.dumps(
            {
                "package_sha256": hashlib.sha256(payload).hexdigest(),
                "expanded_bytes": verified.expanded_length,
                "canonical_text": "café 🧠\ncat",
                "fragment_id": fragment,
                "manifest": manifest.model_dump(mode="json", by_alias=True),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )

    source_range["fragment_id"] = "00000000-0000-4000-8000-000000000009"
    with pytest.raises(OfflineReadingPackageError, match="source range"):
        assemble()
    source_range["fragment_id"] = fragment
    context["next_ref"] = {"key": context_key, "bytes": 1, "sha256": "0" * 64}
    with pytest.raises(OfflineReadingPackageError, match="cycle"):
        assemble()


def _reviewed_revision_key(reader_generation: int, entries: list[dict[str, Any]]) -> str:
    """An independent implementation of the reviewed revision algorithm.

    Every field comes from `readerRevisionAlgorithm` in the shared cross-language
    vector, so this oracle follows the reviewed contract rather than the
    production code it checks. A silent change to the domain separator, the
    ordering rule, or any field width makes the two disagree.
    """
    algorithm = _CORPUS["readerRevisionAlgorithm"]
    digest = hashlib.sha256()
    digest.update(algorithm["domainSeparatorUtf8"].encode("utf-8"))
    digest.update(struct.pack(">Q", reader_generation))
    for entry in sorted(entries, key=lambda item: item["path"].encode("utf-8")):
        path_bytes = entry["path"].encode("utf-8")
        media_type_bytes = entry["mediaType"].encode("ascii")
        digest.update(struct.pack(">I", len(path_bytes)))
        digest.update(path_bytes)
        digest.update(bytes.fromhex(entry["sha256"]))
        digest.update(struct.pack(">Q", entry["sizeBytes"]))
        digest.update(struct.pack(">H", len(media_type_bytes)))
        digest.update(media_type_bytes)
    return digest.hexdigest()


def test_revision_key_binds_the_reviewed_cross_language_algorithm() -> None:
    """Order must not matter; every declared field must."""
    algorithm = _CORPUS["readerRevisionAlgorithm"]
    assert OFFLINE_READING_REVISION_DOMAIN == algorithm["domainSeparatorUtf8"].encode("utf-8"), (
        "the producer's revision domain separator differs from the reviewed contract"
    )
    entries = [
        {
            "path": "descriptor.json",
            "mediaType": "application/json",
            "sizeBytes": 3,
            "sha256": "a" * 64,
        },
        {
            "path": "assets/cover.svg",
            "mediaType": "image/svg+xml",
            "sizeBytes": 5,
            "sha256": "b" * 64,
        },
    ]
    baseline = _reviewed_revision_key(7, entries)

    produced = compute_reader_revision_key(
        7, [OfflineReadingEntry.model_validate(entry) for entry in reversed(entries)]
    )

    assert produced == baseline, (
        "the producer and the reviewed algorithm disagree about this package's revision key"
    )
    assert _reviewed_revision_key(7, list(reversed(entries))) == baseline, (
        "the reviewed algorithm depends on input order instead of UTF-8 path order"
    )
    for field, changed in (
        ("path", "descriptor.jsonx"),
        ("mediaType", "text/plain"),
        ("sizeBytes", 4),
        ("sha256", "c" * 64),
    ):
        mutated = copy.deepcopy(entries)
        mutated[0][field] = changed
        assert _reviewed_revision_key(7, mutated) != baseline, (
            f"the revision key ignores the declared {field} field"
        )
    assert _reviewed_revision_key(8, entries) != baseline, (
        "the revision key ignores the declared readerGeneration prelude"
    )


@pytest.mark.parametrize(
    "path",
    (
        "",
        "/descriptor.json",
        "../descriptor.json",
        "assets/../descriptor.json",
        "assets\\cover.svg",
        "assets//cover.svg",
        "assets/cover.zip",
        "manifest.json",
        "a" * (OFFLINE_READING_MAX_PATH_BYTES + 1),
    ),
    ids=(
        "empty",
        "absolute",
        "leading-traversal",
        "embedded-traversal",
        "backslash",
        "empty-segment",
        "nested-archive",
        "reserved-manifest",
        "overlong-utf8",
    ),
)
def test_entry_path_grammar_rejects_escape_alias_and_nested_archive_paths(path: str) -> None:
    with pytest.raises(ValidationError):
        OfflineReadingEntry(
            path=path,
            mediaType="application/json",
            sizeBytes=1,
            sha256="0" * 64,
        )


def test_manifest_bounds_and_mime_are_closed_not_advisory(tmp_path: Path) -> None:
    fixture = Path(__file__).parents[3] / "testdata/offline-reading/retained-unicode-schema-2.zip"
    with zipfile.ZipFile(fixture) as archive:
        base = json.loads(archive.read("manifest.json"))

    assert (
        parse_offline_reading_manifest(
            json.dumps(base, separators=(",", ":")).encode("utf-8")
        ).package_schema_version
        == 2
    )
    with pytest.raises(ValidationError):
        OfflineReadingManifest.model_validate({**base, "packageSchemaVersion": 1})
    with pytest.raises(ValidationError):
        OfflineReadingManifest.model_validate({**base, "minimumReaderBundleVersion": 1})
    with pytest.raises(ValidationError):
        OfflineReadingManifest.model_validate({**base, "title": "x" * 513})
    with pytest.raises(ValidationError):
        OfflineReadingManifest.model_validate(
            {**base, "entries": [base["entries"][0]] * (OFFLINE_READING_MAX_ENTRIES + 1)}
        )
    with pytest.raises(ValidationError):
        OfflineReadingEntry.model_validate(
            {**base["entries"][0], "mediaType": "application/json; charset=utf-8"}
        )
    with pytest.raises(ValidationError, match="SVG members"):
        OfflineReadingEntry(
            path="assets/large.svg",
            mediaType="image/svg+xml",
            sizeBytes=OFFLINE_READING_MAX_SVG_BYTES + 1,
            sha256="0" * 64,
        )
    oversized = copy.deepcopy(base)
    for entry in oversized["entries"]:
        entry["sizeBytes"] = OFFLINE_READING_MAX_EXPANDED_BYTES
    with pytest.raises(ValidationError, match="expanded byte bound"):
        OfflineReadingManifest.model_validate(oversized)
    with pytest.raises(ValueError, match="BOM"):
        parse_offline_reading_manifest(
            b"\xef\xbb\xbf" + json.dumps(base, separators=(",", ":")).encode("utf-8")
        )
    duplicated = (
        json.dumps(base, separators=(",", ":"))
        .encode("utf-8")
        .replace(b'"mediaKind":', b'"mediaKind":"Pdf","mediaKind":', 1)
    )
    with pytest.raises(ValueError, match="duplicate JSON object key"):
        parse_offline_reading_manifest(duplicated)


def _asset_publication(media_type: str, body: bytes):
    """Replace one source member in the reviewed two-unit graph, rebinding each edge."""
    fixture = Path(__file__).parents[3] / "testdata/offline-reading/retained-unicode-schema-2.zip"
    with zipfile.ZipFile(fixture) as archive:
        bodies = {
            name: archive.read(name) for name in archive.namelist() if name != "manifest.json"
        }
        original = json.loads(archive.read("manifest.json"))
    descriptor = json.loads(bodies["descriptor.json"])
    unit_key = descriptor["first_unit_ref"]["key"]
    index_key = descriptor["index_ref"]["key"]
    unit = json.loads(bodies[unit_key])
    asset = unit["assets"][0]
    asset_key = asset["member"]["key"]
    bodies[asset_key] = body
    asset["member"] = {
        "key": asset_key,
        "bytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
    }
    asset["media_type"] = media_type
    bodies[unit_key] = json.dumps(unit, ensure_ascii=False, separators=(",", ":")).encode()
    unit_ref = {
        "key": unit_key,
        "bytes": len(bodies[unit_key]),
        "sha256": hashlib.sha256(bodies[unit_key]).hexdigest(),
    }
    index = json.loads(bodies[index_key])
    assert index["units"][0]["member"]["key"] == unit_key
    index["units"][0]["member"] = unit_ref
    bodies[index_key] = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode()
    descriptor["first_unit_ref"] = unit_ref
    descriptor["index_ref"] = {
        "key": index_key,
        "bytes": len(bodies[index_key]),
        "sha256": hashlib.sha256(bodies[index_key]).hexdigest(),
    }
    bodies["descriptor.json"] = json.dumps(
        descriptor, ensure_ascii=False, separators=(",", ":")
    ).encode()
    manifest = build_offline_reading_manifest_from_entries(
        media_id=original["mediaId"],
        media_kind=original["mediaKind"],
        title=original["title"],
        reader_generation=original["readerGeneration"],
        entries=[
            OfflineReadingEntry(
                path=key,
                media_type=media_type if key == asset_key else "application/json",
                size_bytes=len(value),
                sha256=hashlib.sha256(value).hexdigest(),
            )
            for key, value in bodies.items()
        ],
    )
    limits = ReaderPublicationLimits(
        unit_bytes=2000,
        unit_codepoints=160,
        unit_dom_nodes=20,
        index_bytes=2000,
        descriptor_bytes=1000,
    )
    return manifest, bodies, limits


def test_schema_two_svg_keeps_namespace_and_local_reference_content() -> None:
    body = b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><path id="shape" d="M0 0h1"/></defs><use xlink:href="#shape"/><desc>https://example.invalid is inert text</desc></svg>'
    manifest, bodies, limits = _asset_publication("image/svg+xml", body)
    verified = verify_offline_reading_package(manifest, bodies, publication_limits=limits)
    assert verified.manifest == manifest


@pytest.mark.parametrize(
    ("media_type", "body", "message"),
    (
        (
            "image/svg+xml",
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            "executable",
        ),
        (
            "image/svg+xml",
            b'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/a.png"/></svg>',
            "remote|non-local",
        ),
        (
            "image/svg+xml",
            b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
            "executable",
        ),
        ("image/png", b"not a png", "does not match its MIME"),
    ),
    ids=("svg-script", "svg-remote", "svg-handler", "false-mime"),
)
def test_schema_two_assets_reject_executable_remote_and_false_mime_content(
    media_type: str, body: bytes, message: str
) -> None:
    manifest, bodies, limits = _asset_publication(media_type, body)
    with pytest.raises(OfflineReadingPackageError, match=message):
        verify_offline_reading_package(manifest, bodies, publication_limits=limits)


def test_schema_two_manifest_rejects_coercion_alias_and_nested_duplicate_keys() -> None:
    fixture = Path(__file__).parents[3] / "testdata/offline-reading/retained-unicode-schema-2.zip"
    with zipfile.ZipFile(fixture) as archive:
        case = json.loads(archive.read("manifest.json"))
    for changed in (
        {**case, "readerGeneration": "7"},
        {**case, "unknown": True},
        {
            "package_schema_version": case["packageSchemaVersion"],
            **{key: value for key, value in case.items() if key != "packageSchemaVersion"},
        },
    ):
        with pytest.raises(ValidationError):
            parse_offline_reading_manifest(json.dumps(changed, separators=(",", ":")).encode())
    encoded = json.dumps(case, separators=(",", ":")).encode()
    duplicate = encoded.replace(b'"path":', b'"path":"other","path":', 1)
    assert duplicate != encoded
    with pytest.raises(ValueError, match="duplicate JSON object key.*path"):
        parse_offline_reading_manifest(duplicate)
    with pytest.raises(OfflineReadingPackageError):
        verify_offline_reading_zip(b"not a ZIP")
