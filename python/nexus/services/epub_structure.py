"""Reconcile publisher navigation and source headings into semantic sections.

Publisher TOC targets, source headings and -- where a book uses them -- an
anchored `[n] <em>incipit` sequence become one ordered list of sections with
parents and ends, without splitting the content itself.
"""

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Literal
from urllib.parse import unquote
from uuid import UUID, uuid5

from nexus.schemas.reader_apparatus import NoteGroupRegion, NoteRegion
from nexus.services.canonicalize import HEADING_TAGS, STRUCTURAL_TAGS, CanonicalStructure
from nexus.services.reader_structure import (
    DocumentPoint,
    NavigationNoteIndex,
    SectionRangeInput,
    resolve_section_ends,
)
from nexus.text import normalize_whitespace

type SectionSource = Literal["Publisher", "Heading", "Both", "InferredNumberedEntry"]


@dataclass(frozen=True)
class EpubStructureFragment:
    fragment_id: UUID
    fragment_idx: int
    package_href: str
    canonical: CanonicalStructure


@dataclass
class EpubStructureTocNode:
    """Parsed publisher/DB fields; target_offset is filled from canonical source."""

    nav_type: str
    node_id: str
    parent_node_id: str | None
    label: str
    href: str | None
    fragment_idx: int | None
    depth: int
    order_key: str
    target_offset: int | None = None
    section_id: str | None = None
    resolution: Literal["Unresolved", "SourceTarget", "BoundaryMatch", "ExactHeadingRepair"] = (
        "Unresolved"
    )


@dataclass(frozen=True)
class EpubStructureSection:
    location_id: str
    label: str
    fragment_idx: int
    href_path: str
    href_fragment: str | None
    start_offset: int
    parent_section_id: str | None
    end: DocumentPoint | None
    source: SectionSource


@dataclass(frozen=True)
class EpubStructureResult:
    sections: list[EpubStructureSection]
    supplemental_toc_nodes: list[EpubStructureTocNode]


@dataclass
class _Section:
    location_id: str
    label: str
    fragment: EpubStructureFragment
    href_fragment: str | None
    element_index: int | None
    target: DocumentPoint
    heading_rank: int | None
    parent: str | None
    container_end: DocumentPoint | None
    source: SectionSource
    owns_container: bool = False


def _heading_location_id(media_id: UUID, fragment_id: UUID, start_offset: int, rank: int) -> str:
    return "heading:" + str(uuid5(media_id, f"{fragment_id}:{start_offset}:{rank}"))


