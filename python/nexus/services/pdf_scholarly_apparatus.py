"""Scholarly PDF apparatus extraction from structured TEI evidence."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

from lxml import etree

from nexus.services.pdf_highlight_geometry import (
    GeometryValidationError,
    canonicalize_geometry,
    validate_exact_length,
)
from nexus.text import normalize_whitespace

_TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}
_XML_ID = "{http://www.w3.org/XML/1998/namespace}id"
_ADAPTER_VERSION = "grobid_tei_scholarly_v1"


@dataclass(frozen=True)
class ScholarlyTeiApparatus:
    status: str = "empty"
    items: list[dict[str, object]] = field(default_factory=list)
    edges: list[dict[str, object]] = field(default_factory=list)
    diagnostics: dict[str, object] = field(default_factory=dict)


def extract_scholarly_tei_apparatus(
    tei_xml: bytes,
    *,
    source_kind: str,
    source_ref: dict[str, object],
) -> ScholarlyTeiApparatus:
    """Extract a conservative bibliography graph from GROBID-style TEI.

    This adapter consumes structured TEI only. It does not infer citations from
    raw PDF text, author-year strings, superscripts, or reference sections.
    """

    try:
        root = _parse_tei(tei_xml)
    except etree.XMLSyntaxError as exc:
        return ScholarlyTeiApparatus(
            diagnostics={
                "grobid_tei_scholarly": {
                    "status": "parse_failed",
                    "adapter_version": _ADAPTER_VERSION,
                    "error": str(exc),
                }
            }
        )

    tei_sha256 = hashlib.sha256(tei_xml).hexdigest()
    base_source_ref = {
        **source_ref,
        "format": "grobid_tei",
        "tei_sha256": tei_sha256,
        "adapter_version": _ADAPTER_VERSION,
    }

    items: list[dict[str, object]] = []
    edges: list[dict[str, object]] = []
    skipped: dict[str, int] = {}
    target_key_by_id: dict[str, str] = {}
    target_id_by_key: dict[str, str] = {}
    target_ids_by_author_year_key: dict[tuple[str, ...], set[str]] = {}

    bibl_structs = root.xpath("//tei:listBibl/tei:biblStruct", namespaces=_TEI_NS)
    for index, element in enumerate(bibl_structs):
        target_id = str(element.get(_XML_ID) or "")
        if not target_id:
            _increment(skipped, "bibliography_entry_missing_id")
            continue
        body_text = _bibliography_entry_text(element)
        if not body_text:
            _increment(skipped, "bibliography_entry_missing_text")
            continue
        stable_key = f"{source_kind}:grobid-bibliography-entry:{target_id}"
        target_key_by_id[target_id] = stable_key
        target_id_by_key[stable_key] = target_id
        _index_author_year_match_keys(
            target_ids_by_author_year_key,
            element=element,
            body_text=body_text,
            target_id=target_id,
        )
        locator, locator_status = _locator_from_coords(
            element.get("coords"),
            media_id=str(source_ref.get("media_id") or ""),
            exact=body_text,
            skipped=skipped,
            skip_key="bibliography_entry_invalid_coords",
        )
        items.append(
            {
                "stable_key": stable_key,
                "kind": "bibliography_entry",
                "label": target_id,
                "body_text": body_text,
                "body_html_sanitized": None,
                "locator": locator,
                "locator_status": locator_status,
                "confidence": "probable",
                "extraction_method": "grobid_tei_bibliography_entry",
                "source_ref": {
                    **base_source_ref,
                    "tei_element": "biblStruct",
                    "target_id": target_id,
                    "coords": element.get("coords"),
                },
                "sort_key": f"bibliography.{index:06d}.target",
            }
        )

    refs = root.xpath("//tei:ref[@type='bibr']", namespaces=_TEI_NS)
    unresolved_ref_count = 0
    author_year_resolved_ref_count = 0
    ambiguous_author_year_ref_count = 0
    suppressed_fragment_ref_count = 0
    suppressed_fragment_edge_count = 0
    pending_suppressed_direct_ref_parent: etree._Element | None = None
    for ordinal, element in enumerate(refs):
        ref_text = normalize_whitespace("".join(element.itertext()))
        if not ref_text:
            _increment(skipped, "bibliography_ref_missing_text")
            continue
        declared_target_id = str(element.get("target") or "").lstrip("#")
        suppressed_resolution_reason: str | None = None
        suppressed_candidate_target_ids: list[str] = []
        continuation_after_suppressed_fragment = (
            not declared_target_id
            and pending_suppressed_direct_ref_parent is not None
            and element.getparent() is pending_suppressed_direct_ref_parent
        )
        target_id = declared_target_id if declared_target_id in target_key_by_id else ""
        if target_id and _looks_like_incomplete_direct_ref(ref_text):
            suppressed_resolution_reason = "incomplete_direct_ref_fragment"
            suppressed_candidate_target_ids = [target_id]
            target_id = ""
            suppressed_fragment_ref_count += 1
            suppressed_fragment_edge_count += 1
            _increment(skipped, "bibliography_ref_suspicious_direct_target")
            pending_suppressed_direct_ref_parent = element.getparent()
        elif continuation_after_suppressed_fragment:
            suppressed_resolution_reason = "split_ref_continuation"
            pending_suppressed_direct_ref_parent = None
        else:
            pending_suppressed_direct_ref_parent = None
        target_keys = [target_key_by_id[target_id]] if target_id else []
        edge_method = "grobid_tei_bibliography_ref"
        if not target_keys and suppressed_resolution_reason is None:
            match = _author_year_target_keys(
                ref_text,
                target_ids_by_author_year_key=target_ids_by_author_year_key,
                target_key_by_id=target_key_by_id,
            )
            target_keys = match
            if match:
                author_year_resolved_ref_count += len(match)
                edge_method = "grobid_tei_author_year_match"
            else:
                unresolved_ref_count += 1
                if _has_author_year_ambiguity(
                    ref_text,
                    target_ids_by_author_year_key=target_ids_by_author_year_key,
                ):
                    ambiguous_author_year_ref_count += 1
        elif not target_keys and suppressed_resolution_reason == "split_ref_continuation":
            suppressed_match = _author_year_target_keys(
                ref_text,
                target_ids_by_author_year_key=target_ids_by_author_year_key,
                target_key_by_id=target_key_by_id,
            )
            suppressed_candidate_target_ids = [
                target_id_by_key[target_key]
                for target_key in suppressed_match
                if target_key in target_id_by_key
            ]
            suppressed_fragment_ref_count += 1
            suppressed_fragment_edge_count += len(suppressed_candidate_target_ids)
            _increment(skipped, "bibliography_ref_fragment_author_year_match_suppressed")
        stable_key = f"{source_kind}:grobid-bibliography-ref:{ordinal:06d}"
        locator, locator_status = _locator_from_coords(
            element.get("coords"),
            media_id=str(source_ref.get("media_id") or ""),
            exact=ref_text,
            skipped=skipped,
            skip_key="bibliography_ref_invalid_coords",
        )
        ref_source_ref = {
            **base_source_ref,
            "tei_element": "ref",
            "ordinal": ordinal,
            "ref_type": "bibr",
            "ref_text": ref_text,
            "target_id": target_id or None,
            "declared_target_id": declared_target_id or None,
            "suppressed_resolution_reason": suppressed_resolution_reason,
            "suppressed_candidate_target_ids": suppressed_candidate_target_ids,
            "resolved_target_ids": [
                target_id_by_key[target_key]
                for target_key in target_keys
                if target_key in target_id_by_key
            ],
            "coords": element.get("coords"),
        }
        items.append(
            {
                "stable_key": stable_key,
                "kind": "bibliography_ref",
                "label": ref_text,
                "body_text": None,
                "body_html_sanitized": None,
                "locator": locator,
                "locator_status": locator_status,
                "confidence": "probable",
                "extraction_method": "grobid_tei_bibliography_ref",
                "source_ref": ref_source_ref,
                "sort_key": f"bibliography_ref.{ordinal:06d}.marker",
            }
        )
        for target_index, target_key in enumerate(target_keys):
            edge_source_ref = {
                **ref_source_ref,
                "target_id": target_id_by_key.get(target_key),
                "resolution_method": edge_method,
            }
            edges.append(
                {
                    "stable_key": f"{stable_key}->{target_key}:{target_index:03d}",
                    "from_stable_key": stable_key,
                    "to_stable_key": target_key,
                    "relation": "cites_bibliography_entry",
                    "confidence": "probable",
                    "extraction_method": edge_method,
                    "source_ref": edge_source_ref,
                    "sort_key": f"bibliography_ref.{ordinal:06d}.edge.{target_index:03d}",
                }
            )

    status = "empty"
    if items and (unresolved_ref_count or suppressed_fragment_ref_count):
        status = "partial"
    elif items:
        status = "ready"

    return ScholarlyTeiApparatus(
        status=status,
        items=items,
        edges=edges,
        diagnostics={
            "grobid_tei_scholarly": {
                "status": status,
                "adapter_version": _ADAPTER_VERSION,
                "tei_sha256": tei_sha256,
                "bibliography_entry_count": len(target_key_by_id),
                "bibliography_ref_count": len(
                    [item for item in items if item["kind"] == "bibliography_ref"]
                ),
                "resolved_bibliography_ref_count": len(edges),
                "author_year_resolved_bibliography_ref_count": author_year_resolved_ref_count,
                "unresolved_bibliography_ref_count": unresolved_ref_count,
                "ambiguous_author_year_ref_count": ambiguous_author_year_ref_count,
                "suppressed_fragment_ref_count": suppressed_fragment_ref_count,
                "suppressed_fragment_edge_count": suppressed_fragment_edge_count,
                "skipped": skipped,
            }
        },
    )


def _parse_tei(tei_xml: bytes) -> etree._Element:
    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        remove_blank_text=False,
        huge_tree=False,
    )
    return etree.fromstring(tei_xml, parser=parser)


def _bibliography_entry_text(element: etree._Element) -> str:
    raw_reference = element.xpath("tei:note[@type='raw_reference'][1]", namespaces=_TEI_NS)
    if raw_reference:
        return normalize_whitespace("".join(raw_reference[0].itertext()))
    return normalize_whitespace("".join(element.itertext()))


def _index_author_year_match_keys(
    target_ids_by_author_year_key: dict[tuple[str, ...], set[str]],
    *,
    element: etree._Element,
    body_text: str,
    target_id: str,
) -> None:
    surnames = _bibliography_entry_author_surnames(element)
    if not surnames:
        return
    for year in _year_tokens(body_text):
        for key_year in {year, year[:4]}:
            target_ids_by_author_year_key.setdefault((surnames[0], key_year), set()).add(target_id)
            if len(surnames) >= 2:
                target_ids_by_author_year_key.setdefault(
                    (surnames[0], surnames[1], key_year),
                    set(),
                ).add(target_id)


def _author_year_target_keys(
    ref_text: str,
    *,
    target_ids_by_author_year_key: dict[tuple[str, ...], set[str]],
    target_key_by_id: dict[str, str],
) -> list[str]:
    matched_target_ids: set[str] = set()
    normalized_ref_text = f" {_normalize_match_text(ref_text)} "
    for year in _ref_year_tokens(ref_text):
        multi_author_names: set[str] = set()
        for key, target_ids in target_ids_by_author_year_key.items():
            if len(key) != 3 or key[-1] != year:
                continue
            names = key[:-1]
            if not all(_contains_author_token(normalized_ref_text, name) for name in names):
                continue
            if len(target_ids) == 1:
                matched_target_ids.update(target_ids)
                multi_author_names.update(names)
        for key, target_ids in target_ids_by_author_year_key.items():
            if len(key) != 2 or key[-1] != year:
                continue
            name = key[0]
            if name in multi_author_names:
                continue
            if not _contains_author_token(normalized_ref_text, name):
                continue
            if len(target_ids) == 1:
                matched_target_ids.update(target_ids)
    return [
        target_key_by_id[target_id]
        for target_id in sorted(matched_target_ids)
        if target_id in target_key_by_id
    ]


def _has_author_year_ambiguity(
    ref_text: str,
    *,
    target_ids_by_author_year_key: dict[tuple[str, ...], set[str]],
) -> bool:
    normalized_ref_text = f" {_normalize_match_text(ref_text)} "
    for year in _ref_year_tokens(ref_text):
        for key, target_ids in target_ids_by_author_year_key.items():
            if key[-1] != year or len(target_ids) <= 1:
                continue
            names = key[:-1]
            if all(_contains_author_token(normalized_ref_text, name) for name in names):
                return True
    return False


def _looks_like_incomplete_direct_ref(ref_text: str) -> bool:
    if _ref_year_tokens(ref_text):
        return False
    normalized = _normalize_match_text(ref_text)
    return normalized.endswith((" and", " et al"))


def _bibliography_entry_author_surnames(element: etree._Element) -> tuple[str, ...]:
    surnames: list[str] = []
    for author in element.xpath(".//tei:author/tei:persName", namespaces=_TEI_NS):
        surname = author.xpath(".//tei:surname[1]", namespaces=_TEI_NS)
        if not surname:
            continue
        normalized = _normalize_match_text("".join(surname[0].itertext()))
        if normalized:
            surnames.append(normalized)
    return tuple(surnames)


def _ref_year_tokens(text: str) -> tuple[str, ...]:
    years = _year_tokens(text)
    return tuple(sorted({year for token in years for year in (token, token[:4])}))


def _year_tokens(text: str) -> tuple[str, ...]:
    return tuple(
        match.group(0).lower()
        for match in re.finditer(r"(?:19|20)\d{2}[a-z]?", text, flags=re.IGNORECASE)
    )


def _contains_author_token(normalized_ref_text: str, author_token: str) -> bool:
    return f" {author_token} " in normalized_ref_text


def _normalize_match_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = normalized.encode("ascii", errors="ignore").decode("ascii")
    return normalize_whitespace(re.sub(r"[^a-z0-9]+", " ", ascii_text.lower()))


def _locator_from_coords(
    raw_coords: str | None,
    *,
    media_id: str,
    exact: str,
    skipped: dict[str, int],
    skip_key: str,
) -> tuple[dict[str, object] | None, str]:
    if not raw_coords or not media_id:
        return None, "missing"
    try:
        validate_exact_length(exact)
        quads = [_quad_from_grobid_coords(part) for part in raw_coords.split(";") if part.strip()]
        if not quads:
            return None, "missing"
        page_number = int(quads[0].pop("page_number"))
        if any(int(quad.pop("page_number")) != page_number for quad in quads[1:]):
            _increment(skipped, skip_key)
            return None, "missing"
        geometry = canonicalize_geometry(page_number, quads)
    except (GeometryValidationError, ValueError):
        _increment(skipped, skip_key)
        return None, "missing"
    return (
        {
            "type": "pdf_page_geometry",
            "media_id": media_id,
            "page_number": geometry.page_number,
            "quads": [_quad_json(quad) for quad in geometry.quads],
            "exact": exact,
            "text_quote_selector": {"exact": exact},
        },
        "exact",
    )


def _quad_from_grobid_coords(raw: str) -> dict[str, float]:
    page_text, x_text, y_text, width_text, height_text = [part.strip() for part in raw.split(",")]
    page_number = int(page_text)
    left = float(x_text)
    top = float(y_text)
    right = left + float(width_text)
    bottom = top + float(height_text)
    return {
        "page_number": page_number,
        "x1": left,
        "y1": top,
        "x2": right,
        "y2": top,
        "x3": right,
        "y3": bottom,
        "x4": left,
        "y4": bottom,
    }


def _quad_json(quad: Any) -> dict[str, float]:
    return {
        "x1": quad.x1,
        "y1": quad.y1,
        "x2": quad.x2,
        "y2": quad.y2,
        "x3": quad.x3,
        "y3": quad.y3,
        "x4": quad.x4,
        "y4": quad.y4,
    }


def _increment(values: dict[str, int], key: str) -> None:
    values[key] = values.get(key, 0) + 1
