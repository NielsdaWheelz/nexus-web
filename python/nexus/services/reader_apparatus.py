"""Reader apparatus read model."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from urllib.parse import unquote
from uuid import UUID

from lxml.etree import ParserError
from lxml.html import HtmlElement, document_fromstring, tostring
from sqlalchemy import bindparam, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_media
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.schemas.reader_apparatus import (
    ReaderApparatusCapabilities,
    ReaderApparatusEdgeOut,
    ReaderApparatusItemOut,
    ReaderApparatusResponse,
)
from nexus.schemas.retrieval import retrieval_locator_json
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.capabilities import is_document_status_ready
from nexus.text import normalize_whitespace

EXTRACTOR_VERSION = "reader_apparatus_v1"
SUPPORTED_MEDIA_KINDS = frozenset({"web_article", "epub", "pdf"})
_LEGACY_NAMED_NOTE_RE = re.compile(r"^f(?P<number>[1-9]\d*)n$")
_PROJECT_GUTENBERG_LINKNOTE_REF_RE = re.compile(r"^linknoteref-(?P<number>[1-9]\d*)$")
_PROJECT_GUTENBERG_LINKNOTE_TARGET_RE = re.compile(r"^linknote-(?P<number>[1-9]\d*)$")


def source_fingerprint(*parts: object) -> str:
    payload = {
        "extractor_version": EXTRACTOR_VERSION,
        "parts": [_fingerprint_part(part) for part in parts],
    }
    digest = hashlib.sha256()
    digest.update(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    return f"sha256:{digest.hexdigest()}"


def extract_html_apparatus(
    html: str | bytes,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    document_href: str | None = None,
    external_targets: Mapping[str, Mapping[str, object]] | None = None,
) -> tuple[str, list[dict[str, object]], list[dict[str, object]]]:
    if not html.strip():
        return _html_string(html), [], []
    try:
        doc = document_fromstring(html)
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
    for element in list(root.iter()):
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
    external_targets_by_local_id = _external_targets_by_local_id(
        document_href=document_href,
        external_targets=external_targets,
    )

    _extract_distill_apparatus(
        root,
        source_kind=source_kind,
        source_ref=source_ref,
        targets=targets,
        items=items,
        edges=edges,
        target_item_key_by_id=target_item_key_by_id,
    )
    _extract_tufte_sidenotes(
        root,
        source_kind=source_kind,
        source_ref=source_ref,
        items=items,
        edges=edges,
    )
    _extract_standalone_margin_notes(
        root,
        source_kind=source_kind,
        source_ref=source_ref,
        items=items,
    )
    _extract_legacy_named_notes(
        root,
        source_kind=source_kind,
        source_ref=source_ref,
        items=items,
        edges=edges,
        target_item_key_by_id=target_item_key_by_id,
    )
    _extract_project_gutenberg_linknotes(
        root,
        source_kind=source_kind,
        source_ref=source_ref,
        items=items,
        edges=edges,
        target_item_key_by_id=target_item_key_by_id,
    )
    _extract_jats_multirid_bibliography_refs(
        root,
        source_kind=source_kind,
        source_ref=source_ref,
        targets=targets,
        items=items,
        edges=edges,
        target_item_key_by_id=target_item_key_by_id,
    )
    _extract_mediawiki_cited_work_links(
        root,
        source_kind=source_kind,
        source_ref=source_ref,
        items=items,
        edges=edges,
        target_item_key_by_id=target_item_key_by_id,
    )

    _materialize_external_targets_in_document(
        targets=targets,
        external_targets_by_local_id=external_targets_by_local_id,
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
        external_target = _external_target_for_marker(element, external_targets)
        if (not target_id or target_id not in targets) and external_target is None:
            continue
        target = targets[target_id] if target_id and target_id in targets else None
        if target is not None:
            marker_kind, target_kind, relation, method, confidence = _classify_link(element, target)
        else:
            marker_kind, target_kind, relation, method, confidence = _classify_external_link(
                element,
                external_target or {},
                document_href=document_href,
            )
        if marker_kind is None:
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
        marker_key = f"{source_kind}:ref:{ordinal:06d}:{_stable_token(target_key_token)}"
        target_source_ref = {**source_ref, "target_id": target_id}
        if external_target is not None:
            target_source_ref = dict(external_target.get("source_ref") or target_source_ref)
        marker_source_ref = dict(target_source_ref)
        if external_target is not None:
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
                        "kind": target_kind,
                        "label": _target_label(target_text),
                        "body_text": target_text,
                        "body_html_sanitized": None,
                        "confidence": confidence,
                        "extraction_method": method,
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
                target.set("data-reader-apparatus-item-id", target_key)
                target.set("data-reader-apparatus-kind", target_kind)
                target.set("data-reader-apparatus-confidence", confidence)

        element.set("data-reader-apparatus-item-id", marker_key)
        element.set("data-reader-apparatus-kind", marker_kind)
        element.set("data-reader-apparatus-confidence", confidence)
        items.append(
            {
                "stable_key": marker_key,
                "kind": marker_kind,
                "label": marker_text,
                "body_text": None,
                "body_html_sanitized": None,
                "confidence": confidence,
                "extraction_method": method,
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
                "relation": relation,
                "confidence": confidence,
                "extraction_method": method,
                "source_ref": marker_source_ref,
                "sort_key": f"{ordinal:06d}.edge",
            }
        )
        ordinal += 1

    return _inner_html(root), items, edges


def collect_html_apparatus_targets(
    html: str | bytes,
    *,
    document_href: str,
    source_kind: str,
    source_ref: dict[str, object],
    extraction_method: str = "html_semantic",
) -> dict[str, dict[str, object]]:
    if not html.strip():
        return {}
    try:
        doc = document_fromstring(html)
    except ParserError:
        return {}
    body = doc.body
    root = body if body is not None else doc
    targets: dict[str, dict[str, object]] = {}
    ordinal = 0
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        target_id = (element.get("id") or element.get("name") or "").strip()
        if not target_id:
            continue
        context = _semantic_target_context(element)
        if context not in {"note", "endnote", "bibliography"}:
            continue
        if context in {"note", "endnote"} and not _is_note_body_target(element):
            continue
        if context == "bibliography" and not _is_bibliography_entry_target(element):
            continue
        body_text = _element_text(element)
        if not body_text:
            continue
        target_ref = f"{document_href}#{target_id}"
        target_kind = _target_kind_for_context(context)
        source_ref_for_target = {
            **source_ref,
            "target_href": document_href,
            "target_id": target_id,
        }
        targets[target_ref] = {
            "target_ref": target_ref,
            "target_href": document_href,
            "target_id": target_id,
            "context": context,
            "kind": target_kind,
            "label": _target_label(body_text),
            "body_text": body_text,
            "confidence": "exact",
            "extraction_method": extraction_method,
            "source_ref": source_ref_for_target,
            "sort_key": f"{_source_order_key(element, ordinal)}.target",
            "stable_key": f"{source_kind}:target:{_stable_token(target_ref)}",
            "backlinks": _link_hrefs(element),
        }
        ordinal += 1
    return targets


def _extract_distill_apparatus(
    root: HtmlElement,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    targets: dict[str, HtmlElement],
    items: list[dict[str, object]],
    edges: list[dict[str, object]],
    target_item_key_by_id: dict[str, str],
) -> None:
    bibliography_text_by_key = _distill_bibliography_text_by_key(root)
    footnote_ordinal = 0
    citation_ordinal = 0

    for element in list(root.iter()):
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        if tag == "d-footnote":
            footnote_text = _element_text(element)
            if not footnote_text:
                continue
            order_key = _source_order_key(element, footnote_ordinal)
            marker_key = f"{source_kind}:distill-footnote-ref:{footnote_ordinal:06d}"
            target_key = f"{source_kind}:distill-footnote:{footnote_ordinal:06d}"
            label = str(footnote_ordinal + 1)
            note_source_ref = {
                **source_ref,
                "element": "d-footnote",
                "ordinal": footnote_ordinal,
            }
            element.tag = "span"
            for child in list(element):
                element.remove(child)
            element.text = label
            element.set("data-reader-apparatus-item-id", marker_key)
            element.set("data-reader-apparatus-kind", "footnote_ref")
            element.set("data-reader-apparatus-confidence", "exact")
            items.append(
                {
                    "stable_key": target_key,
                    "kind": "footnote",
                    "label": label,
                    "body_text": footnote_text,
                    "body_html_sanitized": None,
                    "confidence": "exact",
                    "extraction_method": "distill_footnote",
                    "source_ref": note_source_ref,
                    "sort_key": f"{order_key}.target",
                    "_locator_text": "",
                }
            )
            items.append(
                {
                    "stable_key": marker_key,
                    "kind": "footnote_ref",
                    "label": label,
                    "body_text": None,
                    "body_html_sanitized": None,
                    "confidence": "exact",
                    "extraction_method": "distill_footnote",
                    "source_ref": note_source_ref,
                    "sort_key": f"{order_key}.marker",
                    "_locator_text": label,
                }
            )
            edges.append(
                {
                    "stable_key": f"{marker_key}->{target_key}",
                    "from_stable_key": marker_key,
                    "to_stable_key": target_key,
                    "relation": "points_to_note",
                    "confidence": "exact",
                    "extraction_method": "distill_footnote",
                    "source_ref": note_source_ref,
                    "sort_key": f"{order_key}.edge",
                }
            )
            footnote_ordinal += 1
            continue

        if tag not in {"d-cite", "dt-cite"}:
            continue
        key_attr = (element.get("key") or "").strip()
        keys = _ordered_unique_strings(part.strip() for part in key_attr.split(",") if part.strip())
        if not keys:
            continue
        marker_text = _element_text(element)
        visible_marker_text = marker_text
        if not visible_marker_text:
            visible_marker_text = f"[{citation_ordinal + 1}]"
            element.text = visible_marker_text
        element.tag = "span"
        order_key = _source_order_key(element, citation_ordinal)
        marker_key = (
            f"{source_kind}:distill-bibliography-ref:"
            f"{citation_ordinal:06d}:{_stable_token(','.join(keys))}"
        )
        marker_source_ref = {
            **source_ref,
            "element": tag,
            "citation_ordinal": citation_ordinal,
            "citation_keys": keys,
        }
        marker_item_added = False
        for key_index, citation_key in enumerate(keys):
            candidate_target = targets.get(citation_key)
            target = (
                candidate_target
                if candidate_target is not None and _is_bibliography_entry_target(candidate_target)
                else None
            )
            target_text = _element_text(target) if target is not None else ""
            if not target_text:
                target_text = bibliography_text_by_key.get(citation_key, "")
            if not target_text:
                continue

            citation_token = _stable_token(citation_key)
            target_key = target_item_key_by_id.get(citation_key)
            target_source_ref = {
                **source_ref,
                "element": tag,
                "citation_ordinal": citation_ordinal,
                "citation_key": citation_key,
            }
            if target is not None:
                target_source_ref["target_id"] = citation_key
            if target_key is None:
                target_key = f"{source_kind}:distill-bibliography-target:{citation_token}"
                target_item_key_by_id[citation_key] = target_key
                if target is not None:
                    target.set("data-reader-apparatus-item-id", target_key)
                    target.set("data-reader-apparatus-kind", "bibliography_entry")
                    target.set("data-reader-apparatus-confidence", "exact")
                locator_text = (
                    _bibliography_target_locator_text(target, target_text)
                    if target is not None
                    else ""
                )
                items.append(
                    {
                        "stable_key": target_key,
                        "kind": "bibliography_entry",
                        "label": _target_label(target_text) or citation_key,
                        "body_text": target_text,
                        "body_html_sanitized": None,
                        "confidence": "exact",
                        "extraction_method": "distill_citation",
                        "source_ref": target_source_ref,
                        "sort_key": f"{order_key}.target.{key_index:03d}",
                        "_locator_text": locator_text,
                    }
                )

            if not marker_item_added:
                element.set("data-reader-apparatus-item-id", marker_key)
                element.set("data-reader-apparatus-kind", "bibliography_ref")
                element.set("data-reader-apparatus-confidence", "exact")
                items.append(
                    {
                        "stable_key": marker_key,
                        "kind": "bibliography_ref",
                        "label": visible_marker_text or citation_key,
                        "body_text": None,
                        "body_html_sanitized": None,
                        "confidence": "exact",
                        "extraction_method": "distill_citation",
                        "source_ref": marker_source_ref,
                        "sort_key": f"{order_key}.marker",
                        "_locator_text": visible_marker_text,
                    }
                )
                marker_item_added = True
            edges.append(
                {
                    "stable_key": f"{marker_key}->{target_key}",
                    "from_stable_key": marker_key,
                    "to_stable_key": target_key,
                    "relation": "cites_bibliography_entry",
                    "confidence": "exact",
                    "extraction_method": "distill_citation",
                    "source_ref": target_source_ref,
                    "sort_key": f"{order_key}.edge.{key_index:03d}",
                }
            )
        citation_ordinal += 1


def _extract_tufte_sidenotes(
    root: HtmlElement,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    items: list[dict[str, object]],
    edges: list[dict[str, object]],
) -> None:
    ordinal = 0
    seen_targets: set[int] = set()
    for element in list(root.iter()):
        if not isinstance(element, HtmlElement):
            continue
        if str(element.tag).lower() != "label":
            continue
        classes = _class_tokens(element)
        if "margin-toggle" not in classes:
            continue
        toggle_id = (element.get("for") or "").strip()
        if not toggle_id:
            continue
        is_sidenote = "sidenote-number" in classes
        target_class = "sidenote" if is_sidenote else "marginnote"
        input_element = _tufte_toggle_input_for_label(element, toggle_id)
        if input_element is None:
            continue
        target = _first_following_sibling_with_class(input_element, target_class)
        if target is None:
            continue
        target_identity = id(target)
        if target_identity in seen_targets:
            continue
        note_text = _element_text(target)
        if not note_text:
            continue

        seen_targets.add(target_identity)
        order_key = _source_order_key(element, ordinal)
        note_type = "sidenote" if is_sidenote else "margin-note"
        marker_kind = "sidenote_ref" if is_sidenote else "margin_note_ref"
        target_kind = "sidenote" if is_sidenote else "margin_note"
        relation = "points_to_sidenote" if is_sidenote else "points_to_margin_note"
        method = "tufte_sidenote" if is_sidenote else "tufte_margin_note"
        marker_key = f"{source_kind}:tufte-{note_type}-ref:{ordinal:06d}:{_stable_token(toggle_id)}"
        target_key = f"{source_kind}:tufte-{note_type}:{ordinal:06d}:{_stable_token(toggle_id)}"
        marker_label = _element_text(element) or (
            "Margin note" if not is_sidenote else str(ordinal + 1)
        )
        target_label = marker_label if is_sidenote else f"Margin note {ordinal + 1}"
        note_source_ref = {
            **source_ref,
            "element": f"tufte-{note_type}",
            "toggle_id": toggle_id,
            "ordinal": ordinal,
        }
        element.tag = "span"
        element.text = marker_label
        element.set("data-reader-apparatus-item-id", marker_key)
        element.set("data-reader-apparatus-kind", marker_kind)
        element.set("data-reader-apparatus-confidence", "strong")
        target.set("data-reader-apparatus-item-id", target_key)
        target.set("data-reader-apparatus-kind", target_kind)
        target.set("data-reader-apparatus-confidence", "strong")
        items.append(
            {
                "stable_key": target_key,
                "kind": target_kind,
                "label": target_label,
                "body_text": note_text,
                "body_html_sanitized": None,
                "confidence": "strong",
                "extraction_method": method,
                "source_ref": note_source_ref,
                "sort_key": f"{order_key}.target",
                "_locator_text": note_text,
            }
        )
        items.append(
            {
                "stable_key": marker_key,
                "kind": marker_kind,
                "label": marker_label,
                "body_text": None,
                "body_html_sanitized": None,
                "confidence": "strong",
                "extraction_method": method,
                "source_ref": note_source_ref,
                "sort_key": f"{order_key}.marker",
                "_locator_text": marker_label,
            }
        )
        edges.append(
            {
                "stable_key": f"{marker_key}->{target_key}",
                "from_stable_key": marker_key,
                "to_stable_key": target_key,
                "relation": relation,
                "confidence": "strong",
                "extraction_method": method,
                "source_ref": note_source_ref,
                "sort_key": f"{order_key}.edge",
            }
        )
        ordinal += 1


def _extract_standalone_margin_notes(
    root: HtmlElement,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    items: list[dict[str, object]],
) -> None:
    ordinal = 0
    for element in list(root.iter()):
        if not isinstance(element, HtmlElement):
            continue
        if "marginnote" not in _class_tokens(element):
            continue
        if (element.get("data-reader-apparatus-item-id") or "").strip():
            continue
        if _is_ignored_margin_note_context(element):
            continue
        note_text = _element_text(element)
        if not note_text:
            continue

        order_key = _source_order_key(element, ordinal)
        target_key = f"{source_kind}:html-margin-note:{ordinal:06d}:{_stable_token(note_text[:96])}"
        note_source_ref = {
            **source_ref,
            "element": "span.marginnote",
            "ordinal": ordinal,
        }
        element.set("data-reader-apparatus-item-id", target_key)
        element.set("data-reader-apparatus-kind", "margin_note")
        element.set("data-reader-apparatus-confidence", "strong")
        items.append(
            {
                "stable_key": target_key,
                "kind": "margin_note",
                "label": f"Margin note {ordinal + 1}",
                "body_text": note_text,
                "body_html_sanitized": None,
                "confidence": "strong",
                "extraction_method": "html_margin_note",
                "source_ref": note_source_ref,
                "sort_key": f"{order_key}.target",
                "_locator_text": note_text,
            }
        )
        ordinal += 1


def _tufte_toggle_input_for_label(
    label: HtmlElement,
    toggle_id: str,
) -> HtmlElement | None:
    search_anchors = [label, *label.iterancestors()]
    for anchor in search_anchors:
        if not isinstance(anchor, HtmlElement):
            continue
        for sibling in anchor.itersiblings():
            if not isinstance(sibling, HtmlElement):
                continue
            if (
                str(sibling.tag).lower() == "input"
                and (sibling.get("id") or "").strip() == toggle_id
                and "margin-toggle" in _class_tokens(sibling)
            ):
                return sibling
    return None


def _first_following_sibling_with_class(
    element: HtmlElement,
    class_name: str,
) -> HtmlElement | None:
    for sibling in element.itersiblings():
        if isinstance(sibling, HtmlElement) and class_name in _class_tokens(sibling):
            return sibling
    return None


def _is_ignored_margin_note_context(element: HtmlElement) -> bool:
    for node in [element, *element.iterancestors()]:
        if not isinstance(node, HtmlElement):
            continue
        tag = str(node.tag).lower()
        if tag in {"script", "style", "template", "nav", "header", "footer"}:
            return True
        if (node.get("hidden") is not None) or (
            (node.get("aria-hidden") or "").strip().lower() == "true"
        ):
            return True
        style = (node.get("style") or "").replace(" ", "").lower()
        if "display:none" in style or "visibility:hidden" in style:
            return True
    return False


def _extract_jats_multirid_bibliography_refs(
    root: HtmlElement,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    targets: dict[str, HtmlElement],
    items: list[dict[str, object]],
    edges: list[dict[str, object]],
    target_item_key_by_id: dict[str, str],
) -> None:
    ordinal = 0
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        if str(element.tag).lower() != "xref":
            continue
        if (element.get("ref-type") or "").strip().lower() != "bibr":
            continue
        raw_rids = [rid.strip() for rid in (element.get("rid") or "").split() if rid.strip()]
        if len(raw_rids) < 2:
            continue
        rids = _ordered_unique_strings(raw_rids)
        if not rids:
            continue

        target_rows: list[tuple[str, HtmlElement, str]] = []
        for rid in rids:
            target = targets.get(rid)
            if target is None:
                continue
            if _semantic_target_context(target) == "bibliography" and _is_bibliography_entry_target(
                target
            ):
                target_text = _element_text(target)
                if target_text:
                    target_rows.append((rid, target, target_text))
        if not target_rows:
            continue

        marker_text = _element_text(element)
        if not marker_text:
            continue
        order_key = _source_order_key(element, ordinal)
        marker_key = (
            f"{source_kind}:jats-bibliography-ref:{ordinal:06d}:{_stable_token(','.join(rids))}"
        )
        marker_source_ref = {
            **source_ref,
            "element": "xref",
            "ref_type": "bibr",
            "rids": rids,
        }
        element.set("data-reader-apparatus-item-id", marker_key)
        element.set("data-reader-apparatus-kind", "bibliography_ref")
        element.set("data-reader-apparatus-confidence", "exact")
        items.append(
            {
                "stable_key": marker_key,
                "kind": "bibliography_ref",
                "label": marker_text,
                "body_text": None,
                "body_html_sanitized": None,
                "confidence": "exact",
                "extraction_method": "jats_multirid_bibliography",
                "source_ref": marker_source_ref,
                "sort_key": f"{order_key}.marker",
                "_locator_text": marker_text,
            }
        )

        for target_index, (rid, target, target_text) in enumerate(target_rows):
            target_key = target_item_key_by_id.get(rid)
            target_source_ref = {
                **source_ref,
                "element": "xref",
                "ref_type": "bibr",
                "target_id": rid,
            }
            if target_key is None:
                target_key = f"{source_kind}:jats-bibliography-target:{_stable_token(rid)}"
                target_item_key_by_id[rid] = target_key
                target.set("data-reader-apparatus-item-id", target_key)
                target.set("data-reader-apparatus-kind", "bibliography_entry")
                target.set("data-reader-apparatus-confidence", "exact")
                items.append(
                    {
                        "stable_key": target_key,
                        "kind": "bibliography_entry",
                        "label": _target_label(target_text),
                        "body_text": target_text,
                        "body_html_sanitized": None,
                        "confidence": "exact",
                        "extraction_method": "jats_multirid_bibliography",
                        "source_ref": target_source_ref,
                        "sort_key": f"{order_key}.target.{target_index:03d}",
                        "_locator_text": target_text,
                    }
                )
            edges.append(
                {
                    "stable_key": f"{marker_key}->{target_key}",
                    "from_stable_key": marker_key,
                    "to_stable_key": target_key,
                    "relation": "cites_bibliography_entry",
                    "confidence": "exact",
                    "extraction_method": "jats_multirid_bibliography",
                    "source_ref": target_source_ref,
                    "sort_key": f"{order_key}.edge.{target_index:03d}",
                }
            )
        ordinal += 1


def _extract_mediawiki_cited_work_links(
    root: HtmlElement,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    items: list[dict[str, object]],
    edges: list[dict[str, object]],
    target_item_key_by_id: dict[str, str],
) -> None:
    target_rows = _mediawiki_cited_work_targets(root)
    if not target_rows:
        return

    method = "mediawiki_cited_work"
    confidence = "exact"
    target_keys_by_id: dict[str, str] = {}
    for target_index, (target_id, target, target_text) in enumerate(target_rows):
        target_key = target_item_key_by_id.get(target_id)
        if target_key is None:
            target_key = f"{source_kind}:mediawiki-cited-work:{_stable_token(target_id)}"
            target_item_key_by_id[target_id] = target_key
            order_key = _source_order_key(target, target_index)
            target.set("data-reader-apparatus-item-id", target_key)
            target.set("data-reader-apparatus-kind", "bibliography_entry")
            target.set("data-reader-apparatus-confidence", confidence)
            items.append(
                {
                    "stable_key": target_key,
                    "kind": "bibliography_entry",
                    "label": _target_label(target_text),
                    "body_text": target_text,
                    "body_html_sanitized": None,
                    "confidence": confidence,
                    "extraction_method": method,
                    "source_ref": {
                        **source_ref,
                        "element": str(target.tag).lower(),
                        "target_id": target_id,
                    },
                    "sort_key": f"{order_key}.target",
                    "_locator_text": target_text,
                }
            )
        target_keys_by_id[target_id] = target_key

    ordinal = 0
    for note in root.xpath('.//li[starts-with(@id, "cite_note")]'):
        if not isinstance(note, HtmlElement):
            continue
        note_id = (note.get("id") or "").strip()
        if not note_id:
            continue
        for marker in note.iter("a"):
            if not isinstance(marker, HtmlElement):
                continue
            if (marker.get("data-reader-apparatus-item-id") or "").strip():
                continue
            target_id = _local_target_id(marker)
            if not target_id or target_id not in target_keys_by_id:
                continue
            marker_text = _element_text(marker)
            if not marker_text:
                continue
            order_key = _source_order_key(marker, ordinal)
            target_key = target_keys_by_id[target_id]
            marker_key = (
                f"{source_kind}:mediawiki-cited-work-ref:"
                f"{ordinal:06d}:{_stable_token(f'{note_id}:{target_id}:{marker_text}')}"
            )
            marker_source_ref = {
                **source_ref,
                "element": "a[href]",
                "note_id": note_id,
                "target_id": target_id,
                "marker_href": marker.get("href") or "",
            }
            marker_id = _source_element_id(marker)
            if marker_id:
                marker_source_ref["marker_id"] = marker_id
            marker.set("data-reader-apparatus-item-id", marker_key)
            marker.set("data-reader-apparatus-kind", "bibliography_ref")
            marker.set("data-reader-apparatus-confidence", confidence)
            items.append(
                {
                    "stable_key": marker_key,
                    "kind": "bibliography_ref",
                    "label": marker_text,
                    "body_text": None,
                    "body_html_sanitized": None,
                    "confidence": confidence,
                    "extraction_method": method,
                    "source_ref": marker_source_ref,
                    "sort_key": f"{order_key}.marker",
                    "_locator_text": marker_text,
                }
            )
            edges.append(
                {
                    "stable_key": f"{marker_key}->{target_key}",
                    "from_stable_key": marker_key,
                    "to_stable_key": target_key,
                    "relation": "cites_bibliography_entry",
                    "confidence": confidence,
                    "extraction_method": method,
                    "source_ref": marker_source_ref,
                    "sort_key": f"{order_key}.edge",
                }
            )
            ordinal += 1


def _mediawiki_cited_work_targets(root: HtmlElement) -> list[tuple[str, HtmlElement, str]]:
    target_rows: list[tuple[str, HtmlElement, str]] = []
    seen_target_ids: set[str] = set()
    for element in root.xpath('.//*[@id][starts-with(@id, "CITEREF")]'):
        if not isinstance(element, HtmlElement):
            continue
        target_id = (element.get("id") or "").strip()
        if not target_id or target_id in seen_target_ids:
            continue
        if not _is_mediawiki_cited_work_target(element):
            continue
        target_text = _element_text(element)
        if not target_text:
            continue
        seen_target_ids.add(target_id)
        target_rows.append((target_id, element, target_text))
    return target_rows


def _is_mediawiki_cited_work_target(element: HtmlElement) -> bool:
    if str(element.tag).lower() == "cite":
        return True
    classes = _class_tokens(element)
    return "citation" in classes and "wikicite" in classes


def _extract_legacy_named_notes(
    root: HtmlElement,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    items: list[dict[str, object]],
    edges: list[dict[str, object]],
    target_item_key_by_id: dict[str, str],
) -> None:
    target_rows: list[tuple[int, str, HtmlElement]] = []
    seen_target_names: set[str] = set()
    for element in root.iter("a"):
        if not isinstance(element, HtmlElement):
            continue
        number = _legacy_named_note_number(element)
        if number is None:
            continue
        target_name = (element.get("name") or "").strip()
        if target_name in seen_target_names:
            return
        seen_target_names.add(target_name)
        target_rows.append((number, target_name, element))

    if not target_rows:
        return
    numbers = [number for number, _, _ in target_rows]
    if numbers != list(range(1, len(target_rows) + 1)):
        return
    if not _has_legacy_named_notes_heading(target_rows[0][2]):
        return

    targets_by_id = {target_id: (number, target) for number, target_id, target in target_rows}
    marker_rows: list[tuple[int, str, HtmlElement]] = []
    marker_counts_by_target_id: dict[str, int] = {}
    for element in root.iter("a"):
        if not isinstance(element, HtmlElement):
            continue
        if (element.get("data-reader-apparatus-item-id") or "").strip():
            continue
        target_id = _local_target_id(element)
        if target_id not in targets_by_id:
            continue
        number, _ = targets_by_id[target_id]
        marker_text = _element_text(element)
        if marker_text != str(number):
            continue
        marker_counts_by_target_id[target_id] = marker_counts_by_target_id.get(target_id, 0) + 1
        marker_rows.append((number, target_id, element))

    if not marker_rows:
        return
    if any(marker_counts_by_target_id.get(target_id, 0) == 0 for _, target_id, _ in target_rows):
        return

    method = "html_legacy_named_notes"
    confidence = "strong"
    target_keys_by_id: dict[str, str] = {}
    for target_index, (number, target_id, target) in enumerate(target_rows):
        body_text = _legacy_named_note_body_text(target)
        if not body_text:
            return
        order_key = _source_order_key(target, target_index)
        target_key = f"{source_kind}:legacy-named-note:{_stable_token(target_id)}"
        target_keys_by_id[target_id] = target_key
        target_item_key_by_id[target_id] = target_key
        items.append(
            {
                "stable_key": target_key,
                "kind": "footnote",
                "label": str(number),
                "body_text": body_text,
                "body_html_sanitized": None,
                "confidence": confidence,
                "extraction_method": method,
                "source_ref": {
                    **source_ref,
                    "element": "a[name]",
                    "target_id": target_id,
                    "target_name": target_id,
                    "note_number": number,
                },
                "sort_key": f"{order_key}.target",
                "_locator_text": body_text,
            }
        )

    for marker_index, (number, target_id, marker) in enumerate(marker_rows):
        target_key = target_keys_by_id[target_id]
        order_key = _source_order_key(marker, marker_index)
        marker_key = (
            f"{source_kind}:legacy-named-note-ref:{marker_index:06d}:{_stable_token(target_id)}"
        )
        marker_text = _element_text(marker)
        marker_source_ref = {
            **source_ref,
            "element": "a[href]",
            "target_id": target_id,
            "target_name": target_id,
            "note_number": number,
            "marker_href": marker.get("href") or "",
        }
        marker_id = _source_element_id(marker)
        if marker_id:
            marker_source_ref["marker_id"] = marker_id
        marker.set("data-reader-apparatus-item-id", marker_key)
        marker.set("data-reader-apparatus-kind", "footnote_ref")
        marker.set("data-reader-apparatus-confidence", confidence)
        items.append(
            {
                "stable_key": marker_key,
                "kind": "footnote_ref",
                "label": marker_text,
                "body_text": None,
                "body_html_sanitized": None,
                "confidence": confidence,
                "extraction_method": method,
                "source_ref": marker_source_ref,
                "sort_key": f"{order_key}.marker",
                "_locator_text": marker_text,
            }
        )
        edges.append(
            {
                "stable_key": f"{marker_key}->{target_key}",
                "from_stable_key": marker_key,
                "to_stable_key": target_key,
                "relation": "points_to_note",
                "confidence": confidence,
                "extraction_method": method,
                "source_ref": marker_source_ref,
                "sort_key": f"{order_key}.edge",
            }
        )


def _extract_project_gutenberg_linknotes(
    root: HtmlElement,
    *,
    source_kind: str,
    source_ref: dict[str, object],
    items: list[dict[str, object]],
    edges: list[dict[str, object]],
    target_item_key_by_id: dict[str, str],
) -> None:
    target_rows: list[tuple[int, str, HtmlElement, HtmlElement, str]] = []
    seen_target_ids: set[str] = set()
    for element in root.iter("a"):
        if not isinstance(element, HtmlElement):
            continue
        number = _project_gutenberg_linknote_target_number(element)
        if number is None:
            continue
        target_id = (element.get("id") or "").strip()
        if target_id in seen_target_ids:
            return
        seen_target_ids.add(target_id)
        body = _project_gutenberg_linknote_body_element(element, number)
        if body is None:
            return
        body_text = _project_gutenberg_linknote_body_text(body, number)
        if not body_text:
            return
        target_rows.append((number, target_id, element, body, body_text))

    if not target_rows:
        return
    numbers = [number for number, _, _, _, _ in target_rows]
    if numbers != list(range(1, len(target_rows) + 1)):
        return

    marker_rows: list[tuple[int, str, str, HtmlElement]] = []
    seen_marker_ids: set[str] = set()
    for element in root.iter("a"):
        if not isinstance(element, HtmlElement):
            continue
        if (element.get("data-reader-apparatus-item-id") or "").strip():
            continue
        number = _project_gutenberg_linknote_ref_number(element)
        if number is None:
            continue
        marker_id = (element.get("id") or "").strip()
        if marker_id in seen_marker_ids:
            return
        seen_marker_ids.add(marker_id)
        target_id = _local_target_id(element)
        if target_id != f"linknote-{number}":
            return
        marker_text = _element_text(element)
        if marker_text not in {str(number), f"[{number}]"}:
            return
        marker_rows.append((number, marker_id, target_id, element))

    if not marker_rows:
        return
    target_ids = [target_id for _, target_id, _, _, _ in target_rows]
    if [number for number, _, _, _ in marker_rows] != numbers:
        return
    if [target_id for _, _, target_id, _ in marker_rows] != target_ids:
        return

    method = "html_project_gutenberg_linknote"
    confidence = "strong"
    target_keys_by_id: dict[str, str] = {}
    for target_index, (number, target_id, _target_anchor, body, body_text) in enumerate(
        target_rows
    ):
        order_key = _source_order_key(body, target_index)
        target_key = f"{source_kind}:project-gutenberg-linknote:{_stable_token(target_id)}"
        target_keys_by_id[target_id] = target_key
        target_item_key_by_id[target_id] = target_key
        body.set("data-reader-apparatus-item-id", target_key)
        body.set("data-reader-apparatus-kind", "endnote")
        body.set("data-reader-apparatus-confidence", confidence)
        items.append(
            {
                "stable_key": target_key,
                "kind": "endnote",
                "label": str(number),
                "body_text": body_text,
                "body_html_sanitized": None,
                "confidence": confidence,
                "extraction_method": method,
                "source_ref": {
                    **source_ref,
                    "element": "p.footnote",
                    "target_anchor_element": "a#linknote",
                    "target_id": target_id,
                    "note_number": number,
                    "backlink_href": f"#linknoteref-{number}",
                },
                "sort_key": f"{order_key}.target",
                "_locator_text": body_text,
            }
        )

    for marker_index, (number, marker_id, target_id, marker) in enumerate(marker_rows):
        target_key = target_keys_by_id[target_id]
        order_key = _source_order_key(marker, marker_index)
        marker_key = (
            f"{source_kind}:project-gutenberg-linknote-ref:"
            f"{marker_index:06d}:{_stable_token(target_id)}"
        )
        marker_text = _element_text(marker)
        marker_source_ref = {
            **source_ref,
            "element": "a[href]",
            "target_id": target_id,
            "marker_id": marker_id,
            "note_number": number,
            "marker_href": marker.get("href") or "",
        }
        marker.set("data-reader-apparatus-item-id", marker_key)
        marker.set("data-reader-apparatus-kind", "endnote_ref")
        marker.set("data-reader-apparatus-confidence", confidence)
        items.append(
            {
                "stable_key": marker_key,
                "kind": "endnote_ref",
                "label": marker_text,
                "body_text": None,
                "body_html_sanitized": None,
                "confidence": confidence,
                "extraction_method": method,
                "source_ref": marker_source_ref,
                "sort_key": f"{order_key}.marker",
                "_locator_text": marker_text,
            }
        )
        edges.append(
            {
                "stable_key": f"{marker_key}->{target_key}",
                "from_stable_key": marker_key,
                "to_stable_key": target_key,
                "relation": "points_to_endnote",
                "confidence": confidence,
                "extraction_method": method,
                "source_ref": marker_source_ref,
                "sort_key": f"{order_key}.edge",
            }
        )


def _legacy_named_note_number(element: HtmlElement) -> int | None:
    if str(element.tag).lower() != "a":
        return None
    match = _LEGACY_NAMED_NOTE_RE.fullmatch((element.get("name") or "").strip())
    if match is None:
        return None
    return int(match.group("number"))


def _has_legacy_named_notes_heading(first_target: HtmlElement) -> bool:
    parent = first_target.getparent()
    if not isinstance(parent, HtmlElement):
        return False
    for sibling in parent.iterchildren():
        if sibling is first_target:
            return False
        if not isinstance(sibling, HtmlElement):
            continue
        if normalize_whitespace(" ".join(sibling.itertext())).strip().lower() == "notes":
            return True
    return False


def _legacy_named_note_body_text(target: HtmlElement) -> str:
    parts: list[str] = []

    def append(value: str | None) -> None:
        if value and value.strip():
            parts.append(value)

    append(target.tail)
    for sibling in target.itersiblings():
        if not isinstance(sibling, HtmlElement):
            continue
        if _legacy_named_note_number(sibling) is not None:
            break
        if str(sibling.tag).lower() == "br":
            break
        append(_element_text(sibling))
        append(sibling.tail)

    text_value = normalize_whitespace(" ".join(parts))
    text_value = re.sub(r"^\]\s*", "", text_value)
    text_value = re.sub(r"\s+([,.;:!?])", r"\1", text_value)
    return re.sub(r"\s*\[\s*$", "", text_value).strip()


def _project_gutenberg_linknote_ref_number(element: HtmlElement) -> int | None:
    if str(element.tag).lower() != "a":
        return None
    match = _PROJECT_GUTENBERG_LINKNOTE_REF_RE.fullmatch((element.get("id") or "").strip())
    if match is None:
        return None
    return int(match.group("number"))


def _project_gutenberg_linknote_target_number(element: HtmlElement) -> int | None:
    if str(element.tag).lower() != "a":
        return None
    match = _PROJECT_GUTENBERG_LINKNOTE_TARGET_RE.fullmatch((element.get("id") or "").strip())
    if match is None:
        return None
    return int(match.group("number"))


def _project_gutenberg_linknote_body_element(
    target_anchor: HtmlElement,
    number: int,
) -> HtmlElement | None:
    parent = target_anchor.getparent()
    if not isinstance(parent, HtmlElement) or str(parent.tag).lower() != "p":
        return None
    body = next(
        (sibling for sibling in parent.itersiblings() if isinstance(sibling, HtmlElement)), None
    )
    if body is None or str(body.tag).lower() != "p" or "footnote" not in _class_tokens(body):
        return None
    first_child = next(
        (child for child in body.iterchildren() if isinstance(child, HtmlElement)),
        None,
    )
    if first_child is None or str(first_child.tag).lower() != "a":
        return None
    if (first_child.get("href") or "").strip() != f"#linknoteref-{number}":
        return None
    if _element_text(first_child) != str(number):
        return None
    return body


def _project_gutenberg_linknote_body_text(body: HtmlElement, number: int) -> str:
    text_value = _element_text(body)
    text_value = re.sub(rf"^{number}\s*", "", text_value, count=1)
    return text_value.strip()


def _html_string(html: str | bytes) -> str:
    if isinstance(html, bytes):
        return html.decode("utf-8", errors="replace")
    return html


def _external_targets_by_local_id(
    *,
    document_href: str | None,
    external_targets: Mapping[str, Mapping[str, object]],
) -> dict[str, Mapping[str, object]]:
    if not document_href:
        return {}
    prefix = f"{document_href}#"
    return {
        target_ref[len(prefix) :]: target
        for target_ref, target in external_targets.items()
        if target_ref.startswith(prefix)
    }


def _materialize_external_targets_in_document(
    *,
    targets: dict[str, HtmlElement],
    external_targets_by_local_id: Mapping[str, Mapping[str, object]],
    target_item_key_by_id: dict[str, str],
    items: list[dict[str, object]],
) -> None:
    for target_id, external_target in external_targets_by_local_id.items():
        target = targets.get(target_id)
        if target is None or target_id in target_item_key_by_id:
            continue
        target_key = str(external_target["stable_key"])
        target_kind = str(external_target["kind"])
        confidence = str(external_target["confidence"])
        body_text = str(external_target.get("body_text") or "")
        if not body_text:
            continue
        target.set("data-reader-apparatus-item-id", target_key)
        target.set("data-reader-apparatus-kind", target_kind)
        target.set("data-reader-apparatus-confidence", confidence)
        target_item_key_by_id[target_id] = target_key
        items.append(
            {
                "stable_key": target_key,
                "kind": target_kind,
                "label": external_target.get("label"),
                "body_text": body_text,
                "body_html_sanitized": None,
                "confidence": confidence,
                "extraction_method": str(external_target["extraction_method"]),
                "source_ref": dict(external_target.get("source_ref") or {}),
                "sort_key": str(external_target["sort_key"]),
                "_locator_text": body_text,
            }
        )


def attach_fragment_locators(
    *,
    media_id: UUID,
    fragment_id: UUID,
    media_kind: str,
    canonical_text: str,
    items: list[dict[str, object]],
    html_sanitized: str | None = None,
) -> list[dict[str, object]]:
    locator_text_by_key = _apparatus_locator_text_by_key(html_sanitized)
    locator_span_by_key = _apparatus_locator_span_by_key(
        html_sanitized,
        canonical_text,
    )
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
        if span is not None:
            start, end = span
            item["locator_status"] = "exact"
            item["locator"] = {
                "type": "web_text_offsets"
                if media_kind == "web_article"
                else "epub_fragment_offsets",
                "media_id": str(media_id),
                "fragment_id": str(fragment_id),
                "start_offset": start,
                "end_offset": end,
                "media_kind": media_kind,
                "text_quote_selector": {"exact": locator_text},
            }
        else:
            item["locator_status"] = "missing"
            item["locator"] = None
        result.append(item)
    return result


def _apparatus_locator_span_by_key(
    html_sanitized: str | None,
    canonical_text: str,
) -> dict[str, tuple[int, int, str]]:
    locator_spans: dict[str, tuple[int, int, str]] = {}
    if not html_sanitized or not html_sanitized.strip() or not canonical_text:
        return locator_spans
    try:
        root = document_fromstring(f"<div>{html_sanitized}</div>")
    except ParserError:
        return locator_spans

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
        _wrap_element_text_with_tokens(element, start_token, end_token)
        token_pairs.append((stable_key, start_token, end_token))
        seen_keys.add(stable_key)

    if not token_pairs:
        return locator_spans

    rendered = tostring(root, encoding="unicode", method="html")
    html_with_tokens = rendered.decode("utf-8") if isinstance(rendered, bytes) else rendered
    canonical_with_tokens = generate_canonical_text(html_with_tokens)
    token_values = [token for _stable_key, *tokens in token_pairs for token in tokens]
    canonical_without_tokens = canonical_with_tokens
    for token in token_values:
        canonical_without_tokens = canonical_without_tokens.replace(token, "")
    if canonical_without_tokens != canonical_text:
        return locator_spans

    token_positions: list[tuple[int, int]] = []
    pair_positions: dict[str, tuple[int, int, str, str]] = {}
    for stable_key, start_token, end_token in token_pairs:
        start_token_pos = canonical_with_tokens.find(start_token)
        end_token_pos = canonical_with_tokens.find(end_token)
        if start_token_pos < 0 or end_token_pos < 0 or end_token_pos < start_token_pos:
            continue
        token_positions.append((start_token_pos, len(start_token)))
        token_positions.append((end_token_pos, len(end_token)))
        pair_positions[stable_key] = (start_token_pos, end_token_pos, start_token, end_token)
    token_positions.sort()

    for stable_key, (
        start_token_pos,
        end_token_pos,
        start_token,
        _end_token,
    ) in pair_positions.items():
        start = (
            start_token_pos
            + len(start_token)
            - _removed_token_length_before(
                token_positions,
                start_token_pos + len(start_token),
            )
        )
        end = end_token_pos - _removed_token_length_before(token_positions, end_token_pos)
        locator_text = canonical_text[start:end]
        if locator_text:
            locator_spans[stable_key] = (start, end, locator_text)
    return locator_spans


def _wrap_element_text_with_tokens(element: HtmlElement, start_token: str, end_token: str) -> None:
    element.text = f"{start_token}{element.text or ''}"
    children = list(element)
    if children:
        last_child = children[-1]
        last_child.tail = f"{last_child.tail or ''}{end_token}"
    else:
        element.text = f"{element.text or ''}{end_token}"


def _removed_token_length_before(token_positions: list[tuple[int, int]], position: int) -> int:
    return sum(
        token_length
        for token_position, token_length in token_positions
        if token_position < position
    )


def _apparatus_locator_text_by_key(html_sanitized: str | None) -> dict[str, str]:
    return {
        stable_key: locator_text
        for stable_key, locator_text in _apparatus_locator_texts_in_order(html_sanitized)
    }


def _apparatus_locator_texts_in_order(html_sanitized: str | None) -> list[tuple[str, str]]:
    if not html_sanitized or not html_sanitized.strip():
        return []
    try:
        root = document_fromstring(f"<div>{html_sanitized}</div>")
    except ParserError:
        return []
    locator_texts: list[tuple[str, str]] = []
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        stable_key = (element.get("data-reader-apparatus-item-id") or "").strip()
        if not stable_key:
            continue
        rendered = tostring(element, encoding="unicode", method="html")
        html = rendered.decode("utf-8") if isinstance(rendered, bytes) else rendered
        text_value = generate_canonical_text(html)
        if text_value:
            locator_texts.append((stable_key, text_value))
    return locator_texts


def get_media_apparatus(db: Session, viewer_id: UUID, media_id: UUID) -> ReaderApparatusResponse:
    media = _visible_media(db, viewer_id, media_id)
    kind = str(media["kind"])
    status = str(media["processing_status"])

    if kind not in SUPPORTED_MEDIA_KINDS:
        return ReaderApparatusResponse(
            media_id=media_id,
            media_kind=kind,
            status="unsupported",
            extractor_version=EXTRACTOR_VERSION,
            source_fingerprint=source_fingerprint(media_id, kind, "unsupported"),
            capabilities=_capabilities([], []),
            items=[],
            edges=[],
            diagnostics={"reason": "unsupported_media_kind"},
        )
    if not is_document_status_ready(status):
        raise ApiError(ApiErrorCode.E_MEDIA_NOT_READY, "Media is not ready for reading")

    state = (
        db.execute(
            text(
                """
            SELECT id, media_kind, source_fingerprint, extractor_version, status,
                   item_count, edge_count, diagnostics
            FROM reader_apparatus_states
            WHERE media_id = :media_id
            """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .fetchone()
    )
    if state is None:
        raise ApiError(
            ApiErrorCode.E_READER_APPARATUS_STATE_MISSING,
            "Reader apparatus state is missing",
        )

    _validate_state_counts(
        status=str(state["status"]),
        item_count=int(state["item_count"]),
        edge_count=int(state["edge_count"]),
    )

    item_rows = (
        db.execute(
            text(
                """
            SELECT id, stable_key, kind, label, body_text, body_html_sanitized,
                   locator, locator_status, confidence, extraction_method,
                   source_ref, sort_key
            FROM reader_apparatus_items
            WHERE state_id = :state_id
            ORDER BY sort_key, stable_key
            """
            ),
            {"state_id": state["id"]},
        )
        .mappings()
        .all()
    )
    items = [
        ReaderApparatusItemOut(
            id=row["id"],
            resource_ref=f"reader_apparatus_item:{row['id']}",
            stable_key=str(row["stable_key"]),
            kind=row["kind"],
            label=row["label"],
            body_text=row["body_text"],
            body_html_sanitized=row["body_html_sanitized"],
            locator=retrieval_locator_json(row["locator"]),
            locator_status=row["locator_status"],
            confidence=row["confidence"],
            extraction_method=str(row["extraction_method"]),
            source_ref=dict(row["source_ref"] or {}),
            sort_key=str(row["sort_key"]),
        )
        for row in item_rows
    ]

    edge_rows = (
        db.execute(
            text(
                """
            SELECT edge.stable_key,
                   source.stable_key AS from_stable_key,
                   target.stable_key AS to_stable_key,
                   edge.relation,
                   edge.confidence,
                   edge.extraction_method,
                   edge.source_ref,
                   edge.sort_key
            FROM reader_apparatus_edges edge
            JOIN reader_apparatus_items source
              ON source.id = edge.from_item_id
             AND source.state_id = edge.state_id
            JOIN reader_apparatus_items target
              ON target.id = edge.to_item_id
             AND target.state_id = edge.state_id
            WHERE edge.state_id = :state_id
            ORDER BY edge.sort_key, edge.stable_key
            """
            ),
            {"state_id": state["id"]},
        )
        .mappings()
        .all()
    )
    edges = [
        ReaderApparatusEdgeOut(
            stable_key=str(row["stable_key"]),
            from_stable_key=str(row["from_stable_key"]),
            to_stable_key=str(row["to_stable_key"]),
            relation=row["relation"],
            confidence=row["confidence"],
            extraction_method=str(row["extraction_method"]),
            source_ref=dict(row["source_ref"] or {}),
            sort_key=str(row["sort_key"]),
        )
        for row in edge_rows
    ]

    if len(items) != int(state["item_count"]) or len(edges) != int(state["edge_count"]):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus state counts are stale")

    return ReaderApparatusResponse(
        media_id=media_id,
        media_kind=str(state["media_kind"]),
        status=state["status"],
        extractor_version=str(state["extractor_version"]),
        source_fingerprint=str(state["source_fingerprint"]),
        capabilities=_capabilities(items, edges),
        items=items,
        edges=edges,
        diagnostics=dict(state["diagnostics"] or {}),
    )


def replace_media_apparatus(
    db: Session,
    *,
    media_id: UUID,
    media_kind: str,
    source_fingerprint_value: str,
    items: list[dict[str, object]] | None = None,
    edges: list[dict[str, object]] | None = None,
    status: str | None = None,
    diagnostics: dict[str, object] | None = None,
) -> None:
    items = items or []
    edges = edges or []
    if status is None:
        status = "ready" if items else "empty"
    _validate_replacement(status=status, items=items, edges=edges)

    delete_media_apparatus(db, media_id)
    state_id = db.execute(
        text(
            """
            INSERT INTO reader_apparatus_states (
                media_id, media_kind, source_fingerprint, extractor_version,
                status, item_count, edge_count, diagnostics
            )
            VALUES (
                :media_id, :media_kind, :source_fingerprint, :extractor_version,
                :status, :item_count, :edge_count, :diagnostics
            )
            RETURNING id
            """
        ).bindparams(bindparam("diagnostics", type_=JSONB)),
        {
            "media_id": media_id,
            "media_kind": media_kind,
            "source_fingerprint": source_fingerprint_value,
            "extractor_version": EXTRACTOR_VERSION,
            "status": status,
            "item_count": len(items),
            "edge_count": len(edges),
            "diagnostics": diagnostics or {},
        },
    ).scalar_one()

    ids_by_key: dict[str, UUID] = {}
    item_insert = text(
        """
        INSERT INTO reader_apparatus_items (
            media_id, state_id, stable_key, kind, label, body_text,
            body_html_sanitized, locator, locator_status, confidence,
            extraction_method, source_ref, sort_key
        )
        VALUES (
            :media_id, :state_id, :stable_key, :kind, :label, :body_text,
            :body_html_sanitized, :locator, :locator_status, :confidence,
            :extraction_method, :source_ref, :sort_key
        )
        RETURNING id
        """
    ).bindparams(
        bindparam("locator", type_=JSONB(none_as_null=True)),
        bindparam("source_ref", type_=JSONB),
    )
    for item in items:
        locator = retrieval_locator_json(item.get("locator")) if item.get("locator") else None
        stable_key = str(item["stable_key"])
        item_id = db.execute(
            item_insert,
            {
                "media_id": media_id,
                "state_id": state_id,
                "stable_key": stable_key,
                "kind": item["kind"],
                "label": item.get("label"),
                "body_text": item.get("body_text"),
                "body_html_sanitized": item.get("body_html_sanitized"),
                "locator": locator,
                "locator_status": item.get("locator_status", "exact" if locator else "missing"),
                "confidence": item["confidence"],
                "extraction_method": item["extraction_method"],
                "source_ref": item.get("source_ref") or {},
                "sort_key": item["sort_key"],
            },
        ).scalar_one()
        ids_by_key[stable_key] = item_id

    edge_insert = text(
        """
        INSERT INTO reader_apparatus_edges (
            media_id, state_id, stable_key, from_item_id, to_item_id, relation,
            confidence, extraction_method, source_ref, sort_key
        )
        VALUES (
            :media_id, :state_id, :stable_key, :from_item_id, :to_item_id,
            :relation, :confidence, :extraction_method, :source_ref, :sort_key
        )
        """
    ).bindparams(bindparam("source_ref", type_=JSONB))
    for edge in edges:
        from_key = str(edge["from_stable_key"])
        to_key = str(edge["to_stable_key"])
        if from_key not in ids_by_key or to_key not in ids_by_key:
            raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus edge points to missing item")
        db.execute(
            edge_insert,
            {
                "media_id": media_id,
                "state_id": state_id,
                "stable_key": edge["stable_key"],
                "from_item_id": ids_by_key[from_key],
                "to_item_id": ids_by_key[to_key],
                "relation": edge["relation"],
                "confidence": edge["confidence"],
                "extraction_method": edge["extraction_method"],
                "source_ref": edge.get("source_ref") or {},
                "sort_key": edge["sort_key"],
            },
        )
    db.flush()


def delete_media_apparatus(db: Session, media_id: UUID) -> None:
    db.execute(
        text(
            """
            DELETE FROM message_retrievals
            WHERE result_type = 'reader_apparatus_item'
              AND source_id IN (
                  SELECT id::text
                  FROM reader_apparatus_items
                  WHERE media_id = :media_id
              )
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM message_retrieval_candidate_ledgers
            WHERE result_type = 'reader_apparatus_item'
              AND source_id IN (
                  SELECT id::text
                  FROM reader_apparatus_items
                  WHERE media_id = :media_id
              )
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM resource_versions
            WHERE resource_scheme = 'reader_apparatus_item'
              AND resource_id IN (
                  SELECT id
                  FROM reader_apparatus_items
                  WHERE media_id = :media_id
              )
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM resource_view_states
            WHERE (
                target_scheme = 'reader_apparatus_item'
                AND target_id IN (
                    SELECT id
                    FROM reader_apparatus_items
                    WHERE media_id = :media_id
                )
            )
            OR edge_id IN (
                SELECT id
                FROM resource_edges
                WHERE (source_scheme = 'reader_apparatus_item'
                    OR target_scheme = 'reader_apparatus_item')
                  AND (source_id IN (
                        SELECT id
                        FROM reader_apparatus_items
                        WHERE media_id = :media_id
                      )
                       OR target_id IN (
                        SELECT id
                        FROM reader_apparatus_items
                        WHERE media_id = :media_id
                      ))
            )
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text(
            """
            DELETE FROM resource_edges
            WHERE (source_scheme = 'reader_apparatus_item' OR target_scheme = 'reader_apparatus_item')
              AND (source_id IN (
                    SELECT id
                    FROM reader_apparatus_items
                    WHERE media_id = :media_id
                  )
                   OR target_id IN (
                    SELECT id
                    FROM reader_apparatus_items
                    WHERE media_id = :media_id
                  ))
            """
        ),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM reader_apparatus_edges WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM reader_apparatus_items WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.execute(
        text("DELETE FROM reader_apparatus_states WHERE media_id = :media_id"),
        {"media_id": media_id},
    )
    db.flush()


