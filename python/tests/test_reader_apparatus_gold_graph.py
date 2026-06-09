from __future__ import annotations

import io
import json
import posixpath
import re
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse
from uuid import uuid4
from xml.etree import ElementTree as ET

import pytest
from lxml.html import document_fromstring, tostring

from nexus.schemas.reader_apparatus import ReaderApparatusResponse
from nexus.services.pdf_ingest import _extract_pdf_native_link_apparatus
from nexus.services.pdf_scholarly_apparatus import extract_scholarly_tei_apparatus
from nexus.services.reader_apparatus import (
    collect_html_apparatus_targets,
    extract_html_apparatus,
)
from nexus.services.web_article_structure import prepare_web_article_fragment
from tests.reader_apparatus_corpus import (
    automated_fixtures_by_id,
    fixture_path,
    frontend_api_payload_fixtures,
    gold_graph_fixtures,
)
from tests.reader_apparatus_epub_verifiers import (
    assert_epub_noteref_pairs_match_gold_graph,
    epub_noteref_pairs_from_archive,
)
from tests.reader_apparatus_gold_graph import (
    assert_reader_apparatus_matches_gold_graph,
    load_reader_apparatus_gold_graph,
)

pytestmark = pytest.mark.integration

FRONTEND_PAYLOAD_FIXTURE_IDS = {payload["fixture_id"] for payload in frontend_api_payload_fixtures()}
FRONTEND_PAYLOAD_GOLD_GRAPHS = [
    entry for entry in gold_graph_fixtures() if entry["fixture_id"] in FRONTEND_PAYLOAD_FIXTURE_IDS
]
HTML_GOLD_GRAPHS = [
    entry
    for entry in gold_graph_fixtures()
    if automated_fixtures_by_id()[entry["fixture_id"]]["fixture_format"] == "html"
]
EPUB_GOLD_GRAPHS = [
    entry
    for entry in gold_graph_fixtures()
    if automated_fixtures_by_id()[entry["fixture_id"]]["fixture_format"] == "epub"
]
PDF_GOLD_GRAPHS = [
    entry
    for entry in gold_graph_fixtures()
    if automated_fixtures_by_id()[entry["fixture_id"]]["fixture_format"] == "pdf"
]
TEI_GOLD_GRAPHS = [
    entry
    for entry in gold_graph_fixtures()
    if automated_fixtures_by_id()[entry["fixture_id"]]["fixture_format"] == "tei"
]


@pytest.mark.parametrize(
    "gold_entry",
    FRONTEND_PAYLOAD_GOLD_GRAPHS,
    ids=[entry["fixture_id"] for entry in FRONTEND_PAYLOAD_GOLD_GRAPHS],
)
def test_reader_apparatus_frontend_payload_matches_gold_graph(
    gold_entry: dict[str, object],
):
    repo_root = Path(__file__).parents[2]
    payload_fixtures = {
        payload["fixture_id"]: payload for payload in frontend_api_payload_fixtures()
    }
    fixture_id = str(gold_entry["fixture_id"])
    case = automated_fixtures_by_id()[fixture_id]
    payload_fixture = payload_fixtures[fixture_id]
    payload = json.loads((repo_root / payload_fixture["path"]).read_text(encoding="utf-8"))
    gold_graph = load_reader_apparatus_gold_graph(fixture_id)
    apparatus = ReaderApparatusResponse.model_validate(payload["apparatus"]).model_dump(
        mode="json"
    )

    expected_response = gold_graph["expected_response"]
    assert apparatus["status"] == expected_response["status"]
    assert apparatus["media_kind"] == case["media_kind"]
    assert payload["source_fixture_sha256"] == gold_graph["fixture_sha256"]
    assert_reader_apparatus_matches_gold_graph(apparatus, gold_graph)


@pytest.mark.parametrize(
    "gold_entry",
    HTML_GOLD_GRAPHS,
    ids=[entry["fixture_id"] for entry in HTML_GOLD_GRAPHS],
)
def test_reader_apparatus_html_fixture_matches_gold_graph(
    gold_entry: dict[str, object],
):
    fixture_id = str(gold_entry["fixture_id"])
    case = automated_fixtures_by_id()[fixture_id]
    prepared = prepare_web_article_fragment(
        html=fixture_path(case).read_text(encoding="utf-8"),
        base_url="https://example.test/article",
        fragment_idx=0,
        media_title=None,
    )
    gold_graph = load_reader_apparatus_gold_graph(fixture_id)
    apparatus = {
        "status": gold_graph["expected_response"]["status"],
        "media_kind": gold_graph["expected_response"]["media_kind"],
        "items": prepared.apparatus_items,
        "edges": prepared.apparatus_edges,
    }

    assert_reader_apparatus_matches_gold_graph(apparatus, gold_graph)


