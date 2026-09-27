"""Source-authored apparatus extraction from web/EPUB HTML, and its anchoring.

Runs on untrusted source HTML *before* sanitisation: every inbound
``data-reader-apparatus-*`` attribute is stripped, then this module re-applies its
own on the marker and target elements it recognises, and ``sanitize_html`` keeps
exactly those three.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import OrderedDict
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypedDict
from urllib.parse import unquote, urlsplit
from uuid import UUID

from lxml.etree import ParserError
from lxml.html import HtmlElement

from nexus.errors import ResourceFailureDimension
from nexus.schemas.media import NavigationTextPointOut, NavigationTextRangeOut
from nexus.schemas.presence import Present, absent, present
from nexus.schemas.reader_apparatus import NotesGroup
from nexus.services.canonicalize import (
    HEADING_TAGS,
    STRUCTURAL_TAGS,
    canonicalize_structure,
    generate_canonical_text,
)
from nexus.services.html_tree import inner_html, parse_html_document, serialize_html
from nexus.services.parser_temp import nested_utf8_byte_length, utf8_byte_length
from nexus.services.reader_apparatus import stable_token
from nexus.text import normalize_whitespace

_ENDNOTE_TOKENS = frozenset({"endnote", "endnotes", "doc-endnote", "doc-endnotes"})
_FOOTNOTE_TOKENS = frozenset({"footnote", "doc-footnote"})
_BIBLIOGRAPHY_TOKENS = frozenset(
    {"bibliography", "biblioentry", "doc-bibliography", "doc-biblioentry"}
)
_BIBLIOGRAPHY_TAGS = frozenset(
    {"ref", "ref-list", "d-citation-list", "d-bibliography", "dt-bibliography"}
)
_BIBLIOGRAPHY_CONTAINER_TAGS = frozenset({"d-citation-list", "d-bibliography", "dt-bibliography"})
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


class HtmlApparatusTargetLimitExceeded(Exception):
    """The cross-document target index exceeded its parser budget.

    Every cap bounds the index this extraction emits rather than the document's own
    shape, so each declares ``Output``.
    """

    def __init__(self, message: str, *, dimension: ResourceFailureDimension) -> None:
        super().__init__(message)
        self.dimension: ResourceFailureDimension = dimension


class HtmlApparatusAmbiguousMarker(ValueError):
    """A source backlink names more than one authored location."""


@dataclass(frozen=True, slots=True)
class _TargetContext:
    """Where a link target sits: by declared semantics, and by looser evidence."""

    semantic: str | None  # "note" | "endnote" | "bibliography"
    loose: str | None  # "note" | "endnote" | "bibliography"


@dataclass(frozen=True, slots=True)
class _TargetFacts:
    context: _TargetContext
    is_bibliography_entry: bool
    has_backlink: bool
    method: str
    confidence: str
    loose_method: str


@dataclass(frozen=True, slots=True)
class _Classified:
    marker_kind: str
    target_kind: str
    relation: str
    method: str
    confidence: str


def extract_html_apparatus(
    html: str | bytes,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    document_href: str | None = None,
    external_targets: Mapping[str, Mapping[str, object]] | None = None,
    confirmed_target_refs: set[str] | None = None,
    verified_source_markers: Mapping[str, Mapping[str, object]] | None = None,
) -> tuple[str, list[dict[str, object]], list[dict[str, object]]]:
    """Stamp the apparatus this document carries and return it as items and edges."""
    if not html.strip():
        return _html_string(html), [], []
    try:
        doc = parse_html_document(html)
    except ParserError:
        return _html_string(html), [], []
    body = doc.body
    root = body if body is not None else doc
    published_markers: dict[HtmlElement, Mapping[str, object]] = {}
    seen_marker_keys: set[str] = set()
    for element in root.iter():
        if isinstance(element, HtmlElement):
            stamped_key = (element.get("data-reader-apparatus-item-id") or "").strip()
            if verified_source_markers is not None and stamped_key in verified_source_markers:
                if stamped_key in seen_marker_keys:
                    raise ValueError("Retained EPUB repeats a verified source marker identity")
                source_marker = verified_source_markers[stamped_key]
                if element.get("data-reader-apparatus-kind") != source_marker.get(
                    "kind"
                ) or element.get("data-reader-apparatus-confidence") != source_marker.get(
                    "confidence"
                ):
                    raise ValueError("Retained EPUB marker stamp disagrees with verified source")
                published_markers[element] = source_marker
                seen_marker_keys.add(stamped_key)
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
    external_targets = external_targets or {}
    if confirmed_target_refs is None and document_href:
        confirmed_target_refs = confirm_html_apparatus_target_refs(
            html, document_href=document_href, external_targets=external_targets
        )

    source_ref = {
        **source_ref,
        "artifact_digest": hashlib.sha256(_html_string(html).encode()).hexdigest(),
    }
    verified_by_link: dict[tuple[str, str, str | None], list[Mapping[str, object]]] = {}
    if verified_source_markers is not None:
        for marker in verified_source_markers.values():
            marker_source = _object_dict(marker.get("source_ref"))
            target_ref = marker_source.get("target_ref")
            label = marker.get("label")
            if isinstance(target_ref, str) and isinstance(label, str):
                marker_id = marker_source.get("marker_id")
                verified_by_link.setdefault(
                    (target_ref, label, marker_id if isinstance(marker_id, str) else None), []
                ).append(marker)
    _extract_standalone_margin_notes(
        root, source_kind=source_kind, source_ref=source_ref, items=items
    )
    _materialize_external_targets_in_document(
        targets=targets,
        external_targets=external_targets,
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
                candidates.append((element, rid, f"{document_href}#{rid}"))
        else:
            href = _canonical_target_ref(_target_ref(element) or "", document_href)
            candidates.append((element, _local_target_id(element, document_href), href))
    marker_keys: set[str] = set()
    matched_marker_keys: set[str] = set()
    ordinal = 0
    for element, target_id, target_ref in candidates:
        target = targets.get(target_id) if target_id else None
        if target in note_containers:
            continue
        if target is not None and _is_inline_note_marker(target):
            continue
        external_target = external_targets.get(target_ref)
        if target is None and external_target is None:
            continue
        facts = _target_facts(element, target, external_target, document_href, ancestor_prefixes)
        classified = _classify(element, facts)
        source_marker = published_markers.get(element)
        if source_marker is None and verified_source_markers is not None:
            matches = verified_by_link.get(
                (target_ref, _element_text(element), _source_element_id(element)), []
            )
            if len(matches) > 1:
                identity = _source_identity(element, root, document_href, source_ref)
                matches = (
                    [
                        marker
                        for marker in matches
                        if _object_dict(_object_dict(marker.get("source_ref")).get("identity")).get(
                            "address"
                        )
                        == identity.get("address")
                    ]
                    if identity.get("kind") == "Anonymous"
                    else []
                )
            if len(matches) > 1:
                raise ValueError("Retained EPUB has ambiguous source marker correspondence")
            source_marker = matches[0] if matches else None
        if source_marker is not None:
            marker_source = source_marker.get("source_ref")
            confidence = str(source_marker.get("confidence") or "")
            context = facts.context.semantic if confidence == "exact" else facts.context.loose
            corroborated = _classified(
                context, str(source_marker.get("extraction_method") or ""), confidence
            )
            if (
                corroborated is None
                and confidence == "exact"
                and facts.context.semantic is None
                and facts.has_backlink
                and source_marker.get("extraction_method") == "html_semantic"
                and target is not None
                and external_target is not None
                and external_target.get("confidence") == "exact"
                and external_target.get("target_id") == (target.get("id") or target.get("name"))
                and _element_text(_note_body_element(target)) == external_target.get("body_text")
            ):
                corroborated = _classified(
                    str(external_target.get("context") or ""), "html_semantic", "exact"
                )
            if (
                not isinstance(marker_source, dict)
                or marker_source.get("target_ref") != target_ref
                or source_marker.get("label") != _element_text(element)
                or (
                    marker_source.get("marker_id") is not None
                    and marker_source["marker_id"] != _source_element_id(element)
                )
                or corroborated is None
                or corroborated.marker_kind != source_marker.get("kind")
                or (confidence != "exact" and not facts.has_backlink)
                or (classified is not None and classified.marker_kind != corroborated.marker_kind)
            ):
                raise ValueError("Retained EPUB marker disagrees with verified source semantics")
            classified = corroborated
        if classified is None:
            continue

        marker_text = _element_text(element)
        target_body = _note_body_element(target) if target is not None else None
        target_text = (
            str(external_target.get("body_text") or "")
            if external_target is not None
            else _element_text(target_body if target_body is not None else target)
            if target is not None
            else ""
        )
        if not marker_text or (
            not target_text
            and not (target is not None and target.xpath(".//img|.//svg"))
            and not (external_target or {}).get("_body_html")
        ):
            continue

        target_source_ref: dict[str, object] = {**source_ref, "target_id": target_id}
        marker_source_ref: dict[str, object] = dict(target_source_ref)
        if external_target is not None:
            target_source_ref = _object_dict(external_target.get("source_ref") or target_source_ref)
            marker_source_ref = {
                **source_ref,
                "target_ref": external_target.get("target_ref"),
                "target_id": external_target.get("target_id"),
            }
        if str(element.tag).lower() == "xref":
            marker_source_ref["target_ids"] = list(
                dict.fromkeys((element.get("rid") or "").split())
            )
        marker_id = _source_element_id(element)
        if marker_id:
            marker_source_ref["marker_id"] = marker_id
        verified_identity = (
            _object_dict(source_marker.get("source_ref")).get("identity")
            if source_marker is not None
            else None
        )
        marker_source_ref["identity"] = verified_identity or _source_identity(
            element, root, document_href, source_ref
        )
        marker_key = (
            str(source_marker["stable_key"])
            if source_marker is not None
            else f"{source_kind}:ref:{hashlib.sha256(json.dumps(marker_source_ref['identity'], sort_keys=True).encode()).hexdigest()[:32]}"
        )
        if source_marker is not None:
            if marker_key in matched_marker_keys:
                raise ValueError("Retained EPUB repeats a verified source marker identity")
            matched_marker_keys.add(marker_key)

        target_key = target_item_key_by_id.get(target_id or "")
        if target_key is None:
            if external_target is not None and target is None:
                target_key = str(external_target["stable_key"])
            else:
                target_key = f"{source_kind}:target:{target_id}"
                items.append(
                    {
                        "stable_key": target_key,
                        "kind": classified.target_kind,
                        "label": _target_label(target_text),
                        "body_text": target_text,
                        "_body_html": inner_html(target) if target is not None else None,
                        "confidence": classified.confidence,
                        "extraction_method": classified.method,
                        "source_ref": target_source_ref,
                        "sort_key": str(
                            (external_target or {}).get("sort_key") or f"{ordinal:06d}.target"
                        ),
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

    if (
        verified_source_markers is not None
        and matched_marker_keys != verified_source_markers.keys()
    ):
        raise ValueError("Retained EPUB omits a verified source marker")
    if document_href:
        for item in items:
            source = item.get("source_ref")
            target_id = source.get("target_id") if isinstance(source, dict) else None
            target = targets.get(target_id) if isinstance(target_id, str) else None
            if target is not None and is_empty_apparatus_return_body(
                root, target, item.get("label"), document_href, authored_targets=targets
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


def is_empty_apparatus_return_body(
    root: HtmlElement,
    target: HtmlElement,
    label: object,
    document_href: str,
    *,
    authored_targets: Mapping[str, HtmlElement] | None = None,
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
    authored = authored_targets if authored_targets is not None else _unique_authored_targets(root)
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


def collect_html_apparatus_targets(
    html: str | bytes,
    *,
    document_href: str,
    source_kind: str,
    source_ref: dict[str, object],
    max_targets: int,
    max_backlinks: int,
    max_retained_utf8_bytes: int,
    extraction_method: str = "html_semantic",
    marker_backlinks: Mapping[str, set[str]] | None = None,
) -> tuple[dict[str, dict[str, object]], int, int, int]:
    """Index one document's note/bibliography targets so other documents can cite them."""
    if max_targets < 0 or max_backlinks < 0 or max_retained_utf8_bytes < 0:
        raise ValueError("HTML apparatus target budgets cannot be negative")
    if not html.strip():
        return {}, 0, 0, 0
    try:
        doc = parse_html_document(html)
    except ParserError:
        return {}, 0, 0, 0
    body = doc.body
    root = body if body is not None else doc
    text = _bounded_element_text()
    targets: dict[str, dict[str, object]] = {}
    ancestor_prefixes: dict[HtmlElement, str] = {}
    note_containers = _nested_declared_note_containers(root, ancestor_prefixes)
    unique_names = _unique_authored_targets(root)
    aliases_by_element: dict[HtmlElement, set[str]] = {}
    for name, element in unique_names.items():
        aliases_by_element.setdefault(element, set()).add(name)
    ordinal = 0
    retained_count = 0
    retained_utf8_bytes = 0
    backlink_count = 0
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        aliases = aliases_by_element.get(element, set())
        if not aliases:
            continue
        reciprocal_aliases = sorted(
            alias
            for alias in aliases
            if marker_backlinks and marker_backlinks.get(f"{document_href}#{alias}")
        )
        if len(reciprocal_aliases) > 1:
            raise HtmlApparatusAmbiguousMarker("EPUB target has multiple reciprocal authored names")
        target_id = (
            reciprocal_aliases[0]
            if reciprocal_aliases
            else (
                (element.get("id") or "").strip()
                if (element.get("id") or "").strip() in aliases
                else sorted(aliases)[0]
            )
        )
        if element in note_containers:
            continue
        facts = _target_context(element, ancestor_prefixes, text)
        body = _note_body_element(element)
        target_ref = f"{document_href}#{target_id}"
        reciprocal_marker = bool(marker_backlinks and marker_backlinks.get(target_ref))
        boundary = (
            _untyped_note_body(element, text)
            if source_ref.get("format") == "xhtml"
            and facts.semantic is None
            and (facts.loose != "bibliography" or reciprocal_marker)
            else None
        )
        inferred_note = (
            facts.semantic is None
            and (facts.loose != "bibliography" or reciprocal_marker)
            and _looks_like_note_body(body, text)
        )
        context = "note" if boundary is not None or inferred_note else facts.semantic or facts.loose
        if context not in {"note", "endnote", "bibliography"}:
            continue
        if (
            boundary is None
            and context in {"note", "endnote"}
            and not (
                _is_note_body_target(element)
                or inferred_note
                or (facts.loose and str(element.tag).lower() == "li")
            )
        ):
            continue
        if context == "bibliography" and not _is_bibliography_entry_target(
            element, ancestor_prefixes
        ):
            continue
        body_element = boundary if boundary is not None else body if inferred_note else element
        body_html = (
            _inferred_note_html(boundary, text) if boundary is not None else inner_html(element)
        )
        if boundary is None and inferred_note:
            body_html = inner_html(body)
        body_text = (
            generate_canonical_text(body_html) if body_html is not None else text(body_element)
        )
        if not body_text and not element.xpath(".//img|.//svg"):
            continue
        allowed_hrefs = (
            marker_backlinks.get(target_ref, set()) if marker_backlinks is not None else None
        )
        backlinks = _link_hrefs(
            body_element,
            max_count=max_backlinks - backlink_count,
            allowed_hrefs=allowed_hrefs if facts.semantic is None else None,
        )
        candidate_ordinal = ordinal
        ordinal += 1
        if facts.semantic is None and marker_backlinks is not None and not backlinks:
            continue
        if retained_count >= max_targets:
            raise HtmlApparatusTargetLimitExceeded(
                "HTML apparatus target count exceeded", dimension="Output"
            )
        backlinks = [document_href + href if href.startswith("#") else href for href in backlinks]
        backlink_count += len(backlinks)
        target = {
            "target_ref": target_ref,
            "target_href": document_href,
            "target_id": target_id,
            "context": context or "note",
            "kind": _target_kind_for_context(context or "note"),
            "label": _target_label(body_text),
            "body_text": body_text,
            "_body_html": body_html,
            "confidence": "exact" if facts.semantic and boundary is None else "strong",
            "extraction_method": "html_note_boundary"
            if boundary is not None
            else extraction_method
            if facts.semantic
            else "html_link_graph",
            "source_ref": {**source_ref, "target_href": document_href, "target_id": target_id},
            "sort_key": f"{_source_order_key(element, candidate_ordinal)}.target",
            "stable_key": f"{source_kind}:target:{stable_token(target_ref)}",
            "backlinks": backlinks,
        }
        retained_utf8_bytes += nested_utf8_byte_length(target)
        if retained_utf8_bytes > max_retained_utf8_bytes:
            raise HtmlApparatusTargetLimitExceeded(
                "HTML apparatus target text exceeded", dimension="Output"
            )
        targets[target_ref] = target
        retained_count += 1
    return targets, retained_count, retained_utf8_bytes, backlink_count


