"""Reconcile publisher navigation and source headings into semantic sections.

Publisher TOC targets, source headings and -- where a book uses them -- an
anchored `[n] <em>incipit` sequence become one ordered list of sections with
parents and ends, without splitting the content itself.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Literal
from urllib.parse import unquote
from uuid import UUID, uuid5

from nexus.schemas.presence import Presence, Present, absent, present
from nexus.services.canonicalize import HEADING_TAGS, STRUCTURAL_TAGS, CanonicalStructure
from nexus.services.reader_structure import DocumentPoint, SectionRangeInput, resolve_section_ends
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


@dataclass(frozen=True)
class EpubStructureSection:
    location_id: str
    label: str
    source_node_id: Presence[str]
    fragment_idx: int
    href_path: str
    href_fragment: Presence[str]
    start_offset: int
    parent_section_id: Presence[str]
    end: Presence[DocumentPoint]
    source: SectionSource


@dataclass
class _Section:
    location_id: str
    label: str
    source_node_id: Presence[str]
    fragment: EpubStructureFragment
    href_fragment: Presence[str]
    element_index: Presence[int]
    target: DocumentPoint
    heading_rank: Presence[int]
    parent: Presence[str]
    container_end: Presence[DocumentPoint]
    source: SectionSource
    owns_container: bool = False


def build_epub_structure(
    *,
    media_id: UUID,
    fragments: Sequence[EpubStructureFragment],
    toc_nodes: Sequence[EpubStructureTocNode],
) -> list[EpubStructureSection]:
    """Build the exact semantic rows one publication installs."""
    by_fragment = {fragment.fragment_idx: fragment for fragment in fragments}
    by_toc = {node.node_id: node for node in toc_nodes}
    sections: list[_Section] = []
    by_source_node: dict[str, _Section] = {}
    by_element: dict[tuple[int, int], list[_Section]] = {}
    used_ids: set[str] = set()

    for node in toc_nodes:
        node.target_offset = None
        if node.fragment_idx is None:
            continue
        fragment = by_fragment[node.fragment_idx]
        href_fragment = (
            unquote(node.href.split("#", 1)[1]) if node.href and "#" in node.href else ""
        )
        element_index: Presence[int] = absent()
        if href_fragment:
            index = fragment.canonical.anchors.get(href_fragment)
            if index is None:
                continue
            node.target_offset = fragment.canonical.elements[index].start_offset
            ancestor = fragment.canonical.elements[index].parent_element
            while isinstance(ancestor, Present):
                element = fragment.canonical.elements[ancestor.value]
                if element.tag in HEADING_TAGS:
                    if element.start_offset == node.target_offset:
                        index = ancestor.value
                    break
                ancestor = element.parent_element
            element_index = present(index)
        else:
            node.target_offset = 0
        if node.nav_type != "toc":
            continue
        source_target = fragment.package_href + (f"#{href_fragment}" if href_fragment else "")
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
            source_node_id=present(node.node_id),
            fragment=fragment,
            href_fragment=present(href_fragment) if href_fragment else absent(),
            element_index=element_index,
            target=DocumentPoint(fragment.fragment_idx, node.target_offset),
            heading_rank=absent(),
            parent=absent(),
            container_end=absent(),
            source="Publisher",
        )
        sections.append(section)
        by_source_node[node.node_id] = section
        if isinstance(element_index, Present):
            by_element.setdefault((fragment.fragment_idx, element_index.value), []).append(section)

    for node in toc_nodes:
        section = by_source_node.get(node.node_id)
        if section is None:
            continue
        parent_id = node.parent_node_id
        visited = {node.node_id}
        while parent_id is not None:
            if parent_id in visited or parent_id not in by_toc:
                raise ValueError("EPUB publisher ancestry is invalid")
            visited.add(parent_id)
            parent = by_source_node.get(parent_id)
            if parent is not None:
                section.parent = present(parent.location_id)
                break
            parent_id = by_toc[parent_id].parent_node_id

    for fragment in fragments:
        for index, element in enumerate(fragment.canonical.elements):
            if element.tag not in HEADING_TAGS:
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
                    section.heading_rank = present(rank)
                    section.source = "Both"
                continue
            location_id = "heading:" + str(
                uuid5(media_id, f"{fragment.fragment_id}:{element.start_offset}:{rank}")
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
                source_node_id=absent(),
                fragment=fragment,
                href_fragment=present(anchors[0]) if len(anchors) == 1 else absent(),
                element_index=present(index),
                target=DocumentPoint(fragment.fragment_idx, element.start_offset),
                heading_rank=present(rank),
                parent=absent(),
                container_end=absent(),
                source="Heading",
            )
            sections.append(section)
            by_element[(fragment.fragment_idx, index)] = [section]

    _add_inferred_numbered_entries(media_id, fragments, sections, by_element)
    by_container = _bind_containers(fragments, sections, by_element)
    _assign_parents(sections, by_element, by_container)

    if not fragments:
        return []
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
    return [
        EpubStructureSection(
            location_id=section.location_id,
            label=section.label,
            source_node_id=section.source_node_id,
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


def _add_inferred_numbered_entries(
    media_id: UUID,
    fragments: Sequence[EpubStructureFragment],
    sections: list[_Section],
    by_element: dict[tuple[int, int], list[_Section]],
) -> None:
    """Infer only a complete, anchored sequence with typographic opening evidence."""
    numbered: list[tuple[EpubStructureFragment, int, int, str, str]] = []
    for fragment in fragments:
        elements = fragment.canonical.elements
        children: dict[int, list[int]] = {}
        names_by_element: dict[int, list[str]] = {}
        for index, element in enumerate(elements):
            if isinstance(element.parent_element, Present):
                children.setdefault(element.parent_element.value, []).append(index)
        for name, index in fragment.canonical.anchors.items():
            names_by_element.setdefault(index, []).append(name)
        for index, element in enumerate(elements):
            if element.tag != "p" or not element.numbering_allowed:
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
                section.heading_rank = present(7)
            continue
        element = fragment.canonical.elements[index]
        section = _Section(
            location_id="numbered:"
            + str(uuid5(media_id, f"{fragment.fragment_id}:{element.start_offset}:{number}")),
            label=label[:512],
            source_node_id=absent(),
            fragment=fragment,
            href_fragment=present(anchor),
            element_index=present(index),
            target=DocumentPoint(fragment.fragment_idx, element.start_offset),
            heading_rank=present(7),
            parent=absent(),
            container_end=absent(),
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
                    section.element_index.value
                    for section in sections
                    if section.fragment is fragment
                    and isinstance(section.element_index, Present)
                    and fragment.canonical.elements[section.element_index.value].parent_container
                    == present(index)
                    and (
                        section.element_index.value in labelled
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
                    owner.container_end = present(
                        DocumentPoint(fragment.fragment_idx, container.end_offset)
                    )

    for section in sections:
        if not isinstance(section.element_index, Present):
            continue
        element = section.fragment.canonical.elements[section.element_index.value]
        container = (
            section.element_index if element.tag in STRUCTURAL_TAGS else element.parent_container
        )
        if isinstance(container, Present) and not section.owns_container:
            source_container = section.fragment.canonical.elements[container.value]
            section.container_end = present(
                DocumentPoint(section.fragment.fragment_idx, source_container.end_offset)
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
        if not section.owns_container or not isinstance(section.parent, Present):
            continue
        parent = by_id[section.parent.value]
        if isinstance(parent.container_end, Present) and (
            section.target < parent.target
            or (
                isinstance(section.container_end, Present)
                and section.container_end.value > parent.container_end.value
            )
        ):
            section.parent = absent()

    # A source container precedes its first heading at coincident text offsets.
    sections.sort(
        key=lambda section: (
            section.target,
            section.element_index.value if isinstance(section.element_index, Present) else -1,
        )
    )
    stack: list[_Section] = []
    processed_elements: set[tuple[int, int]] = set()
    for section in sections:
        element_key = (
            (section.fragment.fragment_idx, section.element_index.value)
            if isinstance(section.element_index, Present)
            else None
        )
        if element_key is not None and element_key in processed_elements:
            first = by_element[element_key][0]
            if not isinstance(section.parent, Present):
                section.parent = first.parent
            continue
        if element_key is not None:
            processed_elements.add(element_key)
        while stack and (
            (
                isinstance(stack[-1].container_end, Present)
                and stack[-1].container_end.value <= section.target
            )
            or (
                isinstance(section.heading_rank, Present)
                and isinstance(stack[-1].heading_rank, Present)
                and stack[-1].heading_rank.value >= section.heading_rank.value
            )
        ):
            stack.pop()
        if not isinstance(section.parent, Present) and isinstance(section.element_index, Present):
            container = section.fragment.canonical.elements[
                section.element_index.value
            ].parent_container
            while isinstance(container, Present):
                owner = by_container.get((section.fragment.fragment_idx, container.value))
                if owner is not None and owner.location_id != section.location_id:
                    section.parent = present(
                        stack[-1].location_id
                        if isinstance(section.heading_rank, Present)
                        and stack
                        and any(ancestor.location_id == owner.location_id for ancestor in stack)
                        else owner.location_id
                    )
                    break
                container = section.fragment.canonical.elements[container.value].parent_container
        if (
            not isinstance(section.parent, Present)
            and isinstance(section.heading_rank, Present)
            and stack
        ):
            section.parent = present(stack[-1].location_id)
        # Publisher boundaries reset context; only headings and containers can parent it.
        chain: list[_Section] = []
        parent_presence = section.parent
        visited = {section.location_id}
        while isinstance(parent_presence, Present):
            if parent_presence.value in visited:
                raise ValueError("EPUB semantic ancestry contains a cycle")
            visited.add(parent_presence.value)
            ancestor = by_id[parent_presence.value]
            chain.append(ancestor)
            parent_presence = ancestor.parent
        stack = [
            ancestor
            for ancestor in [*reversed(chain), section]
            if isinstance(ancestor.heading_rank, Present) or ancestor.owns_container
        ]