def build_epub_structure(
    *,
    media_id: UUID,
    fragments: Sequence[EpubStructureFragment],
    toc_nodes: Sequence[EpubStructureTocNode],
    note_regions: Sequence[NoteRegion],
) -> EpubStructureResult:
    """Build the exact semantic rows one publication installs."""
    by_href = {fragment.package_href: fragment for fragment in fragments}
    fragment_order = {fragment.fragment_id: fragment.fragment_idx for fragment in fragments}
    note_index = NavigationNoteIndex(note_regions, fragment_order)
    by_toc = {node.node_id: node for node in toc_nodes}
    sections: list[_Section] = []
    by_source_node: dict[str, _Section] = {}
    publisher_boundaries: dict[tuple[DocumentPoint, str], _Section] = {}
    by_element: dict[tuple[int, int], list[_Section]] = {}
    used_ids: set[str] = set()
    claimed_headings: set[tuple[int, int]] = set()

    headings_by_label: dict[str, list[tuple[EpubStructureFragment, int]]] = {}
    for fragment in fragments:
        for index, element in enumerate(fragment.canonical.elements):
            if element.tag in HEADING_TAGS and note_index.is_routine(
                DocumentPoint(fragment.fragment_idx, element.start_offset)
            ):
                label = _match_label(
                    fragment.canonical.text[element.start_offset : element.end_offset]
                )
                if label:
                    headings_by_label.setdefault(label, []).append((fragment, index))

    for node in toc_nodes:
        node.target_offset = None
        node.section_id = None
        node.resolution = "Unresolved"
        source_fragment = by_href.get(node.href.split("#", 1)[0]) if node.href else None
        node.fragment_idx = source_fragment.fragment_idx if source_fragment is not None else None
        if source_fragment is None:
            continue
        fragment = source_fragment
        href_fragment = (
            unquote(node.href.split("#", 1)[1]) if node.href and "#" in node.href else ""
        )
        element_index: int | None = None
        if href_fragment:
            index = fragment.canonical.anchors.get(href_fragment)
            if index is None:
                node.fragment_idx = None
                continue
            node.target_offset = fragment.canonical.elements[index].start_offset
            ancestor = fragment.canonical.elements[index].parent_element
            while ancestor is not None:
                element = fragment.canonical.elements[ancestor]
                if element.tag in HEADING_TAGS:
                    if element.start_offset == node.target_offset:
                        index = ancestor
                    break
                ancestor = element.parent_element
            element_index = index
        else:
            node.target_offset = 0
        node.resolution = "SourceTarget"
        if node.nav_type != "toc":
            continue
        match = _matching_heading(fragment, node.target_offset, node.label)
        if match is not None:
            element_index = match[0]
            node.target_offset = fragment.canonical.elements[match[0]].start_offset
            node.resolution = "BoundaryMatch"
            claimed_headings.update((fragment.fragment_idx, index) for index in match)
        else:
            candidates = headings_by_label.get(_match_label(node.label), [])
            if (
                len(candidates) == 1
                and _source_target_incompatible(node, fragment, candidates[0], toc_nodes, by_href)
                and _repair_has_neighbor_agreement(
                    node,
                    DocumentPoint(
                        candidates[0][0].fragment_idx,
                        candidates[0][0].canonical.elements[candidates[0][1]].start_offset,
                    ),
                    toc_nodes,
                    by_href,
                    note_index,
                )
            ):
                repaired_fragment, repaired_index = candidates[0]
                repaired_element = repaired_fragment.canonical.elements[repaired_index]
                if (fragment.fragment_idx, node.target_offset) != (
                    repaired_fragment.fragment_idx,
                    repaired_element.start_offset,
                ):
                    fragment = repaired_fragment
                    node.fragment_idx = fragment.fragment_idx
                    node.target_offset = repaired_element.start_offset
                    element_index = repaired_index
                    repaired_anchors = [
                        anchor
                        for anchor, anchor_index in fragment.canonical.anchors.items()
                        if anchor_index == repaired_index
                    ]
                    href_fragment = repaired_anchors[0] if len(repaired_anchors) == 1 else ""
                    node.resolution = "ExactHeadingRepair"
                    claimed_headings.add((fragment.fragment_idx, repaired_index))
            elif element_index is not None:
                current = fragment.canonical.elements[element_index]
                if current.tag in HEADING_TAGS and _match_label(
                    fragment.canonical.text[current.start_offset : current.end_offset]
                ) == _match_label(node.label):
                    claimed_headings.add((fragment.fragment_idx, element_index))
        if not note_index.is_routine(DocumentPoint(fragment.fragment_idx, node.target_offset)):
            continue
        boundary = (
            DocumentPoint(fragment.fragment_idx, node.target_offset),
            _match_label(node.label),
        )
        prior = publisher_boundaries.get(boundary)
        if prior is not None:
            node.section_id = prior.location_id
            by_source_node[node.node_id] = prior
            continue
        source_target = node.href or fragment.package_href
        location_id = (
            source_target
            if len(source_target) <= 255 and source_target not in used_ids
            else str(uuid5(media_id, f"publisher:{node.node_id}"))
        )
        if location_id in used_ids or not 1 <= len(location_id) <= 255:
            raise ValueError("EPUB source section identity is invalid or duplicated")
        used_ids.add(location_id)
        section = _Section(
            location_id=location_id,
            label=node.label,
            fragment=fragment,
            href_fragment=href_fragment if href_fragment else None,
            element_index=element_index,
            target=DocumentPoint(fragment.fragment_idx, node.target_offset),
            heading_rank=None,
            parent=None,
            container_end=None,
            source="Publisher",
        )
        sections.append(section)
        publisher_boundaries[boundary] = section
        node.section_id = section.location_id
        by_source_node[node.node_id] = section
        if element_index is not None:
            by_element.setdefault((fragment.fragment_idx, element_index), []).append(section)

    parented_sections: set[str] = set()
    for node in toc_nodes:
        section = by_source_node.get(node.node_id)
        if section is None:
            continue
        if section.location_id in parented_sections:
            continue
        parented_sections.add(section.location_id)
        parent_id = node.parent_node_id
        visited = {node.node_id}
        while parent_id is not None:
            if parent_id in visited or parent_id not in by_toc:
                raise ValueError("EPUB publisher ancestry is invalid")
            visited.add(parent_id)
            parent = by_source_node.get(parent_id)
            if parent is not None:
                section.parent = parent.location_id
                break
            parent_id = by_toc[parent_id].parent_node_id

    for fragment in fragments:
        for index, element in enumerate(fragment.canonical.elements):
            if element.tag not in HEADING_TAGS:
                continue
            if not note_index.is_routine(
                DocumentPoint(fragment.fragment_idx, element.start_offset)
            ):
                continue
            label = normalize_whitespace(
                fragment.canonical.text[element.start_offset : element.end_offset]
            )
            if not label:
                continue
            rank = int(element.tag[1])
            matched = by_element.get((fragment.fragment_idx, index))
            if matched:
                for section in matched:
                    section.heading_rank = rank
                    section.source = "Both"
                continue
            if (fragment.fragment_idx, index) in claimed_headings:
                # A publisher's adjacent number/title group claims both headings;
                # only its first heading owns the section boundary.
                continue
            location_id = _heading_location_id(
                media_id, fragment.fragment_id, element.start_offset, rank
            )
            if location_id in used_ids:
                raise ValueError("EPUB heading identity is duplicated")
            used_ids.add(location_id)
            anchors = [
                anchor
                for anchor, anchor_index in fragment.canonical.anchors.items()
                if anchor_index == index
            ]
            section = _Section(
                location_id=location_id,
                label=label[:512],
                fragment=fragment,
                href_fragment=anchors[0] if len(anchors) == 1 else None,
                element_index=index,
                target=DocumentPoint(fragment.fragment_idx, element.start_offset),
                heading_rank=rank,
                parent=None,
                container_end=None,
                source="Heading",
            )
            sections.append(section)
            by_element[(fragment.fragment_idx, index)] = [section]

    _add_inferred_numbered_entries(media_id, fragments, sections, by_element, note_index)
    by_container = _bind_containers(fragments, sections, by_element)
    _assign_parents(sections, by_element, by_container)

    if not fragments:
        return EpubStructureResult([], [])
    last = max(fragments, key=lambda fragment: fragment.fragment_idx)
    ends = resolve_section_ends(
        [
            SectionRangeInput(
                section.location_id,
                section.target,
                section.parent,
                section.container_end,
                section.owns_container,
            )
            for section in sections
        ],
        DocumentPoint(last.fragment_idx, len(last.canonical.text)),
    )
    published_sections = [
        EpubStructureSection(
            location_id=section.location_id,
            label=section.label,
            fragment_idx=section.fragment.fragment_idx,
            href_path=section.fragment.package_href,
            href_fragment=section.href_fragment,
            start_offset=section.target.offset,
            parent_section_id=section.parent,
            end=ends[section.location_id],
            source=section.source,
        )
        for section in sections
    ]
    return EpubStructureResult(
        published_sections,
        _supplemental_toc_nodes(media_id, fragments, toc_nodes, sections, note_regions, note_index),
    )