def collect_html_apparatus_candidate_backlinks(
    html: str | bytes,
    *,
    document_href: str,
    record_candidate: Callable[[str, Iterator[str]], None],
) -> None:
    """Spill possible target backlinks before applying the retained-target budget."""
    if not html.strip():
        return
    try:
        doc = parse_html_document(html)
    except ParserError:
        return
    root = doc.body if doc.body is not None else doc
    text = _bounded_element_text()
    prefixes: dict[HtmlElement, str] = {}
    note_containers = _nested_declared_note_containers(root, prefixes)
    unique_names = _unique_authored_targets(root)
    aliases_by_element: dict[HtmlElement, set[str]] = {}
    for name, element in unique_names.items():
        aliases_by_element.setdefault(element, set()).add(name)
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        aliases = aliases_by_element.get(element)
        if not aliases or element in note_containers:
            continue
        facts = _target_context(element, prefixes, text)
        body = _note_body_element(element)
        boundary = _untyped_note_body(element, text) if facts.semantic is None else None
        inferred = facts.semantic is None and _looks_like_note_body(body, text)
        context = "note" if boundary is not None or inferred else facts.semantic or facts.loose
        if context not in {"note", "endnote", "bibliography"}:
            continue
        if (
            boundary is None
            and context in {"note", "endnote"}
            and not (
                _is_note_body_target(element)
                or inferred
                or (facts.loose and str(element.tag).lower() == "li")
            )
        ):
            continue
        if context == "bibliography" and not _is_bibliography_entry_target(element, prefixes):
            continue
        backlink_root = boundary if boundary is not None else body if inferred else element
        backlinks = [
            unquote((link.get("href") or "").strip())
            for link in backlink_root.iter()
            if isinstance(link, HtmlElement)
            and str(link.tag).lower() == "a"
            and (link.get("href") or "").strip()
        ]
        for target_id in aliases:
            record_candidate(f"{document_href}#{target_id}", iter(backlinks))


