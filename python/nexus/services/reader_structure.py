"""Proved section extents over canonical text, independent of rendering units.

Peer boundaries share a source scope. A different, unowned reading division or
an unproved source boundary prevents an extent; containers and actual ancestry
govern their children. Missing ends stay unknown and finite ranges are nonempty.
Callers supplying one scope and a document end retain ordinary article behavior.
"""

from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from uuid import UUID

from nexus.schemas.reader_apparatus import NoteBodyRegion, NoteGroupRegion, NoteRegion


@dataclass(frozen=True, order=True)
class DocumentPoint:
    fragment_idx: int
    offset: int


@dataclass(frozen=True)
class SectionRangeInput:
    section_id: str
    target: DocumentPoint
    parent_section_id: str | None
    container_end: DocumentPoint | None
    owns_container: bool
    boundary_scope: str | None = None


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
            if isinstance(region, NoteGroupRegion) and region.heading is not None:
                headings.add(DocumentPoint(idx, region.heading.offset))
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
    sections: Sequence[SectionRangeInput],
    document_end: DocumentPoint | None,
    *,
    unproved_boundaries: Sequence[DocumentPoint] = (),
) -> dict[str, DocumentPoint | None]:
    """End at a proved peer/container; a missing document end stays unknown."""
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
        if parent is not None and parent not in by_id:
            raise ValueError("Section ancestry names a missing parent")
        result = depth(parent) + 1 if parent is not None else 0
        visiting.remove(section_id)
        depths[section_id] = result
        return result

    ordered = sorted(sections, key=lambda section: (section.target, depth(section.section_id)))
    natural_ends = dict.fromkeys(by_id, document_end)
    unproved: set[str] = set()
    stacks: dict[str | None, list[SectionRangeInput]] = {}
    boundaries: dict[DocumentPoint, list[SectionRangeInput]] = {}
    for section in ordered:
        boundaries.setdefault(section.target, []).append(section)
    barriers = set(unproved_boundaries)
    for target in sorted(boundaries.keys() | barriers):
        grouped = boundaries.get(target, [])
        for scope, stack in stacks.items():
            kept: list[SectionRangeInput] = []
            for active in stack:
                if any(
                    section.boundary_scope == scope
                    and depths[section.section_id] <= depths[active.section_id]
                    for section in grouped
                ):
                    kept.append(active)
                    continue
                incompatible = target in barriers
                if not incompatible:
                    for section in grouped:
                        if section.boundary_scope == scope:
                            continue
                        ancestor = section.parent_section_id
                        while ancestor is not None and ancestor != active.section_id:
                            ancestor = by_id[ancestor].parent_section_id
                        if ancestor is None:
                            incompatible = True
                            break
                if (
                    incompatible
                    and active.target < target
                    and (active.container_end is None or target < active.container_end)
                ):
                    unproved.add(active.section_id)
                else:
                    kept.append(active)
            stacks[scope] = kept
        groups: dict[str | None, list[SectionRangeInput]] = {}
        for section in grouped:
            groups.setdefault(section.boundary_scope, []).append(section)
        for scope, group in groups.items():
            stack = stacks.setdefault(scope, [])
            next_depth = min(depths[section.section_id] for section in group)
            while stack and depths[stack[-1].section_id] >= next_depth:
                natural_ends[stack.pop().section_id] = target
            stack.extend(group)

    by_depth = sorted(ordered, key=lambda section: depths[section.section_id])
    last_descendant_target = {section.section_id: section.target for section in ordered}
    for section in reversed(by_depth):
        if section.parent_section_id is not None:
            parent_id = section.parent_section_id
            last_descendant_target[parent_id] = max(
                last_descendant_target[parent_id], last_descendant_target[section.section_id]
            )

    ends: dict[str, DocumentPoint | None] = {}
    for section in by_depth:
        if section.section_id in unproved:
            ends[section.section_id] = None
            continue
        end = natural_ends[section.section_id]
        if section.container_end is not None:
            end = (
                section.container_end
                if section.owns_container or end is None
                else min(end, section.container_end)
            )
        if end is not None and end <= last_descendant_target[section.section_id]:
            if (
                section.owns_container
                and last_descendant_target[section.section_id] > section.target
            ):
                raise ValueError("A proved child lies beyond its owned source container")
            end = None
        if section.parent_section_id is not None:
            parent = by_id[section.parent_section_id]
            parent_end = ends[parent.section_id]
            if parent.target > section.target or (
                parent_end is not None and section.target >= parent_end
            ):
                ends[section.section_id] = None
                continue
            if parent_end is not None:
                end = parent_end if end is None else min(end, parent_end)
        ends[section.section_id] = end if end is not None and end > section.target else None
    return ends