def _match_label(label: str) -> str:
    return unicodedata.normalize("NFC", normalize_whitespace(label)).casefold()


def _matching_heading(
    fragment: EpubStructureFragment, target_offset: int, label: str
) -> tuple[int, ...] | None:
    """A source boundary or adjacent number/title pair claimed by one TOC entry."""
    elements = fragment.canonical.elements
    headings = [
        (index, element)
        for index, element in enumerate(elements)
        if element.tag in HEADING_TAGS and target_offset <= element.start_offset
    ]
    if not headings or fragment.canonical.text[target_offset : headings[0][1].start_offset].strip():
        return None
    first_index, first = headings[0]
    first_label = _match_label(fragment.canonical.text[first.start_offset : first.end_offset])
    expected = _match_label(label)
    if first_label == expected:
        return (first_index,)
    if len(headings) < 2:
        return None
    second_index, second = headings[1]
    if fragment.canonical.text[first.end_offset : second.start_offset].strip():
        return None
    second_label = _match_label(fragment.canonical.text[second.start_offset : second.end_offset])
    if re.fullmatch(re.escape(first_label) + r"[\s.:-]+" + re.escape(second_label), expected):
        return first_index, second_index
    return None


def _source_target_incompatible(
    node: EpubStructureTocNode,
    source: EpubStructureFragment,
    candidate: tuple[EpubStructureFragment, int],
    toc_nodes: Sequence[EpubStructureTocNode],
    by_href: dict[str, EpubStructureFragment],
) -> bool:
    """A conflicting authored boundary must already own the declared point."""
    assert node.target_offset is not None
    candidate_fragment, candidate_index = candidate
    candidate_offset = candidate_fragment.canonical.elements[candidate_index].start_offset
    if candidate_fragment is source and node.target_offset < candidate_offset:
        # Leading prose can be an intentional chapter arrival before its title.
        return False
    elements = source.canonical.elements
    nearest_heading = next(
        (
            index
            for index in range(len(elements) - 1, -1, -1)
            if elements[index].tag in HEADING_TAGS
            and elements[index].start_offset <= node.target_offset
        ),
        None,
    )
    if nearest_heading is None:
        return False
    for other in toc_nodes:
        if other.node_id == node.node_id or other.nav_type != "toc" or other.href is None:
            continue
        if by_href.get(other.href.split("#", 1)[0]) is not source:
            continue
        anchor = unquote(other.href.split("#", 1)[1]) if "#" in other.href else ""
        if anchor:
            index = source.canonical.anchors.get(anchor)
            if index is None:
                continue
            offset = source.canonical.elements[index].start_offset
        else:
            offset = 0
        matched = _matching_heading(source, offset, other.label)
        if matched is None:
            continue
        boundary_offset = source.canonical.elements[matched[0]].start_offset
        if (
            matched[0] == nearest_heading
            and boundary_offset <= node.target_offset
            and _match_label(other.label) != _match_label(node.label)
        ):
            return True
    return False


