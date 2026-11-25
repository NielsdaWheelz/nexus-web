"""Proved section extents over canonical text, independent of rendering units.

Peer boundaries share a source scope. A different, unowned reading division or
an unproved source boundary prevents an extent; containers and actual ancestry
govern their children. Missing ends stay unknown and finite ranges are nonempty.
Callers supplying one scope and a document end retain ordinary article behavior.
"""

from bisect import bisect_right
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from heapq import merge
from typing import Literal
from uuid import UUID

from nexus.schemas.reader import MediaNavigationOut
from nexus.schemas.reader_apparatus import NoteBodyRegion, NoteGroupRegion, NoteRegion


@dataclass(frozen=True, order=True)
class DocumentPoint:
    fragment_idx: int
    offset: int


@dataclass(frozen=True)
class DomCut:
    """An element-only path; after an element precedes its tail."""

    path: tuple[int, ...]
    edge: Literal["before", "after"]


@dataclass(frozen=True)
class SectionEnd:
    point: DocumentPoint
    cut: DomCut | None


@dataclass(frozen=True)
class SectionProof:
    section_id: str
    label: str
    parent_section_id: str | None
    start: DocumentPoint
    end: DocumentPoint | None
    start_cut: DomCut | None
    end_cut: DomCut | None


@dataclass(frozen=True)
class NavigationProof:
    navigation: MediaNavigationOut
    sections: tuple[SectionProof, ...]
    key: str


@dataclass(frozen=True)
class SectionRangeInput:
    section_id: str
    target: DocumentPoint
    parent_section_id: str | None
    container_end: DocumentPoint | None
    owns_container: bool
    boundary_scope: str | None = None
    start_cut: DomCut | None = None
    container_end_cut: DomCut | None = None
    source_rank: int | None = None


@dataclass(frozen=True)
class SectionBoundary:
    """A source peer arrival that supplies a cut without a section of its own."""

    scope: str
    rank: int
    end: SectionEnd


class FragmentIntervals:
    """Sorted, disjoint source ranges for repeated exact point checks."""

    def __init__(self, by_fragment: Mapping[int, list[tuple[int, int]]]) -> None:
        self._bounds: dict[int, tuple[list[int], list[int]]] = {}
        for index, spans in by_fragment.items():
            starts: list[int] = []
            ends: list[int] = []
            for start, end in sorted(spans):
                if ends and start <= ends[-1]:
                    ends[-1] = max(ends[-1], end)
                else:
                    starts.append(start)
                    ends.append(end)
            self._bounds[index] = starts, ends

    def contains(self, point: DocumentPoint) -> bool:
        bounds = self._bounds.get(point.fragment_idx)
        if bounds is None:
            return False
        starts, ends = bounds
        previous = bisect_right(starts, point.offset) - 1
        return previous >= 0 and point.offset < ends[previous]

    def spans(self, fragment_idx: int) -> Iterator[tuple[int, int]]:
        bounds = self._bounds.get(fragment_idx)
        return zip(*bounds, strict=True) if bounds is not None else iter(())


class NavigationNoteIndex:
    """One publication's note ranges, indexed once for repeated candidate reads."""

    def __init__(self, regions: Iterable[NoteRegion], fragment_order: Mapping[UUID, int]) -> None:
        bodies: dict[int, list[tuple[int, int]]] = {}
        groups: dict[int, list[tuple[int, int]]] = {}
        headings: set[DocumentPoint] = set()
        group_regions: list[NoteGroupRegion] = []
        for region in regions:
            start = region.range.start
            end = region.range.end
            idx = fragment_order[start.fragment_id]
            if fragment_order[end.fragment_id] != idx:
                raise ValueError("A note region must remain within one canonical fragment")
            target = bodies if isinstance(region, NoteBodyRegion) else groups
            target.setdefault(idx, []).append((start.offset, end.offset))
            if isinstance(region, NoteGroupRegion):
                group_regions.append(region)
                if region.heading is not None:
                    headings.add(DocumentPoint(idx, region.heading.offset))
        self.groups = tuple(group_regions)
        self._fragments = bodies.keys() | groups.keys()
        self._bodies = FragmentIntervals(bodies)
        self._groups = FragmentIntervals(groups)
        self._headings = headings

    def has_notes(self, fragment_idx: int) -> bool:
        return fragment_idx in self._fragments

    def is_routine(self, point: DocumentPoint) -> bool:
        if self._bodies.contains(point):
            return False
        return not self._groups.contains(point) or (point in self._headings)

    def covers_member(self, fragment_idx: int, text: str) -> bool:
        if not text.strip():
            return False
        cursor = 0
        for start, end in merge(self._bodies.spans(fragment_idx), self._groups.spans(fragment_idx)):
            if text[cursor:start].strip():
                return False
            cursor = max(cursor, end)
        return cursor > 0 and not text[cursor:].strip()


