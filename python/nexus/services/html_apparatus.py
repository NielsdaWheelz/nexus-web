"""Source-authored apparatus extraction from web/EPUB HTML, and its anchoring.

Runs on untrusted source HTML *before* sanitisation: every inbound
``data-reader-apparatus-*`` attribute is stripped, then this module re-applies its
own on the marker and target elements it recognises, and ``sanitize_html`` keeps
exactly those three.

A proved source interval owns rich content, plain text and its complete stored location.
Return links do not become references merely through reciprocity. Ambiguous note
boundaries yield no body; a leading paragraph is not a complete-body substitute.
Indexed targets retain whether note context preceded return-link inference. A
heading reference requires that independent context and its exact backlink.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import OrderedDict
from collections.abc import Callable, Iterable, Iterator, Mapping
from copy import deepcopy
from dataclasses import dataclass
from functools import cache
from html.parser import HTMLParser
from typing import Any, Literal, TypedDict
from urllib.parse import unquote
from uuid import UUID

from lxml.etree import ParserError, iterwalk
from lxml.html import HtmlElement

from nexus.errors import ApiError, ApiErrorCode, ResourceLimitError
from nexus.schemas.reader import NavigationTextPointOut, NavigationTextRangeOut
from nexus.schemas.reader_apparatus import NotesGroup
from nexus.services.canonicalize import (
    HEADING_TAGS,
    STRUCTURAL_TAGS,
    CanonicalStructure,
    canonicalize_structure,
    generate_canonical_text,
)
from nexus.services.html_tree import inner_html, parse_html_document, serialize_html
from nexus.services.parser_temp import nested_utf8_byte_length, utf8_byte_length
from nexus.services.reader_apparatus import stable_token
from nexus.services.sanitize_html import hides
from nexus.services.text_quote import NormalizedText, find_quote_candidates, normalize_for_match
from nexus.text import normalize_whitespace

_ENDNOTE_TOKENS = frozenset({"endnote", "endnotes", "doc-endnote", "doc-endnotes"})
_FOOTNOTE_TOKENS = frozenset({"footnote", "doc-footnote"})
_NOTE_BODY_TOKENS = _FOOTNOTE_TOKENS | {"endnote", "doc-endnote"}
_SEMANTIC_ATTRIBUTES = ("role", "epub:type", "{http://www.idpf.org/2007/ops}type", "type")
_BIBLIOGRAPHY_TOKENS = frozenset(
    {"bibliography", "biblioentry", "doc-bibliography", "doc-biblioentry"}
)
_BIBLIOGRAPHY_TAGS = frozenset(
    {"ref", "ref-list", "d-citation-list", "d-bibliography", "dt-bibliography"}
)
_BIBLIOGRAPHY_CONTAINER_TAGS = frozenset({"d-citation-list", "d-bibliography", "dt-bibliography"})
_APPARATUS_STAMP_ATTRIBUTES = frozenset(
    {
        "data-reader-apparatus-item-id",
        "data-reader-apparatus-kind",
        "data-reader-apparatus-confidence",
    }
)
_START_TAG_ATTRIBUTE = re.compile(
    r"""\s+(?P<name>[^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?"""
)
# target context -> (marker kind, target kind, edge relation)
_CONTEXT_KINDS = {
    "note": ("footnote_ref", "footnote", "points_to_note"),
    "endnote": ("endnote_ref", "endnote", "points_to_endnote"),
    "bibliography": ("bibliography_ref", "bibliography_entry", "cites_bibliography_entry"),
}


class AuthoredSourceIdentity(TypedDict):
    kind: Literal["Authored"]
    document: str
    element_id: str


class AnonymousSourceIdentity(TypedDict):
    kind: Literal["Anonymous"]
    document: str
    digest: str
    address: str


SourceIdentity = AuthoredSourceIdentity | AnonymousSourceIdentity


@dataclass(frozen=True, slots=True)
class _TargetContext:
    """Where a link target sits: by declared semantics, and by looser evidence."""

    semantic: str | None  # "note" | "endnote" | "bibliography"
    loose: str | None  # "note" | "endnote" | "bibliography"

    @property
    def is_note(self) -> bool:
        return self.semantic in {"note", "endnote"} or self.loose in {"note", "endnote"}


@dataclass(frozen=True, slots=True)
class _TargetFacts:
    context: _TargetContext
    has_note_context: bool
    is_bibliography_entry: bool
    has_backlink: bool
    method: str
    confidence: str
    loose_method: str
    dedicated_marker: bool
    scoped_marker: bool
    shared_note_reference: bool


@dataclass(frozen=True, slots=True)
class HtmlApparatusEntryOpener:
    """Source evidence for a boundary inside an independently proved note group."""

    label: str
    role: Literal["Symbol", "Division", "UnpairedReference", "UnmarkedReference"]


type HtmlNoteBlockSignature = tuple[str, tuple[str, ...], str]
# (tag, sorted classes) for each element from a link up to its paragraph or heading.
type HtmlInlineChain = tuple[tuple[str, tuple[str, ...]], ...]
# Label kind and the inline chain of a marker.
type HtmlParagraphMarkerShape = tuple[Literal["Numeric", "Symbol"], HtmlInlineChain]
type HtmlParagraphMarker = tuple[str, HtmlParagraphMarkerShape]  # (label, shape)
type HtmlParagraphBacklinks = Mapping[str, Mapping[str, HtmlParagraphMarker]]
# (sequence, inline marker shape, return block signature, leading-return link chain)
type HtmlNotePeerKey = tuple[int, HtmlParagraphMarkerShape, HtmlNoteBlockSignature, HtmlInlineChain]


@dataclass(frozen=True, slots=True)
class HtmlParagraphNoteEvidence:
    """Package evidence shared with one staged document's body pass."""

    paragraph_backlinks: HtmlParagraphBacklinks
    chapter_opening_ids: frozenset[str]
    next_file_has_opening: bool
    outside_signatures: set[HtmlNoteBlockSignature]
    continuation_witnesses: dict[HtmlNoteBlockSignature, set[str]]
    # Verified editorial openings close a note run; they never open a peer scope.
    editorial_opening_ids: frozenset[str]
    # Bound neighbors around an opening that failed to bind; None is a file boundary.
    uncertain_openings: tuple[tuple[str | None, str | None], ...]
    # Marker and return keys -> (sequence, chapter) inside one bounded chapter interval.
    chapter_by_ref: Mapping[str, tuple[int, int]]
    # (sequence, chapter) -> the exact key of the opening that ends it.
    chapter_closers: Mapping[tuple[int, int], str]
    # The exact key proved to open the next consecutive spine file.
    next_file_opening: str | None
    # Chapters whose multi-note runs show a shape; filled before any body is emitted.
    peer_chapters: dict[HtmlNotePeerKey, set[int]]


@dataclass(frozen=True, slots=True)
class _Classified:
    marker_kind: str
    target_kind: str
    relation: str
    method: str
    confidence: str


def extract_html_apparatus(
    html: str,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    document_href: str | None = None,
    find_target: Callable[[str], Mapping[str, object] | None],
    confirmed_target_refs: set[str] | None = None,
) -> tuple[str, list[dict[str, object]], list[dict[str, object]]]:
    """Stamp apparatus as items and edges; the target index decides every target."""
    if not html.strip():
        return html, [], []
    try:
        doc = parse_html_document(html)
    except ParserError:
        return html, [], []
    body = doc.body
    root = body if body is not None else doc
    for element in root.iter():
        if isinstance(element, HtmlElement):
            for attr in list(element.attrib):
                if attr.lower().startswith("data-reader-apparatus-"):
                    del element.attrib[attr]

    targets = _unique_authored_targets(root)
    aliases_by_target: dict[HtmlElement, set[str]] = {}
    for alias, element in targets.items():
        aliases_by_target.setdefault(element, set()).add(alias)

    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    ancestor_prefixes: dict[HtmlElement, str] = {}
    note_containers = _nested_declared_note_containers(root, ancestor_prefixes)
    target_item_key_by_id: dict[str, str] = {}
    if confirmed_target_refs is None and document_href:
        confirmed_target_refs = confirm_html_apparatus_target_refs(
            html, document_href=document_href, find_target=find_target
        )

    source_ref = {
        **source_ref,
        "artifact_digest": hashlib.sha256(html.encode()).hexdigest(),
    }
    _extract_standalone_margin_notes(
        root, source_kind=source_kind, source_ref=source_ref, items=items
    )
    _materialize_external_targets_in_document(
        targets=targets,
        find_target=find_target,
        confirmed_target_refs=confirmed_target_refs or set(),
        document_href=document_href,
        target_item_key_by_id=target_item_key_by_id,
        items=items,
    )
    _extract_unlinked_declared_notes(
        root,
        note_containers=note_containers,
        source_kind=source_kind,
        source_ref=source_ref,
        target_item_key_by_id=target_item_key_by_id,
        items=items,
        ancestor_prefixes=ancestor_prefixes,
    )

    candidates: list[tuple[HtmlElement, str | None, str]] = []
    for element in root.iter():
        if not isinstance(element, HtmlElement) or element.get("data-reader-apparatus-item-id"):
            continue
        if str(element.tag).lower() == "xref":
            for rid in dict.fromkeys((element.get("rid") or "").split()):
                candidates.append((element, rid, html_apparatus_ref(document_href or "", rid)))
        else:
            if ref := _target_ref(element):
                href = _canonical_target_ref(ref, document_href)
                candidates.append((element, _local_target_id(element, document_href), href))
    marker_keys: set[str] = set()
    note_scopes = cache(lambda: _authored_note_scopes(root, _bounded_element_text()))
    ordinal = 0
    for element, target_id, target_ref in candidates:
        target = targets.get(target_id) if target_id else None
        if target in note_containers:
            continue
        if target is not None and _is_inline_note_marker(target):
            continue
        external_target = find_target(target_ref)
        if external_target is None:
            continue
        printed_range = external_target.get("_printed_note_range")
        shared_note_reference = (
            isinstance(printed_range, list)
            and external_target.get("target_href") == document_href
            and (label := _short_note_label(_element_text(element))) is not None
            and label.isdecimal()
            and printed_range[0] <= int(label) <= printed_range[1]
            and _source_element_id_owner(element) is None
            and _is_sup_marker(element)
            and element not in note_scopes()
        )
        source_owner = _source_element_id_owner(element)
        if source_owner is not None and not any(
            targets.get(name) is source_owner for name in _authored_names(source_owner)
        ):
            continue
        facts = _target_facts(
            element,
            external_target,
            document_href,
            unique_names=targets,
            shared_note_reference=shared_note_reference,
            outside_note_scope=external_target.get("_scoped_note") is True
            and element not in note_scopes(),
        )
        classified = _classify(element, facts)
        if classified is None:
            continue

        marker_text = _element_text(element)
        target_body = _note_body_element(target) if target is not None else None
        target_body_html = external_target.get("_body_html")
        target_text = str(external_target.get("body_text") or "")
        if not marker_text or (
            not target_text
            and not (target is not None and target.xpath(".//img|.//svg"))
            and not target_body_html
        ):
            continue

        target_source_ref = _object_dict(
            external_target.get("source_ref") or {**source_ref, "target_id": target_id}
        )
        marker_source_ref: dict[str, object] = {
            **source_ref,
            "target_ref": target_ref,
            "target_id": external_target.get("target_id"),
        }
        if str(element.tag).lower() == "xref":
            marker_source_ref["target_ids"] = list(
                dict.fromkeys((element.get("rid") or "").split())
            )
        marker_id = _source_element_id(element)
        if (
            document_href is not None
            and (adjacent := _adjacent_note_marker_address(element)) is not None
        ):
            backlinks = external_target.get("backlinks")
            previous = next(iter(_authored_names(adjacent)))
            if (
                targets.get(previous) is adjacent
                and isinstance(backlinks, list)
                and html_apparatus_ref(document_href, marker_id) not in backlinks
                and html_apparatus_ref(document_href, previous) in backlinks
            ):
                marker_id = previous
        if marker_id:
            marker_source_ref["marker_id"] = marker_id
        marker_source_ref["identity"] = _source_identity(element, root, document_href, source_ref)
        marker_key = f"{source_kind}:ref:{hashlib.sha256(json.dumps(marker_source_ref['identity'], sort_keys=True).encode()).hexdigest()[:32]}"

        target_key = target_item_key_by_id.get(target_id or "")
        if target_key is None:
            if target is None:
                target_key = str(external_target["stable_key"])
            else:
                target_key = f"{source_kind}:target:{target_id}"
                items.append(
                    {
                        "stable_key": target_key,
                        "kind": classified.target_kind,
                        "label": _target_label(target_text),
                        "body_text": target_text,
                        "_body_html": target_body_html,
                        "confidence": classified.confidence,
                        "extraction_method": classified.method,
                        "source_ref": target_source_ref,
                        "sort_key": str(external_target.get("sort_key") or f"{ordinal:06d}.target"),
                        "_locator_text": target_text,
                    }
                )
            if target is not None:
                for alias in aliases_by_target.get(target, ()):
                    target_item_key_by_id[alias] = target_key
            elif target_id:
                target_item_key_by_id[target_id] = target_key
            if target is not None:
                _stamp(
                    target_body if target_body is not None else target,
                    target_key,
                    classified.target_kind,
                    classified.confidence,
                )

        _stamp(element, marker_key, classified.marker_kind, classified.confidence)
        if marker_key not in marker_keys:
            marker_keys.add(marker_key)
            items.append(
                {
                    "stable_key": marker_key,
                    "kind": classified.marker_kind,
                    "label": marker_text,
                    "body_text": None,
                    "confidence": classified.confidence,
                    "extraction_method": classified.method,
                    "source_ref": marker_source_ref,
                    "sort_key": f"{ordinal:06d}.marker",
                    "_locator_text": marker_text,
                }
            )
        edges.append(
            {
                "stable_key": f"{marker_key}->{target_key}",
                "from_stable_key": marker_key,
                "to_stable_key": target_key,
                "relation": classified.relation,
                "confidence": classified.confidence,
                "extraction_method": classified.method,
                "source_ref": marker_source_ref,
                "sort_key": f"{ordinal:06d}.edge",
            }
        )
        ordinal += 1

    if document_href:
        for item in items:
            source = item.get("source_ref")
            target_id = source.get("target_id") if isinstance(source, dict) else None
            target = targets.get(target_id) if isinstance(target_id, str) else None
            if (
                target is not None
                and item.get("body_text") == item.get("label")
                and _is_empty_return_body(target, item.get("label"), document_href, targets)
            ):
                item["_empty_return_body"] = True
    return _fragment_html(root), items, edges


def _source_identity(
    element: HtmlElement,
    root: HtmlElement,
    document_href: str | None,
    source_ref: dict[str, object],
) -> SourceIdentity:
    document = document_href or str(
        source_ref.get("package_href")
        or source_ref.get("document_href")
        or source_ref.get("fragment_idx")
        or "0"
    )
    element_id = _source_element_id(element)
    if element_id and len(root.xpath("//*[@id=$value or @name=$value]", value=element_id)) == 1:
        return {"kind": "Authored", "document": document, "element_id": element_id}
    return {
        "kind": "Anonymous",
        "document": document,
        "digest": str(
            source_ref.get("artifact_digest")
            or hashlib.sha256(serialize_html(root).encode()).hexdigest()
        ),
        "address": element.getroottree().getpath(element),
    }


def prepare_apparatus_bodies(
    items: list[dict[str, object]], *, sanitize: Callable[[str], str], media_kind: str
) -> None:
    """Sanitize the source body once; missing rich source never becomes text content."""
    for item in items:
        raw = item.pop("_body_html", None)
        empty_return_body = item.pop("_empty_return_body", False)
        item["body_html_sanitized"] = None
        if not isinstance(raw, str) or not raw.strip():
            continue
        if empty_return_body:
            continue
        body = parse_html_document(raw)
        unsupported = body.xpath(".//math|.//object|.//embed|.//iframe|.//audio|.//video|.//canvas")
        if unsupported or (media_kind == "web_article" and body.xpath(".//svg")):
            continue
        html = sanitize(raw)
        if not html.strip():
            continue
        item["body_html_sanitized"] = html
        item["body_text"] = generate_canonical_text(html)


def _is_empty_return_body(
    target: HtmlElement, label: object, document_href: str, authored: Mapping[str, HtmlElement]
) -> bool:
    """A sole numbered return link names a note but supplies no note content."""
    if not isinstance(label, str) or not label.isdecimal():
        return False
    names = _authored_names(target)
    if not names:
        return False
    body = _note_body_element(target)
    links = body.xpath(".//a[@href]")
    if len(links) != 1 or body.xpath(".//img|.//svg"):
        return False
    marker_id = _local_target_id(links[0], document_href)
    if not marker_id or _element_text(links[0]) != label or _element_text(body) != label:
        return False
    if any(authored.get(name) is not target for name in names):
        return False
    marker = authored.get(marker_id)
    return bool(
        marker is not None
        and _local_target_id(marker, document_href) in names
        and not any(ancestor is target for ancestor in marker.iterancestors())
    )


def _authored_names(element: HtmlElement) -> set[str]:
    names = {(element.get("id") or "").strip()}
    if str(element.tag).lower() == "a":
        names.add((element.get("name") or "").strip())
    names.discard("")
    return names


@dataclass(frozen=True, slots=True)
class _TargetDocument:
    """One parsed document's authored names, declared note containers and text cache."""

    root: HtmlElement
    text: Callable[[HtmlElement], str]
    prefixes: dict[HtmlElement, str]
    note_containers: set[HtmlElement]
    unique_names: dict[str, HtmlElement]
    aliases: dict[HtmlElement, set[str]]
    note_scopes: Callable[[], dict[HtmlElement, HtmlElement | None]]


def _target_document(html: str) -> _TargetDocument | None:
    if not html.strip():
        return None
    try:
        doc = parse_html_document(html)
    except ParserError:
        return None
    root = doc.body if doc.body is not None else doc
    prefixes: dict[HtmlElement, str] = {}
    note_containers = _nested_declared_note_containers(root, prefixes)
    unique_names = _unique_authored_targets(root)
    aliases: dict[HtmlElement, set[str]] = {}
    for name, element in unique_names.items():
        aliases.setdefault(element, set()).add(name)
    text = _bounded_element_text()
    return _TargetDocument(
        root,
        text,
        prefixes,
        note_containers,
        unique_names,
        aliases,
        cache(lambda: _authored_note_scopes(root, text)),
    )


def normalize_html_rearnote_collections(
    html: str, *, document_href: str, marker_backlinks: Mapping[str, set[str]]
) -> str:
    """A singular rearnote cannot own a distinct entry proved by the source graph."""
    if not marker_backlinks or not re.search(r"\brearnote\b", html, re.IGNORECASE):
        return html
    document = parse_html_document(html)
    root = document.body if document.body is not None else document
    changed = False
    for name, entry in _unique_authored_targets(root).items():
        if html_apparatus_ref(document_href, name) not in marker_backlinks:
            continue
        for container in entry.iterancestors():
            for attribute in _SEMANTIC_ATTRIBUTES:
                tokens = (container.get(attribute) or "").split()
                if any(
                    token.casefold() == "rearnote" for token in tokens
                ) and not _leading_note_link(entry, container):
                    remaining = [token for token in tokens if token.casefold() != "rearnote"]
                    if remaining:
                        container.set(attribute, " ".join(remaining))
                    else:
                        del container.attrib[attribute]
                    changed = True
    return inner_html(root) if changed else html


def _file_start_note(root: HtmlElement) -> tuple[HtmlElement, str, str] | None:
    """An anonymous first declared body whose leading link can witness a file address."""
    body = root[0] if len(root) else None
    if (
        not isinstance(body, HtmlElement)
        or body.tag != "aside"
        or not _semantic_tokens(body) & _NOTE_BODY_TOKENS
        or _authored_names(body)
        or "marginnote" in _class_tokens(body)
        or _semantic_tokens(root) & _NOTE_BODY_TOKENS
        or (root.text or "").strip()
        or hides(body)
    ):
        return None
    first = next((link for link in body.iter("a") if link.get("href")), None)
    if (
        first is None
        or not _leading_note_link(first, body)
        or not _numeric_marker(first)
        or _element_text(body) == _element_text(first)
    ):
        return None
    return body, (first.get("href") or "").strip(), _element_text(first).strip("[].")


def _declared_collection_return(
    element: HtmlElement, text: Callable[[HtmlElement], str]
) -> str | None:
    """A named endnote paragraph followed immediately by its standalone return."""
    parent = element.getparent()
    if (
        element.tag != "p"
        or parent is None
        or not _semantic_tokens(parent) & {"endnotes", "doc-endnotes"}
        or _semantic_tokens(element) & _NOTE_BODY_TOKENS
        or (element.tail or "").strip()
        or not text(element)
    ):
        return None
    following = element.getnext()
    if not isinstance(following, HtmlElement) or following.tag != "p":
        return None
    links = list(following.iter("a"))
    if len(links) != 1:
        return None
    link = links[0]
    if (
        not (href := (link.get("href") or "").strip())
        or not text(link)
        or text(following) != text(link)
        or (following.tail or "").strip()
        or _semantic_tokens(following) & _NOTE_BODY_TOKENS
        or following.xpath(".//img|.//svg|.//table|.//math")
        or hides(element)
        or any(hides(owner) for owner in (link, *link.iterancestors()))
    ):
        return None
    return href


def _target_note_context(
    element: HtmlElement,
    facts: _TargetContext,
    prefixes: dict[HtmlElement, str],
    *,
    bounded: bool,
    evidence: bool,
) -> str | None:
    """A target's context, once a note has a body and a bibliography an entry."""
    context = "note" if bounded or evidence else facts.semantic or facts.loose
    if context not in {"note", "endnote", "bibliography"}:
        return None
    if (
        not bounded
        and context in {"note", "endnote"}
        and not (
            _is_note_body_target(element)
            or evidence
            or (facts.loose and str(element.tag).lower() == "li")
        )
    ):
        return None
    if context == "bibliography" and not _is_bibliography_entry_target(element, prefixes):
        return None
    return context


def _ambiguous(message: str) -> ApiError:
    return ApiError(ApiErrorCode.E_SOURCE_NOT_READABLE, message)


def _unique_authored_targets(root: HtmlElement) -> dict[str, HtmlElement]:
    targets: dict[str, HtmlElement] = {}
    repeated: set[str] = set()
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        for name in _authored_names(element):
            previous = targets.setdefault(name, element)
            if previous is not element:
                repeated.add(name)
    for name in repeated:
        del targets[name]
    return targets


@dataclass(frozen=True, slots=True)
class _ParagraphNoteWindow:
    blocks: list[HtmlElement]
    entries: list[tuple[int, str, str]]
    division: HtmlElement | None
    has_closing_opening: bool
    # Entry positions whose span, through its closing endpoint, could contain an
    # opening that failed to bind.
    uncertain: frozenset[int]
    # The opening block that ends the run; None at the parent's end.
    closer: HtmlElement | None
    # One return, the only meaningful content between its divider and its closer:
    # anything else there is unshown with no text tail.
    isolated: bool


def _first_content_owner(root: HtmlElement) -> HtmlElement | None:
    for event, node in iterwalk(root, events=("start", "end", "comment", "pi")):
        if event == "start":
            if isinstance(node, HtmlElement) and (
                node.tag in {"img", "svg", "table"}
                or "img" in (node.get("role") or "").split()
                or (node.text or "").strip()
            ):
                return node
        elif node is not root and (node.tail or "").strip():
            return node.getparent()
    return None


def _supplies_first_content(first: HtmlElement | None, opening: HtmlElement) -> bool:
    return first is not None and (opening is first or opening in first.iterancestors())


def collect_html_apparatus_source_positions(
    html: str,
    *,
    document_href: str,
    opening_returns: Mapping[str, str],
    refs: set[str],
) -> tuple[dict[str, int], set[str], str | None]:
    """Exact staged joins, title-first openings, and the exact file opening.

    A joined title can have preceding content. Such a join locates the source
    boundary without proving title-first geometry for a singleton.
    """
    document = _target_document(html)
    if document is None:
        return {}, set(), None
    wanted: dict[HtmlElement, list[str]] = {}
    title_first: set[str] = set()
    first_opening: str | None = None
    first_content = cache(_first_content_owner)
    for name in dict.fromkeys([*opening_returns, *refs]):
        element = document.unique_names.get(name)
        if element is None or any(
            hides(node)
            for node in [element, *element.iterancestors()]
            if node.tag not in {"html", "body"}
        ):
            continue
        if name in opening_returns:
            context = next(
                (
                    ancestor
                    for ancestor in [element, *element.iterancestors()]
                    if ancestor.tag in {"p", "figcaption"} or _authored_heading(ancestor)
                ),
                element,
            )
            returns = [
                link
                for link in context.iter("a")
                if (href := (link.get("href") or "").strip())
                and _canonical_target_ref(href, document_href) == opening_returns[name]
            ]
            if len(returns) != 1 or not document.text(returns[0]):
                continue
            if _supplies_first_content(first_content(context), returns[0]):
                title_first.add(name)
                if _supplies_first_content(first_content(document.root), returns[0]):
                    first_opening = name
        wanted.setdefault(element, []).append(name)
    positions = {
        name: index
        for index, node in enumerate(document.root.iter())
        if node in wanted
        for name in wanted[node]
    }
    return positions, title_first, first_opening


def _short_note_label(text: str) -> str | None:
    if re.fullmatch(r"(?:\[\d{1,4}\]|\d{1,4}[.:]?)", text):
        return text.strip("[].:")
    return text if re.fullmatch(r"([*†‡§¶‖])\1{0,2}|\|\|", text) else None


def _printed_return_label(text: str) -> str | None:
    if (label := _short_note_label(text)) is not None:
        return label
    if label_match := re.fullmatch(
        r"\[?((?:\d{1,4}:)?\d{1,4}[a-z]?)(?:\s*[–-]\s*(?:\d{1,4}:)?\d{1,4}[a-z]?)?\.?\]?",
        text,
    ):
        return label_match[1]
    if label_match := re.match(
        r"^(\d{1,4}:\d{1,4}[a-z]?)(?:\s*[–-]\s*[\d:a-z]+)?(?:[.:,]|\s)", text
    ):
        return label_match[1]
    if label_match := re.fullmatch(r"ch\.\s+\d{1,4}\s+(\d{1,4})\.?", text, re.IGNORECASE):
        return label_match[1]
    return text.removesuffix(".") if re.fullmatch(r"(?:[IVXLCDM]{1,8}|[a-z])\.?", text) else None


def _printed_numeric_note_range(text: str) -> tuple[int, int] | None:
    match = re.fullmatch(r"\[?(\d{1,4})[–-](\d{1,4})\.?\]?", text)
    if match is None:
        return None
    start, end = int(match[1]), int(match[2])
    return (start, end) if start < end else None


def _scoped_marker(marker: HtmlElement, printed: str, *, outside_note_scope: bool = False) -> bool:
    label = _printed_return_label(printed)
    if marker.tag != "a" or label is None and not (outside_note_scope and printed.isalpha()):
        return False
    prose = next(
        (
            owner
            for owner in marker.iterancestors()
            if owner.tag in {"p", "blockquote", "li", "div"} or _authored_heading(owner)
        ),
        None,
    )
    if prose is None:
        return False
    leading = _leading_note_link(marker, prose)
    if label is not None:
        return not leading or outside_note_scope and _element_text(prose) != printed
    return outside_note_scope and leading and prose.tag == "p" and _element_text(prose) != printed


def _authored_heading(element: HtmlElement) -> bool:
    return str(element.tag).lower() in HEADING_TAGS or (
        "heading" in (element.get("role") or "").split()
        and re.fullmatch(r"0*[1-9][0-9]*", (element.get("aria-level") or "").strip()) is not None
    )


def _paragraph_note_marker_label(marker: HtmlElement, printed: str) -> str | None:
    if str(marker.tag).lower() != "a" or not (label := _short_note_label(printed)):
        return None
    if any(
        hides(element)
        for element in [marker, *marker.iterancestors()]
        if element.tag not in {"html", "body"}
    ):
        return None
    context = next(
        (
            element
            for element in marker.iterancestors()
            if element.tag == "p" or _authored_heading(element)
        ),
        None,
    )
    # A number alone is not a reading occurrence. An attached symbol at a
    # printed section number still has independent visible content before it.
    if context is None or (
        not any(char.isalpha() for text in context.itertext() for char in text)
        and (label.isdecimal() or _leading_note_link(marker, context))
    ):
        return None
    return label


def _paragraph_note_windows(
    document: _TargetDocument,
    document_href: str,
    evidence: HtmlParagraphNoteEvidence,
) -> Iterator[_ParagraphNoteWindow]:
    returns: dict[HtmlElement, tuple[str, str]] = {}
    for element, aliases in document.aliases.items():
        if element.tag != "a" or not (href := element.get("href")):
            continue
        if not (label := _short_note_label(document.text(element))):
            continue
        marker_ref = _canonical_target_ref(href, document_href)
        anchor = next(
            (
                html_apparatus_ref(document_href, name)
                for name in sorted(aliases)
                if evidence.paragraph_backlinks.get(
                    html_apparatus_ref(document_href, name), {}
                ).get(marker_ref, ("", ("Numeric", ())))[0]
                == label
            ),
            None,
        )
        if anchor is None:
            continue
        paragraph = next(element.iterancestors("p"), None)
        if paragraph is None or not _leading_note_link(element, paragraph):
            continue
        if not re.search(r"\w", document.text(paragraph)[len(document.text(element)) :]):
            continue
        if any(
            hides(node)
            for node in [element, *element.iterancestors()]
            if node.tag not in {"html", "body"}
        ):
            continue
        returns[paragraph] = (anchor, marker_ref)

    openings: set[HtmlElement] = set()
    for name in evidence.chapter_opening_ids:
        if (element := document.unique_names.get(name)) is not None:
            openings.add(next(element.iterancestors("p"), element))
    # An editorial opening closes at each enclosing block it begins, never past
    # a declared note container. A chapter opening keeps its chapter role.
    closers: set[HtmlElement] = set()
    first_content = cache(_first_content_owner)
    for name in evidence.editorial_opening_ids - evidence.chapter_opening_ids:
        if (element := document.unique_names.get(name)) is None:
            continue
        for block in [element, *element.iterancestors()]:
            if block in document.note_containers or not _supplies_first_content(
                first_content(block), element
            ):
                break
            closers.add(block)

    order: dict[HtmlElement, int] = {}
    gaps: list[tuple[float, float]] = []
    if evidence.uncertain_openings:
        order = {element: index for index, element in enumerate(document.root.iter())}
        for names in evidence.uncertain_openings:
            bounds = [None if name is None else document.unique_names.get(name) for name in names]
            if any(
                name is not None and bound is None
                for name, bound in zip(names, bounds, strict=True)
            ):
                gaps = [(float("-inf"), float("inf"))]
                break
            left, right = bounds
            gaps.append(
                (
                    float("-inf") if left is None else order[left],
                    float("inf") if right is None else order[right],
                )
            )

    def visible(element: HtmlElement) -> bool:
        return not hides(element) and (
            element.tag in {"img", "svg", "table"}
            or bool(document.text(element) or element.xpath(".//img|.//svg|.//table"))
        )

    def inert_between(start: Any, stop: HtmlElement | None) -> bool:
        """Only whitespace and unshown nodes, comments included, lie between siblings."""
        if (start.tail or "").strip():
            return False
        for node in start.itersiblings():
            if node is stop:
                return True
            if (node.tail or "").strip() or (isinstance(node, HtmlElement) and visible(node)):
                return False
        return stop is None

    for parent in dict.fromkeys(note.getparent() for note in returns):
        if parent is None:
            continue
        division: HtmlElement | None = None
        after_divider = False
        last_divider: HtmlElement | None = None
        blocks: list[HtmlElement] = []
        for block in [*parent, None]:
            if block is not None and not isinstance(block, HtmlElement):
                continue
            scope = block is not None and (
                block in openings or (_authored_heading(block) and visible(block))
            )
            opening = scope or block in closers
            divider = block is not None and block.tag == "hr" and not hides(block)
            if block is not None and not divider and not opening:
                if after_divider:
                    blocks.append(block)
                continue
            if blocks and next((part for part in blocks if visible(part)), None) in returns:
                positions = set(blocks)
                entries: list[tuple[int, str, str]] = []
                for index, part in enumerate(blocks):
                    if (pair := returns.get(part)) is None:
                        continue
                    anchor, marker_ref = pair
                    marker_path, marker_id = split_html_apparatus_ref(marker_ref)
                    if marker_path == document_href:
                        marker = document.unique_names.get(marker_id or "")
                        if (
                            marker is None
                            or marker in positions
                            or any(ancestor in positions for ancestor in marker.iterancestors())
                        ):
                            continue
                    entries.append((index, anchor, marker_ref))
                if entries and all(not visible(part) for part in blocks[: entries[0][0]]):
                    closes = opening or (
                        block is None
                        and evidence.next_file_has_opening
                        and not any(
                            (ancestor.tail or "").strip()
                            or any(
                                visible(later)
                                for later in ancestor.itersiblings()
                                if isinstance(later, HtmlElement)
                            )
                            for ancestor in [parent, *parent.iterancestors()]
                            if ancestor.tag not in {"html", "body"}
                        )
                    )
                    uncertain: frozenset[int] = frozenset()
                    if gaps:
                        # Each span runs from its return through the next return, the
                        # closing block, or the file end.
                        ends: list[float] = [order[blocks[index]] for index, _, _ in entries[1:]]
                        ends.append(float("inf") if block is None else order[block])
                        uncertain = frozenset(
                            position
                            for position, ((index, _, _), end) in enumerate(
                                zip(entries, ends, strict=True)
                            )
                            for left, right in gaps
                            if order[blocks[index]] < right and end > left
                        )
                    assert last_divider is not None
                    first = entries[0][0]
                    isolated = (
                        len(entries) == 1
                        and inert_between(last_divider, blocks[first])
                        and inert_between(blocks[first], block)
                        and (
                            block is not None
                            or all(
                                inert_between(ancestor, None)
                                for ancestor in [parent, *parent.iterancestors()]
                                if ancestor.tag not in {"html", "body"}
                            )
                        )
                    )
                    yield _ParagraphNoteWindow(
                        blocks, entries, division, closes, uncertain, block, isolated
                    )
            blocks = []
            # An editorial close keeps the established scope; it never opens one.
            if scope:
                division = block
            after_divider = divider
            if divider:
                last_divider = block


def _inline_chain(element: HtmlElement, context: HtmlElement) -> HtmlInlineChain:
    """Each (tag, sorted classes) from element up to, not including, context."""
    chain: list[tuple[str, tuple[str, ...]]] = []
    for node in [element, *element.iterancestors()]:
        if node is context:
            break
        chain.append((str(node.tag).lower(), tuple(sorted(set((node.get("class") or "").split())))))
    return tuple(chain)


def _adjacent(block: HtmlElement, following: HtmlElement) -> bool:
    """Only whitespace and comments separate two sibling blocks."""
    if (block.tail or "").strip():
        return False
    for node in block.itersiblings():
        if node is following:
            return True
        if isinstance(node, HtmlElement) or (node.tail or "").strip():
            return False
    return False


def _note_peer_key(
    document: _TargetDocument,
    evidence: HtmlParagraphNoteEvidence,
    block: HtmlElement,
    anchor: str,
    marker_ref: str,
) -> tuple[HtmlNotePeerKey, int] | None:
    """A pair inside one chapter, keyed by its marker and leading-return shapes."""
    chapter = evidence.chapter_by_ref.get(anchor)
    if chapter is None or evidence.chapter_by_ref.get(marker_ref) != chapter:
        return None
    marker = evidence.paragraph_backlinks.get(anchor, {}).get(marker_ref)
    signature = _note_block_signature(block)
    link = document.unique_names.get(split_html_apparatus_ref(anchor)[1] or "")
    if marker is None or signature is None or link is None:
        return None
    return (chapter[0], marker[1], signature, _inline_chain(link, block)), chapter[1]


def _chapter_singleton(
    document: _TargetDocument,
    document_href: str,
    evidence: HtmlParagraphNoteEvidence,
    window: _ParagraphNoteWindow,
) -> bool:
    """A lone return ending exactly at its chapter's closer, whose shapes another
    chapter's multi-note run shows."""
    first, anchor, marker_ref = window.entries[0]
    peer = _note_peer_key(document, evidence, window.blocks[first], anchor, marker_ref)
    if peer is None or not window.isolated or not window.has_closing_opening:
        return False
    key, chapter = peer
    closer = evidence.chapter_closers.get((key[0], chapter))
    if closer is None:
        return False
    if window.closer is None:
        if evidence.next_file_opening != closer:
            return False
    else:
        path, name = split_html_apparatus_ref(closer)
        element = document.unique_names.get(name or "") if path == document_href else None
        if (
            element is None
            or window.closer not in {element, *element.iterancestors()}
            or not _supplies_first_content(_first_content_owner(window.closer), element)
        ):
            return False
    return bool(evidence.peer_chapters.get(key, set()) - {chapter})


def _note_block_signature(block: HtmlElement) -> HtmlNoteBlockSignature | None:
    if block.tag not in {"p", "blockquote", "ul", "ol"}:
        return None
    classes = tuple(sorted(set((block.get("class") or "").split())))
    if not classes:
        return None
    return str(block.tag), classes, _parent_tag(block) or ""


def _note_continuation_signature(block: HtmlElement) -> HtmlNoteBlockSignature | None:
    if _authored_names(block) or block.xpath(".//a[@id or @name]") or (block.tail or "").strip():
        return None
    return _note_block_signature(block)


def collect_html_apparatus_note_window_evidence(
    html: str,
    *,
    document_href: str,
    evidence: HtmlParagraphNoteEvidence,
    max_retained_utf8_bytes: int,
) -> int:
    """Count outside shapes and witnesses before interpreting any continuation."""
    if not evidence.paragraph_backlinks:
        return 0
    document = _target_document(html)
    if document is None:
        return 0
    retained_bytes = 0
    inside: set[HtmlElement] = set()
    for window in _paragraph_note_windows(document, document_href, evidence):
        first, last = window.entries[0][0], window.entries[-1][0]
        inside.update(window.blocks[first:])
        if window.uncertain:
            continue
        # A peer witness closes at the next return with nothing between them.
        for (index, anchor, marker_ref), (following, _, _) in zip(
            window.entries, window.entries[1:], strict=False
        ):
            if not _adjacent(window.blocks[index], window.blocks[following]):
                continue
            peer = _note_peer_key(document, evidence, window.blocks[index], anchor, marker_ref)
            if peer is None:
                continue
            key, chapter = peer
            chapters = evidence.peer_chapters.setdefault(key, set())
            if len(chapters) < 2 and chapter not in chapters:
                chapters.add(chapter)
                retained_bytes += nested_utf8_byte_length(key)
                if retained_bytes > max_retained_utf8_bytes:
                    raise ResourceLimitError(
                        "HTML apparatus note shape index exceeded", dimension="Output"
                    )
        entries = {index for index, _, _ in window.entries}
        witness = window.entries[0][1]
        for index in range(first + 1, last):
            if index in entries:
                continue
            if (signature := _note_continuation_signature(window.blocks[index])) is not None:
                peers = evidence.continuation_witnesses.setdefault(signature, set())
                if len(peers) < 2 and witness not in peers:
                    peers.add(witness)
                    retained_bytes += nested_utf8_byte_length((signature, witness))
                    if retained_bytes > max_retained_utf8_bytes:
                        raise ResourceLimitError(
                            "HTML apparatus note shape index exceeded", dimension="Output"
                        )
    for element in document.root.iter():
        if not isinstance(element, HtmlElement) or element in inside:
            continue
        signature = _note_block_signature(element)
        if signature is not None and signature not in evidence.outside_signatures:
            evidence.outside_signatures.add(signature)
            retained_bytes += nested_utf8_byte_length(signature)
            if retained_bytes > max_retained_utf8_bytes:
                raise ResourceLimitError(
                    "HTML apparatus note shape index exceeded", dimension="Output"
                )
    return retained_bytes


def _paragraph_note_bodies(
    document: _TargetDocument,
    document_href: str,
    evidence: HtmlParagraphNoteEvidence,
) -> dict[str, tuple[str, str]]:
    windows = list(_paragraph_note_windows(document, document_href, evidence))
    corroborated_openers = {
        (window.division, _note_block_signature(window.blocks[index]))
        for window in windows
        if window.division is not None and len(window.entries) >= 2 and not window.uncertain
        for index, _, _ in window.entries
    }
    bodies: dict[str, tuple[str, str]] = {}
    for window in windows:
        witness = window.entries[0][1]
        for position, (first, target, marker) in enumerate(window.entries):
            if position in window.uncertain:
                continue
            # An independently proved opener bounds the preceding body even
            # when the new body's own end cannot be proved.
            if position + 1 < len(window.entries):
                last = window.entries[position + 1][0]
            elif window.has_closing_opening:
                last = len(window.blocks)
            else:
                continue
            if (
                len(window.entries) == 1
                and (window.division, _note_block_signature(window.blocks[first]))
                not in corroborated_openers
            ):
                if not _chapter_singleton(document, document_href, evidence, window):
                    continue
                # Chapter geometry proves one paragraph; inert blocks after it stay out.
                last = first + 1
            if (window.blocks[first].tail or "").strip():
                continue
            parts = [serialize_html(window.blocks[first])]
            for block in window.blocks[first + 1 : last]:
                signature = _note_continuation_signature(block)
                if (
                    signature is None
                    or signature in evidence.outside_signatures
                    or not evidence.continuation_witnesses.get(signature, set()) - {witness}
                ):
                    break
                parts.append(serialize_html(block))
            else:
                bodies[target] = ("".join(parts), marker)
    return bodies


def _note_block_style(block: HtmlElement) -> tuple[str, tuple[str, ...]]:
    return str(block.tag), tuple(
        sorted(re.sub(r"[0-9]+$", "", name) for name in _class_tokens(block))
    )


def _bounded_continuation_styles(
    owner: HtmlElement, entries: set[HtmlElement], note_headings: set[HtmlElement]
) -> set[tuple[str, tuple[str, ...]]]:
    """Learn only the authored presentation repeated between independent entries."""
    seen: dict[tuple[str, tuple[str, ...]], int] = {}
    pending: set[tuple[str, tuple[str, ...]]] | None = None
    for child in owner:
        if not isinstance(child, HtmlElement) or _first_content_owner(child) is None:
            continue
        if child in entries:
            for shape in pending or ():
                seen[shape] = seen.get(shape, 0) + 1
            pending = set()
        elif child in note_headings or _authored_heading(child) or child.tag == "hr":
            pending = None
        elif pending is not None and child.tag in {"p", "div", "blockquote"}:
            shape = _note_block_style(child)
            if shape[1]:
                pending.add(shape)
    return {shape for shape, count in seen.items() if count >= 2}


def collect_html_apparatus_targets(
    html: str,
    *,
    document_href: str,
    source_kind: str,
    source_ref: dict[str, object],
    max_targets: int,
    max_backlinks: int,
    max_retained_utf8_bytes: int,
    extraction_method: str = "html_semantic",
    marker_backlinks: Mapping[str, set[str]] | None = None,
    entry_openers: Mapping[str, Mapping[str, HtmlApparatusEntryOpener]],
    paragraph_notes: HtmlParagraphNoteEvidence | None = None,
    paragraph_markers: HtmlParagraphBacklinks | None = None,
    note_collection_end: bool | None = None,
    bounded_note_page: bool = False,
    reading_titles: Mapping[str, str] | None = None,
    published_navigation: frozenset[str] | set[str] = frozenset(),
    prose_note_markers: Mapping[str, str] | None = None,
    closes_member: Callable[[str], bool] | None = None,
) -> tuple[dict[str, dict[str, object]], int, int, int]:
    """Index one document's note/bibliography targets so other documents can cite them."""
    if max_targets < 0 or max_backlinks < 0 or max_retained_utf8_bytes < 0:
        raise ValueError("HTML apparatus target budgets cannot be negative")
    document = _target_document(html)
    if document is None:
        return {}, 0, 0, 0
    text, ancestor_prefixes = document.text, document.prefixes
    targets: dict[str, dict[str, object]] = {}
    body_claims: dict[HtmlElement, str] = {}
    conflicting_claims: set[str] = set()
    referenced_entries = {
        element
        for name, element in document.unique_names.items()
        if html_apparatus_ref(document_href, name) in (marker_backlinks or {})
    }
    classed_entries = _terminal_footnote_paragraphs(document) | _lettered_footnote_wrappers(
        document
    )
    reference_targets, entry_boundaries, unresolved_paragraphs = _proved_note_entries(
        document_href, marker_backlinks or {}, entry_openers, document.unique_names
    )
    styled_entries: dict[tuple[HtmlElement, str], set[HtmlElement]] = {}
    typed_leaf_blocks: set[HtmlElement] = set()
    note_headings: set[HtmlElement] = set()
    peer_roles: set[HtmlElement] = set()
    for entry in entry_boundaries:
        block = _untyped_note_body(entry, text, entry_boundaries)
        if block is None:
            continue
        if block in document.note_scopes() or note_collection_end is not None:
            opening_label = _printed_return_label(text(entry))
            return_member, _ = split_html_apparatus_ref(
                _canonical_target_ref(entry.get("href") or "", document_href)
            )
            division_title = (reading_titles or {}).get(return_member)
            owner = block
            enclosure = block.getparent()
            if enclosure is not None and enclosure.tag == "blockquote" and len(enclosure) == 1:
                owner = enclosure
            for previous in owner.itersiblings(preceding=True):
                if not isinstance(previous, HtmlElement) or _first_content_owner(previous) is None:
                    continue
                if opening_label == "1" and _authored_heading(previous):
                    continue
                if previous.tag != "p" or previous.xpath(".//a[@href]|.//img|.//svg|.//table"):
                    break
                printed_title = text(previous)
                typed_title = (
                    any(
                        re.fullmatch(
                            r"(?:fn[-_]sec(?:tion)?|(?:foot|end)?notes?[-_]?(?:head(?:ing)?|title))",
                            token,
                        )
                        for token in _class_tokens(previous)
                    )
                    or enclosure is not None
                    and "note" in _semantic_tokens(enclosure)
                    and any(
                        re.fullmatch(r"h[1-6][a-z]?", token) for token in _class_tokens(previous)
                    )
                )
                if (
                    typed_title
                    or opening_label == "1"
                    and (
                        division_title is not None
                        and len(printed_title) <= 512
                        and reading_title_key(printed_title) == division_title
                        or re.fullmatch(r"(?:CHAPTER|PART|VOLUME) [A-Z0-9-]+", printed_title)
                        or text(previous)
                        in {"PREFACE", "INTRODUCTION", "PROLOGUE", "EPILOGUE", "CONCLUSION"}
                        or (
                            len(previous) == 1
                            and previous[0].tag in {"em", "i", "small"}
                            and not (previous.text or "").strip()
                            and not (previous[0].tail or "").strip()
                            and re.fullmatch(
                                r"[IVXLCDM]{1,8} [A-Z][\w’'-]*(?: [A-Z][\w’'-]*)*", text(previous)
                            )
                        )
                    )
                ):
                    note_headings.add(previous)
                    continue
                if (
                    not any(child.tag in {"b", "strong"} for child in previous)
                    or any(child.tag not in {"b", "strong", "i", "em"} for child in previous)
                    or re.search(
                        r"\w",
                        (previous.text or "") + "".join(child.tail or "" for child in previous),
                    )
                    or len(previous) > 1
                    and opening_label != "1"
                ):
                    break
                note_headings.add(previous)
        parent = block.getparent()
        if parent is not None:
            styled_entries.setdefault((parent, block.get("class") or ""), set()).add(block)
    printed_peers: dict[HtmlElement, set[HtmlElement]] = {}
    for (parent, style), blocks in styled_entries.items():
        if printed := {block for block in blocks if _looks_like_printed_note_block(block)}:
            printed_peers.setdefault(parent, set()).update(printed)
        if parent.tag == "section" and _semantic_tokens(parent) & {"appendix", "doc-appendix"}:
            entries = [
                child
                for child in parent
                if isinstance(child, HtmlElement) and _first_content_owner(child) is not None
            ]
            if len(entries) >= 2 and entries[0] in blocks and entries[-1] in blocks:
                for block in entries:
                    document.note_scopes().setdefault(block, parent)
        if parent.tag in {"body", "div", "section", "aside"} and marker_backlinks and style:
            # Corroborated openings establish the role of the styled entries
            # inside an exhaustive enclosure. Unpaired entries can close a span.
            def owned_return(
                block: HtmlElement, owner: HtmlElement, labels: Mapping[str, str] | None
            ) -> bool:
                pair = _returned_note_paragraph(
                    document, block, document_href, marker_backlinks or {}, labels
                )
                if pair is None:
                    return False
                source, name = split_html_apparatus_ref(pair[1])
                if source != document_href:
                    return True
                marker = document.unique_names.get(name or "")
                return marker is not None and owner not in marker.iterancestors()

            entries = [
                block
                for block in parent
                if isinstance(block, HtmlElement) and _first_content_owner(block) is not None
            ]
            if (
                parent.tag == "body"
                and paragraph_markers is not None
                and entries
                and not (parent.text or "").strip()
                and all(not (child.tail or "").strip() for child in parent)
            ):
                for block in entries:
                    if (
                        block.tag != "p"
                        or not any(
                            re.fullmatch(r"(?:foot|end)note[0-9]*", token)
                            for token in _class_tokens(block)
                        )
                        or (
                            pair := _returned_note_paragraph(
                                document, block, document_href, marker_backlinks, None
                            )
                        )
                        is None
                        or split_html_apparatus_ref(pair[1])[0] == document_href
                    ):
                        break
                    opening = next(link for link in block.iter("a") if link.get("href"))
                    label = _printed_return_label(text(opening))
                    visible = paragraph_markers.get(pair[0], {}).get(pair[1])
                    if label is None or (
                        (visible is None or visible[0] != label)
                        and (prose_note_markers or {}).get(pair[1]) != label
                    ):
                        break
                else:
                    typed_leaf_blocks.update(entries)
                    for block in entries:
                        document.note_scopes().setdefault(block, None)
            outer = parent.getparent()
            isolated_symbol = (
                len(entries) == 1
                and outer is not None
                and outer.tag == "div"
                and outer.get("class") is not None
                and len(outer) == 1
                and not (outer.text or "").strip()
                and not (parent.text or "").strip()
                and not (parent.tail or "").strip()
                and (
                    leading := next(
                        (link for link in entries[0].iter("a") if link.get("href")), None
                    )
                )
                is not None
                and (label := _short_note_label(text(leading))) is not None
                and not label.isdecimal()
            )
            printed = {
                block
                for block in entries
                if block.get("class") == style and _untyped_note_body(block, text) is block
            }
            typed_page = len(printed) >= 2 and all(
                _looks_like_printed_note_block(block) for block in printed
            )
            returned = sum(owned_return(block, parent, None) for block in blocks)
            if (
                returned >= (1 if isolated_symbol or typed_page else 2)
                and prose_note_markers is not None
                and any(owned_return(block, parent, prose_note_markers) for block in blocks)
                and all(
                    block in printed
                    or block.getprevious() in printed
                    and (
                        _bracketed_editorial_paragraph(block, text)
                        or block is entries[-1]
                        and block.get("class") != style
                        and _standalone_lexicon(block)
                    )
                    for block in entries
                )
            ):
                for block in printed:
                    document.note_scopes().setdefault(block, parent)
                    leading = next(link for link in block.iter("a") if link.get("href"))
                    entry_boundaries.add(leading)
    peer_roles.update(
        block for peers in printed_peers.values() if len(peers) >= 2 for block in peers
    )
    continuation_styles = {
        parent: _bounded_continuation_styles(parent, blocks, note_headings)
        for parent, blocks in printed_peers.items()
        if len(blocks) >= 2
        and (
            "note" in _semantic_tokens(parent)
            or note_collection_end is not None
            and _semantic_tokens(parent) & {"appendix", "doc-appendix"}
        )
        and any(block in document.note_scopes() for block in blocks)
    }
    # A terminal run can prove its own role and close when each printed
    # glyph returns to the reading and the publisher styled it as a note.
    for parent in {parent for parent, _ in styled_entries}:
        run = []
        returns: set[str] = set()
        blocks = (
            [
                block
                for block in parent
                if isinstance(block, HtmlElement) and _first_content_owner(block) is not None
            ]
            if parent.tag == "body"
            else []
        )
        closed_note_page = (
            bool(blocks)
            and (len(blocks) > 1 or _looks_like_printed_note_block(blocks[0]))
            and all(
                paragraph.tag == "p"
                and _returned_note_paragraph(
                    document,
                    paragraph,
                    document_href,
                    marker_backlinks or {},
                    prose_note_markers or {},
                )
                is not None
                for paragraph in blocks
            )
        )
        separated = False
        for paragraph in reversed(parent):
            if (
                isinstance(paragraph, HtmlElement)
                and paragraph.tag == "hr"
                and not hides(paragraph)
            ):
                separated = not (paragraph.tail or "").strip()
                break
            if (paragraph.tail or "").strip():
                break
            if not isinstance(paragraph, HtmlElement) or _first_content_owner(paragraph) is None:
                continue
            leading = (
                next((link for link in paragraph.iter("a") if link in entry_boundaries), None)
                if paragraph.tag == "p"
                else None
            )
            if (
                leading is None
                and paragraph.tag == "p"
                and not paragraph.xpath(".//a[@href]")
                and any(
                    re.fullmatch(r"(?:foot|end)?note(?:i[0-9]*|[-_](?:ext|ind(?:ent)?))", style)
                    for style in _class_tokens(paragraph)
                )
            ):
                run.append(paragraph)
                continue
            if (
                leading is None
                or not _leading_note_link(leading, paragraph)
                or (
                    label := _short_note_label(text(leading))
                    or (
                        text(leading).removesuffix(".")
                        if re.fullmatch(r"[IVXLCDM]{1,8}\.?", text(leading))
                        else None
                    )
                )
                is None
                or (return_ref := _canonical_target_ref(leading.get("href") or "", document_href))
                in returns
                or not (
                    closed_note_page
                    or not label.isdecimal()
                    and _looks_like_printed_note_block(paragraph)
                    or len(leading) == 1
                    and leading[0].tag == "sup"
                    and leading[0] in document.aliases
                    and _first_content_owner(leading) is leading[0]
                )
            ):
                break
            returns.add(return_ref)
            run.append(paragraph)
        if len(returns) >= 2 or closed_note_page or separated and returns:
            for paragraph in run:
                document.note_scopes().setdefault(paragraph, parent)
    paragraph_bodies = (
        _paragraph_note_bodies(document, document_href, paragraph_notes)
        if paragraph_notes is not None and paragraph_notes.paragraph_backlinks
        else {}
    )
    if prose_note_markers and marker_backlinks:
        for target, body in _terminal_paragraph_note_run(
            document, document_href, marker_backlinks, prose_note_markers
        ):
            paragraph_bodies.setdefault(target, body)
    ordinal = 0
    retained_count = 0
    retained_utf8_bytes = 0
    backlink_count = 0
    opening_note = (
        _file_start_note(document.root)
        if marker_backlinks and html_apparatus_ref(document_href) in marker_backlinks
        else None
    )
    for element in document.root.iter():
        if not isinstance(element, HtmlElement):
            continue
        aliases = document.aliases.get(element, set())
        file_start = opening_note is not None and element is opening_note[0]
        if not aliases and not file_start:
            continue
        reciprocal_aliases = sorted(
            alias
            for alias in aliases
            if (marker_backlinks and marker_backlinks.get(html_apparatus_ref(document_href, alias)))
            or html_apparatus_ref(document_href, alias) in paragraph_bodies
        )
        preferred = (element.get("id") or "").strip()
        names = reciprocal_aliases or sorted(aliases)
        target_id = None if file_start else preferred if preferred in names else names[0]
        if element in document.note_containers:
            continue
        facts = _target_context(element, ancestor_prefixes, text)
        body = _note_body_element(element)
        target_ref = html_apparatus_ref(document_href, target_id)
        paragraph_body = (
            paragraph_bodies.get(target_ref)
            if facts.semantic is None and facts.loose != "bibliography"
            else None
        )
        allowed_hrefs = (
            (marker_backlinks or {}).get(target_ref, set())
            if file_start
            else {
                href
                for name in aliases
                for href in (marker_backlinks or {}).get(
                    html_apparatus_ref(document_href, name), set()
                )
            }
        )
        reciprocal_marker = bool(allowed_hrefs)
        adjacent_return = _declared_collection_return(element, text) if reciprocal_marker else None
        if (
            adjacent_return is not None
            and _canonical_target_ref(adjacent_return, document_href) not in allowed_hrefs
        ):
            adjacent_return = None
        paragraph = (
            element if str(element.tag).lower() == "p" else next(element.iterancestors("p"), None)
        )
        wrapper = None
        wrapper_return = None
        wrapper_label = None
        dedicated = False
        inline_html = (
            _inline_note_html(element, body, entry_boundaries, document_href)
            if source_ref.get("format") == "xhtml"
            and reciprocal_marker
            and paragraph_body is None
            and facts.semantic != "bibliography"
            and facts.loose != "bibliography"
            else None
        )
        if (
            reciprocal_marker
            and facts.semantic is None
            and paragraph_body is None
            and inline_html is None
            and paragraph not in typed_leaf_blocks
        ):
            if (entry := _grouped_note_entry(element, text, classed_entries)) is not None:
                body_owner, returning, opening_label = entry
                wrapper_return = (returning.get("href") or "").strip()
                if (
                    _canonical_target_ref(wrapper_return, document_href) in allowed_hrefs
                    and not any(
                        child in referenced_entries and not _leading_note_link(child, body_owner)
                        for child in body_owner.iterdescendants()
                    )
                    and (
                        opening_label != "*"
                        or _star_paragraph_is_bounded(body_owner, referenced_entries)
                    )
                ):
                    wrapper = body_owner
                    wrapper_label = opening_label
                    dedicated = not _leading_note_link(returning, body_owner)
        if (
            source_ref.get("format") == "xhtml"
            and facts.semantic is None
            and facts.loose != "bibliography"
            and paragraph_body is None
            and wrapper is None
            and (target_ref not in reference_targets or paragraph in unresolved_paragraphs)
        ):
            continue
        boundary = (
            _untyped_note_body(element, text, entry_boundaries)
            if source_ref.get("format") == "xhtml"
            and element.tag != "div"
            and facts.semantic is None
            and paragraph_body is None
            and wrapper is None
            and (facts.loose != "bibliography" or reciprocal_marker)
            else None
        )
        inferred_note = (
            facts.semantic is None
            and paragraph_body is None
            and wrapper is None
            and (facts.loose != "bibliography" or reciprocal_marker)
            and _looks_like_note_body(body, text)
        )
        context = (
            "endnote"
            if adjacent_return is not None
            or (
                wrapper is not None
                and (name := _writer_note_name(element, wrapper)) is not None
                and name.startswith("sdendnote")
            )
            else _target_note_context(
                element,
                facts,
                ancestor_prefixes,
                bounded=boundary is not None,
                evidence=(
                    paragraph_body is not None
                    or wrapper is not None
                    or inline_html is not None
                    or inferred_note
                ),
            )
        )
        if context is None:
            continue
        body_html = inline_html
        if wrapper is not None:
            body_html = serialize_html(wrapper) if wrapper.tag == "p" else inner_html(wrapper)
        elif paragraph_body is not None:
            body_html = paragraph_body[0]
        if body_html is None:
            body_html = (
                _inferred_note_html(
                    boundary,
                    document,
                    entry_boundaries,
                    unresolved_paragraphs,
                    document_href=document_href,
                    marker_backlinks=marker_backlinks or {},
                    note_headings=note_headings,
                    local_scope=boundary in document.note_scopes()
                    or note_collection_end is not None,
                    peer_scope=boundary in peer_roles,
                    authored_scope=document.note_scopes().get(boundary),
                    note_collection_end=note_collection_end,
                    bounded_note_page=bounded_note_page,
                    published_navigation=published_navigation,
                    continuation_styles=continuation_styles.get(boundary.getparent()),
                    closes_member=closes_member,
                )
                if boundary is not None
                else inner_html(element)
            )
        if body_html is None:
            continue
        if wrapper is None and inline_html is None and boundary is None and inferred_note:
            body_html = inner_html(body)
        body_text = generate_canonical_text(body_html)
        if not body_text and not element.xpath(".//img|.//svg"):
            continue
        backlinks = (
            [_canonical_target_ref(opening_note[1], document_href)]
            if file_start and opening_note is not None
            else [_canonical_target_ref(adjacent_return, document_href)]
            if adjacent_return is not None
            else [_canonical_target_ref(wrapper_return, document_href)]
            if wrapper is not None and wrapper_return is not None and len(reciprocal_aliases) < 2
            else [paragraph_body[1]]
            if paragraph_body is not None
            else _link_hrefs(
                parse_html_document(body_html),
                document_href=document_href,
                max_count=max_backlinks - backlink_count,
                allowed_hrefs=allowed_hrefs
                if facts.semantic is None and marker_backlinks is not None
                else None,
            )
        )
        if len(backlinks) > max_backlinks - backlink_count:
            raise ResourceLimitError("HTML apparatus backlink count exceeded", dimension="Output")
        candidate_ordinal = ordinal
        if not file_start:
            ordinal += 1
        if facts.semantic is None and marker_backlinks is not None and not backlinks:
            continue
        if retained_count >= max_targets:
            raise ResourceLimitError("HTML apparatus target count exceeded", dimension="Output")
        backlink_count += len(backlinks)
        scoped_body = (
            boundary is not None
            and (
                boundary in document.note_scopes()
                or boundary in peer_roles
                or note_collection_end is not None
            )
            or inline_html is not None
            and (body in document.note_scopes() or note_collection_end is not None)
        )
        target = {
            "target_ref": target_ref,
            "target_href": document_href,
            "target_id": target_id,
            "context": context,
            "_has_note_context": (
                paragraph_body is not None or wrapper is not None or facts.is_note or scoped_body
            ),
            "kind": _target_kind_for_context(context),
            "_scoped_note": scoped_body,
            "label": _target_label(body_text),
            "body_text": body_text,
            "_body_html": body_html,
            "confidence": "exact" if facts.semantic and boundary is None else "strong",
            "extraction_method": "html_paragraph_note"
            if paragraph_body is not None
            else "html_note_boundary"
            if boundary is not None or inline_html is not None or wrapper is not None
            else extraction_method
            if facts.semantic
            else "html_link_graph",
            "source_ref": {**source_ref, "target_href": document_href, "target_id": target_id},
            "sort_key": f"{_source_order_key(element, candidate_ordinal)}.target",
            # The body is already owned by unlinked declared-note publication.
            "stable_key": f"{source_kind}:declared-note:000000"
            if file_start
            else f"{source_kind}:target:{stable_token(target_ref)}",
            "backlinks": backlinks,
            "_body_inline": inline_html is not None,
        }
        if file_start and opening_note is not None:
            target["_file_start_label"] = opening_note[2]
        if boundary is not None and boundary in document.note_scopes():
            leading = next((link for link in boundary.iter("a") if link.get("href")), None)
            if leading is not None:
                target["_leading_return_label"] = _printed_return_label(text(leading))
            if (
                leading is not None
                and (printed_range := _printed_numeric_note_range(text(leading))) is not None
            ):
                target["_printed_note_range"] = list(printed_range)
        if wrapper_label is not None:
            target["_body_wrapper_label"] = wrapper_label
            if wrapper is not None and wrapper.tag == "p":
                target["_body_is_paragraph_wrapper"] = True
            if dedicated:
                target["_body_has_terminal_return"] = True
        if (
            wrapper is None
            and paragraph is not None
            and inline_html is None
            and generate_canonical_text(serialize_html(paragraph)) == body_text
        ):
            target["_body_paragraph_names"] = [
                name
                for node in paragraph.iter()
                if isinstance(node, HtmlElement)
                for name in sorted(_authored_names(node))
            ]
        if source_ref.get("format") == "xhtml":
            stamp = (
                element
                if inline_html is not None
                else wrapper
                if wrapper is not None
                else paragraph
                if paragraph_body is not None or "_body_paragraph_names" in target
                else body
            )
            if stamp is not None:
                first_claim = body_claims.setdefault(stamp, target_ref)
                if first_claim != target_ref:
                    conflicting_claims.update((first_claim, target_ref))
        retained_utf8_bytes += nested_utf8_byte_length(target)
        if retained_utf8_bytes > max_retained_utf8_bytes:
            raise ResourceLimitError("HTML apparatus target text exceeded", dimension="Output")
        targets[target_ref] = target
        for alias in aliases:
            targets[html_apparatus_ref(document_href, alias)] = target
        retained_count += 1
    if conflicting_claims:
        targets = {
            ref: proof
            for ref, proof in targets.items()
            if proof["target_ref"] not in conflicting_claims
        }
    return targets, retained_count, retained_utf8_bytes, backlink_count


def collect_html_apparatus_candidate_backlinks(
    html: str,
    *,
    document_href: str,
    record_candidate: Callable[[str, Iterator[str], bool, str | None], None],
) -> None:
    """Spill target backlinks and their independent note context before budgeting."""
    document = _target_document(html)
    if document is None:
        return
    if (opening_note := _file_start_note(document.root)) is not None:
        record_candidate(
            html_apparatus_ref(document_href),
            iter((_canonical_target_ref(opening_note[1], document_href),)),
            True,
            None,
        )
    text, prefixes = document.text, document.prefixes
    classed_entries = _terminal_footnote_paragraphs(document) | _lettered_footnote_wrappers(
        document
    )
    for element in document.root.iter():
        if not isinstance(element, HtmlElement):
            continue
        aliases = document.aliases.get(element)
        if not aliases or element in document.note_containers:
            continue
        if (adjacent_return := _declared_collection_return(element, text)) is not None:
            for target_id in aliases:
                record_candidate(
                    html_apparatus_ref(document_href, target_id),
                    iter((_canonical_target_ref(adjacent_return, document_href),)),
                    True,
                    None,
                )
            continue
        # An inherited singular rearnote may be a mislabeled collection.
        facts = _target_context(element, prefixes, text, inherit_rearnote=False)
        if (
            facts.semantic is None
            and (entry := _grouped_note_entry(element, text, classed_entries)) is not None
        ):
            owner, returning, printed = entry
            leading_href = (returning.get("href") or "").strip()
            marker_label = (
                printed
                if printed == "*"
                or owner in classed_entries
                and owner.tag == "div"
                or not _leading_note_link(returning, owner)
                else None
            )
            backlinks = (
                _same_body_return_hrefs(owner, returning, text)
                if len(aliases) > 1
                else [leading_href]
            )
            for target_id in aliases:
                record_candidate(
                    html_apparatus_ref(document_href, target_id),
                    (_canonical_target_ref(href, document_href) for href in backlinks),
                    True,
                    marker_label,
                )
            continue
        body = _note_body_element(element)
        boundary = (
            _untyped_note_body(element, text, allow_label_only=True)
            if facts.semantic is None and element.tag != "div"
            else None
        )
        inferred = facts.semantic is None and _looks_like_note_body(body, text)
        inline = (
            facts.semantic is None
            and facts.loose != "bibliography"
            and str(element.tag).lower() == "a"
            and bool(element.get("href"))
            and not _is_sup_marker(element)
            and (
                body.tag in {"p", "li"}
                or any(parent.tag in {"p", "li"} for parent in element.iterancestors())
            )
        )
        if (
            _target_note_context(
                element, facts, prefixes, bounded=boundary is not None, evidence=inferred or inline
            )
            is None
        ):
            continue
        backlink_root = boundary if boundary is not None else body if inferred else element
        if inline and boundary is None:
            backlinks = [element.get("href") or ""]
        elif facts.semantic is None or len(aliases) > 1 and facts.is_note:
            leading = next((link for link in backlink_root.iter("a") if link.get("href")), None)
            backlinks = (
                _same_body_return_hrefs(backlink_root, leading, text) if leading is not None else []
            )
        else:
            backlinks = [
                (link.get("href") or "").strip()
                for link in backlink_root.iter("a")
                if link.get("href")
            ]
        for target_id in aliases:
            record_candidate(
                html_apparatus_ref(document_href, target_id),
                (_canonical_target_ref(href, document_href) for href in backlinks),
                facts.is_note
                or body in document.note_scopes()
                or boundary is not None
                and (
                    boundary in document.note_scopes() or _looks_like_printed_note_block(boundary)
                ),
                None,
            )


def _same_body_return_hrefs(
    owner: HtmlElement, leading: HtmlElement, text: Callable[[HtmlElement], str]
) -> list[str]:
    return [
        link.get("href") or ""
        for link in owner.iter("a")
        if link.get("href")
        and (
            link is leading
            and _leading_note_link(link, owner)
            or text(link).casefold() in {"return", "back to text", "(back to text)", "↩", "↵"}
            and _ends_source_scope(link, owner)
        )
    ]


def collect_html_apparatus_marker_backlinks(
    html: str,
    *,
    document_href: str,
    target_hrefs: set[str],
    candidate_backlink_exists: Callable[[str, str, str, bool, str | None], bool],
    marker_backlinks: dict[str, set[str]],
    entry_openers: dict[str, dict[str, HtmlApparatusEntryOpener]],
    max_markers: int,
    max_retained_utf8_bytes: int,
    paragraph_backlinks: dict[str, dict[str, HtmlParagraphMarker]] | None = None,
    prose_note_markers: dict[str, str] | None = None,
) -> tuple[int, int]:
    if max_markers < 0 or max_retained_utf8_bytes < 0:
        raise ValueError("HTML apparatus marker budgets cannot be negative")
    if not html.strip():
        return 0, 0
    try:
        doc = parse_html_document(html)
    except ParserError:
        return 0, 0
    source_ids = _unique_authored_targets(doc)
    root = doc.body if doc.body is not None else doc
    source_scopes = cache(lambda: _authored_note_scopes(root, _bounded_element_text()))
    count = 0
    retained_bytes = 0

    def returning_id(
        target: str, source_ids: list[str], require_note: bool, *labels: str | None
    ) -> str | None:
        for source_id in source_ids:
            for label in labels:
                if candidate_backlink_exists(target, source_id, document_href, require_note, label):
                    return source_id
        return None

    for marker in doc.iter():
        if not isinstance(marker, HtmlElement):
            continue
        if not (ref := _target_ref(marker)):
            continue
        owner = _source_element_id_owner(marker)
        nearby = _nearby_reading_return(marker) if owner is None else None
        if owner is None:
            owner = nearby
        if owner is None:
            continue
        primary = (owner.get("id") or owner.get("name") or "").strip()
        marker_ids = [
            name
            for name in (primary, *sorted(_authored_names(owner) - {primary}))
            if name and source_ids.get(name) is owner
        ]
        if (adjacent := _adjacent_note_marker_address(marker)) is not None:
            name = next(iter(_authored_names(adjacent)))
            if source_ids.get(name) is adjacent:
                marker_ids.append(name)
        if not marker_ids:
            continue
        marker_id = marker_ids[0]
        tokens = _semantic_tokens(marker)
        explicit = (
            "noteref" in tokens
            or "doc-noteref" in tokens
            or "biblioref" in tokens
            or "doc-biblioref" in tokens
            or (marker.get("ref-type") or "").strip().lower() in {"fn", "bibr"}
        )
        printed = _element_text(marker)
        unmarked = marker.tag == "a" and not printed and _first_content_owner(marker) is None
        numeric_sup = (
            str(marker.tag).lower() == "a" and _numeric_marker(marker) and _is_sup_marker(marker)
        )
        paragraph_label = (
            _paragraph_note_marker_label(marker, printed)
            if paragraph_backlinks is not None and not explicit and not numeric_sup
            else None
        )
        entry_opener = None
        label = printed
        if not explicit and not numeric_sup:
            paragraph = next(marker.iterancestors("p"), None)
            if (
                _is_sup_marker(marker)
                and (symbol := _short_note_label(label)) is not None
                and not symbol.isdecimal()
            ):
                entry_opener = HtmlApparatusEntryOpener(symbol, "Symbol")
            elif (
                paragraph is not None
                and _leading_note_link(marker, paragraph)
                and re.search(r"\w", _element_text(paragraph)[len(label) :])
            ):
                division_label = label if _numeric_marker(marker) else None
                if division_label is None:
                    superscripts = marker.xpath(".//sup")
                    plain_label = normalize_whitespace(
                        "".join(marker.xpath(".//text()[not(ancestor::sup)]"))
                    )
                    if (
                        len(superscripts) == 1
                        and _element_text(superscripts[0]) == "1"
                        and re.fullmatch(r"\d{1,4}", plain_label)
                    ):
                        division_label = plain_label
                if division_label is not None:
                    entry_opener = HtmlApparatusEntryOpener(division_label, "Division")
        dedicated_label = _dedicated_note_marker(marker, printed)
        scoped = _scoped_marker(marker, printed) or (
            _scoped_marker(marker, printed, outside_note_scope=True)
            and marker not in source_scopes()
        )
        marker_label = (
            dedicated_label
            if dedicated_label is not None
            else printed
            if _printed_note_marker(marker, printed)
            else None
        )
        if (
            not explicit
            and not numeric_sup
            and entry_opener is None
            and paragraph_label is None
            and marker_label is None
            and not scoped
            and not unmarked
        ):
            continue
        if _is_ignored_margin_note_context(marker, allow_chapter_header=True):
            continue
        target_ref = _canonical_target_ref(ref, document_href)
        target_href, target_id = split_html_apparatus_ref(target_ref)
        if target_href not in target_hrefs or target_id == "":
            continue
        if nearby is not None and (target_href != document_href or marker in source_scopes()):
            continue
        if target_id is None and (
            target_href == document_href
            or not tokens & {"noteref", "doc-noteref"}
            or not _numeric_marker(marker)
        ):
            continue
        if unmarked:
            if (unmarked_id := returning_id(target_ref, marker_ids, True, None)) is None:
                continue
            marker_ids = [unmarked_id]
            marker_id = unmarked_id
            entry_opener = HtmlApparatusEntryOpener("", "UnmarkedReference")
        heading_reference = (
            not explicit
            and entry_opener is None
            and any(
                isinstance(a, HtmlElement) and str(a.tag).lower() in HEADING_TAGS
                for a in marker.iterancestors()
            )
        )
        labeled = (
            returning_id(target_ref, marker_ids, True, marker_label)
            if marker_label is not None
            and (target_href == document_href) == (marker_label == "*" and dedicated_label is None)
            else None
        )
        scope_label = _short_note_label(printed) if scoped else None
        scope_labels = (None,) if scope_label is None else (None, scope_label)
        scoped_id = returning_id(target_ref, marker_ids, True, *scope_labels) if scoped else None
        reciprocal_id = (
            labeled or scoped_id or returning_id(target_ref, marker_ids, heading_reference, None)
        )
        marker_id = reciprocal_id or marker_id
        labeled_backlink = labeled is not None
        scoped_backlink = scoped_id is not None
        has_backlink = reciprocal_id is not None
        prose_sup = scoped and _is_sup_marker(marker)
        direct_pair = scoped and has_backlink
        if labeled_backlink or scoped_backlink or (prose_sup and has_backlink):
            entry_opener = None
        paragraph_id = reciprocal_id
        if paragraph_id is None and heading_reference and paragraph_label is not None:
            paragraph_id = returning_id(target_ref, marker_ids, False, None)
        if paragraph_label is not None and paragraph_id is not None:
            assert paragraph_backlinks is not None
            source_ref = html_apparatus_ref(document_href, paragraph_id)
            refs = paragraph_backlinks.setdefault(target_ref, {})
            if source_ref not in refs:
                context = next(
                    ancestor
                    for ancestor in marker.iterancestors()
                    if ancestor.tag == "p" or _authored_heading(ancestor)
                )
                kind: Literal["Numeric", "Symbol"] = (
                    "Numeric" if paragraph_label.isdigit() else "Symbol"
                )
                shape = (kind, _inline_chain(marker, context))
                added_bytes = nested_utf8_byte_length(
                    (target_ref, source_ref, paragraph_label, shape)
                )
                if count >= max_markers or retained_bytes + added_bytes > max_retained_utf8_bytes:
                    raise ResourceLimitError(
                        "HTML apparatus marker index exceeded", dimension="Output"
                    )
                refs[source_ref] = (paragraph_label, shape)
                count += 1
                retained_bytes += added_bytes
        if (
            not explicit
            and not numeric_sup
            and entry_opener is None
            and not labeled_backlink
            and not scoped_backlink
            and not direct_pair
        ):
            continue
        if nearby is not None and not scoped_backlink:
            continue
        if not has_backlink:
            if heading_reference or not numeric_sup:
                continue
            entry_opener = HtmlApparatusEntryOpener(label, "UnpairedReference")
        if entry_opener is not None:
            source_href = html_apparatus_ref(document_href, marker_id)
            if source_href in entry_openers.get(target_ref, {}):
                continue
            if count >= max_markers:
                raise ResourceLimitError("HTML apparatus marker count exceeded", dimension="Output")
            added_bytes = nested_utf8_byte_length(
                (target_ref, source_href, entry_opener.role, entry_opener.label)
            )
            if retained_bytes + added_bytes > max_retained_utf8_bytes:
                raise ResourceLimitError("HTML apparatus marker text exceeded", dimension="Output")
            entry_openers.setdefault(target_ref, {})[source_href] = entry_opener
            count += 1
            retained_bytes += added_bytes
            if not direct_pair:
                continue
        hrefs = {html_apparatus_ref(document_href, marker_id)}
        existing = marker_backlinks.get(target_ref, set())
        new_hrefs = hrefs - existing
        if not new_hrefs:
            continue
        if count >= max_markers:
            raise ResourceLimitError("HTML apparatus marker count exceeded", dimension="Output")
        added_bytes = sum(utf8_byte_length(href) for href in new_hrefs)
        if not existing:
            added_bytes += utf8_byte_length(target_ref)
        source_key = html_apparatus_ref(document_href, marker_id)
        if (
            prose_note_markers is not None
            and source_key not in prose_note_markers
            and prose_sup
            and (label := _printed_return_label(printed)) is not None
        ):
            prose_note_markers[source_key] = label
            added_bytes += nested_utf8_byte_length((source_key, label))
        if retained_bytes + added_bytes > max_retained_utf8_bytes:
            raise ResourceLimitError("HTML apparatus marker text exceeded", dimension="Output")
        marker_backlinks.setdefault(target_ref, set()).update(new_hrefs)
        count += 1
        retained_bytes += added_bytes
    return count, retained_bytes


def confirm_html_apparatus_target_refs(
    html: str,
    *,
    document_href: str,
    find_target: Callable[[str], Mapping[str, object] | None],
) -> set[str]:
    """Confirm inferred targets from actual reciprocal source markers."""
    if not html.strip():
        return set()
    try:
        doc = parse_html_document(html)
    except ParserError:
        return set()
    confirmed: set[str] = set()
    root = doc.body if doc.body is not None else doc
    unique_names = _unique_authored_targets(root)
    scopes = cache(lambda: _authored_note_scopes(root, _bounded_element_text()))
    for marker in doc.iter():
        if not isinstance(marker, HtmlElement):
            continue
        ref = _target_ref(marker)
        if not ref:
            continue
        target_ref = _canonical_target_ref(ref, document_href)
        target = find_target(target_ref)
        if target is None or str(target.get("confidence")) != "strong":
            continue
        facts = _target_facts(
            marker,
            target,
            document_href,
            unique_names=unique_names,
            outside_note_scope=target.get("_scoped_note") is True and marker not in scopes(),
        )
        if facts.has_backlink and _classify(marker, facts) is not None:
            confirmed.add(target_ref)
            confirmed.add(str(target["target_ref"]))
    return confirmed


def attach_fragment_locators(
    *,
    media_id: UUID,
    fragment_id: UUID,
    media_kind: str,
    canonical_text: str,
    items: list[dict[str, object]],
    accepted_spans: Mapping[str, tuple[int, int, str]],
    html_sanitized: str | None = None,
) -> list[dict[str, object]]:
    """Give each item an exact canonical-text offset span, or no locator at all.

    Complete bodies may differ in whitespace from their exact stored quote.
    A complete source-bound paragraph uses its corresponding full stored paragraph.
    A stamped source start stays authoritative; an unstamped match must be unique.
    """
    locator_text_by_key = _apparatus_locator_texts(html_sanitized)
    normalized_text: NormalizedText | None = None
    result: list[dict[str, object]] = []
    for item in items:
        item = dict(item)
        complete_source_paragraph = item.pop("_complete_source_paragraph", False)
        stable_key = str(item["stable_key"])
        raw_locator_text = str(item.pop("_locator_text", "") or "")
        locator_text = locator_text_by_key.get(stable_key) or raw_locator_text
        span_with_text = accepted_spans.get(stable_key)
        if item.get("extraction_method") == "html_paragraph_note" and span_with_text is None:
            result.append({**item, "locator_status": "missing", "locator": None})
            continue
        if item["kind"] in {"footnote", "endnote", "bibliography_entry"}:
            body_text = str(item.get("body_text") or "")
            if not complete_source_paragraph or normalize_whitespace(
                locator_text
            ) == normalize_whitespace(body_text):
                locator_text = body_text
            span = _unique_text_span(canonical_text, locator_text)
            if span_with_text is not None:
                start = span_with_text[0]
                end = start + len(locator_text)
                span = (
                    (start, end)
                    if locator_text and canonical_text[start:end] == locator_text
                    else None
                )
            if span is None and locator_text:
                if normalized_text is None:
                    normalized_text = normalize_for_match(canonical_text)
                candidates = find_quote_candidates(
                    normalized_text,
                    exact=normalize_for_match(locator_text).text.strip(),
                    prefix="",
                    suffix="",
                )
                if span_with_text is not None:
                    candidates = [
                        candidate
                        for candidate in candidates
                        if candidate.raw_start == span_with_text[0]
                    ]
                if len(candidates) == 1:
                    span = (candidates[0].raw_start, candidates[0].raw_end)
                    locator_text = canonical_text[span[0] : span[1]]
        elif span_with_text is not None:
            start, end, locator_text = span_with_text
            span = (start, end)
        else:
            span = _unique_text_span(canonical_text, locator_text)
        if span is None:
            item["locator_status"] = "missing"
            item["locator"] = None
        else:
            item["locator_status"] = "exact"
            item["locator"] = {
                "type": "web_text_offsets"
                if media_kind == "web_article"
                else "epub_fragment_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": span[0],
                "end_offset": span[1],
                "media_kind": media_kind,
                "text_quote_selector": {"exact": locator_text},
            }
        if span is not None:
            source = dict(_object_dict(item.get("source_ref") or {}))
            source["quote_context"] = {
                "exact": locator_text,
                "prefix": canonical_text[max(0, span[0] - 48) : span[0]],
                "suffix": canonical_text[span[1] : span[1] + 48],
                "target": source.get("target_ref") or source.get("target_id"),
            }
            item["source_ref"] = source
        result.append(item)
    return result


def incomplete_epub_paragraph_note_keys(
    items: Iterable[Mapping[str, object]], edges: Iterable[Mapping[str, object]]
) -> frozenset[str]:
    """Only publish a new inferred note when both exact ends and rich body survived."""
    candidates = {
        str(item["stable_key"]): (
            item.get("locator_status") == "exact",
            bool(item.get("body_html_sanitized") and item.get("body_text")),
        )
        for item in items
        if item.get("extraction_method") == "html_paragraph_note"
    }
    complete: set[str] = set()
    for edge in edges:
        if edge.get("extraction_method") != "html_paragraph_note":
            continue
        source = str(edge["from_stable_key"])
        target = str(edge["to_stable_key"])
        marker, body = candidates.get(source), candidates.get(target)
        if marker is not None and marker[0] and body == (True, True):
            complete.update((source, target))
    return frozenset(candidates.keys() - complete)


def prune_epub_paragraph_note_stamps(html: str, keys: frozenset[str]) -> str:
    """Remove only generated note attributes, leaving actual source markup byte-identical."""
    if not keys or "data-reader-apparatus-item-id" not in html:
        return html
    cuts: list[tuple[int, int]] = []
    current_line = 1
    line_start = 0

    class StampedTags(HTMLParser):
        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            nonlocal current_line, line_start
            if dict(attrs).get("data-reader-apparatus-item-id") not in keys:
                return
            start_tag = self.get_starttag_text()
            assert start_tag is not None
            line, column = self.getpos()
            for _ in range(current_line, line):
                line_start = html.index("\n", line_start) + 1
            current_line = line
            base = line_start + column
            for attribute in _START_TAG_ATTRIBUTE.finditer(start_tag):
                if attribute["name"] in _APPARATUS_STAMP_ATTRIBUTES:
                    cuts.append((base + attribute.start(), base + attribute.end()))

    parser = StampedTags(convert_charrefs=False)
    parser.feed(html)
    parser.close()
    parts: list[str] = []
    previous = 0
    for start, end in cuts:
        parts.append(html[previous:start])
        previous = end
    parts.append(html[previous:])
    return "".join(parts)


def bind_retained_epub_apparatus(
    *,
    source_html: str,
    retained_html: str,
    source: CanonicalStructure,
    retained: CanonicalStructure,
    source_fragment_id: UUID,
    retained_fragment_id: UUID,
    items: list[dict[str, object]],
    note_groups: list[NotesGroup],
) -> tuple[list[dict[str, object]], list[NotesGroup]]:
    """Bind a proved source extraction to an unchanged retained document."""

    def without_stamps(html: str) -> str:
        document = parse_html_document(html)
        for node in document.iter():
            if not isinstance(node, HtmlElement):
                continue
            for attribute in _APPARATUS_STAMP_ATTRIBUTES:
                node.attrib.pop(attribute, None)
        return serialize_html(document)

    if source.text != retained.text or (
        source_html != retained_html
        and without_stamps(source_html) != without_stamps(retained_html)
    ):
        raise ValueError("EPUB apparatus source differs from the retained fragment")

    def retained_point(point: NavigationTextPointOut) -> NavigationTextPointOut:
        if point.fragment_id != source_fragment_id or not 0 <= point.offset <= len(retained.text):
            raise ValueError("EPUB apparatus point has no retained correspondence")
        return NavigationTextPointOut(fragment_id=retained_fragment_id, offset=point.offset)

    rebound: list[dict[str, object]] = []
    for item in items:
        locator = _object_dict(item.get("locator"))
        if not locator:
            if item.get("extraction_method") == "html_paragraph_note":
                raise ValueError("EPUB paragraph note has no exact source locator")
            rebound.append(item)
            continue
        start, end = locator.get("start_offset"), locator.get("end_offset")
        if (
            item.get("locator_status") != "exact"
            or locator.get("type") != "epub_fragment_offsets"
            or locator.get("fragment_id") != str(source_fragment_id)
            or not isinstance(start, int)
            or not isinstance(end, int)
            or not 0 <= start < end <= len(retained.text)
            or _object_dict(locator.get("text_quote_selector")).get("exact")
            != retained.text[start:end]
        ):
            raise ValueError("EPUB apparatus locator disagrees with the retained fragment")
        rebound.append({**item, "locator": {**locator, "fragment_id": str(retained_fragment_id)}})

    groups = [
        NotesGroup(
            range=NavigationTextRangeOut(
                start=retained_point(group.range.start), end=retained_point(group.range.end)
            ),
            heading=retained_point(group.heading) if group.heading is not None else None,
            provenance=group.provenance,
        )
        for group in note_groups
    ]
    return rebound, groups


def derive_fragment_note_groups(
    html_sanitized: str,
    canonical_text: str,
    fragment_id: UUID,
    *,
    structure: CanonicalStructure,
    accepted_spans: Mapping[str, tuple[int, int, str]],
    source_html: str | None = None,
) -> list[NotesGroup]:
    """Bound a governed collection only when repeated note bodies corroborate it."""
    if structure.text != canonical_text:
        raise ValueError("note group source must equal stored canonical text")
    headings = [element for element in structure.elements if element.tag in HEADING_TAGS]
    declared: list[NotesGroup] = []
    if source_html:
        source = parse_html_document(source_html)
        aside_structure = None
        for wrapper in source.iter():
            if not isinstance(wrapper, HtmlElement):
                continue
            if not _semantic_tokens(wrapper) & {
                "endnotes",
                "doc-endnotes",
                "footnotes",
                "doc-footnotes",
            }:
                continue
            wrapper_tag = str(wrapper.tag).lower()
            mapped = structure
            if wrapper_tag == "aside":
                if aside_structure is None:
                    sanitized = parse_html_document(html_sanitized)
                    sanitized_root = sanitized.body if sanitized.body is not None else sanitized
                    for node in sanitized_root.iter():
                        if isinstance(node, HtmlElement) and str(node.tag).lower() == "aside":
                            node.tag = "section"
                    aside_structure = canonicalize_structure(inner_html(sanitized_root))
                if aside_structure.text != canonical_text:
                    continue
                mapped = aside_structure
            mapped_headings = [
                element for element in mapped.elements if element.tag in HEADING_TAGS
            ]
            wrapper_id = (wrapper.get("id") or "").strip()
            index = mapped.anchors.get(wrapper_id) if wrapper_id else None
            if index is None:
                if wrapper_tag not in STRUCTURAL_TAGS | {"aside"}:
                    continue
                source_heading = next(
                    (node for node in wrapper.iter() if str(node.tag).lower() in HEADING_TAGS),
                    None,
                )
                if source_heading is None:
                    continue
                label = normalize_whitespace(_element_text(source_heading)).casefold()
                matches = [
                    heading
                    for heading in mapped_headings
                    if normalize_whitespace(
                        canonical_text[heading.start_offset : heading.end_offset]
                    ).casefold()
                    == label
                ]
                if len(matches) != 1 or matches[0].parent_container is None:
                    continue
                index = matches[0].parent_container
            element = mapped.elements[index]
            if element.tag != ("section" if wrapper_tag == "aside" else wrapper_tag):
                continue
            if element.start_offset >= element.end_offset:
                continue
            heading = next(
                (
                    item
                    for item in mapped_headings
                    if element.start_offset <= item.start_offset < element.end_offset
                ),
                None,
            )
            start = NavigationTextPointOut(fragment_id=fragment_id, offset=element.start_offset)
            declared.append(
                NotesGroup(
                    range=NavigationTextRangeOut(
                        start=start,
                        end=NavigationTextPointOut(
                            fragment_id=fragment_id, offset=element.end_offset
                        ),
                    ),
                    heading=(
                        NavigationTextPointOut(fragment_id=fragment_id, offset=heading.start_offset)
                        if heading is not None
                        else None
                    ),
                    provenance="Declared",
                )
            )
    candidate_headings = [
        heading
        for heading in headings
        if normalize_whitespace(
            canonical_text[heading.start_offset : heading.end_offset]
        ).casefold()
        in {"notes", "endnotes", "footnotes"}
    ]
    if not candidate_headings:
        return declared
    note_spans = [
        (start, end) for key, (start, end, _text) in accepted_spans.items() if ":target:" in key
    ]
    groups: list[NotesGroup] = list(declared)
    for heading in candidate_headings:
        index = headings.index(heading)
        rank = int(heading.tag[1])
        end = next(
            (later.start_offset for later in headings[index + 1 :] if int(later.tag[1]) <= rank),
            len(canonical_text),
        )
        if end <= heading.start_offset or any(
            group.range.start.offset <= heading.start_offset < group.range.end.offset
            for group in declared
        ):
            continue
        spans = sorted(
            (start, stop) for start, stop in note_spans if heading.end_offset <= start < stop <= end
        )
        if len(spans) < 2:
            continue
        paragraphs = [
            paragraph
            for paragraph in structure.elements
            if paragraph.tag == "p"
            and heading.end_offset <= paragraph.start_offset < end
            and paragraph.start_offset < paragraph.end_offset
        ]
        marked = [
            any(
                start <= paragraph.start_offset and paragraph.end_offset <= stop
                for start, stop in spans
            )
            for paragraph in paragraphs
        ]
        if not marked or sum(marked) <= len(marked) - sum(marked):
            continue
        start_point = NavigationTextPointOut(fragment_id=fragment_id, offset=heading.start_offset)
        groups.append(
            NotesGroup(
                range=NavigationTextRangeOut(
                    start=start_point,
                    end=NavigationTextPointOut(fragment_id=fragment_id, offset=end),
                ),
                heading=start_point,
                provenance="Inferred",
            )
        )
    return groups


def _extract_standalone_margin_notes(
    root: HtmlElement,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    items: list[dict[str, object]],
) -> None:
    """A margin note has no marker, so it can never come out of the marker loop."""
    ordinal = 0
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        if "marginnote" not in _class_tokens(element):
            continue
        if _is_ignored_margin_note_context(element):
            continue
        note_text = _element_text(element)
        if not note_text and not element.xpath(".//img|.//svg"):
            continue
        identity = _source_identity(element, root, None, source_ref)
        token = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:32]
        target_key = f"{source_kind}:margin-note:{token}"
        _stamp(element, target_key, "margin_note", "strong")
        items.append(
            {
                "stable_key": target_key,
                "kind": "margin_note",
                "label": f"Margin note {ordinal + 1}",
                "body_text": note_text,
                "_body_html": inner_html(element),
                "confidence": "strong",
                "extraction_method": "html_margin_note",
                "source_ref": {**source_ref, "element": "span.marginnote", "identity": identity},
                "sort_key": f"{_source_order_key(element, ordinal)}.target",
                "_locator_text": note_text,
            }
        )
        ordinal += 1


def _extract_unlinked_declared_notes(
    root: HtmlElement,
    *,
    note_containers: set[HtmlElement],
    source_kind: str,
    source_ref: dict[str, object],
    target_item_key_by_id: dict[str, str],
    items: list[dict[str, object]],
    ancestor_prefixes: dict[HtmlElement, str],
) -> None:
    candidates = [
        element
        for element in root.iter()
        if isinstance(element, HtmlElement)
        and _is_note_body_target(element)
        and _target_context(element, ancestor_prefixes).semantic in {"note", "endnote"}
    ]
    for ordinal, element in enumerate(candidates):
        if element in note_containers:
            continue
        context = _target_context(element, ancestor_prefixes).semantic
        if context is None:
            continue
        if (element.get("data-reader-apparatus-item-id") or "").strip():
            continue
        target_id = (element.get("id") or element.get("name") or "").strip()
        if target_id and target_id in target_item_key_by_id:
            continue
        body_text = _element_text(element)
        if not body_text:
            continue
        key = (
            f"{source_kind}:target:{target_id}"
            if target_id
            else f"{source_kind}:declared-note:{ordinal:06d}"
        )

        _stamp(element, key, _target_kind_for_context(context), "exact")
        if target_id:
            target_item_key_by_id[target_id] = key
        items.append(
            {
                "stable_key": key,
                "kind": _target_kind_for_context(context),
                "label": _target_label(body_text),
                "body_text": body_text,
                "_body_html": inner_html(element),
                "confidence": "exact",
                "extraction_method": "html_semantic",
                "source_ref": {**source_ref, "target_id": target_id or None},
                "sort_key": f"{_source_order_key(element, ordinal)}.target",
                "_locator_text": body_text,
            }
        )


def _nested_declared_note_containers(
    root: HtmlElement, ancestor_prefixes: dict[HtmlElement, str]
) -> set[HtmlElement]:
    bodies = [
        element
        for element in root.iter()
        if isinstance(element, HtmlElement)
        and _is_note_body_target(element)
        and _target_context(element, ancestor_prefixes).semantic in {"note", "endnote"}
    ]
    body_set = set(bodies)
    return {
        ancestor
        for body in bodies
        for ancestor in body.iterancestors()
        if isinstance(ancestor, HtmlElement)
        and ancestor in body_set
        and not (
            _semantic_tokens(ancestor) & _NOTE_BODY_TOKENS
            or str(ancestor.tag).lower() in {"fn", "footnote"}
        )
    }


def _is_ignored_margin_note_context(
    element: HtmlElement, *, allow_chapter_header: bool = False
) -> bool:
    for node in [element, *element.iterancestors()]:
        if not isinstance(node, HtmlElement):
            continue
        if str(node.tag).lower() in {"script", "style", "template", "nav", "footer"}:
            return True
        if node.tag == "header" and not (
            allow_chapter_header
            and isinstance(owner := node.getparent(), HtmlElement)
            and _semantic_tokens(owner) & {"chapter", "doc-chapter"}
        ):
            return True
        if (
            node.get("hidden") is not None
            or (node.get("aria-hidden") or "").strip().lower() == "true"
        ):
            return True
        style = (node.get("style") or "").replace(" ", "").lower()
        if "display:none" in style or "visibility:hidden" in style:
            return True
    return False


def _materialize_external_targets_in_document(
    *,
    targets: dict[str, HtmlElement],
    find_target: Callable[[str], Mapping[str, object] | None],
    confirmed_target_refs: set[str],
    document_href: str | None,
    target_item_key_by_id: dict[str, str],
    items: list[dict[str, object]],
) -> None:
    """Adopt the index entries that live in this very document, keeping their keys."""
    if not document_href:
        return
    stamped_bodies: set[HtmlElement] = set()
    for target_id, target in targets.items():
        target_ref = html_apparatus_ref(document_href, target_id)
        external_target = find_target(target_ref)
        if external_target is None:
            continue
        if external_target["target_ref"] != target_ref:
            canonical_id = external_target["target_id"]
            if not isinstance(canonical_id, str) or targets.get(canonical_id) is not target:
                raise _ambiguous("EPUB target aliases no longer identify the same source element")
            continue
        if (
            str(external_target.get("confidence")) == "strong"
            and target_ref not in confirmed_target_refs
        ):
            continue
        if target_id in target_item_key_by_id:
            continue
        body = target if external_target.get("_body_inline") else _note_body_element(target)
        if (wrapper_label := external_target.get("_body_wrapper_label")) is not None:
            if re.fullmatch(r"[a-z]+", str(wrapper_label)):
                wrapper = target.getparent()
                if (
                    wrapper is None
                    or wrapper.tag != "div"
                    or len(wrapper) != 2
                    or wrapper[0] is not target
                ):
                    raise ValueError(
                        "EPUB lettered note wrapper changed between indexing and extraction"
                    )
            else:
                wrapper = (
                    (target if target.tag == "p" else next(target.iterancestors("p"), None))
                    if external_target.get("_body_is_paragraph_wrapper")
                    else (_grouped_note_wrapper(target))
                )
            if wrapper is None:
                raise ValueError("EPUB note wrapper changed between indexing and extraction")
            body = wrapper
        paragraph_names = external_target.get("_body_paragraph_names")
        paragraph = (
            target if str(target.tag).lower() == "p" else next(target.iterancestors("p"), None)
        )
        if external_target.get("extraction_method") == "html_paragraph_note":
            if paragraph is None:
                continue
            body = paragraph
        complete_source_paragraph = bool(
            paragraph_names
            and paragraph is not None
            and paragraph_names
            == [
                name
                for node in paragraph.iter()
                if isinstance(node, HtmlElement)
                for name in sorted(_authored_names(node))
            ]
        )
        if complete_source_paragraph:
            assert paragraph is not None
            body = paragraph
        body_text = str(external_target.get("body_text") or "")
        if not body_text:
            continue
        if body in stamped_bodies:
            raise _ambiguous("EPUB source element is claimed by distinct note bodies")
        stamped_bodies.add(body)
        target_key = str(external_target["stable_key"])
        kind = str(external_target["kind"])
        confidence = str(external_target["confidence"])
        _stamp(body, target_key, kind, confidence)
        for alias in _authored_names(target):
            if targets.get(alias) is target:
                target_item_key_by_id[alias] = target_key
        items.append(
            {
                "stable_key": target_key,
                "kind": kind,
                "label": _target_label(body_text),
                "body_text": body_text,
                "_body_html": external_target.get("_body_html"),
                "_complete_source_paragraph": complete_source_paragraph,
                "confidence": confidence,
                "extraction_method": str(external_target["extraction_method"]),
                "source_ref": _object_dict(external_target.get("source_ref")),
                "sort_key": str(external_target["sort_key"]),
                "_locator_text": body_text,
            }
        )


def _target_facts(
    marker: HtmlElement,
    external_target: Mapping[str, object],
    document_href: str | None,
    *,
    unique_names: Mapping[str, HtmlElement],
    shared_note_reference: bool = False,
    outside_note_scope: bool = False,
) -> _TargetFacts:
    has_note_context = external_target["_has_note_context"] is True
    context = str(external_target.get("context") or "") or None
    has_backlink = _external_target_has_backlink(
        marker,
        external_target,
        document_href,
        unique_names=unique_names,
        outside_note_scope=outside_note_scope,
    )
    if (file_start_label := external_target.get("_file_start_label")) is not None and (
        not _semantic_tokens(marker) & {"noteref", "doc-noteref"}
        or not has_backlink
        or not _numeric_marker(marker)
        or _element_text(marker).strip("[].") != file_start_label
    ):
        context = None
    wrapper_label = external_target.get("_body_wrapper_label")
    dedicated = external_target.get("_body_has_terminal_return") is True
    dedicated_marker = (
        dedicated and _dedicated_note_marker(marker, _element_text(marker)) == wrapper_label
    )
    if dedicated:
        if not dedicated_marker:
            context = None
    elif wrapper_label is not None:
        lettered = re.fullmatch(r"[a-z]+", str(wrapper_label)) is not None
        if (
            not (
                _printed_note_marker(marker, _element_text(marker))
                if lettered or wrapper_label == "*"
                else _numeric_marker(marker)
                and (
                    _is_sup_marker(marker) or _semantic_tokens(marker) & {"noteref", "doc-noteref"}
                )
            )
            or _element_text(marker).strip("[].") != wrapper_label
            or any(
                _grouped_note_collection(owner) or lettered and "footnote" in _class_tokens(owner)
                for owner in marker.iterancestors()
            )
        ):
            context = None
    if not dedicated and external_target.get("_body_is_paragraph_wrapper"):
        owner = next(
            (
                parent
                for parent in marker.iterancestors()
                if parent.tag == "p" or _authored_heading(parent)
            ),
            None,
        )
        if (
            owner is None
            or _leading_note_link(marker, owner)
            or _is_ignored_margin_note_context(marker, allow_chapter_header=True)
        ):
            context = None
    method = str(external_target.get("extraction_method") or "html_semantic")
    return _TargetFacts(
        context=_TargetContext(semantic=context, loose=context),
        has_note_context=has_note_context,
        is_bibliography_entry=True,
        has_backlink=has_backlink,
        method=method,
        confidence=str(external_target.get("confidence") or "exact"),
        loose_method=method,
        dedicated_marker=dedicated_marker,
        scoped_marker=external_target.get("_scoped_note") is True
        and _scoped_marker(marker, _element_text(marker), outside_note_scope=outside_note_scope),
        shared_note_reference=shared_note_reference,
    )


def _classify(marker: HtmlElement, facts: _TargetFacts) -> _Classified | None:
    """The target's context fixes the kinds; how it was recognised fixes the confidence."""

    def declared(context: str | None) -> _Classified | None:
        return _classified(context, facts.method, facts.confidence)

    def inferred(context: str | None) -> _Classified | None:
        return _classified(context, facts.loose_method, "strong")

    if any(
        hides(node)
        for node in [marker, *marker.iterancestors()]
        if str(node.tag).lower() not in ("html", "body")
    ):
        return None  # the sanitizer drops hidden content: no marker would remain
    tokens = _semantic_tokens(marker)
    ref_type = (marker.get("ref-type") or "").strip().lower()
    semantic = facts.context.semantic
    loose = facts.context.loose
    inferred_marker = not _is_ignored_margin_note_context(marker, allow_chapter_header=True) and (
        facts.has_note_context
        or not any(
            isinstance(ancestor, HtmlElement) and str(ancestor.tag).lower() in HEADING_TAGS
            for ancestor in marker.iterancestors()
        )
    )

    if "noteref" in tokens or "doc-noteref" in tokens or ref_type == "fn":
        if semantic in ("note", "endnote"):
            return declared(semantic)
        return (
            inferred("note") if inferred_marker and loose == "note" and facts.has_backlink else None
        )
    if "biblioref" in tokens or "doc-biblioref" in tokens or ref_type == "bibr":
        if not facts.is_bibliography_entry:
            return None
        if semantic == "bibliography":
            return declared("bibliography")
        return inferred("bibliography") if loose == "bibliography" else None
    if (
        inferred_marker
        and facts.method == "html_paragraph_note"
        and facts.has_backlink
        and _paragraph_note_marker_label(marker, _element_text(marker)) is not None
    ):
        return inferred(loose)
    if (
        inferred_marker
        and facts.method == "html_note_boundary"
        and (
            facts.shared_note_reference
            or facts.has_backlink
            and (
                facts.dedicated_marker
                or _is_inline_note_marker(marker)
                or _printed_note_marker(marker, _element_text(marker))
                or facts.scoped_marker
            )
        )
    ):
        return inferred(loose)
    if inferred_marker and str(marker.tag).lower() == "a" and _is_sup_marker(marker):
        numeric = _numeric_marker(marker)
        # a bracketed group label (wikipedia's grouped notes, `[a]` or `[note 1]`) marks a note
        grouped = re.fullmatch(r"\[\w[\w ]{0,9}\]", _element_text(marker)) is not None
        if (numeric or grouped) and loose in ("note", "endnote") and facts.has_backlink:
            return inferred(loose)
        if numeric and loose == "bibliography" and facts.is_bibliography_entry:
            return inferred("bibliography")
    return None


def _classified(context: str | None, method: str, confidence: str) -> _Classified | None:
    kinds = _CONTEXT_KINDS.get(context or "")
    if kinds is None:
        return None
    return _Classified(kinds[0], kinds[1], kinds[2], method, confidence)


def _target_context(
    target: HtmlElement,
    ancestor_prefixes: dict[HtmlElement, str],
    text: Callable[[HtmlElement], str] | None = None,
    *,
    inherit_rearnote: bool = True,
) -> _TargetContext:
    """Walk the target's ancestry once, recording the first declared and loose hit."""
    semantic: str | None = None
    loose: str | None = None
    for element in [target, *target.iterancestors()]:
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        tokens = _semantic_tokens(element, include_rearnote=element is target or inherit_rearnote)
        if semantic is None:
            if tokens & _ENDNOTE_TOKENS:
                semantic = "endnote"
            elif tag in {"fn", "footnote", "d-footnote"} or tokens & _FOOTNOTE_TOKENS:
                semantic = "note"
            elif tag in _BIBLIOGRAPHY_TAGS or tokens & _BIBLIOGRAPHY_TOKENS:
                semantic = "bibliography"
        if loose is None:
            if tokens & (_ENDNOTE_TOKENS | _FOOTNOTE_TOKENS) or tag == "d-footnote":
                loose = "note"
            elif _class_tokens(element) & {"references", "reference-text", "mw-references-wrap"}:
                loose = "note"
            elif tag in _BIBLIOGRAPHY_CONTAINER_TAGS or tokens & _BIBLIOGRAPHY_TOKENS:
                loose = "bibliography"
            elif tag in {"aside", "section", "div", "ol", "ul"}:
                head = ancestor_prefixes.get(element)
                if head is None:
                    head = (text(element) if text is not None else _element_text(element)).lower()[
                        :80
                    ]
                    ancestor_prefixes[element] = head
                if any(word in head for word in ("footnote", "endnote", "notes")):
                    loose = "note"
                elif any(word in head for word in ("references", "bibliography")):
                    loose = "bibliography"
        if semantic is not None and loose is not None:
            return _TargetContext(semantic=semantic, loose=loose)
    if loose is None:
        target_id = (target.get("id") or target.get("name") or "").lower()
        if target_id.startswith(("cite_note", "cite-note", "fn", "footnote", "note")):
            loose = "note"
        elif target_id.startswith(("ref", "bib")):
            loose = "bibliography"
    return _TargetContext(semantic=semantic, loose=loose)


def _external_target_has_backlink(
    marker: HtmlElement,
    target: Mapping[str, object],
    document_href: str | None,
    *,
    unique_names: Mapping[str, HtmlElement],
    outside_note_scope: bool,
) -> bool:
    """A return names the marker occurrence or its enclosing superscript."""
    source_owner = _source_element_id_owner(marker)
    parent = marker.getparent()
    owners = [source_owner] if source_owner is not None else []
    if (adjacent := _adjacent_note_marker_address(marker)) is not None:
        owners.append(adjacent)
    if marker.tag == "a" and isinstance(parent, HtmlElement) and parent.tag == "sup":
        owners.append(parent)
    if (
        outside_note_scope
        and source_owner is None
        and target.get("_scoped_note") is True
        and target.get("target_href") == document_href
        and target.get("_leading_return_label") == _printed_return_label(_element_text(marker))
        and (nearby := _nearby_reading_return(marker)) is not None
    ):
        owners.append(nearby)
    backlinks = target.get("backlinks")
    if not document_href or not isinstance(backlinks, list):
        return False
    return any(
        unique_names.get(name) is owner and html_apparatus_ref(document_href, name) in backlinks
        for owner in owners
        for name in _authored_names(owner)
    )


def _untyped_note_body(
    anchor: HtmlElement,
    text: Callable[[HtmlElement], str] | None = None,
    entry_boundaries: set[HtmlElement] | None = None,
    *,
    allow_label_only: bool = False,
) -> HtmlElement | None:
    """A leading backlink and prose in one paragraph; reciprocity is checked separately."""
    tag = str(anchor.tag).lower()
    if tag not in {"a", "p", "div", "blockquote", "span", "small", "sup"}:
        return None
    paragraph = next(
        (
            block
            for block in (anchor, *anchor.iterancestors())
            if block.tag == "p"
            or block.tag in {"div", "blockquote"}
            and _class_tokens(block).isdisjoint({"notes", "footnotes", "endnotes"})
            and next(block.iterdescendants("p"), None) is None
        ),
        None,
    )
    if paragraph is None:
        return None
    links = paragraph.xpath(".//a[@href]")
    if not links:
        return None
    element_text = text or _element_text
    label = element_text(links[0]).strip()
    body_text = element_text(paragraph)
    if not _leading_note_link(links[0], paragraph):
        return None
    if entry_boundaries is not None:
        if links[0] not in entry_boundaries:
            return None
    elif _printed_return_label(label) is None:
        return None
    if (
        entry_boundaries is None
        and not allow_label_only
        and not body_text[len(label) :].strip(". \t\n")
        and not paragraph.xpath(".//img|.//svg")
    ):
        return None
    return paragraph if anchor is paragraph or _leading_note_link(anchor, paragraph) else None


def reading_title_key(text: str) -> str:
    """Match an authored title across publisher markup and typographic spacing."""
    return "".join(character for character in text.casefold() if character.isalnum())


def is_printed_note_heading(text: str) -> bool:
    return (
        re.fullmatch(
            r"(?:(?:chapter|book|part|psalm)\s+[0-9ivxlcdm]+\s+)?(?:editorial\s+)?"
            r"(?:notes(?:\s+and\s+(?:errata|asides)|\s+[ivxlcdm]+"
            r"|\s+to\s+(?:the\s+text|(?:chapter|book|part|volume)\s+[0-9ivxlcdm]+))?"
            r"|footnotes|endnotes):?",
            text.casefold().strip(),
        )
        is not None
    )


def _looks_like_printed_note_block(block: HtmlElement) -> bool:
    return any(
        re.fullmatch(
            r"(?:fn|fnote|end|(?:foot|end)?notes?[a-z]{0,2})(?:[0-9]+[a-z]?)?"
            r"|(?:foot|end)?note[-_](?:flush[-_]left|ind(?:ent)?|ext|cent(?:er(?:ed)?|red?)|hg)[0-9]*",
            token,
        )
        is not None
        for token in _class_tokens(block)
    ) or any(
        re.fullmatch(r"(?:footnote|endnote)[_-]text[_-]\d+[a-z]?", name) is not None
        for name in _authored_names(block)
    )


def _styled_note_heading(block: HtmlElement, text: Callable[[HtmlElement], str]) -> bool:
    return (
        block.tag in {"p", "div"}
        and bool(_class_tokens(block) & {"noteh", "footnoteh", "endnoteh"})
        and text(block).isupper()
        and not block.xpath(".//a[@href]")
    )


def _authored_note_scopes(
    root: HtmlElement, text: Callable[[HtmlElement], str]
) -> dict[HtmlElement, HtmlElement | None]:
    """Read source order once. An authored container can close a printed note run."""
    scopes: dict[HtmlElement, HtmlElement | None] = {}

    def visit(parent: HtmlElement, active: bool, end: HtmlElement | None) -> None:
        tokens = _semantic_tokens(parent)
        if (
            parent.tag == "header"
            and isinstance(chapter := parent.getparent(), HtmlElement)
            and _semantic_tokens(chapter) & {"chapter", "doc-chapter"}
        ):
            tokens |= {"chapter"}
        if (
            tokens & {"footnotes", "endnotes", "doc-footnotes", "doc-endnotes"}
            or parent.tag == "section"
            and "note" in tokens
            and len(parent) > 0
            and is_printed_note_heading(text(parent[0]))
            or parent.tag in {"div", "section"}
            and len(parent) > 0
            and (
                _class_tokens(parent) & {"footnote", "endnote", "footnote_page", "footnote-page"}
                and any(
                    _untyped_note_body(child, text) is child
                    for child in parent
                    if isinstance(child, HtmlElement)
                )
                or _untyped_note_body(parent[0], text) is parent[0]
                and all(
                    child.tag == "p" and _looks_like_printed_note_block(child)
                    for child in parent
                    if isinstance(child, HtmlElement) and _first_content_owner(child) is not None
                )
            )
        ):
            active, end = True, parent
        if active and (
            (parent.tag == "section" or parent.tag == "div" and "section" in _class_tokens(parent))
            and len(parent) >= 2
            and (
                _authored_heading(parent[0])
                or parent[0].tag == "p"
                and any(
                    re.fullmatch(r"(?:sub)?title[0-9]*", token)
                    for token in _class_tokens(parent[0])
                )
            )
            and parent[1].tag == "p"
            and _looks_like_printed_note_block(parent[1])
            and _untyped_note_body(parent[1], text) is parent[1]
        ):
            end = parent
        headings: list[tuple[int, bool, bool]] = []
        for block in parent:
            if not isinstance(block, HtmlElement) or hides(block):
                continue
            typed_note_heading = _styled_note_heading(block, text)
            note_heading = typed_note_heading or (
                block.tag in HEADING_TAGS | {"p", "div"} and is_printed_note_heading(text(block))
            )
            if block.tag in HEADING_TAGS or note_heading:
                rank = int(block.tag[1]) if block.tag in HEADING_TAGS else 6
                while headings and headings[-1][0] >= rank:
                    headings.pop()
                headings.append((rank, note_heading, typed_note_heading))
            printed = any(is_note for _, is_note, _ in headings)
            local_end = (
                parent
                if printed
                and (
                    tokens & {"chapter", "doc-chapter", "appendix", "doc-appendix"}
                    or any(typed for _, _, typed in headings)
                )
                else end
            )
            if active or printed:
                scopes[block] = local_end
            if len(block):
                visit(block, active or printed, local_end)

    visit(root, False, None)
    return scopes


def _ends_document(element: HtmlElement) -> bool:
    return _ends_source_scope(element, None)


def _ends_source_scope(element: HtmlElement, owner: HtmlElement | None) -> bool:
    for block in (element, *element.iterancestors()):
        if block is owner or block.tag in {"html", "body"}:
            break
        if (block.tail or "").strip() or any(
            (later.tail or "").strip()
            or isinstance(later, HtmlElement)
            and _first_content_owner(later) is not None
            for later in block.itersiblings()
        ):
            return False
    return True


def _star_paragraph_is_bounded(
    paragraph: HtmlElement, referenced_entries: set[HtmlElement]
) -> bool:
    if (paragraph.tail or "").strip():
        return False
    for following in paragraph.itersiblings():
        if isinstance(following, HtmlElement) and _first_content_owner(following) is not None:
            return _authored_heading(following) or any(
                entry in referenced_entries and _leading_note_link(entry, following)
                for entry in following.iter()
            )
        if (following.tail or "").strip():
            return False
    return _ends_document(paragraph)


def _returned_note_paragraph(
    document: _TargetDocument,
    block: HtmlElement,
    document_href: str,
    marker_backlinks: Mapping[str, set[str]],
    prose_markers: Mapping[str, str] | None,
) -> tuple[str, str] | None:
    first = _first_content_owner(block)
    if first is None:
        return None
    link = next((node for node in (first, *first.iterancestors()) if node.tag == "a"), None)
    if (
        link is None
        or not _leading_note_link(link, block)
        or any(
            hides(owner)
            for owner in (link, *link.iterancestors())
            if owner.tag not in {"html", "body"}
        )
    ):
        return None
    destination = _canonical_target_ref(link.get("href") or "", document_href)
    label = _printed_return_label(document.text(link))
    if (
        label is None
        or prose_markers is not None
        and prose_markers.get(destination) != label
        or not re.search(r"\w", document.text(block)[len(document.text(link)) :])
    ):
        return None
    targets = {
        ref
        for named in block.iter()
        if named in document.aliases and _leading_note_link(named, block)
        for name in document.aliases[named]
        if destination in marker_backlinks.get(ref := html_apparatus_ref(document_href, name), ())
    }
    return (targets.pop(), destination) if len(targets) == 1 else None


def _printed_symbol_return(
    block: HtmlElement, entry: HtmlElement, document_href: str
) -> str | None:
    if (
        block.tag not in {"p", "blockquote"}
        or block.tag == "p"
        and block.get("class") != entry.get("class")
        or (opening := next((link for link in block.iter("a") if link.get("href")), None)) is None
        or (label := _short_note_label(_element_text(opening))) is None
        or label.isdecimal()
        or not _leading_note_link(opening, block)
        or not any(
            _authored_names(node) and _leading_note_link(node, block)
            for node in block.iter()
            if isinstance(node, HtmlElement)
        )
    ):
        return None
    member, _ = split_html_apparatus_ref(
        _canonical_target_ref(opening.get("href") or "", document_href)
    )
    return member or None


def _owned_note_quote(
    quote: HtmlElement, entry: HtmlElement, document_href: str, document: _TargetDocument
) -> bool:
    """A subordinate quote can close at its own return into the opening note."""
    if quote.tag != "blockquote":
        return False
    address = quote.getprevious()
    returning = next((link for link in quote.iter("a") if link.get("href")), None)
    if (
        not isinstance(address, HtmlElement)
        or _first_content_owner(address) is not None
        or (address.tail or "").strip()
        or address not in document.aliases
        or returning is None
        or not _leading_note_link(returning, quote)
    ):
        return False
    member, anchor = split_html_apparatus_ref(
        _canonical_target_ref(returning.get("href") or "", document_href)
    )
    destination = document.unique_names.get(anchor or "")
    if (
        member != document_href
        or destination is None
        or (destination is not entry and entry not in destination.iterancestors())
    ):
        return False
    expected = {html_apparatus_ref(document_href, name) for name in document.aliases[address]}
    label = document.text(returning)
    return (
        sum(
            _canonical_target_ref(link.get("href") or "", document_href) in expected
            and document.text(link) == label
            and (destination is entry or link is destination or destination in link.iterancestors())
            for link in entry.iter("a")
            if link.get("href")
        )
        == 1
    )


def html_paragraph_note_page_shape(
    html: str,
    *,
    document_href: str,
    marker_backlinks: Mapping[str, set[str]],
    earlier_prose_markers: Mapping[str, str],
) -> tuple[tuple[str, ...], Literal["Closed", "Quotation", "Citations"]] | None:
    """Return the first opening and the evidence that still needs a closing peer."""
    document = _target_document(html)
    if document is None:
        return None
    first = _first_content_owner(document.root)
    if first is None:
        return None
    paragraph = (
        first
        if first.tag in {"p", "blockquote"}
        else next(first.iterancestors("p", "blockquote"), None)
    )
    if paragraph is None:
        return None
    shape = None
    last: HtmlElement | None = None
    entry: HtmlElement | None = None
    pending_continuation = False
    entry_count = 0
    plain_tail = True
    parenthetical_tail = False
    citation_tail = False
    reading_members = {split_html_apparatus_ref(ref)[0] for ref in earlier_prose_markers}
    for block in (paragraph, *paragraph.itersiblings()):
        if (block.tail or "").strip():
            return None
        if not isinstance(block, HtmlElement) or _first_content_owner(block) is None:
            continue
        if (
            block.tag in {"p", "blockquote"}
            and (
                pair := _returned_note_paragraph(
                    document, block, document_href, marker_backlinks, earlier_prose_markers
                )
            )
            is not None
        ):
            entry = block
            entry_count += 1
            pending_continuation = False
            if shape is None:
                label = earlier_prose_markers[pair[1]]
                shape = (
                    "Numeric" if label.isdecimal() else "Symbol",
                    *sorted(_class_tokens(block)),
                )
        elif (
            entry is not None
            and shape is not None
            and shape[0] == "Symbol"
            and (member := _printed_symbol_return(block, entry, document_href)) is not None
            and member in reading_members
        ):
            # A separately printed entry can close its neighbour even when its
            # authored reading address cannot bind to a unique visible marker.
            pending_continuation = False
        elif entry is not None and _owned_note_quote(block, entry, document_href, document):
            pending_continuation = False
        elif entry is None or (
            block.tag != "blockquote"
            and (block.tag != "p" or block.get("class") != entry.get("class"))
            or _untyped_note_body(block, document.text) is not None
        ):
            return None
        else:
            printed = document.text(block)
            if not pending_continuation:
                parenthetical_tail = printed.startswith("(") and printed.endswith(")")
                plain_tail = (
                    parenthetical_tail
                    or document.text(entry).endswith(":")
                    and (block.tag == "blockquote" or printed.startswith(("“", "‘", '"')))
                )
                citation_tail = block.tag == "p" and _continued_citation_sequence(
                    entry, block, document, document_href, marker_backlinks
                )
            else:
                citation_tail = False
                if parenthetical_tail:
                    plain_tail = False
            pending_continuation = True
            if (
                not any(character.isalpha() for character in printed)
                or re.match(
                    r"^(?:[*†‡§¶‖]+|[a-z]\.|\d{1,4}[a-z]?\.|\[\d{1,4}[a-z]?\]|\(\d{1,4}[a-z]?\))(?:\s|$)",
                    printed,
                )
                or re.fullmatch(r"\(?[ivxlcdm]+\)?\.?", printed, re.IGNORECASE)
                or not printed.endswith((".", "?", "!"))
                and re.match(
                    r"^(?:chapter|part|book|volume|section)\s+",
                    printed,
                    re.IGNORECASE,
                )
            ):
                plain_tail = citation_tail = False
            plain_tail = plain_tail and not block.xpath(
                ".//a[@href]|.//h1|.//h2|.//h3|.//h4|.//h5|.//h6|.//img|.//svg|.//table"
            )
        last = block
    if last is None or not _ends_document(last):
        return None
    if shape is None:
        return None
    if not pending_continuation:
        return shape, "Closed"
    if entry_count != 1:
        return None
    if plain_tail:
        return shape, "Quotation"
    return (shape, "Citations") if citation_tail else None


def _continued_citation_sequence(
    entry: HtmlElement,
    tail: HtmlElement,
    document: _TargetDocument,
    document_href: str,
    marker_backlinks: Mapping[str, set[str]],
) -> bool:
    """Both paragraphs carry consecutive exact references into one other member."""
    citations: list[list[tuple[str, int]]] = [[], []]
    for block, refs in zip((entry, tail), citations, strict=True):
        for link in block.iter("a"):
            if not (href := link.get("href")) or _leading_note_link(link, block):
                continue
            target = _canonical_target_ref(href, document_href)
            member, anchor = split_html_apparatus_ref(target)
            if (
                not anchor
                or member == document_href
                or not _is_sup_marker(link)
                or not _numeric_marker(link, document.text)
                or (owner := _source_element_id_owner(link)) is None
                or not any(
                    document.unique_names.get(name) is owner
                    and html_apparatus_ref(document_href, name) in marker_backlinks.get(target, ())
                    for name in _authored_names(owner)
                )
            ):
                if block is tail:
                    return False
                continue
            refs.append((member, int(document.text(link).strip("[]."))))
    before, after = citations
    return bool(before) and len(after) == 1 and (before[-1][0], before[-1][1] + 1) == after[0]


def html_has_independent_apparatus_opening(
    html: str,
    *,
    document_href: str,
    marker_backlinks: Mapping[str, set[str]],
    prose_markers: Mapping[str, str],
) -> bool:
    """An exact opening closes a proved note collection in the adjacent member."""
    document = _target_document(html)
    if document is None or (first := _first_content_owner(document.root)) is None:
        return False
    chain = (first, *first.iterancestors())
    paragraph = next((node for node in chain if node.tag == "p"), None)
    if (
        paragraph is not None
        and (
            pair := _returned_note_paragraph(
                document,
                paragraph,
                document_href,
                marker_backlinks,
                None if _looks_like_printed_note_block(paragraph) else prose_markers,
            )
        )
        is not None
    ):
        return split_html_apparatus_ref(pair[1])[0] != document_href
    if any(
        _class_tokens(node) & {"copyright"}
        and "all rights reserved" in document.text(node).casefold()
        for node in chain
    ):
        return True
    for block in document.root:
        if not isinstance(block, HtmlElement) or not (printed := document.text(block)):
            continue
        if (
            block.tag == "div"
            and _class_tokens(block) & {"fmht", "bmht"}
            and re.match(r"^inspired by\b", printed, re.IGNORECASE)
        ):
            return True
        if block.tag not in HEADING_TAGS and not (
            block.tag == "p"
            and any(
                re.fullmatch(r"(?:h[1-6]|(?:[\w-]+_)?heading[1-6]?)", token)
                for token in _class_tokens(block)
            )
        ):
            return False
        return (
            re.match(r"^glossary\b", printed, re.IGNORECASE) is not None
            or re.fullmatch(
                r"(?:supplement|bibliography|bibliographical note|index|acknowledg(?:e)?ments?)"
                r"(?:\s+[ivxlcdm0-9]+)?[.:]?",
                printed,
                re.IGNORECASE,
            )
            is not None
            or "endpagehead" in _class_tokens(block)
            and any(
                "eb01imprint" in _class_tokens(following)
                for following in block.itersiblings()
                if isinstance(following, HtmlElement)
            )
        )
    return False


def _terminal_paragraph_note_run(
    document: _TargetDocument,
    document_href: str,
    marker_backlinks: Mapping[str, set[str]],
    prose_markers: Mapping[str, str],
) -> Iterator[tuple[str, tuple[str, str]]]:
    for first in document.root.iter("p"):
        if "fn__top" not in _class_tokens(first):
            continue
        run = [first, *first.itersiblings()]
        if (
            len(run) < 2
            or any(
                not isinstance(entry, HtmlElement)
                or entry.tag != "p"
                or (entry.tail or "").strip()
                or (entry is not first and "fn" not in _class_tokens(entry))
                for entry in run
            )
            or not _ends_document(run[-1])
        ):
            continue
        pairs = []
        for entry in run:
            pair = _returned_note_paragraph(
                document, entry, document_href, marker_backlinks, prose_markers
            )
            if pair is None:
                break
            target, marker = pair
            pairs.append((target, (serialize_html(entry), marker)))
        else:
            yield from pairs


def _nested_location_return(opening: str, following: str) -> bool:
    start = re.match(r"^(\d+):(\d+)[a-z]?[–-](?:(\d+):)?(\d+)[a-z]?(?:\b|\.)", opening)
    nested = re.match(r"^(\d+):(\d+)[a-z]?(?:[–-](?:(\d+):)?(\d+)[a-z]?)?(?:\b|\.)", following)
    if start is not None and nested is not None:
        origin = (int(start[1]), int(start[2]))
        return origin == (int(nested[1]), int(nested[2])) and (
            int(nested[3] or nested[1]),
            int(nested[4] or nested[2]),
        ) < (int(start[3] or start[1]), int(start[4]))
    book = re.match(r"^Book [IVXLCDM]+ \(Pss? (\d+)[–-]\d+\)", opening)
    psalm = re.match(r"^Psalm (\d+)\.", following)
    return book is not None and psalm is not None and book[1] == psalm[1]


def _bracketed_editorial_paragraph(block: HtmlElement, text: Callable[[HtmlElement], str]) -> bool:
    return (
        block.tag == "p"
        and (printed := text(block)).startswith("[")
        and printed.endswith("]")
        and not block.xpath(".//a[@href]|.//img|.//svg|.//table")
    )


def _standalone_lexicon(block: HtmlElement) -> bool:
    if block.tag != "p" or block.xpath(".//a[@href]|.//img|.//svg|.//table"):
        return False
    divisions = list(block.iter("br"))
    if len(divisions) < 2:
        return False
    first = _first_content_owner(block)
    leads = [first, *(line.getnext() for line in divisions if not (line.tail or "").strip())]
    return len(leads) == len(divisions) + 1 and all(
        lead is not None and lead.tag in {"i", "em"} and (lead.tail or "").startswith(": ")
        for lead in leads
    )


def _owned_note_continuation(
    paragraph: HtmlElement,
    block: HtmlElement,
    owner: HtmlElement,
    opening: HtmlElement | None,
    entries: set[HtmlElement] | None,
    text: Callable[[HtmlElement], str],
    bracketed: bool,
) -> bool:
    if (
        owner is not paragraph.getparent()
        or entries is None
        or opening is None
        or opening not in entries
        or not _leading_note_link(opening, paragraph)
        or block.xpath("self::*[@id or @name]|.//*[@id or @name or @href]")
    ):
        return False
    style = paragraph.get("class")
    block_style = block.get("class") or ""
    if bracketed:
        if (
            style not in {"footnote", "endnote"}
            or block_style != f"{style}-ind"
            or re.match(
                r"^\[(?:in|for|with) (?:this|the preceding) (?:passage|quotation|note|line)\b",
                text(block),
                re.IGNORECASE,
            )
            is None
        ):
            return False
    elif not _class_tokens(owner) & {"footnote", "endnote"}:
        return False
    elif block.tag == "p" and _ends_source_scope(block, owner):
        # A terminal signature in an isolated note wrapper, or a biography
        # that takes up the author named by the opening bibliographic citation.
        if block_style == "right":
            return (
                _short_note_label(text(opening)) == "*"
                and _supplies_first_content(_first_content_owner(owner), paragraph)
                and len(block) == 1
                and block[0].tag in {"em", "i"}
                and not (block.text or "").strip()
                and not (block[0].tail or "").strip()
                and re.fullmatch(r"—[^\W\d_]+(?:[ ’'-][^\W\d_]+)+", text(block)) is not None
            )
        author = re.match(r"From ([^,]{1,80}), ", text(paragraph)[len(text(opening)) :].strip())
        return (
            block_style == style
            and len(block) == 0
            and any(child.tag in {"em", "i"} for child in paragraph)
            and author is not None
            and re.match(re.escape(author[1]) + r" \(\d{3,4}[–-]\d{3,4}\)\s", text(block))
            is not None
        )
    elif not (
        block.tag == "div"
        and text(paragraph).endswith(":")
        and not (block.text or "").strip()
        and all(not (child.tail or "").strip() for child in block)
        and (
            re.fullmatch(r"(?:foot|end)note[0-9]*", block_style) is not None
            and len(block) == 1
            and block[0].tag == "p"
            and re.fullmatch(r'(?:“.+”|‘.+’|".+")', text(block[0])) is not None
            or re.fullmatch(r"block[a-z]?", block_style) is not None
            and len(block) > 1
            and all(
                child.tag == "p"
                and len(child) == 1
                and child[0].tag in {"em", "i"}
                and not (child.text or "").strip()
                for child in block
            )
        )
    ):
        return False
    # The next returned entry fences the indented aside or introduced display.
    following = _next_content_sibling(block)
    return (
        following is not None
        and following.tag == paragraph.tag
        and following.get("class") == style
        and any(
            link in entries and _leading_note_link(link, following) for link in following.iter("a")
        )
    )


def _inferred_note_html(
    paragraph: HtmlElement,
    document: _TargetDocument,
    entry_boundaries: set[HtmlElement] | None = None,
    unresolved_paragraphs: set[HtmlElement] | None = None,
    *,
    document_href: str,
    marker_backlinks: Mapping[str, set[str]],
    note_headings: set[HtmlElement],
    local_scope: bool,
    peer_scope: bool,
    authored_scope: HtmlElement | None,
    note_collection_end: bool | None = None,
    bounded_note_page: bool = False,
    published_navigation: frozenset[str] | set[str] = frozenset(),
    continuation_styles: set[tuple[str, tuple[str, ...]]] | None = None,
    closes_member: Callable[[str], bool] | None = None,
) -> str | None:
    """Bound inferred paragraphs inside an independently authored notes collection.

    A reciprocal link alone supplies direction. Extending past its opening
    paragraph requires an independent closing boundary.
    """
    text = element_text = document.text

    def is_quote(block: HtmlElement) -> bool:
        return (
            block.tag == "blockquote"
            or block.tag in {"p", "div"}
            and any(
                re.fullmatch(r"(?:block(?:quote[a-z]?)?|extractp?)[0-9]*", token)
                for token in _class_tokens(block)
            )
        )

    enclosure = paragraph.getparent()
    if (
        note_collection_end is not None
        and enclosure is not None
        and enclosure.tag == "blockquote"
        and len(enclosure) == 1
        and not (enclosure.text or "").strip()
        and not (paragraph.tail or "").strip()
        and not (enclosure.tail or "").strip()
    ):
        parts = [serialize_html(paragraph)]
        needs_next_note = False
        for following in enclosure.itersiblings():
            if (following.tail or "").strip():
                break
            if not isinstance(following, HtmlElement) or _first_content_owner(following) is None:
                continue
            links = [link for link in following.iter("a") if link.get("href")]
            if entry_boundaries is not None and any(
                opening in entry_boundaries and _leading_note_link(opening, following)
                for opening in links
            ):
                return "".join(parts)
            if (
                following.tag == "blockquote"
                and following.get("class") == enclosure.get("class")
                and len(following) == 1
                and following[0].tag == "p"
                and (not links or _leading_note_link(links[0], following))
            ):
                successor = _next_content_sibling(following)
                next_paragraph = (
                    successor[0]
                    if successor is not None
                    and successor.tag == "blockquote"
                    and successor.get("class") == enclosure.get("class")
                    and len(successor) == 1
                    and successor[0].tag == "p"
                    else None
                )
                boundary = _printed_note_boundary(
                    paragraph,
                    following[0],
                    text,
                    entry_boundaries,
                    local_scope=True,
                    next_paragraph=next_paragraph,
                )
                if boundary is not None:
                    return "".join(parts) if boundary == "Entry" else None
            if (
                _class_tokens(following) & {"epigraph", "colophon"}
                or links
                and _leading_note_link(links[0], following)
                and _printed_return_label(element_text(links[0])) is not None
                and any(
                    _authored_names(node) and _leading_note_link(node, following)
                    for node in following.iter()
                    if isinstance(node, HtmlElement)
                )
                or following in note_headings
                or _authored_heading(following)
                or following.tag in {"p", "div", "blockquote"}
                and is_printed_note_heading(element_text(following))
            ):
                return None if needs_next_note else "".join(parts)
            if (
                following.tag == "blockquote"
                or following.tag == "div"
                and following.get("class") is not None
                and following.get("class") == enclosure.get("class")
                or following.tag == "p"
                and not element_text(following)
                and following.xpath(".//img|.//svg")
            ):
                if any(
                    (candidate := _untyped_note_body(node, text)) is not None
                    and _leading_note_link(node, candidate)
                    for node in following.xpath(".//*[@id or @name]")
                ):
                    break
                parts.append(serialize_html(following))
                # The next separately returned entry, rather than an outer
                # heading alone, proves a different quote style is attached.
                needs_next_note = needs_next_note or following.get("class") != enclosure.get(
                    "class"
                )
            else:
                break
        else:
            if (
                len(parts) == 1
                and _ends_document(enclosure)
                and (
                    note_collection_end is True
                    or closes_member is not None
                    and closes_member(document_href)
                )
            ):
                return parts[0]
    if not (local_scope or peer_scope):
        return None
    parts = [serialize_html(paragraph)]
    opening = next((link for link in paragraph.iter("a") if link.get("href")), None)
    opening_return = (
        _canonical_target_ref(opening.get("href") or "", document_href)
        if opening is not None
        else None
    )
    last = paragraph
    included = {paragraph}
    unproved_end_tail = False
    follows_quote = False
    follows_witnessed_style = False
    opening_style = paragraph.get("class") or ""
    for sibling in paragraph.itersiblings():
        if not isinstance(sibling, HtmlElement):
            continue
        if (sibling.tail or "").strip():
            return None
        tag = str(sibling.tag).lower()
        if (
            sibling in note_headings
            or _class_tokens(sibling) & {"epigraph", "colophon"}
            or tag in HEADING_TAGS | {"hr"}
            or tag in {"p", "div"}
            and (
                _styled_note_heading(sibling, element_text)
                or is_printed_note_heading(element_text(sibling))
            )
        ):
            if unproved_end_tail:
                following = _next_content_sibling(sibling)
                if not (
                    len(parts) == 2
                    and note_collection_end is not None
                    and last.get("class") == paragraph.get("class")
                    and not last.xpath(".//a[@href]")
                    and tag in HEADING_TAGS
                    and re.fullmatch(r"chapter [0-9ivxlcdm]+", element_text(sibling).casefold())
                    and following is not None
                    and following.get("class") == paragraph.get("class")
                    and entry_boundaries is not None
                    and any(
                        link in entry_boundaries
                        and _leading_note_link(link, following)
                        and _printed_return_label(element_text(link)) == "1"
                        for link in following.iter("a")
                    )
                ):
                    return None
            break
        printed_lexicon = (
            authored_scope is paragraph.getparent()
            and sibling.get("class") != paragraph.get("class")
            and sibling.getprevious() is paragraph
            and _standalone_lexicon(sibling)
        )
        introduced_lexicon = printed_lexicon and element_text(paragraph).endswith(":")
        if printed_lexicon and not introduced_lexicon:
            break
        if (
            local_scope
            and opening is not None
            and opening_return is not None
            and entry_boundaries is not None
            and tag == "p"
            and _looks_like_printed_note_block(paragraph)
            and _looks_like_printed_note_block(sibling)
        ):
            leading = next((link for link in sibling.iter("a") if link.get("href")), None)
            if (
                leading is not None
                and not _authored_names(leading)
                and _leading_note_link(leading, sibling)
                and _canonical_target_ref(leading.get("href") or "", document_href)
                == opening_return
                and _nested_location_return(element_text(opening), element_text(leading))
            ):
                end = next(
                    (
                        link
                        for link in sibling.iter("a")
                        if link in entry_boundaries
                        and (
                            _authored_names(link)
                            or _canonical_target_ref(link.get("href") or "", document_href)
                            != opening_return
                        )
                    ),
                    None,
                )
                parts.append(_clip_note_block(sibling, None, end))
                included.add(sibling)
                last = sibling
                if end is not None:
                    break
                continue
        if (
            tag == "p"
            and sibling.getprevious() is last
            and _looks_like_printed_note_block(last)
            and sibling.get("class") == last.get("class")
            and (
                subnote := _returned_note_paragraph(
                    document, sibling, document_href, marker_backlinks, None
                )
            )
            is not None
        ):
            member, name = split_html_apparatus_ref(subnote[1])
            marker = document.unique_names.get(name or "") if member == document_href else None
            if marker is not None and any(owner in included for owner in marker.iterancestors()):
                parts.append(serialize_html(sibling))
                included.add(sibling)
                last = sibling
                continue
        if tag in {"p", "div"} and _untyped_note_body(sibling, text, entry_boundaries) is not None:
            break
        if any(
            _untyped_note_body(anchor, text, entry_boundaries) is not None
            for anchor in sibling.xpath(".//a[@id or @name]")
        ):
            break
        if (
            note_collection_end is not None
            and opening is not None
            and opening_return is not None
            and (symbol := _short_note_label(element_text(opening))) is not None
            and not symbol.isdecimal()
            and _printed_symbol_return(sibling, paragraph, document_href)
            == split_html_apparatus_ref(opening_return)[0]
        ):
            break
        if tag in {"p", "div"}:
            boundary = _printed_note_boundary(
                paragraph, sibling, text, entry_boundaries, local_scope=local_scope or peer_scope
            )
            if boundary == "Entry":
                break
            if boundary == "Ambiguous":
                return None
            if _untyped_note_body(sibling, text) is not None:
                if (
                    (local_scope or peer_scope)
                    and _looks_like_printed_note_block(paragraph)
                    and _looks_like_printed_note_block(sibling)
                ):
                    leading = next(link for link in sibling.iter("a") if link.get("href"))
                    label = _printed_return_label(element_text(leading)) or ""
                    same_return = (
                        _canonical_target_ref(leading.get("href") or "", document_href)
                        == opening_return
                    )
                    if (
                        not same_return
                        and sibling.get("class") == paragraph.get("class")
                        and opening is not None
                        and re.fullmatch(r"[IVXLCDM]{1,8}", element_text(opening))
                        and re.fullmatch(r"[IVXLCDM]{1,8}", label)
                        and any(
                            _authored_names(node) and _leading_note_link(node, sibling)
                            for node in sibling.iter("a")
                        )
                    ):
                        break
                    if not local_scope:
                        return None
                    if sibling.get("class") == paragraph.get("class") and label[:1].isdecimal():
                        opener_label = (
                            _short_note_label(element_text(opening))
                            if opening is not None
                            else None
                        )
                        printed_range = _printed_numeric_note_range(element_text(leading))
                        if (
                            not same_return
                            or printed_range is not None
                            and opener_label == str(printed_range[0])
                            or _authored_names(sibling)
                            or _authored_names(leading)
                            or (
                                len([link for link in sibling.iter("a") if link.get("href")]) >= 2
                                and opening is not None
                                and element_text(leading) != element_text(opening)
                            )
                        ):
                            break
                        parts.append(serialize_html(sibling))
                        included.add(sibling)
                        last = sibling
                        unproved_end_tail = True
                        continue
                    # A short linked word can be a quotation at the start of
                    # an independently styled continuation paragraph.
                    if (
                        sibling.get("class") == paragraph.get("class")
                        or label[:1].isdecimal()
                        or _short_note_label(label) is not None
                    ):
                        return None
                else:
                    return None
        if unresolved_paragraphs is not None and sibling in unresolved_paragraphs:
            return None
        if entry_boundaries is not None and any(
            _untyped_note_body(anchor, text) is not None
            for anchor in sibling.xpath(".//a[@id or @name]")
        ):
            return None
        if _first_content_owner(sibling) is None:
            continue
        witnessed_style = (
            continuation_styles is not None and _note_block_style(sibling) in continuation_styles
        )
        attached_illustration = False
        if tag == "p" and not element_text(sibling) and sibling.xpath(".//img|.//svg"):
            addressed = any(
                _authored_names(node) & published_navigation
                for node in sibling.iter()
                if isinstance(node, HtmlElement)
            )
            if addressed:
                if unproved_end_tail:
                    return None
                break
            if not (witnessed_style or follows_witnessed_style):
                if unproved_end_tail:
                    return None
                break
            attached_illustration = True
        extension = sibling
        if (
            tag == "div"
            and len(sibling) == 1
            and not (sibling.text or "").strip()
            and not (sibling[0].tail or "").strip()
        ):
            extension = sibling[0]
        typed_extension = any(
            re.fullmatch(r"(?:foot|end)?note[-_](?:ext|quotes?)[0-9]*", token)
            for token in _class_tokens(sibling) | _class_tokens(extension)
        )
        sibling_classes = _class_tokens(sibling)
        quote = is_quote(sibling) or extension is not sibling and is_quote(extension)
        styled_variant = (
            tag == "p"
            and bool(opening_style)
            and re.fullmatch(
                re.escape(opening_style) + r"(?:\d+[a-z]?|[a-z]\d*)", sibling.get("class") or ""
            )
            is not None
        )
        quote_heading = (
            tag == "p"
            and any(re.fullmatch(r"cent(?:er|re)[0-9]*", token) for token in sibling_classes)
            and element_text(last).endswith(":")
            and not sibling.xpath(".//a[@href]")
            and (following := _next_content_sibling(sibling)) is not None
            and is_quote(following)
        )
        bracketed = _bracketed_editorial_paragraph(sibling, element_text)
        owned_continuation = (
            last is paragraph
            and authored_scope is not None
            and _owned_note_continuation(
                paragraph, sibling, authored_scope, opening, entry_boundaries, text, bracketed
            )
        )
        if bracketed and not owned_continuation:
            return None
        bracket_continuation = (
            tag == "p"
            and last is paragraph
            and opening is not None
            and (
                remainder := element_text(paragraph)[len(element_text(opening)) :].lstrip(". \t")
            ).startswith("[")
            and remainder.count("[") == remainder.count("]") + 1
            and (printed := element_text(sibling)).endswith("]")
            and printed.count("]") == printed.count("[") + 1
        )
        paired_indent = tag == "p" and (
            opening_style.endswith("indent")
            and any(token.startswith(opening_style + "ed") for token in sibling_classes)
            or any(token.endswith("bodytextfullout") for token in _class_tokens(paragraph))
            and any(token.endswith("bodytextindented") for token in sibling_classes)
        )
        indented = (
            paired_indent
            or tag == "p"
            and any(re.fullmatch(r"(?:no)?indent[0-9]*", token) for token in sibling_classes)
        )
        if not (
            typed_extension
            or witnessed_style
            or attached_illustration
            or owned_continuation
            or bracket_continuation
            or introduced_lexicon
            or tag == paragraph.tag
            and (
                _looks_like_printed_note_block(sibling)
                or sibling.get("class") is not None
                and sibling.get("class") == paragraph.get("class")
            )
            or local_scope
            and (
                quote
                or quote_heading
                or indented
                or styled_variant
                or follows_quote
                and tag == "p"
                or tag in {"ul", "ol", "table"}
            )
        ):
            return None
        if tag not in {"p", "div", "blockquote", "ul", "ol", "table"} and (
            element_text(sibling) or sibling.xpath(".//img|.//svg")
        ):
            return None
        introduced_quote = quote and (
            element_text(last).endswith(":")
            or follows_quote
            and not unproved_end_tail
            and sibling.tag == last.tag == "p"
            and _note_block_style(sibling) == _note_block_style(last)
            or tag == "p"
            and any(token.startswith("extract") for token in sibling_classes)
            and element_text(last)[-1:].isalpha()
            and element_text(sibling)[:1].islower()
        )
        cited_excerpt = (
            local_scope
            and sibling.get("class") == paragraph.get("class")
            and _looks_like_printed_note_block(paragraph)
            and (printed := element_text(sibling)).startswith("“")
            and "”" in printed[1:]
            and all(
                any(
                    (link.get("href") or "").startswith(("https://", "http://"))
                    for link in block.iter("a")
                )
                for block in (last, sibling)
            )
        )
        parts.append(serialize_html(sibling))
        included.add(sibling)
        last = sibling
        follows_quote = quote or styled_variant and element_text(paragraph).endswith(":")
        follows_witnessed_style = witnessed_style or attached_illustration
        if attached_illustration:
            unproved_end_tail = True
        if not (
            typed_extension
            or witnessed_style
            or paired_indent
            or owned_continuation
            or bracket_continuation
            or introduced_lexicon
            or introduced_quote
            or cited_excerpt
            or bounded_note_page
            or sibling.get("class") != paragraph.get("class")
            and _looks_like_printed_note_block(sibling)
        ):
            unproved_end_tail = True
    else:
        if unproved_end_tail:
            return None
        if not (
            authored_scope is not None
            and _ends_source_scope(last, authored_scope)
            or _ends_document(last)
            and (
                note_collection_end is True
                or closes_member is not None
                and closes_member(document_href)
            )
        ):
            return None
    return "".join(parts)


def _next_content_sibling(block: HtmlElement) -> HtmlElement | None:
    return next(
        (
            sibling
            for sibling in block.itersiblings()
            if isinstance(sibling, HtmlElement) and _first_content_owner(sibling) is not None
        ),
        None,
    )


def _printed_note_boundary(
    paragraph: HtmlElement,
    candidate: HtmlElement,
    text: Callable[[HtmlElement], str] | None,
    entry_boundaries: set[HtmlElement] | None,
    *,
    local_scope: bool,
    next_paragraph: HtmlElement | None = None,
) -> Literal["Entry", "Ambiguous"] | None:
    """Distinguish a separately styled entry from an unproved numbered paragraph."""
    element_text = text or _element_text
    label = _target_label(element_text(candidate))
    links = paragraph.xpath(".//a[@href]")
    if (
        local_scope
        and entry_boundaries is not None
        and candidate.tag == "p"
        and len(candidate)
        and (lemma := candidate[0]).tag in {"i", "em"}
        and not (candidate.text or "").strip()
        and (lemma.tail or "").lstrip().startswith(":")
        and re.fullmatch(r"(?:see|(?:cf|ibid|op\.\s*cit)\.)", element_text(lemma), re.IGNORECASE)
        is None
        and (style := candidate.get("class")) is not None
        and paragraph.get("class") == style
        and (following := _next_content_sibling(candidate)) is not None
        and following.get("class") == style
    ):
        # The same printed lemma introduces both independently returned peers.
        # Here only its link wrapper is absent.
        for peer in (paragraph, following):
            first = next((link for link in peer.iter("a") if link.get("href")), None)
            if (
                first is None
                or first not in entry_boundaries
                or not _leading_note_link(first, peer)
                or len(first) == 0
                or first[-1].tag != lemma.tag
                or (first[-1].tail or "").strip()
                or not (first.tail or "").lstrip().startswith(":")
            ):
                break
        else:
            return "Entry"
    printed = re.match(r"^(?:≠\s+)?(\d{1,4})([a-z]?)\.(?:\s|$)", element_text(candidate))
    if (
        local_scope
        and printed is not None
        and _authored_names(candidate)
        and candidate.get("class") is not None
        and candidate.get("class") == paragraph.get("class")
    ):
        return "Entry"
    if local_scope and printed is not None and links:
        previous = _printed_return_label(element_text(links[0]))
        following = (
            next_paragraph if next_paragraph is not None else _next_content_sibling(candidate)
        )
        if (
            previous is not None
            and not previous.isdecimal()
            and printed[1] == "1"
            and following is not None
            and bool(re.match(r"^1\. [\w’'-]+\]", element_text(candidate)))
            and bool(re.match(r"^2\. [\w’'-]+\]", element_text(following)))
        ):
            return "Entry"
        if previous is not None and previous.isdecimal():
            if (
                int(previous) < int(printed[1])
                and entry_boundaries is not None
                and following is not None
                and candidate.get("class") is not None
                and candidate.get("class") == following.get("class") == paragraph.get("class")
                and _untyped_note_body(following, text, entry_boundaries) is following
                and (
                    upcoming := _printed_return_label(
                        element_text(next(link for link in following.iter("a") if link.get("href")))
                    )
                )
                is not None
                and upcoming.isdecimal()
                and int(printed[1]) < int(upcoming)
            ):
                return "Entry"
            if int(printed[1]) == int(previous) + 1 or (
                printed[2] and int(printed[1]) == int(previous)
            ):
                if candidate.get("class") == paragraph.get("class"):
                    return "Entry"
                if _looks_like_printed_note_block(candidate) and _authored_names(candidate):
                    if (
                        following is not None
                        and _authored_heading(following)
                        and re.sub(r"[0-9]+$", "", candidate.get("class") or "")
                        == re.sub(r"[0-9]+$", "", paragraph.get("class") or "")
                    ):
                        return "Entry"
                    return "Ambiguous"
    if local_scope and printed is not None and candidate.get("class") == paragraph.get("class"):
        return "Ambiguous"
    if (
        not label
        or not re.fullmatch(r"\d{1,4}\.", label)
        or not links
        or not _numeric_marker(links[0], element_text)
        or int(label[:-1]) != int(element_text(links[0]).strip("[].")) + 1
        or not _authored_names(candidate)
    ):
        return None
    parent = paragraph.getparent()
    if parent is None or _target_context(parent, {}, element_text).loose != "note":
        return None
    if not candidate.get("class") or candidate.get("class") == paragraph.get("class"):
        return "Ambiguous"
    peers = sum(
        isinstance(peer, HtmlElement)
        and peer is not paragraph
        and str(peer.tag).lower() == "p"
        and peer.get("class") == candidate.get("class")
        and any(
            _untyped_note_body(anchor, element_text) is not None
            for anchor in peer.xpath(".//a[@id or @name]")
        )
        for peer in parent
    )
    return "Entry" if peers >= 2 else "Ambiguous"


def _leading_note_link(link: HtmlElement, body: HtmlElement) -> bool:
    """Whitespace and empty authored anchors may precede a return; prose may not."""
    branch = link
    while branch is not body:
        parent = branch.getparent()
        if parent is None or (parent.text or "").strip() not in {"", "["}:
            return False
        if any(
            _element_text(previous) or (previous.tail or "").strip()
            for previous in branch.itersiblings(preceding=True)
            if isinstance(previous, HtmlElement)
        ):
            return False
        branch = parent
    return True


def _inline_note_html(
    target: HtmlElement,
    owner: HtmlElement,
    entry_boundaries: set[HtmlElement],
    document_href: str,
) -> str | None:
    """Clip independently reciprocal inline entries without flattening their DOM."""
    if owner.tag not in {"p", "li"}:
        owner = next((node for node in target.iterancestors() if node.tag in {"p", "li"}), owner)
    if owner.tag not in {"p", "li"} or _is_sup_marker(target):
        return None
    entries = [
        element
        for element in owner.iter("a")
        if isinstance(element, HtmlElement) and element in entry_boundaries
    ]
    if target not in entries or (len(entries) == 1 and _leading_note_link(target, owner)):
        return None
    if owner.tag == "li" and (
        len(entries) < 2
        or not _leading_note_link(entries[0], owner)
        or (
            _grouped_note_wrapper(entries[0]) is not owner
            and not _target_context(owner, {}).is_note
        )
    ):
        return None
    index = entries.index(target)
    opening_return = _canonical_target_ref(target.get("href") or "", document_href)
    end = next(
        (
            entry
            for entry in entries[index + 1 :]
            if _authored_names(entry)
            or _canonical_target_ref(entry.get("href") or "", document_href) != opening_return
            or ":" not in (_printed_return_label(_element_text(entry)) or "")
        ),
        None,
    )
    return _clip_note_block(owner, target, end)


def _clip_note_block(owner: HtmlElement, start: HtmlElement | None, end: HtmlElement | None) -> str:
    clipped = deepcopy(owner)
    copies = dict(zip(owner.iter(), clipped.iter(), strict=True))
    if start is not None:
        branch = copies[start]
        while branch is not clipped:
            parent = branch.getparent()
            if parent is None:
                raise ValueError("Inline note start is outside its source block")
            parent.text = None
            for previous in list(branch.itersiblings(preceding=True)):
                parent.remove(previous)
            branch = parent
    if end is not None:
        branch = copies[end]
        while branch is not clipped:
            parent = branch.getparent()
            if parent is None:
                raise ValueError("Inline note end is outside its source block")
            for following in list(branch.itersiblings()):
                parent.remove(following)
            branch.tail = None
            if branch is copies[end]:
                parent.remove(branch)
            branch = parent
    clipped.tail = None
    return serialize_html(clipped)


def _proved_note_entries(
    document_href: str,
    marker_backlinks: Mapping[str, set[str]],
    entry_openers: Mapping[str, Mapping[str, HtmlApparatusEntryOpener]],
    unique_names: Mapping[str, HtmlElement],
) -> tuple[set[str], set[HtmlElement], set[HtmlElement]]:
    """Separate eligible targets, proved boundaries and ambiguous paragraphs.

    Extra openers may delimit only between independent Reference-return paragraphs.
    That run's repeated return-label typography may identify an idless range
    entry linked to the same source opener or the following proved body. This is
    source-local structural inference, never a new reference or target identity.
    """
    reference_targets: set[str] = set()
    reference_entries: set[HtmlElement] = set()
    extra_entries: set[HtmlElement] = set()
    unresolved_paragraphs: set[HtmlElement] = set()
    unpaired_openers: dict[str, tuple[str, HtmlApparatusEntryOpener]] = {}
    for declared_target, openers in entry_openers.items():
        for source_href, opener in openers.items():
            if opener.role != "UnpairedReference":
                continue
            fact = (declared_target, opener)
            previous = unpaired_openers.setdefault(source_href, fact)
            if previous != fact:
                raise _ambiguous("EPUB source opener names multiple targets")
    for name, target in unique_names.items():
        target_ref = html_apparatus_ref(document_href, name)
        body = _note_body_element(target)
        if _is_sup_marker(target) and not _leading_note_link(target, body):
            continue
        if str(target.tag).lower() == "a" and target.get("href"):
            entry = target
        else:
            links = body.xpath(".//a[@href]")
            if not links or not _leading_note_link(links[0], body):
                continue
            if target is not body and not _leading_note_link(target, body):
                continue
            entry = links[0]
        if (
            not _leading_note_link(entry, body)
            and _printed_return_label(_element_text(entry)) is None
        ):
            continue
        return_ref = _canonical_target_ref(entry.get("href") or "", document_href)
        if (
            target_ref not in marker_backlinks
            and target_ref not in entry_openers
            and return_ref not in unpaired_openers
        ):
            continue
        if return_ref in marker_backlinks.get(target_ref, set()):
            reference_targets.add(target_ref)
            reference_entries.add(entry)
            continue
        if target_ref in marker_backlinks:
            paragraph = next(entry.iterancestors("p"), None)
            if paragraph is not None:
                unresolved_paragraphs.add(paragraph)
        opener = entry_openers.get(target_ref, {}).get(return_ref)
        if opener is None and (unpaired := unpaired_openers.get(return_ref)) is not None:
            opener = unpaired[1]
        paragraph = next(entry.iterancestors("p"), None)
        if opener is None or paragraph is None:
            continue
        label = _element_text(entry)
        if opener.role == "UnmarkedReference":
            if _leading_note_link(entry, paragraph):
                extra_entries.add(entry)
        elif opener.role == "UnpairedReference":
            location = re.match(r"^\d{1,4}:(\d{1,4})[a-z]?\b", label)
            if (
                _numeric_marker(entry)
                and int(label.strip("[].")) == int(opener.label.strip("[]."))
                or _looks_like_printed_note_block(paragraph)
                and location is not None
                and int(location[1]) == int(opener.label.strip("[]."))
            ):
                extra_entries.add(entry)
        elif opener.role == "Symbol":
            if label == opener.label and _leading_note_link(entry, paragraph):
                extra_entries.add(entry)
        else:
            location = re.match(r"^(\d{1,4}):1(?:\b|[–-])", label)
            division = re.fullmatch(r"(?:[^\W\d_]+\s+)+(\d{1,4})\.?", label)
            if (
                (location is not None and int(location[1]) == int(opener.label.strip("[].")))
                or (
                    _numeric_marker(entry)
                    and int(label.strip("[].")) == int(opener.label.strip("[]."))
                )
                or (division is not None and int(division[1]) == int(opener.label.strip("[].")))
            ):
                extra_entries.add(entry)
    references_by_paragraph: dict[HtmlElement, set[HtmlElement]] = {}
    extras_by_paragraph: dict[HtmlElement, set[HtmlElement]] = {}
    for entries, by_paragraph in (
        (reference_entries, references_by_paragraph),
        (extra_entries, extras_by_paragraph),
    ):
        for entry in entries:
            paragraph = next(entry.iterancestors("p"), None)
            if paragraph is not None:
                by_paragraph.setdefault(paragraph, set()).add(entry)
    corroborated: set[HtmlElement] = set()
    groups: list[list[HtmlElement]] = []
    parents = {
        paragraph.getparent()
        for paragraph in references_by_paragraph.keys() | extras_by_paragraph.keys()
    }
    for parent in parents:
        if parent is None:
            continue
        run: list[HtmlElement] = []
        for paragraph in [*parent, None]:
            if paragraph is not None and not isinstance(paragraph, HtmlElement):
                continue
            if paragraph is not None and str(paragraph.tag).lower() == "p":
                run.append(paragraph)
            else:
                references = [
                    index for index, part in enumerate(run) if part in references_by_paragraph
                ]
                if sum(len(references_by_paragraph[run[index]]) for index in references) >= 2:
                    group = run[references[0] : references[-1] + 1]
                    groups.append(group)
                    corroborated.update(group)
                run = []
    boundaries = reference_entries | {
        entry for paragraph in corroborated for entry in extras_by_paragraph.get(paragraph, set())
    }
    for group in groups:
        shapes: dict[tuple[str, ...], int] = {}
        printed_shapes: dict[tuple[str, tuple[str, ...]], int] = {}
        return_refs: set[str] = set()
        for paragraph in group:
            for entry in references_by_paragraph.get(paragraph, set()):
                shape = tuple(str(node.tag).lower() for node in entry.iterdescendants())
                shapes[shape] = shapes.get(shape, 0) + 1
                if _looks_like_printed_note_block(paragraph):
                    layout = (entry.get("class") or "", shape)
                    printed_shapes[layout] = printed_shapes.get(layout, 0) + 1
            for entry in paragraph.iter("a"):
                if entry in boundaries:
                    return_refs.add(_canonical_target_ref(entry.get("href") or "", document_href))
        for paragraph in group:
            links = list(paragraph.iter("a"))
            for index, link in enumerate(links):
                shape = tuple(str(node.tag).lower() for node in link.iterdescendants())
                label = _element_text(link)
                if (
                    link in boundaries
                    or not link.get("href")
                    or _is_sup_marker(link)
                    or not (
                        not _authored_names(link)
                        and re.match(r"^\d{1,4}(?::\d{1,4})?[a-z]?[–-]\d", label)
                        and shapes.get(shape, 0) >= 2
                        or _looks_like_printed_note_block(paragraph)
                        and printed_shapes.get((link.get("class") or "", shape), 0) >= 2
                        and re.match(r"^(?:\d{1,4}:\d{1,4}[a-z]?\b|Psalms? \d{1,4}\.)", label)
                    )
                ):
                    continue
                target_ref = _canonical_target_ref(link.get("href") or "", document_href)
                following = next(
                    (entry for entry in links[index + 1 :] if entry in reference_entries), None
                )
                if target_ref in return_refs or (
                    following is not None
                    and split_html_apparatus_ref(target_ref)[0] == document_href
                    and unique_names.get(split_html_apparatus_ref(target_ref)[1] or "") is following
                ):
                    boundaries.add(link)
    return (
        reference_targets,
        boundaries,
        unresolved_paragraphs
        | {
            paragraph
            for paragraph, entries in extras_by_paragraph.items()
            if not entries <= boundaries
        },
    )


def _dedicated_note_marker(marker: HtmlElement, printed: str) -> str | None:
    if marker.tag != "a":
        return None
    sup = marker.getparent()
    if sup is None or sup.tag != "sup":
        return None
    owner = _source_element_id_owner(marker)
    if owner is None or owner is not sup.getnext():
        return None
    prose = next(
        (
            node
            for node in marker.iterancestors()
            if node.tag in {"p", "blockquote"} or _authored_heading(node)
        ),
        None,
    )
    if prose is None or _leading_note_link(marker, prose):
        return None
    return "*" if printed == "[*]" else _short_note_label(printed.removesuffix(","))


def _printed_note_marker(marker: HtmlElement, label: str) -> bool:
    if marker.tag != "a" or not re.fullmatch(r"(?:[a-z]+|\*)", label) or not _is_sup_marker(marker):
        return False
    paragraph = next((node for node in marker.iterancestors() if node.tag in {"p", "div"}), None)
    return paragraph is not None and not _leading_note_link(marker, paragraph)


def _is_inline_note_marker(marker: HtmlElement) -> bool:
    if not (marker.xpath(".//sup") or _parent_tag(marker) == "sup"):
        return False
    paragraph = next(marker.iterancestors("p"), None)
    if paragraph is None:
        return False
    text, label = _element_text(paragraph), _element_text(marker)
    return not text.startswith(label) and len(text.split(maxsplit=7)) >= 8


def _is_bibliography_entry_target(
    target: HtmlElement, ancestor_prefixes: dict[HtmlElement, str]
) -> bool:
    tag = str(target.tag).lower()
    if tag in {"ref", "li"} or _semantic_tokens(target) & {"biblioentry", "doc-biblioentry"}:
        return True
    if tag in {"section", "div", "ol", "ref-list", "ul"} | _BIBLIOGRAPHY_CONTAINER_TAGS:
        return False
    return _target_context(target, ancestor_prefixes).semantic == "bibliography"


def _is_note_body_target(target: HtmlElement) -> bool:
    tokens = _semantic_tokens(target)
    if tokens & {"endnotes", "doc-endnotes"}:
        return False
    tag = str(target.tag).lower()
    if tokens & _NOTE_BODY_TOKENS or tag in {"fn", "footnote"}:
        return True
    return tag in {"li", "aside"} and not any(
        isinstance(ancestor, HtmlElement)
        and (
            _semantic_tokens(ancestor) & _NOTE_BODY_TOKENS
            or str(ancestor.tag).lower() in {"li", "aside", "fn", "footnote"}
        )
        for ancestor in target.iterancestors()
    )


def _grouped_note_collection(element: HtmlElement) -> set[str]:
    named = {
        match[1]
        for token in _class_tokens(element)
        if (match := re.fullmatch(r"(footnote|endnote)s(?:[1-9][0-9]*)?", token)) is not None
    }
    return named | {
        token.removeprefix("doc-")[:-1]
        for token in _semantic_tokens(element)
        if token in {"footnotes", "doc-footnotes", "endnotes", "doc-endnotes"}
    }


def _grouped_note_wrapper(target: HtmlElement) -> HtmlElement | None:
    """Use a publisher-delimited entry inside its explicitly named collection."""
    for element in (target, *target.iterancestors()):
        if _writer_note_name(target, element) is not None and _leading_note_link(target, element):
            return element
        parent = element.getparent()
        if parent is None:
            continue
        collection = _grouped_note_collection(parent)
        if not collection:
            continue
        if (
            element.tag == "li"
            and parent.tag in {"ol", "ul"}
            or (element.tag == parent.tag == "div" and bool(collection & _class_tokens(element)))
        ) and _leading_note_link(target, element):
            return element
    parent = target.getparent()
    if (
        parent is not None
        and parent.tag == "div"
        and len(parent) == 2
        and parent[0] is target
        and target.tag == "a"
        and target.get("href")
        and _numeric_marker(target)
        and parent[1].tag in {"p", "div"}
        and not (target.tail or "").strip()
        and not (parent[1].tail or "").strip()
        and (
            _class_tokens(parent) & {"fn", "footnote", "endnote"}
            or any(
                re.fullmatch(r"(?:ftn|footnote|endnote)[_-]\d+[a-z]?", name, re.IGNORECASE)
                for name in _authored_names(target)
            )
        )
    ):
        return parent
    return None


def _writer_note_name(target: HtmlElement, wrapper: HtmlElement) -> str | None:
    """The Writer export uses one name for a wrapper, marker and return."""
    name = wrapper.get("id") or ""
    if (
        wrapper.tag == "div"
        and target.tag == "a"
        and re.fullmatch(r"sd(?:foot|end)note[0-9]+", name)
        and any(
            re.fullmatch(r"sd(?:foot|end)notesym(?:-(?:western|cjk|ctl))?", token)
            for token in _class_tokens(target)
        )
        and _authored_names(target) == {f"{name}sym"}
        and unquote((target.get("href") or "").partition("#")[2]) == f"{name}anc"
    ):
        return name
    return None


def _terminal_footnote_paragraphs(document: _TargetDocument) -> dict[HtmlElement, HtmlElement]:
    """Collect individual paragraphs in a named footnote group or an exhaustive run."""
    parents = {
        paragraph.getparent()
        for paragraph in document.root.iter("p")
        if "footnote" in _class_tokens(paragraph)
    }
    parents.add(document.root)
    out: dict[HtmlElement, HtmlElement] = {}
    text = document.text
    for parent in parents:
        if parent is None:
            continue
        entries: dict[HtmlElement, HtmlElement] = {}
        following_number: int | None = None
        page_styles: set[str] = set()
        for block in reversed(list(parent)):
            if (block.tail or "").strip():
                break
            if not isinstance(block, HtmlElement):
                continue
            styles = _class_tokens(block)
            if following_number is None and parent is document.root:
                page_styles = styles & {"fn", "notes"}
            if block.tag != "p" or (
                not page_styles
                and "footnote" not in styles
                or page_styles
                and not page_styles & styles
                and following_number != 2
            ):
                if (
                    not page_styles
                    and len(entries) >= 2
                    and (block.tag == "p" or _authored_heading(block))
                    and not hides(block)
                    and text(block).casefold().removesuffix(":").rstrip() == "footnotes"
                ):
                    out.update(entries)
                break
            leading = next((link for link in block.iter("a") if link.get("href")), None)
            if (
                leading is None
                or not _supplies_first_content(_first_content_owner(block), leading)
                or any(hides(node) for node in (leading, *leading.iterancestors()))
                or text(block) == text(leading)
                or (label := _short_note_label(text(leading))) is None
                or not label.isdecimal()
            ):
                break
            number = int(label)
            if following_number is not None and number + 1 != following_number:
                break
            entries[block] = leading
            if page_styles and number == 1:
                if len(entries) >= 2:
                    out.update(entries)
                break
            following_number = number
    return out


def _lettered_footnote_wrappers(document: _TargetDocument) -> dict[HtmlElement, HtmlElement]:
    """An entire authored container of alphabetical notes gives each wrapper its extent."""

    def entries_after_anchor(owner: HtmlElement) -> list[HtmlElement]:
        if (owner.text or "").strip() or any((child.tail or "").strip() for child in owner):
            return []
        children = [node for node in owner if isinstance(node, HtmlElement)]
        if children:
            first = children[0]
            if (
                first.tag in {"a", "span"}
                and _authored_names(first)
                and not first.get("href")
                and _first_content_owner(first) is None
            ):
                return children[1:]
        return children

    children = entries_after_anchor(document.root)
    if len(children) == 1 and children[0].tag == "div" and not hides(children[0]):
        children = entries_after_anchor(children[0])
    text = document.text
    if len(children) < 2 or not (classes := _class_tokens(children[0])):
        return {}
    entries: dict[HtmlElement, HtmlElement] = {}
    for index, wrapper in enumerate(children, start=1):
        letters = ""
        while index:
            index, letter = divmod(index - 1, 26)
            letters = chr(ord("a") + letter) + letters
        if (
            wrapper.tag != "div"
            or _class_tokens(wrapper) != classes
            or hides(wrapper)
            or (wrapper.text or "").strip()
            or any((child.tail or "").strip() for child in wrapper)
        ):
            return {}
        parts = [node for node in wrapper if isinstance(node, HtmlElement)]
        if len(parts) != 2:
            return {}
        leading, prose = parts
        if (
            leading.tag != "a"
            or not leading.get("href")
            or len(document.aliases.get(leading, ())) != 1
            or hides(leading)
            or text(leading) != letters
            or prose.tag not in {"p", "div"}
            or hides(prose)
            or not text(prose)
        ):
            return {}
        entries[wrapper] = leading
    return entries


def _dedicated_note_body(
    target: HtmlElement,
    text: Callable[[HtmlElement], str],
) -> tuple[HtmlElement, HtmlElement, str] | None:
    if target.tag != "a" or target.get("href"):
        return None
    label = _short_note_label(text(target))
    if label != "*" and not _is_sup_marker(target):
        return None
    paragraph = next(target.iterancestors("p"), None)
    if (
        label is None
        or paragraph is None
        or any(hides(node) for node in (target, *target.iterancestors()))
    ):
        return None
    body = paragraph.getparent()
    if (
        body is None
        or body.tag != "body"
        or not _supplies_first_content(_first_content_owner(body), target)
    ):
        return None
    links = [link for link in paragraph.iter("a") if link.get("href")]
    if not links:
        return None
    returning = links[-1]
    prompt = text(returning)
    if (
        prompt.casefold() not in {"back to text", "(back to text)"}
        or hides(returning)
        or not _ends_document(returning)
        or not re.search(r"\w", text(paragraph).removeprefix(text(target)).removesuffix(prompt))
    ):
        return None
    return paragraph, returning, label


def _grouped_note_entry(
    target: HtmlElement,
    text: Callable[[HtmlElement], str],
    classed_entries: Mapping[HtmlElement, HtmlElement],
) -> tuple[HtmlElement, HtmlElement, str] | None:
    # Dedicated lettered pages put the return directly inside the wrapper.
    parent = target.getparent()
    if parent is not None and classed_entries.get(parent) is target:
        return parent, target, text(target).strip("[].")
    paragraph = _note_body_element(target)
    if (lead := classed_entries.get(paragraph)) is not None and _leading_note_link(
        target, paragraph
    ):
        return paragraph, lead, text(lead).strip("[].")
    if (
        paragraph.tag == "p"
        and "footnote" in _class_tokens(paragraph)
        and target.tag == "a"
        and parent is paragraph
        and not target.get("href")
        and _first_content_owner(target) is None
        and isinstance(leading := target.getnext(), HtmlElement)
        and leading.tag == "a"
        and leading.get("href")
        and text(leading) == "*"
        and not any(
            hides(node) for node in (target, leading, *paragraph.iterancestors(), paragraph)
        )
        and _supplies_first_content(_first_content_owner(paragraph), leading)
        and text(paragraph) != text(leading)
    ):
        return paragraph, leading, "*"
    if (dedicated := _dedicated_note_body(target, text)) is not None:
        return dedicated
    owner = _grouped_note_wrapper(target)
    if owner is None:
        return None
    leading = next((link for link in owner.iter("a") if link.get("href")), None)
    if (
        leading is None
        or not _supplies_first_content(_first_content_owner(owner), leading)
        or any(hides(node) for node in (leading, *leading.iterancestors()))
        or not _numeric_marker(leading, text)
        or (text(owner) == text(leading) and not owner.xpath(".//img|.//svg"))
    ):
        return None
    return owner, leading, text(leading).strip("[].")


def _note_body_element(target: HtmlElement) -> HtmlElement:
    """Use the smallest prose container for an anchor that only names a note."""
    if str(target.tag).lower() in {"p", "li", "blockquote", "aside", "fn", "footnote"}:
        return target
    if _semantic_tokens(target) & (_FOOTNOTE_TOKENS | _ENDNOTE_TOKENS):
        return target
    parent = target.getparent()
    if not isinstance(parent, HtmlElement):
        return target
    if str(target.tag).lower() == "sup" and str(parent.tag).lower() == "a":
        parent = parent.getparent()
        if not isinstance(parent, HtmlElement):
            return target
    if str(parent.tag).lower() == "span":
        return parent
    if str(parent.tag).lower() in {"p", "li", "blockquote"}:
        return parent
    if (
        parent.tag == "div"
        and _class_tokens(parent).isdisjoint({"notes", "footnotes", "endnotes"})
        and _looks_like_printed_note_block(parent)
    ):
        return parent
    grandparent = parent.getparent()
    if isinstance(grandparent, HtmlElement) and str(grandparent.tag).lower() in {"p", "li"}:
        return grandparent
    return target


def _numeric_marker(element: HtmlElement, text: Callable[[HtmlElement], str] | None = None) -> bool:
    return bool(re.fullmatch(r"(?:\[\d+\]|\d+\.?)", (text or _element_text)(element)))


def _is_sup_marker(element: HtmlElement) -> bool:
    for ancestor in element.iterancestors():
        tag = str(ancestor.tag).lower()
        if tag == "sup":
            return True
        if tag not in {"span", "small"}:
            break
    return any(
        isinstance(child, HtmlElement) and str(child.tag).lower() == "sup"
        for child in element.iterdescendants()
    )


def _looks_like_note_body(
    body: HtmlElement, text: Callable[[HtmlElement], str] | None = None
) -> bool:
    """A numbered return link followed by prose, not just a reciprocal link."""
    if any(
        isinstance(element, HtmlElement) and str(element.tag).lower() in HEADING_TAGS
        for element in body.iterdescendants()
    ):
        return False
    element_text = text or _element_text
    text_value = element_text(body)
    for link in body.iter("a"):
        if not isinstance(link, HtmlElement):
            continue
        if not (link.get("href") or "").strip() or not _numeric_marker(link, element_text):
            continue
        marker = element_text(link)
        if _leading_note_link(link, body) and re.search(r"\w", text_value[len(marker) :]):
            return True
    return False


def _target_kind_for_context(context: str) -> str:
    if context == "endnote":
        return "endnote"
    if context == "bibliography":
        return "bibliography_entry"
    return "footnote"


def accepted_apparatus_spans(
    structure: CanonicalStructure, canonical_text: str
) -> dict[str, tuple[int, int, str]]:
    """Use the canonicalizer's exact element boundaries without modifying source text."""
    if not canonical_text:
        return {}
    if structure.text != canonical_text:
        return {}
    spans: dict[str, tuple[int, int, str]] = {}
    for stable_key, index in structure.apparatus_items.items():
        element = structure.elements[index]
        start, end = element.start_offset, element.end_offset
        locator_text = canonical_text[start:end]
        if locator_text:
            spans[stable_key] = (start, end, locator_text)
    return spans


def _apparatus_locator_texts(html_sanitized: str | None) -> dict[str, str]:
    if not html_sanitized or not html_sanitized.strip():
        return {}
    try:
        root = parse_html_document(f"<div>{html_sanitized}</div>")
    except ParserError:
        return {}
    texts: dict[str, str] = {}
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        stable_key = (element.get("data-reader-apparatus-item-id") or "").strip()
        if not stable_key:
            continue
        text_value = generate_canonical_text(serialize_html(element))
        if text_value:
            texts[stable_key] = text_value
    return texts


def _unique_text_span(canonical_text: str, locator_text: str) -> tuple[int, int] | None:
    if not locator_text:
        return None
    matches = [match.start() for match in re.finditer(re.escape(locator_text), canonical_text)]
    if len(matches) != 1:
        return None
    return matches[0], matches[0] + len(locator_text)


def _stamp(element: HtmlElement, stable_key: str, kind: str, confidence: str) -> None:
    element.set("data-reader-apparatus-item-id", stable_key)
    element.set("data-reader-apparatus-kind", kind)
    element.set("data-reader-apparatus-confidence", confidence)


def _local_target_id(element: HtmlElement, document_href: str | None = None) -> str | None:
    if str(element.tag).lower() == "xref":
        return (element.get("rid") or "").strip() or None
    href = (element.get("href") or "").strip()
    if href.startswith("#") and len(href) > 1:
        return unquote(href[1:])
    if document_href:
        member, anchor = split_html_apparatus_ref(_canonical_target_ref(href, document_href))
        if member == document_href:
            return anchor or None
    return None


def _target_ref(element: HtmlElement) -> str | None:
    if str(element.tag).lower() == "xref":
        return (element.get("rid") or "").strip() or None
    return (element.get("href") or "").strip() or None


def html_apparatus_ref(member: str, anchor: str | None = None) -> str:
    """Key a literal source member and already decoded anchor without ambiguity."""
    member = member.replace("%", "%25").replace("#", "%23").replace("?", "%3F")
    return member if anchor is None else f"{member}#{anchor}"


def split_html_apparatus_ref(ref: str) -> tuple[str, str | None]:
    member, separator, anchor = ref.partition("#")
    return unquote(member), anchor if separator else None


def _canonical_target_ref(href: str, document_href: str | None) -> str:
    path, separator, fragment = href.partition("#")
    if separator and not path:
        return html_apparatus_ref(document_href or "", unquote(fragment))
    return html_apparatus_ref(unquote(path), unquote(fragment) if separator else None)


def _link_hrefs(
    element: HtmlElement,
    *,
    document_href: str,
    max_count: int,
    allowed_hrefs: set[str] | None = None,
) -> list[str]:
    hrefs: list[str] = []
    for descendant in element.iter():
        if not isinstance(descendant, HtmlElement) or str(descendant.tag).lower() != "a":
            continue
        href = (descendant.get("href") or "").strip()
        if not href:
            continue
        ref = _canonical_target_ref(href, document_href)
        if allowed_hrefs is not None and ref not in allowed_hrefs:
            continue
        if len(hrefs) >= max_count:
            raise ResourceLimitError("HTML apparatus backlink count exceeded", dimension="Output")
        hrefs.append(ref)
    return hrefs


def _semantic_tokens(element: HtmlElement, *, include_rearnote: bool = True) -> set[str]:
    tokens = {
        token
        for attr in _SEMANTIC_ATTRIBUTES
        for token in (element.get(attr) or "").lower().split()
    }
    if "rearnotes" in tokens:
        tokens.add("endnotes")
    if (
        include_rearnote
        and "rearnote" in tokens
        and (
            element.tag == "aside"
            or any(
                ancestor.tag in {"article", "aside", "nav", "section"}
                for ancestor in element.iterancestors()
            )
        )
    ):
        tokens.add("endnote")
    return tokens


def _class_tokens(element: HtmlElement) -> set[str]:
    return {
        token.strip().lower() for token in (element.get("class") or "").split() if token.strip()
    }


def _element_text(element: HtmlElement) -> str:
    return generate_canonical_text(inner_html(element))


def _bounded_element_text() -> Callable[[HtmlElement], str]:
    """Memoize repeated small subtree text within one immutable parsed document."""
    values: OrderedDict[HtmlElement, str] = OrderedDict()
    total_bytes = 0

    def text(element: HtmlElement) -> str:
        nonlocal total_bytes
        if element in values:
            values.move_to_end(element)
            return values[element]
        value = _element_text(element)
        if len(value) > 32_768:
            return value
        size = len(value) * 4
        while values and (total_bytes + size > 1024 * 1024 or len(values) >= 4_096):
            _, removed = values.popitem(last=False)
            total_bytes -= len(removed) * 4
        values[element] = value
        total_bytes += size
        return value

    return text


def _target_label(text_value: str) -> str | None:
    token = re.match(r"\s*(\S+)", text_value)
    first = token[1] if token is not None else ""
    # A leading marker is an authored label. The first prose word (including
    # a trailing backlink after an image) is not a note's name.
    return first if re.fullmatch(r"(?:\[\d{1,4}\]|\d{1,4}[.)]?|[*†‡§]+)", first) else None


def _source_element_id(element: HtmlElement) -> str | None:
    owner = _source_element_id_owner(element)
    value = (owner.get("id") or owner.get("name") or "").strip() if owner is not None else ""
    return value or None


def _empty_named_anchor(element: HtmlElement, gap: str | None) -> bool:
    return (
        isinstance(element, HtmlElement)
        and str(element.tag).lower() == "a"
        and not (element.get("href") or "").strip()
        and bool(_authored_names(element))
        and not (gap or "").strip()
        and _first_content_owner(element) is None
    )


def _nearby_reading_return(marker: HtmlElement) -> HtmlElement | None:
    """An anonymous glyph can return to the start of its marked reading phrase."""
    prior = marker.getprevious()
    if (
        marker.tag == "a"
        and _numeric_marker(marker)
        and _is_sup_marker(marker)
        and isinstance(prior, HtmlElement)
        and _empty_named_anchor(prior, None)
        and len(_authored_names(prior)) == 1
        and bool((prior.tail or "").strip())
    ):
        return prior
    return None


def _adjacent_note_marker_address(marker: HtmlElement) -> HtmlElement | None:
    previous = marker.getprevious()
    if (
        marker.tag == "a"
        and _authored_names(marker)
        and previous is not None
        and _empty_named_anchor(previous, previous.tail)
        and len(_authored_names(previous)) == 1
        and _is_sup_marker(marker)
        and _printed_return_label(_element_text(marker)) is not None
    ):
        return previous
    return None


def _source_element_id_owner(element: HtmlElement) -> HtmlElement | None:
    if _authored_names(element):
        return element
    if str(element.tag).lower() == "a":
        child_ids = [
            child
            for child in element
            if isinstance(child, HtmlElement) and str(child.tag).lower() == "sup"
        ]
        if len(child_ids) == 1 and (child_ids[0].get("id") or "").strip():
            return child_ids[0]
    parent = element.getparent()
    if isinstance(parent, HtmlElement) and str(parent.tag).lower() == "sup":
        parent_id = (parent.get("id") or "").strip()
        if parent_id:
            return parent
        for earlier in (element.getprevious(), parent.getprevious()):
            if earlier is not None and _empty_named_anchor(earlier, earlier.tail):
                return earlier
        for following, gap in (
            (element.getnext(), element.tail),
            (parent.getnext(), parent.tail),
        ):
            if following is not None and _empty_named_anchor(following, gap):
                return following
    if str(element.tag).lower() == "a":
        preceding = element.getprevious()
        href = (element.get("href") or "").strip()
        if (
            preceding is not None
            and _empty_named_anchor(preceding, preceding.tail)
            and len(_authored_names(preceding)) == 1
            and bool(href.partition("#")[2])
            and not _semantic_tokens(element) & {"noteref", "doc-noteref"}
            and _printed_return_label(printed := _element_text(element)) is not None
            and (
                _is_sup_marker(element)
                or (
                    (symbol := _short_note_label(printed)) is not None
                    and not symbol.isdecimal()
                    and isinstance(parent, HtmlElement)
                    and parent.tag in {"p", "em", "i"}
                    and (paragraph := next(element.iterancestors("p"), None)) is not None
                    and not _leading_note_link(element, paragraph)
                )
            )
        ):
            return preceding
        if (
            isinstance(parent, HtmlElement)
            and parent.tag in {"span", "small"}
            and _authored_names(parent)
            and len(parent) == 1
            and not (parent.text or "").strip()
            and not (element.tail or "").strip()
            and _is_sup_marker(element)
            and _printed_return_label(_element_text(element)) is not None
            and not _semantic_tokens(element) & {"noteref", "doc-noteref"}
        ):
            return parent
        if (
            _is_sup_marker(element)
            and _printed_return_label(_element_text(element)) is not None
            and not _semantic_tokens(element) & {"noteref", "doc-noteref"}
        ):
            names = [
                child
                for child in element.iterdescendants()
                if isinstance(child, HtmlElement)
                and child.tag in {"span", "small"}
                and _authored_names(child)
                and _element_text(child) == _element_text(element)
            ]
            if len(names) == 1:
                return names[0]
        if (
            href
            and "#" not in href
            and _semantic_tokens(element) & {"noteref", "doc-noteref"}
            and isinstance(preceding, HtmlElement)
            and preceding.tag == "span"
            and _authored_names(preceding)
            and len(preceding) == 0
            and not (preceding.text or "").strip()
            and not (preceding.tail or "").strip()
        ):
            return preceding
    return None


def _parent_tag(element: HtmlElement) -> str | None:
    parent = element.getparent()
    return str(parent.tag).lower() if isinstance(parent, HtmlElement) else None


def _preceding_element_count(element: HtmlElement) -> int:
    return sum(
        1 for sibling in element.itersiblings(preceding=True) if isinstance(sibling, HtmlElement)
    )


def _source_order_key(element: HtmlElement, fallback: int) -> str:
    order = _preceding_element_count(element)
    for ancestor in element.iterancestors():
        order += 1 + _preceding_element_count(ancestor)
    return f"{order:06d}.{fallback:06d}"


def _fragment_html(root: HtmlElement) -> str:
    # A parsed document is rooted at `body`; anything else is already a fragment.
    if str(root.tag).lower() == "body":
        return inner_html(root)
    return serialize_html(root)


def _object_dict(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items()}
