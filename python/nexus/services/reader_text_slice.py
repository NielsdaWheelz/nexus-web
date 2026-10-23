"""Exact rich slices and structural keys over retained canonical publications.

Cuts name element edges, including zero-text elements, in the normalized fragment
root. Clipping preserves ancestor markup and never searches prose. A projection
is admitted only when it equals the known source substring after edge whitespace
trim; returned source_start_offset records that trim in canonical coordinates.
"""

import hashlib
import json
from collections.abc import Sequence
from copy import copy
from dataclasses import dataclass

from lxml.html import HtmlElement, fragment_fromstring

from nexus.schemas.reader import MediaNavigationOut
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.html_tree import inner_html
from nexus.services.reader_structure import DomCut, NavigationProof, SectionProof

SECTION_DETECTOR_VERSION = 1


@dataclass(frozen=True)
class ReaderTextSlice:
    html_sanitized: str
    canonical_text: str
    source_start_offset: int


def section_witness_key(generation: int, sections: Sequence[SectionProof]) -> str:
    """Preparation identity excludes the rich cuts being prepared."""
    geometry = [
        (
            section.section_id,
            section.parent_section_id,
            (section.start.fragment_idx, section.start.offset),
            (section.end.fragment_idx, section.end.offset) if section.end is not None else None,
        )
        for section in sections
    ]
    return hashlib.sha256(
        json.dumps((generation, geometry, SECTION_DETECTOR_VERSION), separators=(",", ":")).encode()
    ).hexdigest()


def navigation_proof(
    navigation: MediaNavigationOut, sections: Sequence[SectionProof]
) -> NavigationProof:
    """A selection fences both navigation facts and the exact rich representation."""
    cuts = [
        (
            (section.start_cut.path, section.start_cut.edge) if section.start_cut else None,
            (section.end_cut.path, section.end_cut.edge) if section.end_cut else None,
        )
        for section in sections
    ]
    key = hashlib.sha256(
        json.dumps(
            (navigation.model_dump(mode="json"), cuts, SECTION_DETECTOR_VERSION),
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    return NavigationProof(navigation, tuple(sections), key)


def dom_cuts_equivalent(html_sanitized: str, left: DomCut, right: DomCut) -> bool:
    """Equal text offsets alone cannot launder intervening images or empty elements."""
    if left == right:
        return True
    root = fragment_fromstring(html_sanitized, create_parent=True)
    edges: dict[DomCut, int] = {}
    content: list[int] = []
    position = 0

    def locate(node: HtmlElement, path: tuple[int, ...]) -> None:
        nonlocal position
        edges[DomCut(path, "before")] = position
        if (node.text or "").strip() or (path and not len(node)):
            content.append(position)
        position += 1
        ordinal = 0
        for child in node:
            if isinstance(child.tag, str):
                locate(child, path + (ordinal,))
                ordinal += 1
            if (child.tail or "").strip():
                content.append(position - 1)
        edges[DomCut(path, "after")] = position
        position += 1

    locate(root, ())
    if left not in edges or right not in edges:
        raise ValueError("Section cut has no retained element")
    start, end = sorted((edges[left], edges[right]))
    return not any(start <= point < end for point in content)


def clip_reader_fragment(
    *,
    html_sanitized: str,
    canonical_text: str,
    start_offset: int,
    end_offset: int,
    start_cut: DomCut,
    end_cut: DomCut,
) -> ReaderTextSlice:
    """Clip a proved fragment interval; unavailable or contradictory cuts fail."""
    if not 0 <= start_offset <= end_offset <= len(canonical_text):
        raise ValueError("Slice coordinates lie outside the canonical fragment")
    root = fragment_fromstring(html_sanitized, create_parent=True)
    edges: dict[DomCut, int] = {}
    spans: dict[HtmlElement, tuple[int, int]] = {}
    tail_positions: dict[HtmlElement, int] = {}
    position = 0

    def locate(node: HtmlElement, path: tuple[int, ...]) -> None:
        nonlocal position
        before = position
        edges[DomCut(path, "before")] = position
        position += 1
        ordinal = 0
        for child in node:
            if isinstance(child.tag, str):
                locate(child, path + (ordinal,))
                ordinal += 1
            tail_positions[child] = position - 1
        edges[DomCut(path, "after")] = position
        spans[node] = before, position
        position += 1

    locate(root, ())
    if start_cut not in edges or end_cut not in edges:
        raise ValueError("Slice cut has no retained element")
    start, end = edges[start_cut], edges[end_cut]
    if start >= end:
        raise ValueError("Slice cuts are not in document order")

    def clipped(node: HtmlElement) -> HtmlElement | None:
        before, after = spans[node]
        if before >= end or after <= start:
            return None
        result = copy(node)
        result.clear(keep_tail=False)
        result.attrib.update(node.attrib)
        result.text = node.text if start <= before < end else None
        for child in node:
            if isinstance(child.tag, str):
                kept = clipped(child)
                if kept is not None:
                    result.append(kept)
            tail = child.tail if start <= tail_positions[child] < end else None
            if tail:
                if len(result):
                    result[-1].tail = (result[-1].tail or "") + tail
                else:
                    result.text = (result.text or "") + tail
        return result

    projected = clipped(root)
    if projected is None:
        raise ValueError("Slice contains no retained rich content")
    html = inner_html(projected)
    text = generate_canonical_text(html)
    selected = canonical_text[start_offset:end_offset]
    if text != selected.strip():
        raise ValueError("Rich slice disagrees with its canonical source interval")
    return ReaderTextSlice(html, text, start_offset + len(selected) - len(selected.lstrip()))