def resolve_section_extents(
    sections: Sequence[SectionRangeInput],
    document_end: DocumentPoint | None,
    *,
    unproved_boundaries: Sequence[DocumentPoint] = (),
    document_end_cut: DomCut | None = None,
    closing_boundaries: Sequence[SectionBoundary] = (),
) -> dict[str, SectionEnd | None]:
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
    natural_ends = dict.fromkeys(
        by_id, SectionEnd(document_end, document_end_cut) if document_end is not None else None
    )
    unproved: set[str] = set()
    stacks: dict[str | None, list[SectionRangeInput]] = {}
    boundaries: dict[DocumentPoint, list[SectionRangeInput]] = {}
    for section in ordered:
        boundaries.setdefault(section.target, []).append(section)
    barriers = set(unproved_boundaries)
    closing: dict[DocumentPoint, dict[str, tuple[int, SectionEnd]]] = {}
    for witness in closing_boundaries:
        scopes = closing.setdefault(witness.end.point, {})
        prior = scopes.get(witness.scope)
        if prior is None or witness.rank < prior[0]:
            scopes[witness.scope] = (witness.rank, witness.end)
        elif witness.rank == prior[0] and witness.end != prior[1]:
            scopes[witness.scope] = (witness.rank, SectionEnd(witness.end.point, None))
    for target in sorted(boundaries.keys() | barriers | closing.keys()):
        grouped = boundaries.get(target, [])
        at_target = closing.get(target, {})
        for scope, stack in stacks.items():
            witness = at_target.get(scope) if scope is not None else None
            kept: list[SectionRangeInput] = []
            for active in stack:
                if any(
                    section.boundary_scope == scope
                    and depths[section.section_id] <= depths[active.section_id]
                    for section in grouped
                ):
                    kept.append(active)
                    continue
                if (
                    witness is not None
                    and active.source_rank is not None
                    and witness[0] <= active.source_rank
                ):
                    natural_ends[active.section_id] = witness[1]
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
            witnesses = {
                section.start_cut for section in group if depths[section.section_id] == next_depth
            }
            cut = next(iter(witnesses)) if len(witnesses) == 1 else None
            while stack and depths[stack[-1].section_id] >= next_depth:
                natural_ends[stack.pop().section_id] = SectionEnd(target, cut)
            stack.extend(group)

    by_depth = sorted(ordered, key=lambda section: depths[section.section_id])
    last_descendant_target = {section.section_id: section.target for section in ordered}
    for section in reversed(by_depth):
        if section.parent_section_id is not None:
            parent_id = section.parent_section_id
            last_descendant_target[parent_id] = max(
                last_descendant_target[parent_id], last_descendant_target[section.section_id]
            )

    ends: dict[str, SectionEnd | None] = {}
    for section in by_depth:
        if section.section_id in unproved:
            ends[section.section_id] = None
            continue
        end = natural_ends[section.section_id]
        if section.container_end is not None:
            if section.owns_container or end is None or section.container_end < end.point:
                end = SectionEnd(section.container_end, section.container_end_cut)
        if end is not None and end.point <= last_descendant_target[section.section_id]:
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
                parent_end is not None and section.target >= parent_end.point
            ):
                ends[section.section_id] = None
                continue
            if parent_end is not None:
                if end is None or parent_end.point < end.point:
                    end = parent_end
        ends[section.section_id] = end if end is not None and end.point > section.target else None
    return ends
