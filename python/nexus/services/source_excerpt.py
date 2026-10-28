"""Retained source trees and canonical endpoint proof; shared code owns all clipping."""

import re
import unicodedata
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from lxml.html import HtmlElement, fragment_fromstring
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.reader_excerpts import FrozenExcerpt
from nexus.services.authored import helper
from nexus.services.reader_excerpts import scope_excerpts

_BRANCHES = set(
    "p div span section article header footer nav aside main h1 h2 h3 h4 h5 h6 strong em b i u s cite sup sub code pre blockquote a xref ul dl dt dd figure figcaption table thead tbody tfoot tr ol li td th".split()
)
_STRUCTURAL = set("ul ol dl table thead tbody tfoot tr".split())


@dataclass(frozen=True)
class SourceExcerptRequest:
    reading_id: UUID
    fragment_id: UUID
    start: int
    end: int
    bounds: tuple[int, int] | None = None


def _html_integer(value: str | None, default: int) -> int:
    parsed = re.match(r"^[\t\n\f\r ]*([+-]?[0-9]+)", value or "")
    return int(parsed[1]) if parsed is not None else default


def _tree(html: str) -> tuple[dict[str, Any], set[tuple[int, ...]], set[tuple[int, ...]]]:
    root = fragment_fromstring(html, create_parent=True)
    unsupported: set[int] = set()
    incomplete: set[int] = set()

    def direction_text(node: HtmlElement) -> str:
        parts = [node.text or ""]
        for child in node:
            if (
                isinstance(child.tag, str)
                and child.tag.lower() not in ("bdi", "script", "style", "textarea")
                and (child.get("dir") or "").lower() not in ("ltr", "rtl", "auto")
            ):
                parts.append(direction_text(child))
            parts.append(child.tail or "")
        return "".join(parts)

    def direction(node: HtmlElement, inherited: str | None) -> str | None:
        value = (node.get("dir") or "").lower()
        if value in ("ltr", "rtl"):
            return value
        if value == "auto":
            for char in direction_text(node):
                strong = unicodedata.bidirectional(char)
                if strong == "L":
                    return "ltr"
                if strong in ("R", "AL"):
                    return "rtl"
        return inherited

    def children(node: HtmlElement, lang: str | None, flow: str | None) -> list[dict[str, Any]]:
        output: list[dict[str, Any]] = []

        def words(value: str | None) -> None:
            if value and (node.tag not in _STRUCTURAL or value.strip()):
                output.append({"kind": "text", "text": value})

        words(node.text)
        for child in node:
            if isinstance(child.tag, str):
                output.extend(convert(child, lang, flow))
            words(child.tail)
        return output

    def convert(node: HtmlElement, lang: str | None, flow: str | None) -> list[dict[str, Any]]:
        tag = node.tag.lower().rsplit("}", 1)[-1]
        if (
            tag in ("script", "style", "noscript", "template")
            or "hidden" in node.attrib
            or node.get("aria-hidden") == "true"
        ):
            return []
        if tag in ("svg", "math") and node.text_content().strip():
            words = {"kind": "text", "text": node.text_content()}
            unsupported.add(id(words))
            gap = {
                "kind": "media_gap",
                "media_kind": "svg" if tag == "svg" else "embed",
                "flow": "inline",
            }
            return [
                {"kind": "span", "lang": lang, "dir": flow, "children": [gap, words, dict(gap)]}
            ]
        if tag in ("img", "svg", "iframe", "video", "audio", "object", "embed", "math"):
            return [
                {
                    "kind": "media_gap",
                    "media_kind": "image" if tag == "img" else "svg" if tag == "svg" else "embed",
                    "flow": "inline" if tag in ("img", "svg", "math") else "block",
                }
            ]
        if node.get("data-nexus-document-embed-kind"):
            return [
                {
                    "kind": "figure",
                    "lang": lang,
                    "dir": flow,
                    "children": [{"kind": "media_gap", "media_kind": "embed", "flow": "block"}],
                }
            ]
        if tag in ("br", "hr"):
            return [{"kind": tag}]
        inherited_lang = (
            node.get("lang") or node.get("{http://www.w3.org/XML/1998/namespace}lang") or lang
        )
        resolved = direction(node, flow)
        content = children(node, inherited_lang, resolved)
        if tag not in _BRANCHES:
            return content
        projected = f"h{min(6, int(tag[1]) + 1)}" if tag in {f"h{i}" for i in range(1, 7)} else tag
        value: dict[str, Any] = {
            "kind": projected,
            "lang": inherited_lang,
            "dir": resolved,
            "children": content,
        }
        if tag == "table" and node.get("data-nexus-incomplete-table") == "true":
            incomplete.add(id(value))
        if tag == "ol":
            value.update(
                start=_html_integer(
                    node.get("start"),
                    sum(child.tag == "li" for child in node) if "reversed" in node.attrib else 1,
                ),
                reversed="reversed" in node.attrib,
            )
        elif tag == "li":
            value["value"] = (
                _html_integer(node.get("value"), 0) if node.get("value") is not None else None
            )
        elif tag in ("td", "th"):
            span = _html_integer(node.get("rowspan"), 1)
            span = min(65534, span) if span >= 0 else 1
            scope = (node.get("scope") or "").lower()
            value.update(
                col_span=min(1000, max(1, _html_integer(node.get("colspan"), 1))),
                row_span=span,
                scope=scope if scope in ("row", "col", "rowgroup", "colgroup") else None,
            )
        return [value]

    content = children(root, root.get("lang"), direction(root, "ltr"))
    body: dict[str, Any] = {
        "structure": "captured",
        "lang": root.get("lang"),
        "dir": direction(root, "ltr"),
        "content": content,
        "selection": {
            "start": {"path": [], "offset": 0},
            "end": {"path": [], "offset": len(content)},
        },
    }
    unsupported_paths: set[tuple[int, ...]] = set()
    incomplete_paths: set[tuple[int, ...]] = set()

    def inspect(nodes: list[dict[str, Any]], path: tuple[int, ...] = ()) -> None:
        for index, node in enumerate(nodes):
            at = (*path, index)
            if id(node) in unsupported:
                unsupported_paths.add(at)
            if id(node) in incomplete:
                incomplete_paths.add(at)
            if "children" in node:
                inspect(node["children"], at)

    inspect(content)
    return body, unsupported_paths, incomplete_paths