def _fingerprint_part(part: object) -> dict[str, object]:
    if part is None:
        return {"type": "null", "value": None}
    if isinstance(part, UUID):
        return {"type": "uuid", "value": str(part)}
    if isinstance(part, bool):
        return {"type": "bool", "value": part}
    if isinstance(part, int):
        return {"type": "int", "value": part}
    if isinstance(part, float):
        return {"type": "float", "value": repr(part)}
    if isinstance(part, str):
        return {"type": "str", "value": part}
    if isinstance(part, (list, tuple)):
        return {
            "type": type(part).__name__,
            "value": [_fingerprint_part(value) for value in part],
        }
    if isinstance(part, dict):
        return {
            "type": "dict",
            "value": {
                str(key): _fingerprint_part(value)
                for key, value in sorted(part.items(), key=lambda item: str(item[0]))
            },
        }
    return {"type": type(part).__name__, "value": str(part)}


def _validate_replacement(
    *,
    status: str,
    items: list[dict[str, object]],
    edges: list[dict[str, object]],
) -> None:
    if status not in {"ready", "empty", "partial", "unsupported", "failed"}:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Invalid reader apparatus status")
    if status in {"empty", "unsupported", "failed"} and (items or edges):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Terminal empty apparatus states cannot carry rows")
    if status in {"ready", "partial"} and not items:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus state needs items")


