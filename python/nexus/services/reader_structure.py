"""Semantic section extents over canonical text, independent of rendering units."""

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import groupby
from uuid import UUID

from nexus.schemas.presence import Presence, Present, absent, present
from nexus.schemas.reader_apparatus import NoteBodyRegion, NoteGroupRegion, NoteRegion


@dataclass(frozen=True, order=True)
class DocumentPoint:
    fragment_idx: int
    offset: int


@dataclass(frozen=True)
class SectionRangeInput:
    section_id: str
    target: DocumentPoint
    parent_section_id: Presence[str]
    container_end: Presence[DocumentPoint]
    owns_container: bool


class NavigationNoteIndex:
    """One publication's note ranges, indexed once for repeated candidate reads."""

    def __init__(self, regions: Sequence[NoteRegion], fragment_order: Mapping[UUID, int]) -> None:
        bodies: dict[int, list[tuple[int, int]]] = {}
        groups: dict[int, list[tuple[int, int]]] = {}
        headings: set[DocumentPoint] = set()
        for region in regions:
            start = region.range.start
            end = region.range.end
            idx = fragment_order[start.fragment_id]
            if fragment_order[end.fragment_id] != idx:
                raise ValueError("A note region must remain within one canonical fragment")
            target = bodies if isinstance(region, NoteBodyRegion) else groups
            target.setdefault(idx, []).append((start.offset, end.offset))
            if isinstance(region, NoteGroupRegion) and isinstance(region.heading, Present):
                headings.add(DocumentPoint(idx, region.heading.value.offset))
        self._bodies = {idx: self._merge(ranges) for idx, ranges in bodies.items()}
        self._groups = {idx: self._merge(ranges) for idx, ranges in groups.items()}
        self._headings = headings

    @staticmethod
    def _merge(ranges: list[tuple[int, int]]) -> tuple[tuple[int, ...], tuple[int, ...]]:
        merged: list[tuple[int, int]] = []
        for start, end in sorted(ranges):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        return tuple(start for start, _ in merged), tuple(end for _, end in merged)

    @staticmethod
    def _contains(index: tuple[tuple[int, ...], tuple[int, ...]] | None, offset: int) -> bool:
        if index is None:
            return False
        starts, ends = index
        candidate = bisect_right(starts, offset) - 1
        return candidate >= 0 and offset < ends[candidate]

    def is_routine(self, point: DocumentPoint) -> bool:
        if self._contains(self._bodies.get(point.fragment_idx), point.offset):
            return False
        return not self._contains(self._groups.get(point.fragment_idx), point.offset) or (
            point in self._headings
        )


def resolve_section_ends(
    sections: Sequence[SectionRangeInput], document_end: DocumentPoint
) -> dict[str, Presence[DocumentPoint]]:
    """End a section at its next peer/ancestor, bounded by source containers."""
    by_id = {section.section_id: section for section in sections}
    if len(by_id) != len(sections):
        raise ValueError("Section identities are not unique")
    depths: dict[str, int] = {}
    visiting: set[str] = set()

    def depth(section_id: str) -> int:
        if section_id in depths:
            return depths[section_id]
        if section_id in visiting:
            raise ValueError("Section ancestry contains a cycle")
        visiting.add(section_id)
        parent = by_id[section_id].parent_section_id
        if isinstance(parent, Present) and parent.value not in by_id:
            raise ValueError("Section ancestry names a missing parent")
        result = depth(parent.value) + 1 if isinstance(parent, Present) else 0
        visiting.remove(section_id)
        depths[section_id] = result
        return result

    ordered = sorted(sections, key=lambda section: (section.target, depth(section.section_id)))
    natural_ends = dict.fromkeys(by_id, document_end)
    stack: list[SectionRangeInput] = []
    for target, grouped in groupby(ordered, key=lambda section: section.target):
        group = list(grouped)
        next_depth = min(depths[section.section_id] for section in group)
        while stack and depths[stack[-1].section_id] >= next_depth:
            natural_ends[stack.pop().section_id] = target
        stack.extend(group)

    ends: dict[str, Presence[DocumentPoint]] = {}
    for section in sorted(ordered, key=lambda section: depths[section.section_id]):
        end = natural_ends[section.section_id]
        if isinstance(section.container_end, Present):
            end = (
                section.container_end.value
                if section.owns_container
                else min(end, section.container_end.value)
            )
        if isinstance(section.parent_section_id, Present):
            parent = by_id[section.parent_section_id.value]
            parent_end = ends[parent.section_id]
            if (
                not isinstance(parent_end, Present)
                or parent.target > section.target
                or section.target > parent_end.value
            ):
                ends[section.section_id] = absent()
                continue
            end = min(end, parent_end.value)
        ends[section.section_id] = present(end) if end >= section.target else absent()
    return ends
