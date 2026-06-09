from __future__ import annotations

import hashlib
import io
import json
import posixpath
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from uuid import UUID, uuid5
from xml.etree import ElementTree as ET

from lxml.html import document_fromstring, tostring

from nexus.schemas.reader_apparatus import (
    ReaderApparatusEdgeOut,
    ReaderApparatusItemOut,
    ReaderApparatusResponse,
)
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.latex_apparatus import (
    LatexSourceArchiveSafetyConfig,
    extract_latex_biblatex_apparatus_from_archive,
)
from nexus.services.pdf_ingest import (
    _extract_pdf_legal_footnote_apparatus,
    _extract_pdf_native_link_apparatus,
    _merge_pdf_apparatus_results,
)
from nexus.services.pdf_scholarly_apparatus import extract_scholarly_tei_apparatus
from nexus.services.reader_apparatus import (
    EXTRACTOR_VERSION,
    _capabilities,
    attach_fragment_locators,
    collect_html_apparatus_targets,
    extract_html_apparatus,
    source_fingerprint,
)
from nexus.services.web_article_structure import prepare_web_article_fragment
from tests.reader_apparatus_corpus import (
    automated_fixture_cases,
    fixture_bytes,
    fixture_path,
)

REPO_ROOT = Path(__file__).parents[2]
FRONTEND_PAYLOAD_DIR = (
    REPO_ROOT / "apps/web/src/lib/reader/__fixtures__/reader-apparatus"
)
FRONTEND_PAYLOAD_INDEX_PATH = FRONTEND_PAYLOAD_DIR / "index.ts"
FRONTEND_MEDIA_NAMESPACE = UUID("11111111-1111-4111-8111-111111111111")
FRONTEND_FRAGMENT_NAMESPACE = UUID("22222222-2222-4222-8222-222222222222")
MEDIA_PANE_SHELL_PUBLICATION_FIXTURE_IDS = {
    "arxiv-2606-source-package",
    "epub-standardebooks-james-pragmatism",
    "html-distill-gp-full",
    "html-gwern-sidenote-full",
    "html-numinous-ttft-full",
    "html-tufte-css-full",
    "pdf-attention-native-link-graph",
    "pdf-law-review-footnotes",
    "tei-philpapers-lop-aiz-grobid-0-8-2",
}


@dataclass(frozen=True)
class FrontendPayloadArtifact:
    fixture_id: str
    path: Path
    payload: dict[str, Any]
    payload_bytes: bytes
    payload_sha256: str
    source_fixture_sha256: str
    surface_contract: str
    expected_reader_tools_surface: str
    expected_status: str
    expected_item_count: int
    expected_edge_count: int
    body_needles: list[str]
    row_count: int


def frontend_payload_artifacts() -> list[FrontendPayloadArtifact]:
    artifacts = [
        build_frontend_payload_artifact(case)
        for case in automated_fixture_cases()
        if _should_generate_frontend_payload(case)
    ]
    return sorted(artifacts, key=lambda artifact: artifact.fixture_id)