def collect_html_apparatus_marker_backlinks(
    html: str | bytes,
    *,
    document_href: str,
    target_hrefs: set[str],
    candidate_backlink_exists: Callable[[str, str, str], bool],
    marker_backlinks: dict[str, set[str]],
    max_markers: int,
    max_retained_utf8_bytes: int,
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
    count = 0
    retained_bytes = 0
    for marker in doc.iter():
        if not isinstance(marker, HtmlElement):
            continue
        ref, marker_id = _target_ref(marker), _source_element_id(marker)
        if not ref or not marker_id:
            continue
        tokens = _semantic_tokens(marker)
        explicit = (
            "noteref" in tokens
            or "doc-noteref" in tokens
            or "biblioref" in tokens
            or "doc-biblioref" in tokens
            or (marker.get("ref-type") or "").strip().lower() in {"fn", "bibr"}
        )
        numeric_sup = (
            str(marker.tag).lower() == "a" and _numeric_marker(marker) and _is_sup_marker(marker)
        )
        if not explicit and not numeric_sup:
            continue
        if _is_ignored_margin_note_context(marker) or any(
            isinstance(a, HtmlElement) and str(a.tag).lower() in HEADING_TAGS
            for a in marker.iterancestors()
        ):
            continue
        target_ref = _canonical_target_ref(ref, document_href)
        target_href, sep, target_id = target_ref.partition("#")
        if not sep or not target_id or target_href not in target_hrefs:
            continue
        if not candidate_backlink_exists(target_ref, marker_id, document_href):
            continue
        if source_ids.get(marker_id) is not _source_element_id_owner(marker):
            raise HtmlApparatusAmbiguousMarker(
                "EPUB apparatus backlink names a repeated source marker id"
            )
        hrefs = {f"{document_href}#{marker_id}"}
        if target_href == document_href:
            hrefs.add(f"#{marker_id}")
        existing = marker_backlinks.get(target_ref, set())
        new_hrefs = hrefs - existing
        if not new_hrefs:
            continue
        if count >= max_markers:
            raise HtmlApparatusTargetLimitExceeded(
                "HTML apparatus marker count exceeded", dimension="Output"
            )
        added_bytes = sum(utf8_byte_length(href) for href in new_hrefs)
        if not existing:
            added_bytes += utf8_byte_length(target_ref)
        if retained_bytes + added_bytes > max_retained_utf8_bytes:
            raise HtmlApparatusTargetLimitExceeded(
                "HTML apparatus marker text exceeded", dimension="Output"
            )
        marker_backlinks.setdefault(target_ref, set()).update(new_hrefs)
        count += 1
        retained_bytes += added_bytes
    return count, retained_bytes


def confirm_html_apparatus_target_refs(
    html: str | bytes,
    *,
    document_href: str,
    external_targets: Mapping[str, Mapping[str, object]],
) -> set[str]:
    """Confirm inferred targets from actual reciprocal source markers."""
    if not html.strip():
        return set()
    try:
        doc = parse_html_document(html)
    except ParserError:
        return set()
    confirmed: set[str] = set()
    ancestor_prefixes: dict[HtmlElement, str] = {}
    for marker in doc.iter():
        if not isinstance(marker, HtmlElement):
            continue
        ref = _target_ref(marker)
        if not ref:
            continue
        target_ref = _canonical_target_ref(ref, document_href)
        target = external_targets.get(target_ref)
        if target is None or str(target.get("confidence")) != "strong":
            continue
        facts = _target_facts(marker, None, target, document_href, ancestor_prefixes)
        if facts.has_backlink and _classify(marker, facts) is not None:
            confirmed.add(target_ref)
    return confirmed


def attach_fragment_locators(
    *,
    media_id: UUID,
    fragment_id: UUID,
    media_kind: str,
    canonical_text: str,
    items: list[dict[str, object]],
    html_sanitized: str | None = None,
) -> list[dict[str, object]]:
    """Give each item an exact canonical-text offset span, or no locator at all.

    A source element span is accepted only when canonicalization reproduces the
    stored text exactly, or when the item's text occurs exactly once in it.
    """
    locator_text_by_key = _apparatus_locator_texts(html_sanitized)
    locator_span_by_key = _apparatus_locator_spans(html_sanitized, canonical_text)
    result: list[dict[str, object]] = []
    for item in items:
        item = dict(item)
        stable_key = str(item["stable_key"])
        locator_text = locator_text_by_key.get(stable_key) or str(
            item.pop("_locator_text", "") or ""
        )
        span_with_text = locator_span_by_key.get(stable_key)
        if span_with_text is not None:
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


def derive_fragment_note_groups(
    html_sanitized: str,
    canonical_text: str,
    fragment_id: UUID,
    *,
    source_html: str | None = None,
) -> list[NotesGroup]:
    """Bound a governed collection only when repeated note bodies corroborate it."""
    structure = canonicalize_structure(html_sanitized)
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
                if len(matches) != 1 or not isinstance(matches[0].parent_container, Present):
                    continue
                index = matches[0].parent_container.value
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
                        present(
                            NavigationTextPointOut(
                                fragment_id=fragment_id, offset=heading.start_offset
                            )
                        )
                        if heading is not None
                        else absent()
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
        (start, end)
        for key, (start, end, _text) in _apparatus_locator_spans(
            html_sanitized, canonical_text
        ).items()
        if ":target:" in key or ":html-margin-note:" in key
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
                heading=present(start_point),
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
        if isinstance(ancestor, HtmlElement) and ancestor in body_set
    }