def _validate_state_counts(*, status: str, item_count: int, edge_count: int) -> None:
    if item_count < 0 or edge_count < 0:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus state counts are invalid")
    if status in {"empty", "unsupported", "failed"} and (item_count != 0 or edge_count != 0):
        raise ApiError(ApiErrorCode.E_INTERNAL, "Terminal empty apparatus state has rows")
    if status in {"ready", "partial"} and item_count == 0:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Reader apparatus state has no items")
    if status not in {"ready", "empty", "partial", "unsupported", "failed"}:
        raise ApiError(ApiErrorCode.E_INTERNAL, "Invalid reader apparatus status")


def _visible_media(db: Session, viewer_id: UUID, media_id: UUID) -> dict[str, object]:
    if not can_read_media(db, viewer_id, media_id):
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    row = (
        db.execute(
            text("SELECT kind, processing_status FROM media WHERE id = :media_id"),
            {"media_id": media_id},
        )
        .mappings()
        .fetchone()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_MEDIA_NOT_FOUND, "Media not found")
    return dict(row)


def _capabilities(
    items: list[ReaderApparatusItemOut],
    edges: list[ReaderApparatusEdgeOut],
) -> ReaderApparatusCapabilities:
    locators = [item for item in items if item.locator is not None]
    return ReaderApparatusCapabilities(
        has_inline_markers=any(item.kind.endswith("_ref") and item.locator for item in items),
        has_sidecar_items=bool(items),
        supports_hover_preview=bool(edges),
        supports_jump_to_marker=any(item.kind.endswith("_ref") for item in locators),
        supports_jump_to_target=any(not item.kind.endswith("_ref") for item in locators),
        has_probable_items=any(item.confidence == "probable" for item in items)
        or any(edge.confidence == "probable" for edge in edges),
    )


