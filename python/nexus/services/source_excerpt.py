"""Retained source trees and canonical endpoint proof; shared code owns all clipping."""

import json
import re
import tempfile
import unicodedata
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from lxml.etree import Element
from lxml.html import HtmlElement, fragment_fromstring
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.reader_excerpts import FrozenExcerpt
from nexus.services.authored import helper
from nexus.services.canonicalize import NativeCanonicalTarget, generate_canonical_text
from nexus.services.html_tree import inner_html
from nexus.services.reader_excerpts import scope_excerpts

_BRANCHES = set(
    "p div span section article header footer nav aside main h1 h2 h3 h4 h5 h6 strong em b i u s cite sup sub code pre blockquote a xref ul dl dt dd figure figcaption table thead tbody tfoot tr ol li td th".split()
)
_STRUCTURAL = set("ul ol dl table thead tbody tfoot tr".split())


@dataclass(frozen=True)
class SourceExcerptRequest:
    """A media reading id, or the immutable x capture fragment id itself."""

    reading_id: UUID
    fragment_id: UUID
    start: int
    end: int
    bounds: tuple[int, int] | None = None


def _html_integer(value: str | None, default: int) -> int:
    parsed = re.match(r"^[\t\n\f\r ]*([+-]?[0-9]+)", value or "")
    return int(parsed[1]) if parsed is not None else default


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


def _tree(html: str) -> tuple[dict[str, Any], set[tuple[int, ...]], set[tuple[int, ...]]]:
    root = fragment_fromstring(html, create_parent=True)
    unsupported: set[int] = set()
    incomplete: set[int] = set()

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