def _repair_has_neighbor_agreement(
    node: EpubStructureTocNode,
    candidate: DocumentPoint,
    toc_nodes: Sequence[EpubStructureTocNode],
    by_href: dict[str, EpubStructureFragment],
    note_index: NavigationNoteIndex,
) -> bool:
    def valid_boundary(sibling: EpubStructureTocNode) -> DocumentPoint | None:
        if sibling.href is None:
            return None
        fragment = by_href.get(sibling.href.split("#", 1)[0])
        if fragment is None:
            return None
        anchor = unquote(sibling.href.split("#", 1)[1]) if "#" in sibling.href else ""
        if anchor:
            index = fragment.canonical.anchors.get(anchor)
            if index is None:
                return None
            offset = fragment.canonical.elements[index].start_offset
        else:
            offset = 0
        matched = _matching_heading(fragment, offset, sibling.label)
        if matched is None:
            return None
        point = DocumentPoint(
            fragment.fragment_idx, fragment.canonical.elements[matched[0]].start_offset
        )
        return point if note_index.is_routine(point) else None

    siblings = [
        other
        for other in toc_nodes
        if other.nav_type == "toc" and other.parent_node_id == node.parent_node_id
    ]
    index = next(index for index, sibling in enumerate(siblings) if sibling.node_id == node.node_id)
    before = valid_boundary(siblings[index - 1]) if index > 0 else None
    after = valid_boundary(siblings[index + 1]) if index + 1 < len(siblings) else None
    return before is not None and after is not None and before < candidate < after