@pytest.mark.parametrize(
    "gold_entry",
    EPUB_GOLD_GRAPHS,
    ids=[entry["fixture_id"] for entry in EPUB_GOLD_GRAPHS],
)
def test_reader_apparatus_epub_fixture_matches_gold_graph(
    gold_entry: dict[str, object],
):
    fixture_id = str(gold_entry["fixture_id"])
    case = automated_fixtures_by_id()[fixture_id]
    epub_bytes = fixture_path(case).read_bytes()
    expected_noterefs = epub_noteref_pairs_from_archive(epub_bytes)
    extracted = _extract_epub_apparatus_from_archive(epub_bytes)
    gold_graph = load_reader_apparatus_gold_graph(fixture_id)
    apparatus = {
        "status": "ready" if extracted["items"] else "empty",
        "media_kind": gold_graph["expected_response"]["media_kind"],
        "items": extracted["items"],
        "edges": extracted["edges"],
    }

    assert apparatus["status"] == gold_graph["expected_response"]["status"]
    assert len(expected_noterefs) == len(
        [edge for edge in gold_graph["edges"] if edge["relation"] == "points_to_endnote"]
    )
    assert_epub_noteref_pairs_match_gold_graph(gold_graph, expected_noterefs)
    assert_reader_apparatus_matches_gold_graph(apparatus, gold_graph)
    _assert_epub_expected_absences(
        expected_absences=gold_graph["expected_absences"],
        census=extracted["census"],
    )


@pytest.mark.parametrize(
    "gold_entry",
    PDF_GOLD_GRAPHS,
    ids=[entry["fixture_id"] for entry in PDF_GOLD_GRAPHS],
)
def test_reader_apparatus_pdf_fixture_matches_gold_graph(
    gold_entry: dict[str, object],
):
    fixture_id = str(gold_entry["fixture_id"])
    case = automated_fixtures_by_id()[fixture_id]
    if fixture_id != "pdf-attention-native-link-graph":
        raise AssertionError(f"Unsupported PDF gold fixture: {fixture_id}")
    extracted = _extract_pdf_native_link_apparatus(
        fixture_path(case).read_bytes(),
        media_id=uuid4(),
    )
    gold_graph = load_reader_apparatus_gold_graph(fixture_id)
    apparatus = {
        "status": extracted.status,
        "media_kind": gold_graph["expected_response"]["media_kind"],
        "items": extracted.items,
        "edges": extracted.edges,
    }

    assert apparatus["status"] == gold_graph["expected_response"]["status"]
    assert_reader_apparatus_matches_gold_graph(apparatus, gold_graph)


def test_reader_apparatus_epub_archive_verifier_resolves_same_document_noteref_target():
    case = automated_fixtures_by_id()["epub-synthetic-noteref"]
    noterefs = epub_noteref_pairs_from_archive(fixture_path(case).read_bytes())

    assert len(noterefs) == 1
    noteref = noterefs[0]
    assert noteref.source_href == "OEBPS/chapter.xhtml"
    assert noteref.target_ref == "OEBPS/chapter.xhtml#fn1"
    assert noteref.label == "1"
    assert "EPUB note body for reader apparatus" in noteref.target_text
    assert "footnote" in noteref.target_semantic_tokens
    assert noteref.has_semantic_target_evidence


@pytest.mark.parametrize(
    "gold_entry",
    TEI_GOLD_GRAPHS,
    ids=[entry["fixture_id"] for entry in TEI_GOLD_GRAPHS],
)
def test_reader_apparatus_tei_fixture_matches_gold_graph(
    gold_entry: dict[str, object],
):
    fixture_id = str(gold_entry["fixture_id"])
    case = automated_fixtures_by_id()[fixture_id]
    extracted = extract_scholarly_tei_apparatus(
        fixture_path(case).read_bytes(),
        source_kind=f"fixture:{fixture_id}",
        source_ref={
            "media_id": str(uuid4()),
            "source_url": case["source_url"],
        },
    )
    gold_graph = load_reader_apparatus_gold_graph(fixture_id)
    apparatus = {
        "status": extracted.status,
        "media_kind": gold_graph["expected_response"]["media_kind"],
        "items": extracted.items,
        "edges": extracted.edges,
    }

    assert apparatus["status"] == gold_graph["expected_response"]["status"]
    assert_reader_apparatus_matches_gold_graph(apparatus, gold_graph)
    _assert_tei_ref_hand_gold_matrix(apparatus, gold_graph)