def _local_target_id(element: HtmlElement) -> str | None:
    if str(element.tag).lower() == "xref":
        rid = (element.get("rid") or "").strip()
        return rid or None
    href = (element.get("href") or "").strip()
    if href.startswith("#") and len(href) > 1:
        return unquote(href[1:])
    return None


def _classify_link(
    marker: HtmlElement,
    target: HtmlElement,
) -> tuple[str | None, str | None, str | None, str | None, str | None]:
    marker_tokens = _semantic_tokens(marker)
    ref_type = (marker.get("ref-type") or "").strip().lower()
    semantic_target_context = _semantic_target_context(target)
    target_context = _target_context(target)

    if "noteref" in marker_tokens or "doc-noteref" in marker_tokens or ref_type == "fn":
        if semantic_target_context == "endnote":
            return "endnote_ref", "endnote", "points_to_endnote", "html_semantic", "exact"
        if semantic_target_context == "note":
            return "footnote_ref", "footnote", "points_to_note", "html_semantic", "exact"
        if target_context == "note" and _has_backlink(marker, target):
            return "footnote_ref", "footnote", "points_to_note", "html_link_graph", "strong"
        return None, None, None, None, None
    if "biblioref" in marker_tokens or "doc-biblioref" in marker_tokens or ref_type == "bibr":
        if semantic_target_context == "bibliography" and _is_bibliography_entry_target(target):
            return (
                "bibliography_ref",
                "bibliography_entry",
                "cites_bibliography_entry",
                "html_semantic",
                "exact",
            )
        if target_context == "bibliography" and _is_bibliography_entry_target(target):
            return (
                "bibliography_ref",
                "bibliography_entry",
                "cites_bibliography_entry",
                "html_link_graph",
                "strong",
            )
        return None, None, None, None, None
    if str(marker.tag).lower() == "a" and _parent_tag(marker) == "sup":
        if target_context == "note" and _has_backlink(marker, target):
            return "footnote_ref", "footnote", "points_to_note", "html_link_graph", "strong"
        if target_context == "bibliography" and _is_bibliography_entry_target(target):
            return (
                "bibliography_ref",
                "bibliography_entry",
                "cites_bibliography_entry",
                "html_link_graph",
                "strong",
            )
    return None, None, None, None, None