def _is_ignored_margin_note_context(element: HtmlElement) -> bool:
    for node in [element, *element.iterancestors()]:
        if not isinstance(node, HtmlElement):
            continue
        if str(node.tag).lower() in {"script", "style", "template", "nav", "header", "footer"}:
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
    external_targets: Mapping[str, Mapping[str, object]],
    confirmed_target_refs: set[str],
    document_href: str | None,
    target_item_key_by_id: dict[str, str],
    items: list[dict[str, object]],
) -> None:
    """Adopt the index entries that live in this very document, keeping their keys."""
    if not document_href:
        return
    prefix = f"{document_href}#"
    for target_ref, external_target in external_targets.items():
        if not target_ref.startswith(prefix):
            continue
        if (
            str(external_target.get("confidence")) == "strong"
            and target_ref not in confirmed_target_refs
        ):
            continue
        target_id = target_ref[len(prefix) :]
        target = targets.get(target_id)
        if target is None or target_id in target_item_key_by_id:
            continue
        if external_target.get("extraction_method") == "html_note_boundary":
            recovered = _untyped_note_body(target)
            if recovered is None:
                continue
            target = recovered
        body = _note_body_element(target)
        body_text = _element_text(body)
        if not body_text:
            continue
        target_key = str(external_target["stable_key"])
        kind = str(external_target["kind"])
        confidence = str(external_target["confidence"])
        _stamp(body, target_key, kind, confidence)
        target_item_key_by_id[target_id] = target_key
        items.append(
            {
                "stable_key": target_key,
                "kind": kind,
                "label": _target_label(body_text),
                "body_text": body_text,
                "_body_html": inner_html(body),
                "confidence": confidence,
                "extraction_method": str(external_target["extraction_method"]),
                "source_ref": _object_dict(external_target.get("source_ref")),
                "sort_key": str(external_target["sort_key"]),
                "_locator_text": body_text,
            }
        )


