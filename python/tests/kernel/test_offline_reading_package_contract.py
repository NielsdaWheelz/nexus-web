"""Pure V1 offline-reading package conformance against the shared corpus."""

from __future__ import annotations

import copy
import hashlib
import io
import json
import stat
import struct
import zipfile
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from nexus.schemas.offline_reading_package import (
    OFFLINE_READING_MAX_ENTRIES,
    OFFLINE_READING_MAX_EXPANDED_BYTES,
    OFFLINE_READING_MAX_PATH_BYTES,
    OFFLINE_READING_MAX_READER_JSON_BYTES,
    OFFLINE_READING_MAX_SVG_BYTES,
    OfflineReadingEntry,
    OfflineReadingManifest,
    PdfOfflineReaderDocument,
    parse_offline_reader_document,
    parse_offline_reading_manifest,
)
from nexus.services.offline_reading_packages import (
    OFFLINE_READING_REVISION_DOMAIN,
    OFFLINE_READING_ZIP_MEDIA_TYPE,
    OfflineReadingPackageError,
    OfflineReadingPackageMember,
    assemble_offline_reading_zip,
    assemble_offline_reading_zip_file,
    assemble_offline_reading_zip_from_files,
    build_offline_reading_manifest,
    build_offline_reading_manifest_from_entries,
    compute_reader_revision_key,
    verify_offline_reading_package,
    verify_offline_reading_zip,
)
from nexus.services.stream_tokens import OFFLINE_READING_PACKAGE_SCHEMA_VERSION

_REPO_ROOT = Path(__file__).parents[3]
_CORPUS = json.loads(
    (_REPO_ROOT / "testdata/offline-reading-contract-v1.json").read_text(encoding="utf-8")
)
_READERS = {case["id"]: case["utf8"] for case in _CORPUS["readerDocuments"]}
_PACKAGES = {case["name"]: case for case in _CORPUS["validPackages"]}


def _entry_bodies(case: dict[str, Any]) -> dict[str, bytes]:
    return {
        item["path"]: (
            _READERS[item["readerDocument"]].encode("utf-8")
            if "readerDocument" in item
            else item["utf8"].encode("utf-8")
        )
        for item in case["package"]["entryBodies"]
    }


def _apply_patch(document: dict[str, Any], operations: list[dict[str, Any]]) -> None:
    """Apply only the independently reviewed corpus's small JSON-Patch subset."""
    for operation in operations:
        path = operation["path"].strip("/").split("/")
        target: Any = document
        for segment in path[:-1]:
            target = target[int(segment)] if isinstance(target, list) else target[segment]
        leaf = path[-1]
        if operation["op"] == "replace":
            if isinstance(target, list):
                target[int(leaf)] = operation["value"]
            else:
                target[leaf] = operation["value"]
        elif operation["op"] == "remove":
            target.pop(int(leaf) if isinstance(target, list) else leaf)
        elif operation["op"] == "add" and isinstance(target, list) and leaf == "-":
            target.append(operation["value"])
        elif operation["op"] == "move":
            source_path = operation["from"].strip("/").split("/")
            source: Any = document
            for segment in source_path[:-1]:
                source = source[int(segment)] if isinstance(source, list) else source[segment]
            value = source.pop(int(source_path[-1]))
            target.insert(int(leaf), value)
        else:  # pragma: no cover - the registered corpus controls this helper's input
            raise AssertionError(f"unsupported corpus patch: {operation!r}")


def test_url_text_is_inert_but_the_same_bytes_in_an_attribute_are_remote() -> None:
    reader = json.loads(_READERS["web-text-only"])
    reader["fragments"][0]["htmlSanitized"] = (
        "<p>The source text says https://example.invalid without fetching it.</p>"
    )
    reader["fragments"][0]["canonicalText"] = (
        "The source text says https://example.invalid without fetching it."
    )
    parsed = parse_offline_reader_document(
        json.dumps(reader, separators=(",", ":")).encode("utf-8")
    )
    assert parsed.fragments[0].canonical_text.endswith("without fetching it.")  # type: ignore[union-attr]

    reader["fragments"][0]["htmlSanitized"] = '<p><a href="https://example.invalid">Remote</a></p>'
    with pytest.raises(ValidationError, match="remote or executable URL"):
        parse_offline_reader_document(json.dumps(reader, separators=(",", ":")).encode("utf-8"))

    # `ping` is hyperlink auditing: activating the link POSTs to that URL, so it
    # is a remote subresource wearing an unlisted attribute name.
    reader["fragments"][0]["htmlSanitized"] = (
        '<p><a href="#local" ping="https://example.invalid/beacon">Local</a></p>'
    )
    with pytest.raises(ValidationError, match="remote or executable URL"):
        parse_offline_reader_document(json.dumps(reader, separators=(",", ":")).encode("utf-8"))