def _classify_external_link(
    marker: HtmlElement,
    target: Mapping[str, object],
    *,
    document_href: str | None,
) -> tuple[str | None, str | None, str | None, str | None, str | None]:
    marker_tokens = _semantic_tokens(marker)
    ref_type = (marker.get("ref-type") or "").strip().lower()
    context = str(target.get("context") or "")
    method = str(target.get("extraction_method") or "html_semantic")
    confidence = str(target.get("confidence") or "exact")

    if "noteref" in marker_tokens or "doc-noteref" in marker_tokens or ref_type == "fn":
        if context == "endnote":
            return "endnote_ref", "endnote", "points_to_endnote", method, confidence
        if context == "note":
            return "footnote_ref", "footnote", "points_to_note", method, confidence
        return None, None, None, None, None
    if "biblioref" in marker_tokens or "doc-biblioref" in marker_tokens or ref_type == "bibr":
        if context == "bibliography":
            return (
                "bibliography_ref",
                "bibliography_entry",
                "cites_bibliography_entry",
                method,
                confidence,
            )
        return None, None, None, None, None
    if str(marker.tag).lower() == "a" and _parent_tag(marker) == "sup":
        if context == "note" and _external_target_has_backlink(
            marker,
            target,
            document_href=document_href,
        ):
            return "footnote_ref", "footnote", "points_to_note", method, "strong"
        if context == "endnote" and _external_target_has_backlink(
            marker,
            target,
            document_href=document_href,
        ):
            return "endnote_ref", "endnote", "points_to_endnote", method, "strong"
        if context == "bibliography":
            return (
                "bibliography_ref",
                "bibliography_entry",
                "cites_bibliography_entry",
                method,
                "strong",
            )
    return None, None, None, None, None