def _target_facts(
    marker: HtmlElement,
    target: HtmlElement | None,
    external_target: Mapping[str, object] | None,
    document_href: str | None,
    ancestor_prefixes: dict[HtmlElement, str],
) -> _TargetFacts:
    if (
        target is not None
        and (external_target or {}).get("extraction_method") != "html_note_boundary"
    ):
        body = _note_body_element(target)
        context = _target_context(target, ancestor_prefixes)
        if context.loose is None and _looks_like_note_body(body):
            context = _TargetContext(semantic=None, loose="note")
        return _TargetFacts(
            context=context,
            is_bibliography_entry=_is_bibliography_entry_target(target, ancestor_prefixes),
            has_backlink=_has_backlink(marker, body, document_href),
            method="html_semantic",
            confidence="exact",
            loose_method="html_link_graph",
        )
    external_target = external_target or {}
    context = str(external_target.get("context") or "") or None
    method = str(external_target.get("extraction_method") or "html_semantic")
    return _TargetFacts(
        context=_TargetContext(semantic=context, loose=context),
        is_bibliography_entry=True,
        has_backlink=_external_target_has_backlink(marker, external_target, document_href),
        method=method,
        confidence=str(external_target.get("confidence") or "exact"),
        loose_method=method,
    )


def _classify(marker: HtmlElement, facts: _TargetFacts) -> _Classified | None:
    """The target's context fixes the kinds; how it was recognised fixes the confidence."""

    def declared(context: str | None) -> _Classified | None:
        return _classified(context, facts.method, facts.confidence)

    def inferred(context: str | None) -> _Classified | None:
        return _classified(context, facts.loose_method, "strong")

    tokens = _semantic_tokens(marker)
    ref_type = (marker.get("ref-type") or "").strip().lower()
    semantic = facts.context.semantic
    loose = facts.context.loose
    inferred_marker = not _is_ignored_margin_note_context(marker) and not any(
        isinstance(ancestor, HtmlElement) and str(ancestor.tag).lower() in HEADING_TAGS
        for ancestor in marker.iterancestors()
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
        and facts.method == "html_note_boundary"
        and facts.has_backlink
        and _is_inline_note_marker(marker)
    ):
        return inferred(loose)
    if (
        inferred_marker
        and str(marker.tag).lower() == "a"
        and _numeric_marker(marker)
        and _is_sup_marker(marker)
    ):
        if loose in ("note", "endnote") and facts.has_backlink:
            return inferred(loose)
        if loose == "bibliography" and facts.is_bibliography_entry:
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
) -> _TargetContext:
    """Walk the target's ancestry once, recording the first declared and loose hit."""
    semantic: str | None = None
    loose: str | None = None
    for element in [target, *target.iterancestors()]:
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        tokens = _semantic_tokens(element)
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