def _supplemental_toc_nodes(
    media_id: UUID,
    fragments: Sequence[EpubStructureFragment],
    publisher_nodes: Sequence[EpubStructureTocNode],
    sections: list[_Section],
    note_regions: Sequence[NoteRegion],
    note_index: NavigationNoteIndex,
) -> list[EpubStructureTocNode]:
    """Publish source-only apparatus headings beneath their note collection."""
    by_fragment_id = {fragment.fragment_id: fragment for fragment in fragments}
    groups = [region for region in note_regions if isinstance(region, NoteGroupRegion)]
    published = list(publisher_nodes)
    supplemental: list[EpubStructureTocNode] = []
    used_ids = {node.node_id for node in published}

    def add_heading(
        fragment: EpubStructureFragment,
        index: int,
        parent: EpubStructureTocNode | None,
        section_id: str | None,
    ) -> EpubStructureTocNode:
        element = fragment.canonical.elements[index]
        node_id = _heading_location_id(
            media_id, fragment.fragment_id, element.start_offset, int(element.tag[1])
        )
        if node_id in used_ids:
            raise ValueError("EPUB source contents identity is duplicated")
        used_ids.add(node_id)
        siblings = [
            node
            for node in published
            if node.nav_type == "toc"
            and node.parent_node_id == (parent.node_id if parent is not None else None)
        ]
        ordinal = max((int(node.order_key.rsplit(".", 1)[-1]) for node in siblings), default=-1) + 1
        if ordinal > 9999 or (parent is not None and parent.depth >= 16):
            raise ValueError("EPUB source contents exceed publisher navigation depth or order")
        anchor_names = [
            name
            for name, anchor_index in fragment.canonical.anchors.items()
            if anchor_index == index
        ]
        node = EpubStructureTocNode(
            nav_type="toc",
            node_id=node_id,
            parent_node_id=parent.node_id if parent is not None else None,
            label=normalize_whitespace(
                fragment.canonical.text[element.start_offset : element.end_offset]
            )[:512],
            href=(
                fragment.package_href + "#" + anchor_names[0] if len(anchor_names) == 1 else None
            ),
            fragment_idx=fragment.fragment_idx,
            depth=parent.depth + 1 if parent is not None else 0,
            order_key=(parent.order_key + "." if parent is not None else "") + f"{ordinal:04d}",
            target_offset=element.start_offset,
            section_id=section_id,
            resolution="BoundaryMatch",
        )
        supplemental.append(node)
        published.append(node)
        return node

    group_nodes: dict[tuple[UUID, int], EpubStructureTocNode] = {}
    for group in groups:
        if group.heading is None:
            continue
        heading = group.heading
        fragment = by_fragment_id[heading.fragment_id]
        point = DocumentPoint(fragment.fragment_idx, heading.offset)
        existing = next(
            (
                node
                for node in published
                if node.nav_type == "toc"
                and node.fragment_idx == point.fragment_idx
                and node.target_offset == point.offset
                and node.section_id is not None
            ),
            None,
        )
        if existing is None:
            section = next((item for item in sections if item.target == point), None)
            index = next(
                (
                    index
                    for index, element in enumerate(fragment.canonical.elements)
                    if element.tag in HEADING_TAGS and element.start_offset == point.offset
                ),
                None,
            )
            if section is None or index is None:
                continue
            existing = add_heading(fragment, index, None, section.location_id)
        group_nodes[(heading.fragment_id, heading.offset)] = existing

    for fragment in fragments:
        for index, element in enumerate(fragment.canonical.elements):
            if element.tag not in HEADING_TAGS:
                continue
            point = DocumentPoint(fragment.fragment_idx, element.start_offset)
            if note_index.is_routine(point):
                continue
            containing = [
                group
                for group in groups
                if group.range.start.fragment_id == fragment.fragment_id
                and group.range.start.offset <= point.offset < group.range.end.offset
                and group.heading is not None
                and group.heading.offset != point.offset
            ]
            parent = None
            if containing:
                group = min(
                    containing,
                    key=lambda item: item.range.end.offset - item.range.start.offset,
                )
                assert group.heading is not None
                parent = group_nodes.get((fragment.fragment_id, group.heading.offset))
            label = _match_label(fragment.canonical.text[element.start_offset : element.end_offset])
            if any(
                node.nav_type == "toc"
                and node.fragment_idx == point.fragment_idx
                and node.target_offset == point.offset
                and _match_label(node.label) == label
                for node in published
            ):
                continue
            add_heading(fragment, index, parent, None)
    return supplemental