def _semantic_target_context(target: HtmlElement) -> str | None:
    for element in [target, *target.iterancestors()]:
        if not isinstance(element, HtmlElement):
            continue
        tag = str(element.tag).lower()
        tokens = _semantic_tokens(element)
        if tokens & {"endnote", "endnotes", "doc-endnote", "doc-endnotes"}:
            return "endnote"
        if tag in {"fn", "footnote", "d-footnote"} or tokens & {
            "footnote",
            "doc-footnote",
        }:
            return "note"
        if tag in {
            "ref",
            "ref-list",
            "d-citation-list",
            "d-bibliography",
            "dt-bibliography",
        } or tokens & {
            "bibliography",
            "biblioentry",
            "doc-bibliography",
            "doc-biblioentry",
        }:
            return "bibliography"
    return None


def _target_context(target: HtmlElement) -> str | None:
    for element in [target, *target.iterancestors()]:
        if not isinstance(element, HtmlElement):
            continue
        tokens = _semantic_tokens(element)
        classes = _class_tokens(element)
        if tokens & {"endnote", "doc-endnote", "endnotes", "doc-endnotes"}:
            return "note"
        if tokens & {"footnote", "doc-footnote", "endnote", "doc-endnote"}:
            return "note"
        if classes & {"references", "reference-text", "mw-references-wrap"}:
            return "note"
        if str(element.tag).lower() in {"d-footnote"}:
            return "note"
        if str(element.tag).lower() in {"d-citation-list", "d-bibliography", "dt-bibliography"}:
            return "bibliography"
        if tokens & {"bibliography", "biblioentry", "doc-bibliography", "doc-biblioentry"}:
            return "bibliography"
        text = _element_text(element).lower()
        if str(element.tag).lower() in {"aside", "section", "div", "ol", "ul"}:
            if any(word in text[:80] for word in ("footnote", "endnote", "notes")):
                return "note"
            if any(word in text[:80] for word in ("references", "bibliography")):
                return "bibliography"
    target_id = (target.get("id") or target.get("name") or "").lower()
    if target_id.startswith(("cite_note", "cite-note")):
        return "note"
    if target_id.startswith(("fn", "footnote", "note")):
        return "note"
    if target_id.startswith(("ref", "bib")):
        return "bibliography"
    return None