def _extract_epub_apparatus_from_archive(epub_bytes: bytes) -> dict[str, Any]:
    with zipfile.ZipFile(io.BytesIO(epub_bytes)) as archive:
        documents = _epub_documents(archive)
        external_targets: dict[str, dict[str, object]] = {}
        for document in documents:
            external_targets.update(
                collect_html_apparatus_targets(
                    document["raw_html"],
                    document_href=document["href"],
                    source_kind=f"epub:{document['spine_index']}",
                    source_ref=_epub_document_source_ref(document),
                    extraction_method="epub_noteref",
                )
            )

        items: list[dict[str, object]] = []
        edges: list[dict[str, object]] = []
        for document in documents:
            _html, document_items, document_edges = extract_html_apparatus(
                document["raw_html"],
                source_kind=f"epub:{document['spine_index']}",
                document_href=document["href"],
                external_targets=external_targets,
                source_ref=_epub_document_source_ref(document),
            )
            items.extend(document_items)
            edges.extend(document_edges)

        return {
            "items": items,
            "edges": edges,
            "census": _epub_archive_census(archive, documents, external_targets),
        }


def _assert_tei_ref_hand_gold_matrix(
    apparatus: dict[str, Any],
    gold_graph: dict[str, Any],
) -> None:
    matrix = gold_graph["diagnostics"].get("hand_gold_ref_matrix")
    if not matrix:
        return

    refs_by_ordinal: dict[int, dict[str, Any]] = {}
    target_id_by_item_key: dict[str, str] = {}
    for item in apparatus["items"]:
        source_ref = item.get("source_ref") or {}
        if source_ref.get("format") != "grobid_tei":
            continue
        if item["kind"] == "bibliography_ref":
            ordinal = source_ref.get("ordinal")
            assert isinstance(ordinal, int), item
            refs_by_ordinal[ordinal] = item
        elif item["kind"] == "bibliography_entry":
            target_id = source_ref.get("target_id")
            assert isinstance(target_id, str) and target_id, item
            target_id_by_item_key[item["stable_key"]] = target_id

    edges_by_from_key: dict[str, list[dict[str, Any]]] = {}
    for edge in apparatus["edges"]:
        edges_by_from_key.setdefault(edge["from_stable_key"], []).append(edge)

    seen_ordinals: set[int] = set()
    for row in matrix:
        ordinal = int(row["ordinal"])
        assert ordinal not in seen_ordinals, row
        seen_ordinals.add(ordinal)
        item = refs_by_ordinal[ordinal]
        source_ref = item["source_ref"]
        expected_targets = list(row["expected_target_ids"])
        expected_edge_count = int(row["expected_edge_count"])

        assert item["label"] == row["ref_text"], row
        assert source_ref.get("ref_text") == row["ref_text"], row
        assert source_ref.get("target_id") == row["source_target_id"], row
        assert source_ref.get("declared_target_id") == row["declared_target_id"], row
        assert source_ref.get("resolved_target_ids") == expected_targets, row
        assert (
            source_ref.get("suppressed_resolution_reason")
            == row.get("suppressed_resolution_reason")
        ), row
        assert source_ref.get("suppressed_candidate_target_ids") == row.get(
            "suppressed_candidate_target_ids",
            [],
        ), row

        edges = edges_by_from_key.get(item["stable_key"], [])
        actual_targets = [target_id_by_item_key[edge["to_stable_key"]] for edge in edges]
        assert len(edges) == expected_edge_count, row
        assert actual_targets == expected_targets, row
        if expected_edge_count == 0:
            assert "resolution_method" not in row, row
            continue

        assert row["resolution_method"] in {
            "grobid_tei_bibliography_ref",
            "grobid_tei_author_year_match",
        }, row
        for edge in edges:
            assert edge["relation"] == "cites_bibliography_entry", row
            assert edge["extraction_method"] == row["resolution_method"], row
            assert edge["source_ref"].get("resolution_method") == row["resolution_method"], row


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