def _has_backlink(marker: HtmlElement, target: HtmlElement, document_href: str | None) -> bool:
    marker_id = _source_element_id(marker)
    if not marker_id:
        return False
    for element in target.iter():
        if not isinstance(element, HtmlElement) or str(element.tag).lower() != "a":
            continue
        if _local_target_id(element, document_href) == marker_id:
            return True
    return False


def _external_target_has_backlink(
    marker: HtmlElement, target: Mapping[str, object], document_href: str | None
) -> bool:
    marker_id = _source_element_id(marker)
    backlinks = target.get("backlinks")
    if not marker_id or not document_href or not isinstance(backlinks, list):
        return False
    return bool(
        {f"{document_href}#{marker_id}", f"#{marker_id}"}
        & {unquote(str(href)) for href in backlinks}
    )


def _untyped_note_body(
    anchor: HtmlElement, text: Callable[[HtmlElement], str] | None = None
) -> HtmlElement | None:
    """A leading backlink and prose in one paragraph; reciprocity is checked separately."""
    if str(anchor.tag).lower() != "a":
        return None
    paragraph = next(anchor.iterancestors("p"), None)
    if paragraph is None:
        return None
    links = paragraph.xpath(".//a[@href]")
    if not links:
        return None
    element_text = text or _element_text
    label = element_text(links[0]).strip()
    body_text = element_text(paragraph)
    if not re.fullmatch(r"\[?\d{1,4}\]?", label) or not body_text.startswith(label):
        return None
    if not body_text[len(label) :].strip(". \t\n") and not paragraph.xpath(".//img|.//svg"):
        return None
    anchors = paragraph.xpath(".//a[@id or @name]")
    return paragraph if anchors and anchors[0] is anchor else None