@pytest.mark.parametrize(
    ("field", "value", "message"),
    (
        ("fragmentId", "not-a-uuid", "canonical UUID"),
        ("hrefPath", "../chapter.xhtml", "traversal"),
        ("hrefPath", "https://example.invalid/chapter.xhtml", "origin"),
        ("startOffset", 24, "endOffset"),
        ("endOffset", 24, "canonicalText"),
    ),
)
def test_epub_locator_identity_and_offsets_fail_closed(
    field: str,
    value: object,
    message: str,
) -> None:
    reader = json.loads(_READERS["epub-with-local-asset"])
    reader["sections"][0][field] = value

    with pytest.raises(ValidationError, match=message):
        parse_offline_reader_document(json.dumps(reader, separators=(",", ":")).encode("utf-8"))


def _rewritten_zip(
    original: bytes,
    *,
    target_path: str,
    timestamp: tuple[int, int, int, int, int, int] | None = None,
    symlink: bool = False,
    add_nested_archive: bool = False,
) -> bytes:
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


@pytest.mark.parametrize("case", _CORPUS["validPackages"], ids=lambda case: case["name"])
def test_shared_v1_packages_bind_reader_identity_entries_and_revision(case: dict[str, Any]) -> None:
    manifest = parse_offline_reading_manifest(
        json.dumps(case["package"]["manifest"], separators=(",", ":")).encode("utf-8")
    )
    bodies = _entry_bodies(case)

    verified = verify_offline_reading_package(manifest, bodies)

    assert verified.manifest.reader_revision_key == case["package"]["manifest"]["readerRevisionKey"]
    assert (
        compute_reader_revision_key(manifest.reader_generation, manifest.entries)
        == (case["package"]["manifest"]["readerRevisionKey"])
    )
    assert verified.reader_document.media_id == manifest.media_id
    assert verified.reader_document.media_kind == manifest.media_kind
    assert verified.reader_document.title == manifest.title

    rebuilt, rebuilt_bodies = build_offline_reading_manifest(
        media_id=manifest.media_id,
        media_kind=manifest.media_kind,
        title=manifest.title,
        reader_generation=manifest.reader_generation,
        members=(
            OfflineReadingPackageMember(entry.path, entry.media_type, bodies[entry.path])
            for entry in manifest.entries
        ),
    )
    assert rebuilt == manifest
    assert rebuilt_bodies == bodies


@pytest.mark.parametrize(
    "case",
    _CORPUS["validSvgAssetCases"],
    ids=lambda case: case["name"],
)
def test_shared_svg_assets_accept_namespace_declarations(case: dict[str, Any]) -> None:
    reader_body = _READERS["epub-with-local-asset"].encode("utf-8")
    asset_body = case["utf8"].encode("utf-8")

    manifest, bodies = build_offline_reading_manifest(
        media_id="018f2e74-5efc-7d1e-8a3a-142857142857",
        media_kind="Epub",
        title="Plane Notes EPUB",
        reader_generation=11,
        members=(
            OfflineReadingPackageMember(case["path"], case["mediaType"], asset_body),
            OfflineReadingPackageMember("reader.json", "application/json", reader_body),
        ),
    )

    verified = verify_offline_reading_package(manifest, bodies)

    assert case["expect"] == {"kind": "Accept"}
    assert bodies[case["path"]] == asset_body
    assert verified.expanded_length == sum(entry.size_bytes for entry in manifest.entries)