def build_frontend_payload_artifact(case: dict[str, Any]) -> FrontendPayloadArtifact:
    media_id = _media_uuid(str(case["id"]))
    result = _extract_fixture_apparatus(case, media_id=media_id)
    items = [
        ReaderApparatusItemOut.model_validate(_strip_private_item_fields(item)).model_dump(
            mode="json"
        )
        for item in result["items"]
    ]
    edges = [
        ReaderApparatusEdgeOut.model_validate(edge).model_dump(mode="json")
        for edge in result["edges"]
    ]
    response = ReaderApparatusResponse(
        media_id=media_id,
        media_kind=str(case["media_kind"]),
        status=str(result["status"]),
        extractor_version=EXTRACTOR_VERSION,
        source_fingerprint=source_fingerprint(
            "reader_apparatus_frontend_fixture",
            case["id"],
            case["sha256"],
            result["status"],
        ),
        capabilities=_capabilities(
            [ReaderApparatusItemOut.model_validate(item) for item in items],
            [ReaderApparatusEdgeOut.model_validate(edge) for edge in edges],
        ),
        items=items,
        edges=edges,
        diagnostics=dict(result["diagnostics"]),
    )
    payload = {
        "apparatus": response.model_dump(mode="json"),
        "fixture_id": case["id"],
        "source_fixture_path": case["path"],
        "source_fixture_sha256": case["sha256"],
    }
    payload_bytes = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    row_count = _frontend_row_count(response)
    return FrontendPayloadArtifact(
        fixture_id=str(case["id"]),
        path=FRONTEND_PAYLOAD_DIR / f"{case['id']}.json",
        payload=payload,
        payload_bytes=payload_bytes,
        payload_sha256=hashlib.sha256(payload_bytes).hexdigest(),
        source_fixture_sha256=str(case["sha256"]),
        surface_contract=(
            "reader_apparatus_sidecar_rows" if row_count else "reader_apparatus_empty_sidecar"
        ),
        expected_reader_tools_surface=_expected_reader_tools_surface(case),
        expected_status=str(case["expected"]["status"]),
        expected_item_count=sum(case["expected"].get("item_kinds", {}).values()),
        expected_edge_count=sum(case["expected"].get("edge_relations", {}).values()),
        body_needles=list(case["expected"].get("body_needles", [])),
        row_count=row_count,
    )


def build_frontend_payload_index(artifacts: list[FrontendPayloadArtifact]) -> str:
    lines = [
        "/* Generated by python/scripts/generate_reader_apparatus_frontend_payloads.py. */",
        'import type { ReaderApparatusResponse } from "@/lib/reader/apparatus";',
        "",
    ]
    imports: list[str] = []
    entries: list[str] = []
    for index, artifact in enumerate(artifacts):
        import_name = f"payload{index:03d}"
        imports.append(f'import {import_name} from "./{artifact.fixture_id}.json";')
        entries.append(
            "  {\n"
            f'    fixtureId: "{artifact.fixture_id}",\n'
            f"    payload: {import_name} as ReaderApparatusPayloadFixture,\n"
            f'    expectedReaderToolsSurface: "{artifact.expected_reader_tools_surface}",\n'
            f'    expectedStatus: "{artifact.expected_status}",\n'
            f"    expectedItemCount: {artifact.expected_item_count},\n"
            f"    expectedEdgeCount: {artifact.expected_edge_count},\n"
            f"    expectedRowCount: {artifact.row_count},\n"
            f"    bodyNeedles: {json.dumps(artifact.body_needles)},\n"
            f'    surfaceContract: "{artifact.surface_contract}",\n'
            "  },"
        )
    lines.extend(imports)
    lines.extend(
        [
            "",
            "export interface ReaderApparatusPayloadFixture {",
            "  fixture_id: string;",
            "  source_fixture_path: string;",
            "  source_fixture_sha256: string;",
            "  apparatus: ReaderApparatusResponse;",
            "}",
            "",
            "export interface ReaderApparatusFixtureEntry {",
            "  fixtureId: string;",
            "  payload: ReaderApparatusPayloadFixture;",
            '  expectedReaderToolsSurface: "citations_tab_rows" | "citations_tab_omitted";',
            '  expectedStatus: "ready" | "empty" | "partial" | "unsupported" | "failed";',
            "  expectedItemCount: number;",
            "  expectedEdgeCount: number;",
            "  expectedRowCount: number;",
            "  bodyNeedles: string[];",
            '  surfaceContract: "reader_apparatus_empty_sidecar" | "reader_apparatus_sidecar_rows";',
            "}",
            "",
            "export const readerApparatusPayloadFixtures: ReaderApparatusFixtureEntry[] = [",
            *entries,
            "];",
            "",
            "export const readerApparatusRowPayloadFixtures = readerApparatusPayloadFixtures.filter(",
            '  (entry) => entry.expectedReaderToolsSurface === "citations_tab_rows",',
            ");",
            "",
            "export const readerApparatusOmittedSurfacePayloadFixtures =",
            "  readerApparatusPayloadFixtures.filter(",
            '    (entry) => entry.expectedReaderToolsSurface === "citations_tab_omitted",',
            "  );",
            "",
        ]
    )
    return "\n".join(lines)