def _add_inferred_numbered_entries(
    media_id: UUID,
    fragments: Sequence[EpubStructureFragment],
    sections: list[_Section],
    by_element: dict[tuple[int, int], list[_Section]],
    note_index: NavigationNoteIndex,
) -> None:
    """Infer only a complete, anchored sequence with typographic opening evidence."""
    numbered: list[tuple[EpubStructureFragment, int, int, str, str]] = []
    for fragment in fragments:
        elements = fragment.canonical.elements
        children: dict[int, list[int]] = {}
        names_by_element: dict[int, list[str]] = {}
        for index, element in enumerate(elements):
            if element.parent_element is not None:
                children.setdefault(element.parent_element, []).append(index)
        for name, index in fragment.canonical.anchors.items():
            names_by_element.setdefault(index, []).append(name)
        for index, element in enumerate(elements):
            if element.tag != "p" or not element.numbering_allowed:
                continue
            if not note_index.is_routine(
                DocumentPoint(fragment.fragment_idx, element.start_offset)
            ):
                continue
            text = fragment.canonical.text[element.start_offset : element.end_offset]
            marker = re.match(r"\[([1-9][0-9]*)\]", text)
            if marker is None:
                continue
            opening_names = names_by_element.get(index, [])
            if not opening_names:
                opening_names = [
                    name
                    for child in children.get(index, [])
                    if elements[child].start_offset == element.start_offset
                    and elements[child].end_offset == element.start_offset
                    for name in names_by_element.get(child, [])
                ]
            opening = next(
                (
                    elements[child]
                    for child in children.get(index, [])
                    if elements[child].tag == "em"
                ),
                None,
            )
            if not opening_names or opening is None:
                continue
            if opening.start_offset < element.start_offset + marker.end():
                continue
            prefix = fragment.canonical.text[
                element.start_offset + marker.end() : opening.start_offset
            ]
            incipit = normalize_whitespace(
                fragment.canonical.text[opening.start_offset : opening.end_offset]
            )
            if not incipit or any(character not in " *‘’'“\"(" for character in prefix):
                continue
            number = int(marker[1])
            numbered.append((fragment, index, number, f"[{number}] {incipit}", opening_names[0]))

    if len(numbered) < 3 or any(right[2] != left[2] + 1 for left, right in pairwise(numbered)):
        return
    for fragment, index, number, label, anchor in numbered:
        explicit = by_element.get((fragment.fragment_idx, index), []) + by_element.get(
            (fragment.fragment_idx, fragment.canonical.anchors[anchor]), []
        )
        if explicit:
            for section in explicit:
                section.heading_rank = 7
            continue
        element = fragment.canonical.elements[index]
        section = _Section(
            location_id="numbered:"
            + str(uuid5(media_id, f"{fragment.fragment_id}:{element.start_offset}:{number}")),
            label=label[:512],
            fragment=fragment,
            href_fragment=anchor,
            element_index=index,
            target=DocumentPoint(fragment.fragment_idx, element.start_offset),
            heading_rank=7,
            parent=None,
            container_end=None,
            source="InferredNumberedEntry",
        )
        sections.append(section)
        by_element[(fragment.fragment_idx, index)] = [section]