def _epub_archive_census(
    archive: zipfile.ZipFile,
    documents: list[dict[str, object]],
    external_targets: dict[str, dict[str, object]],
) -> dict[str, object]:
    semantic_noteref_links = 0
    semantic_note_targets = 0
    backlink_count = 0
    toc_links: Counter[tuple[str, str]] = Counter()
    plain_note_count_by_document: Counter[tuple[str, int]] = Counter()

    target_refs = set(external_targets)
    for document in documents:
        root = _epub_document_root(document["raw_html"])
        for element in root.iter():
            if not _is_html_element(element):
                continue
            tokens = _semantic_tokens(element)
            if str(element.tag).lower() == "a":
                href = str(element.get("href") or "").strip()
                if "noteref" in tokens or "doc-noteref" in tokens:
                    target_ref = _resolve_epub_link_ref(str(document["href"]), href)
                    if target_ref in target_refs:
                        semantic_noteref_links += 1
                if "backlink" in tokens or "doc-backlink" in tokens:
                    backlink_count += 1
                if href and _looks_like_toc_document(document):
                    toc_links[(str(document["href"]), href)] += 1
            target_id = str(element.get("id") or element.get("name") or "").strip()
            if target_id and f"{document['href']}#{target_id}" in target_refs:
                semantic_note_targets += 1
        if str(document["href"]).endswith("1321-h-7.htm.xhtml"):
            plain_note_count_by_document[(str(document["href"]), int(document["spine_index"]))] = (
                _plain_gutenberg_waste_land_note_count(document["raw_html"])
            )

    return {
        "semantic_noteref_links": semantic_noteref_links,
        "semantic_note_targets": semantic_note_targets,
        "backlink_count": backlink_count,
        "toc_links": toc_links,
        "plain_note_count_by_document": plain_note_count_by_document,
    }


def _assert_epub_expected_absences(
    *,
    expected_absences: list[dict[str, object]],
    census: dict[str, object],
) -> None:
    for absence in expected_absences:
        kind = absence.get("kind")
        if kind == "semantic_noteref_links":
            assert census["semantic_noteref_links"] == absence["expected_count"]
        elif kind == "semantic_note_targets":
            assert census["semantic_note_targets"] == absence["expected_count"]
        elif kind == "plain_text_note_without_encoded_marker_target_graph":
            source_ref = absence["source_ref"]
            key = (str(source_ref["package_href"]), int(source_ref["spine_index"]))
            assert census["plain_note_count_by_document"][key] == absence["expected_count"]
        elif kind == "toc_navigation_link":
            source_ref = absence["source_ref"]
            key = (str(source_ref["package_href"]), str(source_ref["href"]))
            canonical_href = _resolve_epub_link_ref(key[0], key[1])
            canonical_key = (key[0], canonical_href or key[1])
            assert census["toc_links"][key] == 1 or census["toc_links"][canonical_key] == 1
        elif kind == "container_only":
            continue
        elif kind == "backlink_control":
            assert census["backlink_count"] == absence["expected_count"]


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
        if not _is_html_element(element):
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
    return tostring(root, encoding="unicode")


def _epub_document_root(raw_html: str):
    document = document_fromstring(raw_html)
    return document.body if document.body is not None else document


def _is_html_element(element: object) -> bool:
    from lxml.html import HtmlElement

    return isinstance(element, HtmlElement)


def _semantic_tokens(element: Any) -> set[str]:
    values = []
    for attr in ("epub:type", "type", "role", "class"):
        value = element.get(attr)
        if value:
            values.append(value)
    return set(" ".join(values).replace(",", " ").split())


def _resolve_epub_link_ref(base_href: str, link_href: str) -> str | None:
    decoded_href = unquote(link_href.strip())
    path_part, _, fragment = decoded_href.partition("#")
    parsed = urlparse(path_part)
    if parsed.scheme or path_part.startswith("/"):
        return None
    if path_part:
        target_href = posixpath.normpath(posixpath.join(posixpath.dirname(base_href), path_part))
    else:
        target_href = base_href
    if target_href in {"", "."} or target_href.startswith("../") or target_href == "..":
        return None
    return f"{target_href}#{fragment}" if fragment else target_href


def _looks_like_toc_document(document: dict[str, object]) -> bool:
    return str(document["href"]).endswith("1321-h-0.htm.xhtml")


def _plain_gutenberg_waste_land_note_count(raw_html: str) -> int:
    root = _epub_document_root(raw_html)
    count = 0
    for element in root.iter():
        if not _is_html_element(element):
            continue
        if str(element.tag).lower() != "p":
            continue
        text = re.sub(r"\s+", " ", str(element.text_content() or "")).strip()
        if re.match(r"^(?:\d+(?:-\d+)?\.|Line\s+\d+\b|ll\.\s+\d+)", text):
            count += 1
    return count


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