def _source_windows(
    html: str, canonical: str, intervals: list[tuple[int, int]]
) -> list[tuple[str, str, int, bool, bool]]:
    """Scan native source, then materialize only the shared owner's literal window."""
    root = fragment_fromstring(html, create_parent=True)
    target = NativeCanonicalTarget()
    slots: dict[tuple[HtmlElement, str], tuple[int, int]] = {}
    codepoint_slots: dict[tuple[HtmlElement, str], tuple[int, int]] = {}
    bounds: dict[HtmlElement, tuple[int, int]] = {}
    cursor = 0
    codepoint_cursor = 0
    unsupported_intervals: list[tuple[int, int]] = []

    def convert_points(points: list[int], to_utf16: bool) -> dict[int, int]:
        pending = sorted(set(points))
        converted: dict[int, int] = {}
        point = 0
        previous_in = previous_out = 0
        for key, utf_bounds in slots.items():
            cp_bounds = codepoint_slots[key]
            before, after = cp_bounds if to_utf16 else utf_bounds
            out_before, out_after = utf_bounds if to_utf16 else cp_bounds
            while point < len(pending) and pending[point] < before:
                converted[pending[point]] = previous_out + pending[point] - previous_in
                point += 1
            requested = []
            while point < len(pending) and pending[point] <= after:
                value = pending[point]
                if value == before:
                    converted[value] = out_before
                elif value == after:
                    converted[value] = out_after
                else:
                    requested.append(value)
                point += 1
            if requested:
                value = getattr(key[0], key[1]) or ""
                if value.isascii():
                    converted.update((item, out_before + item - before) for item in requested)
                else:
                    index = units = selected = 0
                    for char in value:
                        coordinate = index if to_utf16 else units
                        while (
                            selected < len(requested) and requested[selected] - before == coordinate
                        ):
                            converted[requested[selected]] = out_before + (
                                units if to_utf16 else index
                            )
                            selected += 1
                        if selected == len(requested):
                            break
                        units += 2 if ord(char) > 0xFFFF else 1
                        index += 1
                    if any(item not in converted for item in requested):
                        raise ValueError("Source window split a UTF-16 surrogate pair")
            previous_in, previous_out = after, out_after
        while point < len(pending):
            converted[pending[point]] = previous_out + pending[point] - previous_in
            point += 1
        return converted

    with tempfile.TemporaryFile() as events:

        def event(value: dict[str, Any]) -> None:
            events.write(
                json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
            )

        def words(node: HtmlElement, attribute: str, parent: HtmlElement) -> None:
            nonlocal cursor, codepoint_cursor
            value = getattr(node, attribute) or ""
            if not value:
                return
            if parent.tag in _STRUCTURAL and not value.strip():
                target.data(value)
                return
            units = len(value.encode("utf-16-le")) // 2
            slots[node, attribute] = (cursor, cursor + units)
            codepoint_slots[node, attribute] = (codepoint_cursor, codepoint_cursor + len(value))
            target.data(value, codepoint_cursor)
            frame_start = cursor
            for offset in range(0, len(value), 4096):
                frame = value[offset : offset + 4096]
                event(
                    {
                        "kind": "text",
                        "text": frame,
                        "start": frame_start,
                    }
                )
                frame_start += len(frame.encode("utf-16-le")) // 2
            cursor += units
            codepoint_cursor += len(value)

        def walk(node: HtmlElement, index: int, *, artificial: bool = False) -> None:
            nonlocal cursor, codepoint_cursor
            tag = node.tag.lower().rsplit("}", 1)[-1]
            target.start(tag, node.attrib)
            before = cursor
            if (
                tag in ("script", "style", "noscript", "template")
                or "hidden" in node.attrib
                or node.get("aria-hidden") == "true"
            ):
                target.end(tag)
                bounds[node] = (before, cursor)
                return
            embedded = bool(node.get("data-nexus-document-embed-kind"))
            media = tag in ("img", "svg", "iframe", "video", "audio", "object", "embed", "math")
            if embedded or media and not (tag in ("svg", "math") and node.text_content().strip()):
                if embedded:
                    event({"kind": "enter", "node_kind": "figure", "index": index, "start": cursor})
                event(
                    {
                        "kind": "leaf",
                        "node_kind": "media_gap",
                        "flow": "inline" if tag in ("img", "svg", "math") else "block",
                        "start": cursor,
                    }
                )
                cursor += 1
                codepoint_cursor += 1
                if embedded:
                    event({"kind": "exit", "node_kind": "figure", "end": cursor})
            elif tag in ("br", "hr"):
                event({"kind": "leaf", "node_kind": tag, "flow": "inline", "start": cursor})
                cursor += 1
                codepoint_cursor += 1
            else:
                kind = (
                    f"h{min(6, int(tag[1]) + 1)}" if tag in {f"h{i}" for i in range(1, 7)} else tag
                )
                branch = not artificial and tag in _BRANCHES
                if branch:
                    event({"kind": "enter", "node_kind": kind, "index": index, "start": cursor})
                unsupported = tag in ("svg", "math")
                if unsupported:
                    event(
                        {
                            "kind": "leaf",
                            "node_kind": "media_gap",
                            "flow": "inline",
                            "start": cursor,
                        }
                    )
                    cursor += 1
                    codepoint_cursor += 1
                words(node, "text", node)
                for child_index, child in enumerate(node):
                    if isinstance(child.tag, str):
                        walk(child, child_index)
                    words(child, "tail", node)
                if unsupported:
                    event(
                        {
                            "kind": "leaf",
                            "node_kind": "media_gap",
                            "flow": "inline",
                            "start": cursor,
                        }
                    )
                    cursor += 1
                    codepoint_cursor += 1
                    unsupported_intervals.append((before, cursor))
                if branch:
                    event({"kind": "exit", "node_kind": kind, "end": cursor})
            target.end(tag)
            bounds[node] = (before, cursor)

        walk(root, 0, artificial=True)
        projection = target.projection()
        if projection.text != canonical:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Source structure disagrees with its canonical publication",
            )
        native = projection.bounds(intervals)
        if any(first == 0xFFFFFFFF or end <= first for first, end in native):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Selection has no native source text"
            )
        converted = convert_points([point for pair in native for point in pair], True)
        selections = []
        for first, end in native:
            native_start, native_end = converted[first], converted[end]
            if any(lo < native_end and hi > native_start for lo, hi in unsupported_intervals):
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "This passage contains text that can’t be captured faithfully yet.",
                )
            selections.append((native_start, native_end))
        windows = helper.source_windows(events, selections)
    converted_windows = convert_points(
        [window[side] for window in windows for side in ("start", "end")], False
    )
    bases = projection.prefixes([converted_windows[window["start"]] for window in windows])

    def copy(node: HtmlElement, inherited: str | None, whole_table: bool = False) -> Any:
        if (
            node.tag in ("script", "style", "noscript", "template")
            or "hidden" in node.attrib
            or node.get("aria-hidden") == "true"
        ):
            return None
        before, after = bounds[node]
        if not whole_table and (after <= left or before >= right):
            return None
        clone = Element(node.tag, dict(node.attrib))
        resolved = direction(node, inherited)
        if resolved is not None:
            clone.set("dir", resolved)
        full_table = whole_table or node.tag == "table" and left <= before and after <= right

        def literal(owner: HtmlElement, attribute: str) -> str | None:
            value = getattr(owner, attribute)
            interval = slots.get((owner, attribute))
            if value is None or interval is None:
                return value if full_table else None
            lo, hi = interval
            cp_start, cp_end = codepoint_slots[owner, attribute]
            first = cp_start if left <= lo else cp_end if left >= hi else converted_windows[left]
            end = cp_start if right <= lo else cp_end if right >= hi else converted_windows[right]
            return value[first - cp_start : end - cp_start] or None

        clone.text = literal(node, "text")
        counter = _html_integer(
            node.get("start"),
            sum(child.tag == "li" for child in node) if "reversed" in node.attrib else 1,
        )
        step = -1 if "reversed" in node.attrib else 1
        for child in node:
            if not isinstance(child.tag, str):
                continue
            retained = copy(child, resolved, full_table)
            if node.tag == "ol" and child.tag == "li":
                counter = _html_integer(child.get("value"), counter)
                if retained is not None:
                    retained.set("value", str(counter))
                counter += step
            tail = literal(child, "tail")
            if retained is not None:
                retained.tail = tail
                clone.append(retained)
            elif tail:
                if len(clone):
                    clone[-1].tail = (clone[-1].tail or "") + tail
                else:
                    clone.text = (clone.text or "") + tail
        return clone

    output = []
    for (start, end), window, base in zip(intervals, windows, bases, strict=True):
        left, right = window["start"], window["end"]
        bounded = copy(root, "ltr")
        if bounded is None:
            raise ValueError("Source window lost its selection")
        candidate = inner_html(bounded)
        projected = generate_canonical_text(candidate)
        if canonical[
            base : base + len(projected)
        ] != projected or not base <= start < end <= base + len(projected):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "Source window changed its canonical publication correspondence",
            )
        output.append(
            (candidate, projected, base, window["truncated_before"], window["truncated_after"])
        )
    return output


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
                "SELECT id,media_id,x_post_capture_id,html_sanitized,canonical_text FROM fragments WHERE id=ANY(:ids)"
            ),
            {"ids": list({request.fragment_id for request in requests})},
        )
    }
    identities = source_identities(db, list({request.reading_id for request in requests}))
    identities.update(
        {
            row.id: f"capture:{row.x_post_capture_id}"
            for row in fragments.values()
            if row.x_post_capture_id is not None
        }
    )
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
        elif row.media_id == request.reading_id or (
            row.x_post_capture_id is not None and row.id == request.reading_id
        ):
            contexts.append((row.html_sanitized or "", row.canonical_text, 0))
        else:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Selection is outside its source"
            )
    groups: dict[tuple[UUID, UUID, int, int], list[int]] = {}
    for index, (request, (_, canonical, base)) in enumerate(zip(requests, contexts, strict=True)):
        groups.setdefault(
            (request.reading_id, request.fragment_id, base, len(canonical)), []
        ).append(index)
    windows: dict[int, tuple[str, str, int, bool, bool]] = {}
    for indices in groups.values():
        html, canonical, base = contexts[indices[0]]
        values = _source_windows(
            html,
            canonical,
            [(requests[index].start - base, requests[index].end - base) for index in indices],
        )
        for index, (candidate, projected, offset, before, after) in zip(
            indices, values, strict=True
        ):
            windows[index] = (candidate, projected, base + offset, before, after)
    contexts = [
        (windows[index][0], windows[index][1], windows[index][2]) for index in range(len(requests))
    ]
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
        elif row.media_id != request.reading_id and not (
            row.x_post_capture_id is not None and row.id == request.reading_id
        ):
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST, "Selection is outside its source"
            )
        full.append(
            {
                **body,
                "source_extent": {
                    "reading_ref": f"fragment:{row.id}"
                    if row.x_post_capture_id is not None
                    else f"media:{request.reading_id}",
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
    for index, value in enumerate(bounded):
        value["truncated_before"] = value["truncated_before"] or windows[index][3]
        value["truncated_after"] = value["truncated_after"] or windows[index][4]
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