def _bind_containers(
    fragments: Sequence[EpubStructureFragment],
    sections: list[_Section],
    by_element: dict[tuple[int, int], list[_Section]],
) -> dict[tuple[int, int], _Section]:
    """Give each `section`/`article` its owning heading and each section its end."""
    by_container: dict[tuple[int, int], _Section] = {}
    for fragment in fragments:
        for index, container in enumerate(fragment.canonical.elements):
            if container.tag not in STRUCTURAL_TAGS:
                continue
            owners = by_element.get((fragment.fragment_idx, index), [])
            if not owners:
                labelled = {
                    fragment.canonical.anchors[label]
                    for label in container.labelled_by
                    if label in fragment.canonical.anchors
                }
                candidates = {
                    section.element_index
                    for section in sections
                    if section.fragment is fragment
                    and section.element_index is not None
                    and fragment.canonical.elements[section.element_index].parent_container == index
                    and (
                        section.element_index in labelled
                        if labelled
                        else section.target.offset == container.start_offset
                    )
                    and section.source != "InferredNumberedEntry"
                }
                if len(candidates) == 1:
                    owners = by_element[(fragment.fragment_idx, candidates.pop())]
            if owners:
                by_container[(fragment.fragment_idx, index)] = owners[0]
                for owner in owners:
                    owner.owns_container = True
                    owner.container_end = DocumentPoint(fragment.fragment_idx, container.end_offset)

    for section in sections:
        if section.element_index is None:
            continue
        element = section.fragment.canonical.elements[section.element_index]
        container = (
            section.element_index if element.tag in STRUCTURAL_TAGS else element.parent_container
        )
        if container is not None and not section.owns_container:
            source_container = section.fragment.canonical.elements[container]
            section.container_end = DocumentPoint(
                section.fragment.fragment_idx, source_container.end_offset
            )
    return by_container


def _assign_parents(
    sections: list[_Section],
    by_element: dict[tuple[int, int], list[_Section]],
    by_container: dict[tuple[int, int], _Section],
) -> None:
    """Nest sections by source container first, then by heading rank."""
    by_id = {section.location_id: section for section in sections}

    # Publisher grouping can span a title page and independently declared chapters.
    # Its presentation parent cannot override a chapter's exact source container.
    for section in sections:
        if not section.owns_container or section.parent is None:
            continue
        parent = by_id[section.parent]
        if parent.container_end is not None and (
            section.target < parent.target
            or (section.container_end is not None and section.container_end > parent.container_end)
        ):
            section.parent = None

    # A source container precedes its first heading at coincident text offsets.
    sections.sort(
        key=lambda section: (
            section.target,
            section.element_index if section.element_index is not None else -1,
        )
    )
    stack: list[_Section] = []
    processed_elements: set[tuple[int, int]] = set()
    for section in sections:
        element_key = (
            (section.fragment.fragment_idx, section.element_index)
            if section.element_index is not None
            else None
        )
        if element_key is not None and element_key in processed_elements:
            first = by_element[element_key][0]
            if section.parent is None:
                section.parent = first.parent
            continue
        if element_key is not None:
            processed_elements.add(element_key)
        while stack and (
            (stack[-1].container_end is not None and stack[-1].container_end <= section.target)
            or (
                section.heading_rank is not None
                and stack[-1].heading_rank is not None
                and stack[-1].heading_rank >= section.heading_rank
            )
        ):
            stack.pop()
        if section.parent is None and section.element_index is not None:
            container = section.fragment.canonical.elements[section.element_index].parent_container
            while container is not None:
                owner = by_container.get((section.fragment.fragment_idx, container))
                if owner is not None and owner.location_id != section.location_id:
                    section.parent = (
                        stack[-1].location_id
                        if section.heading_rank is not None
                        and stack
                        and any(ancestor.location_id == owner.location_id for ancestor in stack)
                        else owner.location_id
                    )
                    break
                container = section.fragment.canonical.elements[container].parent_container
        if section.parent is None and section.heading_rank is not None and stack:
            section.parent = stack[-1].location_id
        # Publisher boundaries reset context; only headings and containers can parent it.
        chain: list[_Section] = []
        ancestor_id = section.parent
        visited = {section.location_id}
        while ancestor_id is not None:
            if ancestor_id in visited:
                raise ValueError("EPUB semantic ancestry contains a cycle")
            visited.add(ancestor_id)
            ancestor = by_id[ancestor_id]
            chain.append(ancestor)
            ancestor_id = ancestor.parent
        stack = [
            ancestor
            for ancestor in [*reversed(chain), section]
            if ancestor.heading_rank is not None or ancestor.owns_container
        ]
