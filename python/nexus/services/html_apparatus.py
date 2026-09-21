"""Source-authored apparatus extraction from web/EPUB HTML, and its anchoring.

Runs on untrusted source HTML *before* sanitisation: every inbound
``data-reader-apparatus-*`` attribute is stripped, then this module re-applies its
own on the marker and target elements it recognises, and ``sanitize_html`` keeps
exactly those three.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote
from uuid import UUID

from lxml.etree import ParserError
from lxml.html import HtmlElement

from nexus.errors import ResourceFailureDimension
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.html_tree import inner_html, parse_html_document, serialize_html
from nexus.services.parser_temp import nested_utf8_byte_length
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


class HtmlApparatusTargetLimitExceeded(Exception):
    """The cross-document target index exceeded its parser budget.

    Every cap bounds the index this extraction emits rather than the document's own
    shape, so each declares ``Output``.
    """

    def __init__(self, message: str, *, dimension: ResourceFailureDimension) -> None:
        super().__init__(message)
        self.dimension: ResourceFailureDimension = dimension


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
    for element in root.iter():
        if isinstance(element, HtmlElement):
            for attr in list(element.attrib):
                if attr.lower().startswith("data-reader-apparatus-"):
                    del element.attrib[attr]

    targets: dict[str, HtmlElement] = {}
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        element_id = (element.get("id") or "").strip()
        if element_id:
            targets[element_id] = element
        if str(element.tag).lower() == "a":
            name = (element.get("name") or "").strip()
            if name:
                targets[name] = element

    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    target_item_key_by_id: dict[str, str] = {}
    external_targets = external_targets or {}

    _extract_standalone_margin_notes(
        root, source_kind=source_kind, source_ref=source_ref, items=items
    )
    _materialize_external_targets_in_document(
        targets=targets,
        external_targets=external_targets,
        document_href=document_href,
        target_item_key_by_id=target_item_key_by_id,
        items=items,
    )

    ordinal = 0
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        if (element.get("data-reader-apparatus-item-id") or "").strip():
            continue
        target_id = _local_target_id(element)
        target = targets.get(target_id) if target_id else None
        external_target = external_targets.get(_target_ref(element) or "")
        if target is None and external_target is None:
            continue
        classified = _classify(
            element, _target_facts(element, target, external_target, document_href)
        )
        if classified is None:
            continue

        marker_text = _element_text(element)
        target_text = (
            _element_text(target)
            if target is not None
            else str((external_target or {}).get("body_text") or "")
        )
        if not marker_text or not target_text:
            continue

        target_key_token = target_id or str((external_target or {}).get("target_ref") or "")
        marker_key = f"{source_kind}:ref:{ordinal:06d}:{stable_token(target_key_token)}"
        target_source_ref: dict[str, object] = {**source_ref, "target_id": target_id}
        marker_source_ref: dict[str, object] = dict(target_source_ref)
        if external_target is not None:
            target_source_ref = _object_dict(external_target.get("source_ref") or target_source_ref)
            marker_source_ref = {
                **source_ref,
                "target_ref": external_target.get("target_ref"),
                "target_id": external_target.get("target_id"),
            }
        marker_id = _source_element_id(element)
        if marker_id:
            marker_source_ref["marker_id"] = marker_id

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
                        "confidence": classified.confidence,
                        "extraction_method": classified.method,
                        "source_ref": target_source_ref,
                        "sort_key": str(
                            (external_target or {}).get("sort_key") or f"{ordinal:06d}.target"
                        ),
                        "_locator_text": target_text,
                    }
                )
            if target_id:
                target_item_key_by_id[target_id] = target_key
            if target is not None:
                _stamp(target, target_key, classified.target_kind, classified.confidence)

        _stamp(element, marker_key, classified.marker_kind, classified.confidence)
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

    return _fragment_html(root), items, edges


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
    targets: dict[str, dict[str, object]] = {}
    ordinal = 0
    retained_utf8_bytes = 0
    backlink_count = 0
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        target_id = (element.get("id") or element.get("name") or "").strip()
        if not target_id:
            continue
        context = _target_context(element).semantic
        if context not in {"note", "endnote", "bibliography"}:
            continue
        if context in {"note", "endnote"} and not _is_note_body_target(element):
            continue
        if context == "bibliography" and not _is_bibliography_entry_target(element):
            continue
        body_text = _element_text(element)
        if not body_text:
            continue
        if ordinal >= max_targets:
            raise HtmlApparatusTargetLimitExceeded(
                "HTML apparatus target count exceeded", dimension="Output"
            )
        target_ref = f"{document_href}#{target_id}"
        backlinks = _link_hrefs(element, max_count=max_backlinks - backlink_count)
        backlink_count += len(backlinks)
        target = {
            "target_ref": target_ref,
            "target_href": document_href,
            "target_id": target_id,
            "context": context,
            "kind": _target_kind_for_context(context),
            "label": _target_label(body_text),
            "body_text": body_text,
            "confidence": "exact",
            "extraction_method": extraction_method,
            "source_ref": {**source_ref, "target_href": document_href, "target_id": target_id},
            "sort_key": f"{_source_order_key(element, ordinal)}.target",
            "stable_key": f"{source_kind}:target:{stable_token(target_ref)}",
            "backlinks": backlinks,
        }
        retained_utf8_bytes += nested_utf8_byte_length(target)
        if retained_utf8_bytes > max_retained_utf8_bytes:
            raise HtmlApparatusTargetLimitExceeded(
                "HTML apparatus target text exceeded", dimension="Output"
            )
        targets[target_ref] = target
        ordinal += 1
    return targets, ordinal, retained_utf8_bytes, backlink_count


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

    A span is accepted only when the tokenised re-serialisation reproduces the stored
    canonical text exactly, or when the item's text occurs exactly once in it.
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
        result.append(item)
    return result


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
        if not note_text:
            continue
        target_key = f"{source_kind}:html-margin-note:{ordinal:06d}:{stable_token(note_text[:96])}"
        _stamp(element, target_key, "margin_note", "strong")
        items.append(
            {
                "stable_key": target_key,
                "kind": "margin_note",
                "label": f"Margin note {ordinal + 1}",
                "body_text": note_text,
                "confidence": "strong",
                "extraction_method": "html_margin_note",
                "source_ref": {**source_ref, "element": "span.marginnote", "ordinal": ordinal},
                "sort_key": f"{_source_order_key(element, ordinal)}.target",
                "_locator_text": note_text,
            }
        )
        ordinal += 1


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
        target_id = target_ref[len(prefix) :]
        target = targets.get(target_id)
        body_text = str(external_target.get("body_text") or "")
        if target is None or target_id in target_item_key_by_id or not body_text:
            continue
        target_key = str(external_target["stable_key"])
        kind = str(external_target["kind"])
        confidence = str(external_target["confidence"])
        _stamp(target, target_key, kind, confidence)
        target_item_key_by_id[target_id] = target_key
        items.append(
            {
                "stable_key": target_key,
                "kind": kind,
                "label": external_target.get("label"),
                "body_text": body_text,
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
) -> _TargetFacts:
    if target is not None:
        return _TargetFacts(
            context=_target_context(target),
            is_bibliography_entry=_is_bibliography_entry_target(target),
            has_backlink=_has_backlink(marker, target),
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

    if "noteref" in tokens or "doc-noteref" in tokens or ref_type == "fn":
        if semantic in ("note", "endnote"):
            return declared(semantic)
        return inferred("note") if loose == "note" and facts.has_backlink else None
    if "biblioref" in tokens or "doc-biblioref" in tokens or ref_type == "bibr":
        if not facts.is_bibliography_entry:
            return None
        if semantic == "bibliography":
            return declared("bibliography")
        return inferred("bibliography") if loose == "bibliography" else None
    if str(marker.tag).lower() == "a" and _parent_tag(marker) == "sup":
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


def _target_context(target: HtmlElement) -> _TargetContext:
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
                head = _element_text(element).lower()[:80]
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


def _has_backlink(marker: HtmlElement, target: HtmlElement) -> bool:
    marker_id = _source_element_id(marker)
    if not marker_id:
        return False
    for element in target.iter():
        if not isinstance(element, HtmlElement) or str(element.tag).lower() != "a":
            continue
        if unquote((element.get("href") or "").strip()) == f"#{marker_id}":
            return True
    return False


def _external_target_has_backlink(
    marker: HtmlElement, target: Mapping[str, object], document_href: str | None
) -> bool:
    marker_id = _source_element_id(marker)
    backlinks = target.get("backlinks")
    if not marker_id or not document_href or not isinstance(backlinks, list):
        return False
    return f"{document_href}#{marker_id}" in {str(href) for href in backlinks}


def _is_bibliography_entry_target(target: HtmlElement) -> bool:
    tag = str(target.tag).lower()
    if tag in {"ref", "li"} or _semantic_tokens(target) & {"biblioentry", "doc-biblioentry"}:
        return True
    if tag in {"section", "div", "ol", "ref-list", "ul"} | _BIBLIOGRAPHY_CONTAINER_TAGS:
        return False
    return _target_context(target).semantic == "bibliography"


def _is_note_body_target(target: HtmlElement) -> bool:
    tokens = _semantic_tokens(target)
    if tokens & {"endnotes", "doc-endnotes"}:
        return False
    if str(target.tag).lower() in {"li", "aside", "fn", "footnote"}:
        return True
    return bool(tokens & {"footnote", "doc-footnote", "endnote", "doc-endnote"})


def _target_kind_for_context(context: str) -> str:
    if context == "endnote":
        return "endnote"
    if context == "bibliography":
        return "bibliography_entry"
    return "footnote"


def _apparatus_locator_spans(
    html_sanitized: str | None, canonical_text: str
) -> dict[str, tuple[int, int, str]]:
    """Map each stamped element to its canonical-text span by re-canonicalising once.

    Sentinel tokens are wrapped around each stamped element's text; if removing them
    from the re-canonicalised document does not reproduce the stored canonical text
    exactly, every span is rejected rather than guessed.
    """
    spans: dict[str, tuple[int, int, str]] = {}
    if not html_sanitized or not html_sanitized.strip() or not canonical_text:
        return spans
    try:
        root = parse_html_document(f"<div>{html_sanitized}</div>")
    except ParserError:
        return spans

    seed = hashlib.sha256(html_sanitized.encode("utf-8")).hexdigest()[:16]
    token_pairs: list[tuple[str, str, str]] = []
    seen_keys: set[str] = set()
    for idx, element in enumerate(root.iter()):
        if not isinstance(element, HtmlElement):
            continue
        stable_key = (element.get("data-reader-apparatus-item-id") or "").strip()
        if not stable_key or stable_key in seen_keys:
            continue
        start_token = f"__NEXUS_READER_APPARATUS_START_{seed}_{idx}__"
        end_token = f"__NEXUS_READER_APPARATUS_END_{seed}_{idx}__"
        if start_token in canonical_text or end_token in canonical_text:
            continue
        element.text = f"{start_token}{element.text or ''}"
        children = list(element)
        if children:
            children[-1].tail = f"{children[-1].tail or ''}{end_token}"
        else:
            element.text = f"{element.text or ''}{end_token}"
        token_pairs.append((stable_key, start_token, end_token))
        seen_keys.add(stable_key)

    if not token_pairs:
        return spans
    canonical_with_tokens = generate_canonical_text(serialize_html(root))
    stripped = canonical_with_tokens
    for _stable_key, start_token, end_token in token_pairs:
        stripped = stripped.replace(start_token, "").replace(end_token, "")
    if stripped != canonical_text:
        return spans

    token_positions: list[tuple[int, int]] = []
    found: dict[str, tuple[int, int, int]] = {}
    for stable_key, start_token, end_token in token_pairs:
        start_pos = canonical_with_tokens.find(start_token)
        end_pos = canonical_with_tokens.find(end_token)
        if start_pos < 0 or end_pos < 0 or end_pos < start_pos:
            continue
        token_positions.append((start_pos, len(start_token)))
        token_positions.append((end_pos, len(end_token)))
        found[stable_key] = (start_pos, len(start_token), end_pos)

    for stable_key, (start_pos, start_len, end_pos) in found.items():
        start = start_pos + start_len - _token_length_before(token_positions, start_pos + start_len)
        end = end_pos - _token_length_before(token_positions, end_pos)
        locator_text = canonical_text[start:end]
        if locator_text:
            spans[stable_key] = (start, end, locator_text)
    return spans


def _token_length_before(token_positions: list[tuple[int, int]], position: int) -> int:
    return sum(length for start, length in token_positions if start < position)


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


def _local_target_id(element: HtmlElement) -> str | None:
    if str(element.tag).lower() == "xref":
        return (element.get("rid") or "").strip() or None
    href = (element.get("href") or "").strip()
    if href.startswith("#") and len(href) > 1:
        return unquote(href[1:])
    return None


def _target_ref(element: HtmlElement) -> str | None:
    if str(element.tag).lower() == "xref":
        return (element.get("rid") or "").strip() or None
    return (element.get("href") or "").strip() or None


def _link_hrefs(element: HtmlElement, *, max_count: int) -> list[str]:
    hrefs: list[str] = []
    for descendant in element.iter():
        if not isinstance(descendant, HtmlElement) or str(descendant.tag).lower() != "a":
            continue
        href = (descendant.get("href") or "").strip()
        if not href:
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
    return normalize_whitespace(str(element.text_content() or ""))


def _target_label(text_value: str) -> str | None:
    first = text_value.split(maxsplit=1)[0] if text_value.split() else ""
    return first[:64] or None


def _source_element_id(element: HtmlElement) -> str | None:
    value = (element.get("id") or element.get("name") or "").strip()
    if value:
        return value
    parent = element.getparent()
    if isinstance(parent, HtmlElement) and str(parent.tag).lower() == "sup":
        return (parent.get("id") or parent.get("name") or "").strip() or None
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