def frontend_payload_manifest_entries(
    artifacts: list[FrontendPayloadArtifact],
) -> list[dict[str, Any]]:
    return [
        {
            "fixture_id": artifact.fixture_id,
            "path": str(artifact.path.relative_to(REPO_ROOT)),
            "payload_sha256": artifact.payload_sha256,
            "source_fixture_sha256": artifact.source_fixture_sha256,
            "surface_contract": artifact.surface_contract,
        }
        for artifact in artifacts
    ]


def frontend_surface_contract_entries(
    artifacts: list[FrontendPayloadArtifact],
) -> list[dict[str, Any]]:
    return [
        {
            "fixture_id": artifact.fixture_id,
            "expected_reader_tools_surface": artifact.expected_reader_tools_surface,
            "verification_status": (
                "reader_shell_omission_tested"
                if artifact.expected_reader_tools_surface == "citations_tab_omitted"
                else "payload_projection_and_direct_surface_tested"
            ),
            "verified_layers": _frontend_verified_layers(artifact),
        }
        for artifact in artifacts
    ]


def _frontend_verified_layers(artifact: FrontendPayloadArtifact) -> list[str]:
    layers = [
        "api_payload_fixture",
        "payload_schema_projection",
        "direct_component_render",
    ]
    if artifact.expected_reader_tools_surface == "citations_tab_rows":
        layers.append("direct_component_desktop_alignment")
        if artifact.fixture_id in MEDIA_PANE_SHELL_PUBLICATION_FIXTURE_IDS:
            layers.append("media_pane_shell_publication")
    else:
        layers.append("media_pane_shell_omission")
    return layers


def _should_generate_frontend_payload(case: dict[str, Any]) -> bool:
    expected = case["expected"]
    return expected["status"] in {"ready", "partial", "empty"} and "item_kinds" in expected


def _expected_reader_tools_surface(case: dict[str, Any]) -> str:
    expected = case["expected"]
    if expected["status"] in {"partial", "ready"} and sum(
        expected.get("item_kinds", {}).values()
    ):
        return "citations_tab_rows"
    return "citations_tab_omitted"


def _extract_fixture_apparatus(case: dict[str, Any], *, media_id: UUID) -> dict[str, Any]:
    fixture_format = case["fixture_format"]
    if fixture_format == "html":
        return _extract_html_fixture_apparatus(case, media_id=media_id)
    if fixture_format == "epub":
        return _extract_epub_fixture_apparatus(case, media_id=media_id)
    if fixture_format == "pdf":
        return _extract_pdf_fixture_apparatus(case, media_id=media_id)
    if fixture_format == "tei":
        extracted = extract_scholarly_tei_apparatus(
            fixture_bytes(case),
            source_kind=f"fixture:{case['id']}",
            source_ref={"media_id": str(media_id), "source_url": case["source_url"]},
        )
        return {
            "status": extracted.status,
            "items": extracted.items,
            "edges": extracted.edges,
            "diagnostics": extracted.diagnostics,
        }
    if fixture_format == "arxiv_source":
        extracted = extract_latex_biblatex_apparatus_from_archive(
            fixture_bytes(case),
            source_kind=f"fixture:{case['id']}:source-package",
            source_ref={
                "format": "arxiv_source",
                "media_id": str(media_id),
                "source_url": case["source_url"],
                "sha256_hex": case["sha256"],
            },
            safety_cfg=_FIXTURE_LATEX_SOURCE_ARCHIVE_SAFETY,
        )
        return {
            "status": extracted.status,
            "items": _mark_missing_locators(extracted.items),
            "edges": extracted.edges,
            "diagnostics": extracted.diagnostics,
        }
    raise AssertionError(f"Unsupported frontend payload fixture format: {fixture_format}")