def _has_backlink(marker: HtmlElement, target: HtmlElement) -> bool:
    marker_id = _source_element_id(marker)
    if not marker_id:
        return False
    expected_href = f"#{marker_id}"
    for element in target.iter():
        if not isinstance(element, HtmlElement):
            continue
        if str(element.tag).lower() != "a":
            continue
        if unquote((element.get("href") or "").strip()) == expected_href:
            return True
    return False


def _external_target_has_backlink(
    marker: HtmlElement,
    target: Mapping[str, object],
    *,
    document_href: str | None,
) -> bool:
    marker_id = _source_element_id(marker)
    if not marker_id or not document_href:
        return False
    backlinks = target.get("backlinks")
    if not isinstance(backlinks, list):
        return False
    return f"{document_href}#{marker_id}" in {str(href) for href in backlinks}


def _is_bibliography_entry_target(target: HtmlElement) -> bool:
    tag = str(target.tag).lower()
    tokens = _semantic_tokens(target)
    if tag in {"ref", "li"} or tokens & {"biblioentry", "doc-biblioentry"}:
        return True
    if tag in {
        "section",
        "div",
        "ol",
        "ref-list",
        "ul",
        "d-citation-list",
        "d-bibliography",
        "dt-bibliography",
    }:
        return False
    return _semantic_target_context(target) == "bibliography"