def source_excerpts(db: Session, requests: list[SourceExcerptRequest]) -> list[FrozenExcerpt]:
    """Batch source conversion, canonical proof, reading scope and bounded capture."""
    from nexus.services.media_text_scope import read_media_text_scope, read_scope_fragment
    from nexus.services.resource_items.locations import source_identities

    if not requests:
        return []
    fragments = {
        row.id: row
        for row in db.execute(
            text(
                "SELECT id,media_id,html_sanitized,canonical_text FROM fragments WHERE id=ANY(:ids)"
            ),
            {"ids": list({request.fragment_id for request in requests})},
        )
    }
    identities = source_identities(db, list({request.reading_id for request in requests}))
    pieces = set(
        db.scalars(
            text("SELECT media_id FROM media_parts WHERE media_id=ANY(:ids)"),
            {"ids": list({request.reading_id for request in requests})},
        )
    )
    scopes = {reading: read_media_text_scope(db, reading) for reading in pieces}
    contexts = []
    for request in requests:
        row = fragments[request.fragment_id]
        if request.reading_id in scopes:
            scope = scopes[request.reading_id]
            if row.media_id != scope.source_media_id or not scope.contains(
                row.id, request.start, request.end
            ):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "Selection is outside its reading"
                )
            interval = next(
                interval
                for interval in scope.fragment_intervals
                if interval.fragment_id == row.id
                and interval.start_offset <= request.start
                and request.end <= interval.end_offset
            )
            sliced = read_scope_fragment(db, scope, interval)
            contexts.append(
                (sliced.html_sanitized, sliced.canonical_text, sliced.source_start_offset)
            )
        elif row.media_id == request.reading_id:
            contexts.append((row.html_sanitized or "", row.canonical_text, 0))
        else:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Selection is outside its source"
            )
    trees = [_tree(html) for html, _, _ in contexts]
    mappings = helper.call_items(
        "excerpt_source_selections",
        [
            {
                "body": body,
                "start_offset": request.start - base,
                "end_offset": request.end - base,
                "unsupported_paths": sorted(unsupported_paths),
            }
            for request, (body, unsupported_paths, _), (_, _, base) in zip(
                requests, trees, contexts, strict=True
            )
        ],
    )
    full = []
    unsupported = []
    bounds = []
    for request, (body, _unsupported_paths, incomplete_paths), mapping, (_, canonical, base) in zip(
        requests, trees, mappings, contexts, strict=True
    ):
        row = fragments[request.fragment_id]
        if mapping["emitted"] != canonical:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Source structure disagrees with its canonical publication",
            )
        intervals = [
            (interval["start_offset"] + base, interval["end_offset"] + base)
            for interval in mapping["unsupported_intervals"]
        ]
        if mapping["selection"] is None or any(
            left < request.end and right > request.start for left, right in intervals
        ):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "This passage contains text that can’t be captured faithfully yet.",
            )
        body["selection"] = mapping["selection"]
        first_path, last_path = (
            tuple(body["selection"]["start"]["path"]),
            tuple(body["selection"]["end"]["path"]),
        )
        if any(
            first_path[: len(path)] == path
            or last_path[: len(path)] == path
            or first_path < path < last_path
            for path in incomplete_paths
        ):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "This passage contains text that can’t be captured faithfully yet.",
            )
        admitted_bounds = request.bounds or (0, len(row.canonical_text))
        if request.reading_id in scopes:
            scope = scopes[request.reading_id]
            if row.media_id != scope.source_media_id or not scope.contains(
                row.id, request.start, request.end
            ):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST, "Selection is outside its reading"
                )
            interval = next(
                interval
                for interval in scope.fragment_intervals
                if interval.fragment_id == row.id
                and interval.start_offset <= request.start
                and request.end <= interval.end_offset
            )
            admitted_bounds = interval.start_offset, interval.end_offset
        elif row.media_id != request.reading_id:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Selection is outside its source"
            )
        full.append(
            {
                **body,
                "source_extent": {
                    "reading_ref": f"media:{request.reading_id}",
                    "document_identity": identities[request.reading_id],
                    "fragment_id": str(request.fragment_id),
                    "start_offset": base,
                    "end_offset": base + len(canonical),
                },
                "truncated_before": False,
                "truncated_after": False,
            }
        )
        unsupported.append(intervals)
        bounds.append(admitted_bounds)
    bounded = helper.call_items("capture_excerpts", full)
    admitted = scope_excerpts(
        [
            {
                "excerpt": value,
                "scope": {"kind": "interval", "start_offset": bound[0], "end_offset": bound[1]},
            }
            for value, bound in zip(bounded, bounds, strict=True)
        ]
    )
    if any(value is None for value in admitted):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "This passage contains text that can’t be captured faithfully yet.",
        )
    captured = [value for value in admitted if value is not None]
    for value, intervals in zip(captured, unsupported, strict=True):
        extent = value.source_extent
        if extent is None or any(
            left < extent.end_offset and right > extent.start_offset for left, right in intervals
        ):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "This passage contains text that can’t be captured faithfully yet.",
            )
    return captured