def _extract_html_fixture_apparatus(case: dict[str, Any], *, media_id: UUID) -> dict[str, Any]:
    prepared = prepare_web_article_fragment(
        html=fixture_path(case).read_text(encoding="utf-8"),
        base_url=str(case.get("source_url") or "https://example.test/article"),
        fragment_idx=0,
        media_title=case.get("title"),
    )
    fragment_id = _fragment_uuid(str(case["id"]), 0)
    items = attach_fragment_locators(
        media_id=media_id,
        fragment_id=fragment_id,
        media_kind="web_article",
        canonical_text=prepared.canonical_text,
        items=prepared.apparatus_items,
        html_sanitized=prepared.html_sanitized,
    )
    return {
        "status": "ready" if items else "empty",
        "items": items,
        "edges": prepared.apparatus_edges,
        "diagnostics": {},
    }


def _extract_epub_fixture_apparatus(case: dict[str, Any], *, media_id: UUID) -> dict[str, Any]:
    with zipfile.ZipFile(io.BytesIO(fixture_bytes(case))) as archive:
        documents = _epub_documents(archive)
        external_targets: dict[str, dict[str, object]] = {}
        for document in documents:
            external_targets.update(
                collect_html_apparatus_targets(
                    str(document["raw_html"]),
                    document_href=str(document["href"]),
                    source_kind=f"epub:{document['spine_index']}",
                    source_ref=_epub_document_source_ref(document),
                    extraction_method="epub_noteref",
                )
            )

        items: list[dict[str, object]] = []
        edges: list[dict[str, object]] = []
        for document in documents:
            html_with_apparatus, document_items, document_edges = extract_html_apparatus(
                str(document["raw_html"]),
                source_kind=f"epub:{document['spine_index']}",
                document_href=str(document["href"]),
                external_targets=external_targets,
                source_ref=_epub_document_source_ref(document),
            )
            canonical_text = generate_canonical_text(html_with_apparatus)
            items.extend(
                attach_fragment_locators(
                    media_id=media_id,
                    fragment_id=_fragment_uuid(str(case["id"]), int(document["spine_index"])),
                    media_kind="epub",
                    canonical_text=canonical_text,
                    items=document_items,
                    html_sanitized=html_with_apparatus,
                )
            )
            edges.extend(document_edges)

    return {
        "status": "ready" if items else "empty",
        "items": items,
        "edges": edges,
        "diagnostics": {},
    }


def _extract_pdf_fixture_apparatus(case: dict[str, Any], *, media_id: UUID) -> dict[str, Any]:
    pdf_bytes = fixture_bytes(case)
    extracted = _merge_pdf_apparatus_results(
        _extract_pdf_native_link_apparatus(pdf_bytes, media_id=media_id),
        _extract_pdf_legal_footnote_apparatus(pdf_bytes, media_id=media_id),
    )
    return {
        "status": extracted.status,
        "items": extracted.items,
        "edges": extracted.edges,
        "diagnostics": extracted.diagnostics,
    }


def _mark_missing_locators(items: list[dict[str, object]]) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for item in items:
        copy = dict(item)
        copy.pop("_locator_text", None)
        copy["locator"] = None
        copy["locator_status"] = "missing"
        result.append(copy)
    return result


def _strip_private_item_fields(item: dict[str, object]) -> dict[str, object]:
    copy = dict(item)
    copy.pop("_locator_text", None)
    return copy


def _frontend_row_count(response: ReaderApparatusResponse) -> int:
    marker_kinds = {
        "footnote_ref",
        "endnote_ref",
        "bibliography_ref",
        "sidenote_ref",
        "margin_note_ref",
    }
    target_kinds = {
        "footnote",
        "endnote",
        "bibliography_entry",
        "sidenote",
        "margin_note",
        "reference_section",
    }
    linked_targets = {edge.to_stable_key for edge in response.edges}
    return sum(
        1
        for item in response.items
        if item.kind in marker_kinds or (item.kind in target_kinds and item.stable_key not in linked_targets)
    )


