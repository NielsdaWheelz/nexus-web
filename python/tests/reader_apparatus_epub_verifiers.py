from __future__ import annotations

import hashlib
import io
import posixpath
import re
import zipfile
from dataclasses import dataclass
from urllib.parse import unquote, urlparse
from xml.etree import ElementTree as ET

from lxml.html import HtmlElement, document_fromstring


@dataclass(frozen=True)
class EpubArchiveNoteref:
    source_href: str
    marker_id: str | None
    target_ref: str
    label: str
    target_text: str
    target_semantic_tokens: tuple[str, ...]
    target_container_semantic_tokens: tuple[str, ...]

    @property
    def target_text_sha256(self) -> str:
        return normalized_text_sha256(self.target_text)

    @property
    def has_semantic_target_evidence(self) -> bool:
        target_tokens = set(self.target_semantic_tokens)
        container_tokens = set(self.target_container_semantic_tokens)
        return bool(
            target_tokens & _NOTE_TARGET_TOKENS or container_tokens & _NOTE_CONTAINER_TOKENS
        )


def epub_noteref_pairs_from_archive(epub_bytes: bytes) -> list[EpubArchiveNoteref]:
    with zipfile.ZipFile(io.BytesIO(epub_bytes)) as archive:
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
        documents: list[tuple[str, HtmlElement]] = []
        for itemref in package.findall(".//opf:spine/opf:itemref", _EPUB_NS):
            item = manifest.get(itemref.attrib["idref"])
            if item is None or item.get("media-type") not in _READABLE_EPUB_MEDIA_TYPES:
                continue
            documents.append((str(item["path"]), document_fromstring(archive.read(item["path"]))))

        target_by_ref: dict[str, tuple[str, tuple[str, ...], tuple[str, ...]]] = {}
        for href, document in documents:
            for element in _html_iter(document):
                target_id = str(element.get("id") or element.get("name") or "").strip()
                if target_id:
                    target_by_ref[f"{href}#{target_id}"] = (
                        normalize_fixture_text(_html_element_text(element)),
                        tuple(sorted(_semantic_tokens(element))),
                        tuple(sorted(_ancestor_semantic_tokens(element))),
                    )

        noterefs: list[EpubArchiveNoteref] = []
        for href, document in documents:
            for element in _html_iter(document):
                if str(element.tag).lower() != "a":
                    continue
                link_href = str(element.get("href") or "").strip()
                if not link_href:
                    continue
                tokens = _semantic_tokens(element)
                if "noteref" not in tokens and "doc-noteref" not in tokens:
                    continue
                target_ref = resolve_epub_link_ref(href, link_href)
                if target_ref is None:
                    continue
                target_text, target_tokens, container_tokens = target_by_ref.get(
                    target_ref,
                    ("", (), ()),
                )
                noterefs.append(
                    EpubArchiveNoteref(
                        source_href=href,
                        marker_id=(element.get("id") or None),
                        target_ref=target_ref,
                        label=normalize_fixture_text(_html_element_text(element)),
                        target_text=target_text,
                        target_semantic_tokens=target_tokens,
                        target_container_semantic_tokens=container_tokens,
                    )
                )
        for noteref in noterefs:
            assert noteref.target_text, noteref
            assert noteref.has_semantic_target_evidence, noteref
        return noterefs


def assert_epub_noteref_pairs_match_apparatus(
    apparatus: dict[str, object],
    expected_noterefs: list[EpubArchiveNoteref],
) -> None:
    items = apparatus["items"]
    edges = apparatus["edges"]
    assert isinstance(items, list)
    assert isinstance(edges, list)
    by_key = {item["stable_key"]: item for item in items}
    actual_noterefs: set[tuple[str, str | None, str, str, str]] = set()
    for edge in edges:
        if edge["relation"] != "points_to_endnote":
            continue
        source = by_key[edge["from_stable_key"]]
        source_ref = source["source_ref"]
        target = by_key[edge["to_stable_key"]]
        assert target["body_text"], edge
        actual_noterefs.add(
            (
                str(source_ref["package_href"]),
                source_ref.get("marker_id"),
                str(source_ref["target_ref"]),
                str(source["label"] or ""),
                normalize_fixture_text(str(target["body_text"])),
            )
        )

    assert actual_noterefs == {
        (
            noteref.source_href,
            noteref.marker_id,
            noteref.target_ref,
            noteref.label,
            noteref.target_text,
        )
        for noteref in expected_noterefs
    }


def assert_epub_noteref_pairs_match_gold_graph(
    gold_graph: dict[str, object],
    expected_noterefs: list[EpubArchiveNoteref],
) -> None:
    items = gold_graph["items"]
    edges = gold_graph["edges"]
    assert isinstance(items, list)
    assert isinstance(edges, list)
    by_key = {item["gold_key"]: item for item in items}
    actual_noterefs: set[tuple[str, str | None, str, str, str]] = set()
    for edge in edges:
        if edge["relation"] != "points_to_endnote":
            continue
        source = by_key[edge["from_gold_key"]]
        target = by_key[edge["to_gold_key"]]
        source_ref = source["source_ref"]
        actual_noterefs.add(
            (
                str(source_ref["package_href"]),
                source_ref.get("marker_id"),
                str(source_ref["target_ref"]),
                str(source["label"] or ""),
                str(target["body_sha256"]),
            )
        )

    assert actual_noterefs == {
        (
            noteref.source_href,
            noteref.marker_id,
            noteref.target_ref,
            noteref.label,
            noteref.target_text_sha256,
        )
        for noteref in expected_noterefs
    }


def normalize_fixture_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalized_text_sha256(value: str | None) -> str:
    normalized = normalize_fixture_text(value or "")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def resolve_epub_link_ref(base_href: str, link_href: str) -> str | None:
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


def _epub_rootfile_path(archive: zipfile.ZipFile) -> str:
    container = ET.fromstring(archive.read("META-INF/container.xml"))
    rootfile = container.find(".//container:rootfile", _EPUB_NS)
    assert rootfile is not None
    return str(rootfile.attrib["full-path"])


def _html_iter(document: HtmlElement):
    root = document.body if document.body is not None else document
    for element in root.iter():
        if isinstance(element, HtmlElement):
            yield element


def _html_element_text(element: HtmlElement) -> str:
    return str(element.text_content() or "")


def _semantic_tokens(element: HtmlElement) -> set[str]:
    values = []
    for attr in ("epub:type", "type", "role", "class"):
        value = element.get(attr)
        if value:
            values.append(value)
    return set(" ".join(values).replace(",", " ").split())


def _ancestor_semantic_tokens(element: HtmlElement) -> set[str]:
    tokens: set[str] = set()
    parent = element.getparent()
    while isinstance(parent, HtmlElement):
        tokens.update(_semantic_tokens(parent))
        parent = parent.getparent()
    return tokens


_NOTE_TARGET_TOKENS = frozenset({"doc-endnote", "doc-footnote", "endnote", "footnote"})
_NOTE_CONTAINER_TOKENS = frozenset({"doc-endnotes", "doc-footnotes", "endnotes", "footnotes"})


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