def _inferred_note_html(
    paragraph: HtmlElement, text: Callable[[HtmlElement], str] | None = None
) -> str | None:
    """Keep continuation paragraphs up to the next note, heading or container end.

    A different intervening structure has no proven boundary: retain navigation,
    but do not call the leading paragraph the complete body.
    """
    parts = [serialize_html(paragraph)]
    for sibling in paragraph.itersiblings():
        if not isinstance(sibling, HtmlElement):
            continue
        tag = str(sibling.tag).lower()
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6", "hr"}:
            break
        if any(
            _untyped_note_body(anchor, text) is not None
            for anchor in sibling.xpath(".//a[@id or @name]")
        ):
            break
        if tag != "p":
            return None
        parts.append(serialize_html(sibling))
    return "".join(parts)


def _is_inline_note_marker(marker: HtmlElement) -> bool:
    if not (marker.xpath(".//sup") or _parent_tag(marker) == "sup"):
        return False
    paragraph = next(marker.iterancestors("p"), None)
    if paragraph is None:
        return False
    text, label = _element_text(paragraph), _element_text(marker)
    return len(text.split()) >= 8 and not text.startswith(label)


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
    if str(target.tag).lower() in {"li", "aside", "fn", "footnote"}:
        return True
    return bool(tokens & {"footnote", "doc-footnote", "endnote", "doc-endnote"})