@pytest.mark.parametrize("case", _CORPUS["readerDocuments"], ids=lambda case: case["id"])
def test_shared_reader_documents_accept_only_the_reviewed_strict_local_projection(
    case: dict[str, Any],
) -> None:
    package_case = _PACKAGES.get(case.get("package", ""))
    manifest = None
    bodies = None
    if package_case is not None:
        manifest = parse_offline_reading_manifest(
            json.dumps(package_case["package"]["manifest"], separators=(",", ":")).encode()
        )
        bodies = _entry_bodies(package_case)

    if case["expect"]["kind"] == "Reject":
        with pytest.raises((OfflineReadingPackageError, ValidationError, ValueError)):
            if manifest is None:
                parse_offline_reader_document(case["utf8"].encode("utf-8"))
            else:
                mutated_bodies = {**bodies, "reader.json": case["utf8"].encode("utf-8")}
                build_offline_reading_manifest(
                    media_id=manifest.media_id,
                    media_kind=manifest.media_kind,
                    title=manifest.title,
                    reader_generation=manifest.reader_generation,
                    members=(
                        OfflineReadingPackageMember(
                            entry.path,
                            entry.media_type,
                            mutated_bodies[entry.path],
                        )
                        for entry in manifest.entries
                    ),
                )
        return

    reader = parse_offline_reader_document(case["utf8"].encode("utf-8"))
    expected = case["expect"]
    assert str(reader.media_id) == expected["mediaId"]
    assert reader.media_kind == expected["mediaKind"]
    assert reader.title == expected["title"]
    if isinstance(reader, PdfOfflineReaderDocument):
        assert reader.document_path == expected["documentPath"]
    elif reader.media_kind == "Epub":
        assert [item.section_id for item in reader.navigation] == expected["navigationOrder"]
        assert [item.section_id for item in reader.sections] == expected["sectionOrder"]
        assert (
            sorted({path for item in reader.sections for path in item.asset_paths})
            == expected["referencedAssetPaths"]
        )
    else:
        assert [item.fragment_id for item in reader.fragments] == expected["fragmentOrder"]


@pytest.mark.parametrize("case", _CORPUS["invalidPackageCases"], ids=lambda case: case["name"])
def test_shared_package_mutations_fail_closed(case: dict[str, Any]) -> None:
    envelope = {"package": copy.deepcopy(_PACKAGES[case["base"]]["package"])}
    _apply_patch(envelope, case["patch"])
    package = envelope["package"]

    with pytest.raises((OfflineReadingPackageError, ValidationError, ValueError)):
        manifest = OfflineReadingManifest.model_validate(package["manifest"])
        verify_offline_reading_package(
            manifest,
            {
                item["path"]: (
                    _READERS[item["readerDocument"]].encode()
                    if "readerDocument" in item
                    else item["utf8"].encode()
                )
                for item in package["entryBodies"]
            },
        )


@pytest.mark.parametrize("case", _CORPUS["invalidRawJsonCases"], ids=lambda case: case["name"])
def test_shared_raw_manifest_json_rejects_duplicate_and_unknown_keys(case: dict[str, Any]) -> None:
    with pytest.raises((ValidationError, ValueError)):
        parse_offline_reading_manifest(case["utf8"].encode("utf-8"))


def test_deterministic_zip_has_one_fixed_representation_and_round_trips() -> None:
    case = _PACKAGES["epub-local-asset-copy"]
    manifest = OfflineReadingManifest.model_validate(case["package"]["manifest"])
    bodies = _entry_bodies(case)

    first = assemble_offline_reading_zip(manifest, bodies)
    second = assemble_offline_reading_zip(manifest, dict(reversed(tuple(bodies.items()))))
    verified = verify_offline_reading_zip(first)

    assert first == second
    assert verified.manifest == manifest
    with zipfile.ZipFile(io.BytesIO(first)) as archive:
        assert archive.namelist() == ["manifest.json", *bodies]
        assert all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist())
        assert all(stat.S_IMODE(info.external_attr >> 16) == 0o644 for info in archive.infolist())


def test_file_assembly_is_the_same_deterministic_representation(
    tmp_path: Path,
) -> None:
    case = _PACKAGES["pdf-verified-copy"]
    manifest = OfflineReadingManifest.model_validate(case["package"]["manifest"])
    bodies = _entry_bodies(case)
    path = tmp_path / "package.zip"

    length = assemble_offline_reading_zip_file(manifest, bodies, path)

    assert length == path.stat().st_size
    assert path.read_bytes() == assemble_offline_reading_zip(manifest, bodies)