def _media_uuid(fixture_id: str) -> UUID:
    return uuid5(FRONTEND_MEDIA_NAMESPACE, fixture_id)


def _fragment_uuid(fixture_id: str, index: int) -> UUID:
    return uuid5(FRONTEND_FRAGMENT_NAMESPACE, f"{fixture_id}:{index}")


def _epub_documents(archive: zipfile.ZipFile) -> list[dict[str, object]]:
    rootfile_path = _epub_rootfile_path(archive)
    package_dir = posixpath.dirname(rootfile_path)
    package = ET.fromstring(archive.read(rootfile_path))
    manifest = {
        item.attrib["id"]: {
            **item.attrib,
            "path": posixpath.normpath(posixpath.join(package_dir, item.attrib["href"])),
        }
        for item in package.findall(".//opf:manifest/opf:item", _EPUB_NS)
    }
    readable_paths = {
        str(item["path"])
        for item in manifest.values()
        if item.get("media-type") in _READABLE_EPUB_MEDIA_TYPES
    }
    documents: list[dict[str, object]] = []
    for spine_index, itemref in enumerate(package.findall(".//opf:spine/opf:itemref", _EPUB_NS)):
        manifest_id = itemref.attrib["idref"]
        item = manifest.get(manifest_id)
        if item is None or item.get("media-type") not in _READABLE_EPUB_MEDIA_TYPES:
            continue
        raw_html = _rewrite_epub_readable_hrefs(
            archive.read(str(item["path"])),
            document_href=str(item["path"]),
            readable_paths=readable_paths,
        )
        if not raw_html.strip():
            continue
        documents.append(
            {
                "href": str(item["path"]),
                "manifest_id": manifest_id,
                "spine_index": spine_index,
                "spine_itemref_id": itemref.attrib.get("id"),
                "raw_html": raw_html,
            }
        )
    return documents


def _epub_document_source_ref(document: dict[str, object]) -> dict[str, object]:
    return {
        "format": "xhtml",
        "package_href": document["href"],
        "manifest_id": document["manifest_id"],
        "spine_index": document["spine_index"],
        "spine_itemref_id": document["spine_itemref_id"],
    }


def _epub_rootfile_path(archive: zipfile.ZipFile) -> str:
    container = ET.fromstring(archive.read("META-INF/container.xml"))
    rootfile = container.find(".//container:rootfile", _EPUB_NS)
    assert rootfile is not None
    return str(rootfile.attrib["full-path"])


def _rewrite_epub_readable_hrefs(
    raw_html: bytes,
    *,
    document_href: str,
    readable_paths: set[str],
) -> str:
    root = document_fromstring(raw_html)
    document_dir = posixpath.dirname(document_href)
    for element in root.iter():
        if not hasattr(element, "tag"):
            continue
        if str(element.tag).lower() != "a":
            continue
        href = str(element.get("href") or "").strip()
        if not href or href.startswith("#"):
            continue
        parsed = urlparse(href)
        if parsed.scheme or href.startswith("//"):
            continue
        resolved = posixpath.normpath(posixpath.join(document_dir, unquote(parsed.path or "")))
        if resolved in readable_paths:
            element.set("href", f"{resolved}#{parsed.fragment}" if parsed.fragment else resolved)
    rendered = tostring(root, encoding="unicode")
    return rendered.decode("utf-8") if isinstance(rendered, bytes) else rendered


_EPUB_NS = {
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
}
_READABLE_EPUB_MEDIA_TYPES = frozenset(
    {
        "application/xhtml+xml",
        "application/xml",
        "text/html",
        "text/xml",
    }
)
_FIXTURE_LATEX_SOURCE_ARCHIVE_SAFETY = LatexSourceArchiveSafetyConfig(
    max_entries=10_000,
    max_total_uncompressed_bytes=536_870_912,
    max_single_entry_uncompressed_bytes=134_217_728,
    max_compression_ratio=100,
)