def _note_body_element(target: HtmlElement) -> HtmlElement:
    """Use the smallest prose container for an anchor that only names a note."""
    if str(target.tag).lower() in {"li", "aside", "fn", "footnote"}:
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
    if str(parent.tag).lower() in {"p", "li"}:
        return parent
    grandparent = parent.getparent()
    if isinstance(grandparent, HtmlElement) and str(grandparent.tag).lower() in {"p", "li"}:
        return grandparent
    return target


def _numeric_marker(element: HtmlElement, text: Callable[[HtmlElement], str] | None = None) -> bool:
    return bool(re.fullmatch(r"\[?\d+\]?", (text or _element_text)(element)))


def _is_sup_marker(element: HtmlElement) -> bool:
    return _parent_tag(element) == "sup" or any(
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
        if text_value.startswith(marker) and re.search(r"\w", text_value[len(marker) :]):
            return True
    return False


def _target_kind_for_context(context: str) -> str:
    if context == "endnote":
        return "endnote"
    if context == "bibliography":
        return "bibliography_entry"
    return "footnote"


def _apparatus_locator_spans(
    html_sanitized: str | None, canonical_text: str
) -> dict[str, tuple[int, int, str]]:
    """Use the canonicalizer's exact element boundaries without modifying source text."""
    if not html_sanitized or not html_sanitized.strip() or not canonical_text:
        return {}
    try:
        structure = canonicalize_structure(html_sanitized)
    except ParserError:
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
        target, source = urlsplit(href), urlsplit(document_href)
        if target.fragment and target._replace(fragment="") == source._replace(fragment=""):
            return unquote(target.fragment)
    return None


def _target_ref(element: HtmlElement) -> str | None:
    if str(element.tag).lower() == "xref":
        return (element.get("rid") or "").strip() or None
    return (element.get("href") or "").strip() or None


def _canonical_target_ref(href: str, document_href: str | None) -> str:
    raw = f"{document_href}{href}" if href.startswith("#") and document_href else href
    path, separator, fragment = raw.partition("#")
    return f"{path}#{unquote(fragment)}" if separator else raw


def _link_hrefs(
    element: HtmlElement, *, max_count: int, allowed_hrefs: set[str] | None = None
) -> list[str]:
    hrefs: list[str] = []
    for descendant in element.iter():
        if not isinstance(descendant, HtmlElement) or str(descendant.tag).lower() != "a":
            continue
        href = (descendant.get("href") or "").strip()
        if not href:
            continue
        if allowed_hrefs is not None and unquote(href) not in allowed_hrefs:
            continue
        if len(hrefs) >= max_count:
            raise HtmlApparatusTargetLimitExceeded(
                "HTML apparatus backlink count exceeded", dimension="Output"
            )
        hrefs.append(href)
    return hrefs


def _semantic_tokens(element: HtmlElement) -> set[str]:
    values = [
        element.get("role") or "",
        element.get("epub:type") or "",
        element.get("{http://www.idpf.org/2007/ops}type") or "",
        element.get("type") or "",
    ]
    return {part.strip().lower() for value in values for part in value.split() if part.strip()}


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
    first = text_value.split(maxsplit=1)[0] if text_value.split() else ""
    # A leading marker is an authored label. The first prose word (including
    # a trailing backlink after an image) is not a note's name.
    return first if re.fullmatch(r"(?:\[\d{1,4}\]|\d{1,4}[.)]?|[*†‡§]+)", first) else None


def _source_element_id(element: HtmlElement) -> str | None:
    owner = _source_element_id_owner(element)
    value = (owner.get("id") or owner.get("name") or "").strip() if owner is not None else ""
    return value or None


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
        sibling = element.getprevious()
        if (
            isinstance(sibling, HtmlElement)
            and str(sibling.tag).lower() == "a"
            and not (sibling.get("href") or "").strip()
            and not _element_text(sibling)
            and not (sibling.tail or "").strip()
        ):
            sibling_id = (sibling.get("id") or sibling.get("name") or "").strip()
            if sibling_id:
                return sibling
        previous = parent.getprevious()
        if (
            isinstance(previous, HtmlElement)
            and str(previous.tag).lower() == "a"
            and not (previous.get("href") or "").strip()
            and not _element_text(previous)
            and not (previous.tail or "").strip()
        ):
            return previous if (previous.get("id") or previous.get("name") or "").strip() else None
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


def _html_string(html: str | bytes) -> str:
    if isinstance(html, bytes):
        return html.decode("utf-8", errors="replace")
    return html


def _fragment_html(root: HtmlElement) -> str:
    # A parsed document is rooted at `body`; anything else is already a fragment.
    if str(root.tag).lower() == "body":
        return inner_html(root)
    return serialize_html(root)


def _object_dict(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items()}