def test_staged_file_assembly_is_streamed_and_byte_identical(tmp_path: Path) -> None:
    case = _PACKAGES["epub-local-asset-copy"]
    manifest = OfflineReadingManifest.model_validate(case["package"]["manifest"])
    bodies = _entry_bodies(case)
    members: dict[str, Path] = {}
    for entry in manifest.entries:
        source = tmp_path.joinpath("members", *entry.path.split("/"))
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(bodies[entry.path])
        members[entry.path] = source
    rebuilt = build_offline_reading_manifest_from_entries(
        media_id=manifest.media_id,
        media_kind=manifest.media_kind,
        title=manifest.title,
        reader_generation=manifest.reader_generation,
        entries=manifest.entries,
    )
    output = tmp_path / "streamed.zip"
    checkpoints = 0

    def checkpoint() -> None:
        nonlocal checkpoints
        checkpoints += 1

    length = assemble_offline_reading_zip_from_files(
        rebuilt,
        members,
        output,
        checkpoint=checkpoint,
    )

    assert checkpoints >= len(members) * 2
    assert length == output.stat().st_size
    assert output.read_bytes() == assemble_offline_reading_zip(manifest, bodies)


def test_staged_file_assembly_observes_cooperative_cancellation(tmp_path: Path) -> None:
    case = _PACKAGES["pdf-verified-copy"]
    manifest = OfflineReadingManifest.model_validate(case["package"]["manifest"])
    members: dict[str, Path] = {}
    for entry in manifest.entries:
        source = tmp_path.joinpath("members", *entry.path.split("/"))
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(_entry_bodies(case)[entry.path])
        members[entry.path] = source
    calls = 0

    def cancel_during_verification() -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise TimeoutError("cancelled")

    with pytest.raises(TimeoutError, match="cancelled"):
        assemble_offline_reading_zip_from_files(
            manifest,
            members,
            tmp_path / "partial.zip",
            checkpoint=cancel_during_verification,
        )


@pytest.mark.parametrize("case", _CORPUS["invalidArchiveCases"], ids=lambda case: case["name"])
def test_shared_invalid_zip_attributes_and_members_fail_closed(case: dict[str, Any]) -> None:
    package_case = _PACKAGES[
        "epub-local-asset-copy" if case["zipAttribute"] == "nestedArchive" else "pdf-verified-copy"
    ]
    manifest = OfflineReadingManifest.model_validate(package_case["package"]["manifest"])
    archive = assemble_offline_reading_zip(manifest, _entry_bodies(package_case))

    if case["zipAttribute"] == "symlink":
        mutated = _rewritten_zip(archive, target_path=case["entryPath"], symlink=True)
    elif case["zipAttribute"] == "nestedArchive":
        mutated = _rewritten_zip(
            archive,
            target_path=case["entryPath"],
            add_nested_archive=True,
        )
    else:
        mutated = _rewritten_zip(
            archive,
            target_path=case["entryPath"],
            timestamp=(2026, 1, 1, 0, 0, 0),
        )

    with pytest.raises(OfflineReadingPackageError):
        verify_offline_reading_zip(mutated)