def _is_note_body_target(target: HtmlElement) -> bool:
    tag = str(target.tag).lower()
    tokens = _semantic_tokens(target)
    if tokens & {"endnotes", "doc-endnotes"}:
        return False
    if tag in {"li", "aside", "fn", "footnote"}:
        return True
    return bool(tokens & {"footnote", "doc-footnote", "endnote", "doc-endnote"})


def _target_kind_for_context(context: str) -> str:
    if context == "endnote":
        return "endnote"
    if context == "bibliography":
        return "bibliography_entry"
    return "footnote"


def _external_target_for_marker(
    marker: HtmlElement,
    external_targets: Mapping[str, Mapping[str, object]],
) -> Mapping[str, object] | None:
    target_ref = _target_ref(marker)
    if not target_ref:
        return None
    return external_targets.get(target_ref)


def _target_ref(element: HtmlElement) -> str | None:
    if str(element.tag).lower() == "xref":
        rid = (element.get("rid") or "").strip()
        return rid or None
    href = (element.get("href") or "").strip()
    return href or None


def _link_hrefs(element: HtmlElement) -> list[str]:
    hrefs: list[str] = []
    for descendant in element.iter():
        if not isinstance(descendant, HtmlElement):
            continue
        if str(descendant.tag).lower() != "a":
            continue
        href = (descendant.get("href") or "").strip()
        if href:
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
        parent_value = (parent.get("id") or parent.get("name") or "").strip()
        if parent_value:
            return parent_value
    return None


def _parent_tag(element: HtmlElement) -> str | None:
    parent = element.getparent()
    if isinstance(parent, HtmlElement):
        return str(parent.tag).lower()
    return None


def _class_tokens(element: HtmlElement) -> set[str]:
    return {
        token.strip().lower() for token in (element.get("class") or "").split() if token.strip()
    }


def _ordered_unique_strings(values: Iterable[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def _distill_bibliography_text_by_key(root: HtmlElement) -> dict[str, str]:
    entries: dict[str, str] = {}
    for element in root.iter():
        if not isinstance(element, HtmlElement):
            continue
        if str(element.tag).lower() != "script":
            continue
        parent = element.getparent()
        if not isinstance(parent, HtmlElement):
            continue
        raw = element.text or ""
        if not raw.strip():
            continue
        script_type = (element.get("type") or "").strip().lower()
        parent_tag = str(parent.tag).lower()
        if script_type == "text/bibliography":
            entries.update(_bibtex_bibliography_text_by_key(raw))
            continue
        if parent_tag not in {"d-bibliography", "dt-bibliography"}:
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, list):
            continue
        for row in parsed:
            if not (
                isinstance(row, list)
                and len(row) == 2
                and isinstance(row[0], str)
                and isinstance(row[1], dict)
            ):
                continue
            text_value = _bibliography_data_text(row[1])
            if text_value:
                entries[row[0]] = text_value
    return entries


def _bibtex_bibliography_text_by_key(raw: str) -> dict[str, str]:
    entries: dict[str, str] = {}
    for key, body in _bibtex_entries(raw):
        data = _bibtex_fields(body)
        text_value = _bibliography_data_text(data)
        if text_value:
            entries[key] = text_value
    return entries


def _bibtex_entries(raw: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    index = 0
    while True:
        start = raw.find("@", index)
        if start < 0:
            return entries
        open_brace = raw.find("{", start)
        if open_brace < 0:
            return entries
        comma = raw.find(",", open_brace)
        if comma < 0:
            return entries
        key = raw[open_brace + 1 : comma].strip()
        depth = 1
        pos = open_brace + 1
        while pos + 1 < len(raw) and depth:
            pos += 1
            char = raw[pos]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
        if depth == 0 and key:
            entries.append((key, raw[comma + 1 : pos]))
        index = pos + 1


def _bibtex_fields(body: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    index = 0
    while index < len(body):
        match = re.search(r"([A-Za-z][A-Za-z0-9_-]*)\s*=\s*", body[index:])
        if match is None:
            break
        name = match.group(1).lower()
        value_start = index + match.end()
        if value_start >= len(body):
            break
        if body[value_start] == "{":
            value, index = _read_balanced_bibtex_value(body, value_start)
        elif body[value_start] == '"':
            value, index = _read_quoted_bibtex_value(body, value_start)
        else:
            value_end = body.find(",", value_start)
            if value_end < 0:
                value_end = len(body)
            value = body[value_start:value_end]
            index = value_end + 1
        fields[name] = normalize_whitespace(value.strip().strip(","))
    return fields


def _read_balanced_bibtex_value(body: str, start: int) -> tuple[str, int]:
    depth = 1
    pos = start
    while pos + 1 < len(body) and depth:
        pos += 1
        char = body[pos]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
    if depth:
        return body[start + 1 :].strip(), len(body)
    return body[start + 1 : pos].strip(), pos + 1


def _read_quoted_bibtex_value(body: str, start: int) -> tuple[str, int]:
    pos = start + 1
    escaped = False
    while pos < len(body):
        char = body[pos]
        if char == '"' and not escaped:
            return body[start + 1 : pos].strip(), pos + 1
        escaped = char == "\\" and not escaped
        if char != "\\":
            escaped = False
        pos += 1
    return body[start + 1 :].strip(), len(body)


def _bibliography_data_text(data: dict[object, object]) -> str:
    parts: list[str] = []
    for key in ("title", "author", "journal", "booktitle", "publisher", "year", "doi", "url"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip())
    return normalize_whitespace(". ".join(parts))


def _bibliography_target_locator_text(target: HtmlElement, fallback: str) -> str:
    for element in target.iter():
        if not isinstance(element, HtmlElement):
            continue
        if "title" not in _class_tokens(element):
            continue
        text_value = _element_text(element)
        if text_value:
            return text_value
    return fallback


def _source_order_key(element: HtmlElement, fallback: int) -> str:
    order = 0
    for ancestor in element.iterancestors():
        order += 1
        for sibling in ancestor.itersiblings(preceding=True):
            if isinstance(sibling, HtmlElement):
                order += 1
    for sibling in element.itersiblings(preceding=True):
        if isinstance(sibling, HtmlElement):
            order += 1
    return f"{order:06d}.{fallback:06d}"


def _stable_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")
    return token[:96] or "item"


def _unique_text_span(canonical_text: str, locator_text: str) -> tuple[int, int] | None:
    if not locator_text:
        return None
    matches = [match.start() for match in re.finditer(re.escape(locator_text), canonical_text)]
    if len(matches) != 1:
        return None
    start = matches[0]
    return start, start + len(locator_text)


def _inner_html(root: HtmlElement) -> str:
    if str(root.tag).lower() == "body":
        return "".join(tostring(child, encoding="unicode", method="html") for child in root)
    return tostring(root, encoding="unicode", method="html")