@pytest.mark.parametrize(
    "path",
    (
        "",
        "/reader.json",
        "../reader.json",
        "assets/../reader.json",
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


def test_v1_bounds_and_mime_are_closed_not_advisory() -> None:
    base = _PACKAGES["web-text-only-copy"]["package"]["manifest"]
    with pytest.raises(ValidationError):
        OfflineReadingManifest.model_validate({**base, "title": "x" * 513})
    with pytest.raises(ValidationError):
        OfflineReadingManifest.model_validate(
            {
                **base,
                "entries": [base["entries"][0]] * (OFFLINE_READING_MAX_ENTRIES + 1),
            }
        )
    with pytest.raises(ValidationError):
        OfflineReadingEntry.model_validate(
            {
                **base["entries"][0],
                "mediaType": "application/json; charset=utf-8",
            }
        )
    with pytest.raises(ValidationError, match="SVG members"):
        OfflineReadingEntry(
            path="assets/large.svg",
            mediaType="image/svg+xml",
            sizeBytes=OFFLINE_READING_MAX_SVG_BYTES + 1,
            sha256="0" * 64,
        )
    with pytest.raises(ValidationError, match="reader.json"):
        OfflineReadingEntry(
            path="reader.json",
            mediaType="application/json",
            sizeBytes=OFFLINE_READING_MAX_READER_JSON_BYTES + 1,
            sha256="0" * 64,
        )
    with pytest.raises(ValidationError):
        OfflineReadingEntry.model_validate(
            {
                **base["entries"][0],
                "sizeBytes": OFFLINE_READING_MAX_EXPANDED_BYTES + 1,
            }
        )
    pdf = copy.deepcopy(_PACKAGES["pdf-verified-copy"]["package"]["manifest"])
    for entry in pdf["entries"]:
        if entry["path"] != "reader.json":
            entry["sizeBytes"] = OFFLINE_READING_MAX_EXPANDED_BYTES
    with pytest.raises(ValidationError, match="expanded byte bound"):
        OfflineReadingManifest.model_validate(pdf)


def test_strict_json_rejects_bom_type_coercion_and_nested_duplicate_keys() -> None:
    case = _PACKAGES["pdf-verified-copy"]["package"]["manifest"]
    encoded = json.dumps(case, separators=(",", ":")).encode()
    with pytest.raises(ValueError, match="BOM"):
        parse_offline_reading_manifest(b"\xef\xbb\xbf" + encoded)

    coerced = {**case, "readerGeneration": "7"}
    with pytest.raises(ValidationError):
        parse_offline_reading_manifest(json.dumps(coerced, separators=(",", ":")).encode())

    snake_case_key = {
        "package_schema_version": case["packageSchemaVersion"],
        **{key: value for key, value in case.items() if key != "packageSchemaVersion"},
    }
    with pytest.raises(ValidationError):
        parse_offline_reading_manifest(json.dumps(snake_case_key, separators=(",", ":")).encode())

    duplicate_nested = encoded.replace(
        b'"path":"document.pdf"',
        b'"path":"other.pdf","path":"document.pdf"',
    )
    with pytest.raises(ValueError, match="duplicate JSON object key.*path"):
        parse_offline_reading_manifest(duplicate_nested)


@pytest.mark.parametrize(
    ("asset_media_type", "asset_body"),
    (
        (
            "image/svg+xml",
            b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
        (
            "image/svg+xml",
            b'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/a.png"/></svg>',
        ),
        ("image/png", b"not a png"),
    ),
    ids=("svg-script", "svg-remote-subresource", "false-mime"),
)
def test_epub_assets_reject_executable_remote_and_false_mime_content(
    asset_media_type: str,
    asset_body: bytes,
) -> None:
    reader_body = _READERS["epub-with-local-asset"].encode()
    with pytest.raises(OfflineReadingPackageError):
        build_offline_reading_manifest(
            media_id="018f2e74-5efc-7d1e-8a3a-142857142857",
            media_kind="Epub",
            title="Plane Notes EPUB",
            reader_generation=11,
            members=(
                OfflineReadingPackageMember("assets/cover.svg", asset_media_type, asset_body),
                OfflineReadingPackageMember("reader.json", "application/json", reader_body),
            ),
        )


def test_corrupt_zip_is_one_fail_closed_package_error() -> None:
    with pytest.raises(OfflineReadingPackageError):
        verify_offline_reading_zip(b"not a ZIP")


def test_integrity_valid_reader_json_still_cannot_change_manifest_media_identity() -> None:
    case = _PACKAGES["web-text-only-copy"]
    manifest = OfflineReadingManifest.model_validate(case["package"]["manifest"])
    changed_reader = (
        _READERS["web-text-only"]
        .replace(
            str(manifest.media_id),
            "018f2e74-5efc-7d2f-8a3a-142857142858",
        )
        .encode()
    )

    with pytest.raises(OfflineReadingPackageError, match="identity does not match"):
        build_offline_reading_manifest(
            media_id=manifest.media_id,
            media_kind=manifest.media_kind,
            title=manifest.title,
            reader_generation=manifest.reader_generation,
            members=(
                OfflineReadingPackageMember("reader.json", "application/json", changed_reader),
            ),
        )


def _reviewed_revision_key(reader_generation: int, entries: list[dict[str, Any]]) -> str:
    """An independent implementation of the reviewed revision algorithm.

    Every field comes from `readerRevisionAlgorithm` in the shared vector, so
    this oracle follows the reviewed contract rather than the production code it
    checks. A silent change to the domain separator, the ordering rule, or any
    field width makes the two disagree.
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


@pytest.mark.parametrize("case", _CORPUS["validPackages"], ids=lambda case: case["name"])
def test_reviewed_revision_algorithm_reproduces_every_published_revision_key(
    case: dict[str, Any],
) -> None:
    """The reviewed algorithm section is the oracle, not decoration."""
    manifest_case = case["package"]["manifest"]
    expected = manifest_case["readerRevisionKey"]

    reviewed = _reviewed_revision_key(manifest_case["readerGeneration"], manifest_case["entries"])

    assert reviewed == expected, (
        "the reviewed revision algorithm no longer reproduces the published key: "
        f"reviewed={reviewed} published={expected}"
    )
    assert expected == expected.lower() and len(expected) == 64
    manifest = parse_offline_reading_manifest(
        json.dumps(manifest_case, separators=(",", ":")).encode("utf-8")
    )
    assert compute_reader_revision_key(manifest.reader_generation, manifest.entries) == reviewed, (
        "the producer and the reviewed algorithm disagree about this package's revision key"
    )


def test_reviewed_revision_algorithm_binds_the_exact_domain_separator_and_ordering() -> None:
    """Order must not matter; every declared field must."""
    algorithm = _CORPUS["readerRevisionAlgorithm"]
    assert OFFLINE_READING_REVISION_DOMAIN == algorithm["domainSeparatorUtf8"].encode("utf-8"), (
        "the producer's revision domain separator differs from the reviewed contract"
    )

    entries = [
        {
            "path": "reader.json",
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

    assert _reviewed_revision_key(7, list(reversed(entries))) == baseline, (
        "the reviewed algorithm depends on input order instead of UTF-8 path order"
    )
    for field, changed in (
        ("path", "reader.jsonx"),
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


def test_reviewed_transport_names_only_facts_the_producer_actually_emits() -> None:
    """Every transport vector must name a real produced header or mint field.

    The client-side rejections in `invalidTransportCases` are owned by the
    native origin client, but each case can only be driven if the header or
    mint field it overrides is one this producer emits. Binding the corpus to
    the producer keeps a renamed header from leaving the corpus decorative.
    """
    transport = _CORPUS["validTransport"]
    response_headers = transport["package"]["responseHeaders"]

    assert response_headers["content-type"] == OFFLINE_READING_ZIP_MEDIA_TYPE
    assert transport["mint"]["packageSchemaVersion"] == OFFLINE_READING_PACKAGE_SCHEMA_VERSION
    assert transport["package"]["requestHeaders"] == {"accept-encoding": "identity"}
    assert transport["mint"]["packageBaseUrl"] == transport["mint"]["clientPinnedApiOrigin"], (
        "the accepted transport must mint the origin the client has pinned"
    )

    produced = set(response_headers)
    minted = set(transport["mint"])
    names = [case["name"] for case in _CORPUS["invalidTransportCases"]]
    assert len(names) == len(set(names))
    for case in _CORPUS["invalidTransportCases"]:
        assert case["expect"] == {"kind": "Reject"}
        overridden = set(case.get("responseHeaders", {})) | set(
            case.get("removeResponseHeaders", [])
        )
        # A rejected hop-by-hop/encoding header is precisely one this producer
        # never emits; every other override must name a produced header.
        assert overridden <= produced | {"content-encoding", "transfer-encoding", "location"}
        assert set(case.get("mint", {})) <= minted
        assert overridden or case.get("mint") or "status" in case, (
            f"transport case {case['name']} overrides nothing and can never be driven"
        )
    assert "reject-foreign-package-origin" in names, (
        "the reviewed corpus lost its package-origin fault case"
    )
