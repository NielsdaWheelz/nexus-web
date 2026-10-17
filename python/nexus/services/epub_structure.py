"""Derive routine reading divisions from verified publisher and source facts.

Contents destinations remain distinct from section ownership. Authored roles,
complete containers and corroborated divisions prove parents; heading rank is
local to one source document. Unproved parents or ranges stay absent. Both
normal import and retained repair use this owner without changing source text.
An anchored `[n] <em>incipit` sequence remains a supported source division.
"""

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass, replace
from itertools import pairwise
from typing import Literal
from urllib.parse import unquote, urlparse
from uuid import UUID, uuid4, uuid5

from lxml.html import HtmlElement

from nexus.schemas.reader_apparatus import NoteGroupRegion, NoteRegion
from nexus.services.canonicalize import (
    HEADING_TAGS,
    STRUCTURAL_TAGS,
    STRUCTURE_CAPTURE_TAGS,
    CanonicalStructure,
    canonicalize_structure,
    generate_canonical_text,
)
from nexus.services.epub_sanitize import element_id, sanitize_epub_chapter
from nexus.services.html_tree import parse_html_document, serialize_html
from nexus.services.reader_structure import (
    DocumentPoint,
    NavigationNoteIndex,
    SectionRangeInput,
    resolve_section_ends,
)
from nexus.text import normalize_whitespace

type SectionSource = Literal["Publisher", "Heading", "Both", "InferredNumberedEntry"]
_PARATEXT_ROLES = frozenset(
    {
        "titlepage",
        "doc-titlepage",
        "copyright-page",
        "colophon",
        "bibliography",
        "index",
        "backmatter",
    }
)


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
    boundary_scope: str
    owns_container: bool = False
    publisher_parent: str | None = None


def bind_epub_source_structure(
    *, structure: CanonicalStructure, source_html: str
) -> CanonicalStructure:
    """Bind authored roles and heading groups without changing retained coordinates.

    Temporary ids track source nodes through the current sanitizer. They never
    leave this copy. Equal complete canonical text permits ordered element
    correspondence; otherwise an exact body and surrounding text must identify
    one retained occurrence. An ambiguous authored fact refuses publication.
    """
    source = parse_html_document(source_html)
    body = source.body if source.body is not None else source
    body_id = element_id(body)

    prefix = "nexus-structure-" + uuid4().hex + "-"
    facts: list[tuple[str, str, tuple[str, ...], frozenset[str], bool, str | None]] = []
    original_nodes = [node for node in body.iterdescendants() if isinstance(node, HtmlElement)]
    identities = {
        node: tuple(
            identity
            for identity in (element_id(node), node.get("name"))
            if identity and identity != body_id
        )
        for node in original_nodes
    }
    marker_ids = {node: prefix + str(index) for index, node in enumerate(original_nodes)}
    for node in original_nodes:
        tag = str(node.tag).lower()
        if tag not in HEADING_TAGS | STRUCTURE_CAPTURE_TAGS or tag == "hgroup":
            continue
        roles: set[str] = set()
        in_navigation = False
        group = None
        ancestor: HtmlElement | None = node
        while ancestor is not None:
            for attribute in ("role", "epub:type", "{http://www.idpf.org/2007/ops}type", "type"):
                roles.update((ancestor.get(attribute) or "").lower().split())
            ancestor_tag = str(ancestor.tag).lower()
            in_navigation |= ancestor_tag == "nav"
            if group is None and ancestor_tag in {"header", "hgroup"}:
                group = marker_ids.get(ancestor)
            ancestor = ancestor.getparent()
        in_navigation |= bool(roles & {"toc", "doc-toc", "landmarks", "page-list"})
        if roles or in_navigation or group is not None:
            facts.append(
                (marker_ids[node], tag, identities[node], frozenset(roles), in_navigation, group)
            )
    for node, marker in marker_ids.items():
        node.set("id", marker)
    source_structure = canonicalize_structure(sanitize_epub_chapter(serialize_html(body)))
    expected_text = generate_canonical_text(sanitize_epub_chapter(source_html))
    if source_structure.text != expected_text:
        raise ValueError("EPUB structural capture changes sanitized source text")

    elements = [replace(element) for element in structure.elements]
    retained_by_span: dict[tuple[str, int, int], list[int]] = {}
    for index, element in enumerate(elements):
        retained_by_span.setdefault(
            (element.tag, element.start_offset, element.end_offset), []
        ).append(index)
    used: set[int] = set()
    same_text = source_structure.text == structure.text

    def retained_span(start: int, end: int) -> tuple[int, int]:
        if same_text:
            return start, end
        before = source_structure.text[max(0, start - 64) : start]
        content = source_structure.text[start:end]
        after = source_structure.text[end : end + 64]
        exact = before + content + after
        position = structure.text.find(exact)
        if not exact or position < 0 or structure.text.find(exact, position + 1) >= 0:
            raise ValueError("EPUB authored structure has no unique retained correspondence")
        return position + len(before), position + len(before) + len(content)

    for marker, tag, names, roles, in_navigation, group in facts:
        source_index = source_structure.anchors.get(marker)
        if source_index is None:
            continue
        source_element = source_structure.elements[source_index]
        start, end = retained_span(source_element.start_offset, source_element.end_offset)
        anchored = {structure.anchors[name] for name in names if name in structure.anchors}
        if len(anchored) > 1:
            raise ValueError("EPUB authored structure has ambiguous retained anchors")
        if anchored:
            index = anchored.pop()
            element = elements[index]
            if element.tag != tag or (element.start_offset, element.end_offset) != (start, end):
                raise ValueError("EPUB authored structure disagrees with its retained anchor")
        else:
            key = tag, start, end
            candidates = retained_by_span.get(key, [])
            if not candidates and not same_text:
                candidates = [
                    candidate
                    for candidate, retained in enumerate(elements)
                    if retained.tag == tag
                    and retained.start_offset == start
                    and retained.end_offset >= end
                    and not structure.text[end : retained.end_offset].strip()
                ]
                if len(candidates) != 1:
                    raise ValueError("EPUB authored structure has ambiguous retained boundaries")
            candidates = [candidate for candidate in candidates if candidate not in used]
            if not candidates:
                raise ValueError(f"EPUB authored {tag} at {start}:{end} has no retained element")
            index = candidates[0]
        if index in used:
            raise ValueError("EPUB authored elements have overlapping retained correspondence")
        used.add(index)
        element = elements[index]
        element.roles = roles
        element.in_navigation = in_navigation
        if group is not None and tag in HEADING_TAGS:
            group_index = source_structure.anchors.get(group)
            if group_index is not None:
                source_group = source_structure.elements[group_index]
                headings = [
                    heading
                    for heading in source_structure.elements
                    if heading.tag in HEADING_TAGS
                    and source_group.start_offset <= heading.start_offset < source_group.end_offset
                ]
                cursor = source_group.start_offset
                only_headings = True
                for heading in headings:
                    only_headings &= not source_structure.text[
                        cursor : heading.start_offset
                    ].strip()
                    cursor = heading.end_offset
                only_headings &= not source_structure.text[cursor : source_group.end_offset].strip()
                if only_headings:
                    element.heading_group = retained_span(
                        source_group.start_offset, source_group.end_offset
                    )
    body_roles = frozenset(
        token
        for attribute in ("role", "epub:type", "{http://www.idpf.org/2007/ops}type", "type")
        for token in (body.get(attribute) or "").lower().split()
    )
    if body_roles and body_id is not None and body_id in structure.anchors:
        element = elements[structure.anchors[body_id]]
        start, end = retained_span(0, 0)
        if element.tag != "span" or (element.start_offset, element.end_offset) != (start, end):
            raise ValueError("EPUB authored body anchor has no retained marker correspondence")
        element.roles = body_roles
        element.in_navigation = bool(element.roles & {"toc", "doc-toc", "landmarks", "page-list"})
    return CanonicalStructure(
        structure.text, tuple(elements), structure.anchors, structure.apparatus_items
    )


def _heading_location_id(media_id: UUID, fragment_id: UUID, start_offset: int, rank: int) -> str:
    return "heading:" + str(uuid5(media_id, f"{fragment_id}:{start_offset}:{rank}"))


def _contents_fragments(
    fragments: Sequence[EpubStructureFragment], toc_nodes: Sequence[EpubStructureTocNode]
) -> set[int]:
    """Corroborate an untyped contents page against the authored contents itself."""
    by_href = {fragment.package_href: fragment for fragment in fragments}

    def destination(href: str) -> DocumentPoint | None:
        parsed = urlparse(href)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.path.startswith(("/", "../")):
            return None
        target = by_href.get(unquote(parsed.path))
        if target is None:
            return None
        if not parsed.fragment:
            return DocumentPoint(target.fragment_idx, 0)
        index = target.canonical.anchors.get(unquote(parsed.fragment))
        if index is None:
            return None
        return DocumentPoint(target.fragment_idx, target.canonical.elements[index].start_offset)

    destinations: set[tuple[DocumentPoint, str]] = set()
    for node in toc_nodes:
        if node.nav_type != "toc" or node.href is None:
            continue
        target = destination(node.href)
        if target is not None:
            destinations.add((target, _boundary_label(node.label)))
    contents: set[int] = set()
    for fragment in fragments:
        elements = fragment.canonical.elements
        if any(
            element.roles & {"chapter", "doc-chapter", "part", "doc-part", "volume"}
            for element in elements
        ):
            continue
        headings = [element for element in elements if element.tag in HEADING_TAGS]
        links = [
            element
            for element in elements
            if element.link_href is not None
            and element.start_offset < element.end_offset
            and not any(
                heading.start_offset <= element.start_offset < heading.end_offset
                for heading in headings
            )
        ]
        targets = [
            (
                destination(
                    fragment.package_href + element.link_href
                    if element.link_href is not None and element.link_href.startswith("#")
                    else element.link_href or ""
                ),
                _boundary_label(fragment.canonical.text[element.start_offset : element.end_offset]),
            )
            for element in links
        ]
        if len({target for target, _ in targets}) < 2 or any(
            target not in destinations for target in targets
        ):
            continue
        cursor = 0
        for element in sorted([*headings, *links], key=lambda element: element.start_offset):
            if fragment.canonical.text[cursor : element.start_offset].strip():
                break
            cursor = max(cursor, element.end_offset)
        else:
            if not fragment.canonical.text[cursor:].strip():
                contents.add(fragment.fragment_idx)
    return contents


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
    contents_fragments = _contents_fragments(fragments, toc_nodes)
    by_toc = {node.node_id: node for node in toc_nodes}
    sections: list[_Section] = []
    by_source_node: dict[str, _Section] = {}
    publisher_boundaries: dict[tuple[DocumentPoint, str], _Section] = {}
    by_element: dict[tuple[int, int], list[_Section]] = {}
    used_ids: set[str] = set()
    claimed_headings: set[tuple[int, int]] = set()

    headings_by_label: dict[str, list[tuple[EpubStructureFragment, int]]] = {}
    for fragment in fragments:
        if fragment.fragment_idx in contents_fragments:
            continue
        for index, element in enumerate(fragment.canonical.elements):
            if (
                element.tag in HEADING_TAGS
                and not element.in_navigation
                and note_index.is_routine(
                    DocumentPoint(fragment.fragment_idx, element.start_offset)
                )
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
        if (
            fragment.fragment_idx in contents_fragments
            or not note_index.is_routine(DocumentPoint(fragment.fragment_idx, node.target_offset))
            or any(
                element.in_navigation
                and element.start_offset <= node.target_offset < element.end_offset
                for element in fragment.canonical.elements
            )
            or not fragment.canonical.text.strip()
        ):
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
            boundary_scope="publisher",
        )
        sections.append(section)
        publisher_boundaries[boundary] = section
        node.section_id = section.location_id
        by_source_node[node.node_id] = section
        if element_index is not None and (
            fragment.canonical.elements[element_index].tag not in HEADING_TAGS
            or (fragment.fragment_idx, element_index) in claimed_headings
        ):
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
                section.publisher_parent = parent.location_id
                break
            parent_id = by_toc[parent_id].parent_node_id

    for fragment in fragments:
        if fragment.fragment_idx in contents_fragments:
            continue
        for index, element in enumerate(fragment.canonical.elements):
            if element.tag not in HEADING_TAGS:
                continue
            if element.in_navigation:
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
                boundary_scope=f"heading:{fragment.fragment_idx}",
            )
            sections.append(section)
            by_element[(fragment.fragment_idx, index)] = [section]

    _add_inferred_numbered_entries(
        media_id,
        [fragment for fragment in fragments if fragment.fragment_idx not in contents_fragments],
        sections,
        by_element,
        note_index,
    )
    by_container = _bind_containers(fragments, sections, by_element)
    _assign_parents(sections, by_element, by_container)
    by_section_id = {section.location_id: section for section in sections}
    unmatched_members: dict[tuple[int, str, str], list[_Section]] = {}
    for section in sections:
        if section.source not in {"Publisher", "Heading"} or section.parent is None:
            continue
        parent = by_section_id[section.parent]
        if _division_kind(parent) not in {"part", "book", "volume"}:
            continue
        if section.source == "Publisher" and section.publisher_parent != parent.location_id:
            continue
        key = section.fragment.fragment_idx, parent.location_id, _match_label(section.label)
        unmatched_members.setdefault(key, []).append(section)
    for members in unmatched_members.values():
        if len(members) != 2 or {section.source for section in members} != {"Publisher", "Heading"}:
            continue
        publisher = next(section for section in members if section.source == "Publisher")
        heading = next(section for section in members if section.source == "Heading")
        # The source heading shares proved membership, not the authored link's
        # earlier arrival. Preserve that destination without giving it an extent.
        heading.boundary_scope = "publisher"
        publisher.boundary_scope = "unproved:" + publisher.location_id
    for section in sections:
        ancestor_id = section.parent
        while ancestor_id is not None:
            ancestor = by_section_id[ancestor_id]
            if ancestor.container_end is not None and section.target >= ancestor.container_end:
                # A proved child beyond a title-page container disproves that
                # physical wrapper as the whole reading division's ceiling.
                ancestor.container_end = None
                ancestor.owns_container = False
            ancestor_id = ancestor.parent
    for section in sections:
        if section.element_index is None or section.owns_container:
            continue
        ancestor = section.fragment.canonical.elements[section.element_index].parent_element
        while ancestor is not None:
            owner = by_container.get((section.fragment.fragment_idx, ancestor))
            if owner is not None and owner.owns_container:
                section.container_end = owner.container_end
                break
            ancestor = section.fragment.canonical.elements[ancestor].parent_element

    if not fragments:
        return EpubStructureResult([], [])
    last = max(fragments, key=lambda fragment: fragment.fragment_idx)
    for section in sections:
        if section.fragment is not last or section.element_index is None or section.owns_container:
            continue
        element = last.canonical.elements[section.element_index]
        if element.tag not in HEADING_TAGS or element.parent_element is not None:
            continue
        following = [
            item for item in last.canonical.elements if item.start_offset >= element.end_offset
        ]
        if (
            not any(
                item.tag == "p"
                and last.canonical.text[item.start_offset : item.end_offset].strip()
                and note_index.is_routine(DocumentPoint(last.fragment_idx, item.start_offset))
                for item in following
            )
            or any(
                item.tag in STRUCTURE_CAPTURE_TAGS or item.roles & _PARATEXT_ROLES
                for item in following
            )
            or any(region.range.start.fragment_id == last.fragment_id for region in note_regions)
        ):
            continue
        section.container_end = DocumentPoint(last.fragment_idx, len(last.canonical.text))
    ends = resolve_section_ends(
        [
            SectionRangeInput(
                section.location_id,
                section.target,
                section.parent,
                section.container_end,
                section.owns_container,
                section.boundary_scope,
            )
            for section in sections
        ],
        None,
        unproved_boundaries=[
            DocumentPoint(fragment.fragment_idx, 0)
            for fragment in fragments
            if fragment.canonical.text.strip()
            and not any(section.fragment is fragment for section in sections)
        ],
    )
    for section in sections:
        if section.publisher_parent is None:
            continue
        ancestor = section.parent
        while ancestor is not None and ancestor != section.publisher_parent:
            ancestor = by_section_id[ancestor].parent
        if ancestor is None and not by_section_id[section.publisher_parent].owns_container:
            ends[section.publisher_parent] = None
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


def _boundary_label(label: str) -> str:
    return re.sub(r"[\s.:—–-]+", " ", _match_label(label)).strip()


def _matching_heading(
    fragment: EpubStructureFragment, target_offset: int, label: str
) -> tuple[int, ...] | None:
    """Match one authored boundary, including its adjacent number/title group."""
    elements = fragment.canonical.elements
    headings = [
        (index, element)
        for index, element in enumerate(elements)
        if element.tag in HEADING_TAGS and target_offset <= element.start_offset
    ]
    if not headings or fragment.canonical.text[target_offset : headings[0][1].start_offset].strip():
        return None
    first = headings[0][1]
    expected = _boundary_label(label)
    labels: list[str] = []
    indexes: list[int] = []
    end = first.start_offset
    for index, heading in headings:
        if fragment.canonical.text[end : heading.start_offset].strip() or (
            heading.parent_element != first.parent_element
            and (first.heading_group is None or heading.heading_group != first.heading_group)
        ):
            break
        labels.append(
            _match_label(fragment.canonical.text[heading.start_offset : heading.end_offset])
        )
        indexes.append(index)
        combined = _boundary_label(" ".join(labels))
        if (
            combined == expected
            or re.sub(r"^(?:part|book|volume|chapter)\s+", "", combined) == expected
        ):
            return tuple(indexes)
        end = heading.end_offset
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
        emphasis: dict[int, list[int]] = {}
        names_by_element: dict[int, list[str]] = {}
        for index, element in enumerate(elements):
            if element.parent_element is not None:
                children.setdefault(element.parent_element, []).append(index)
            if element.tag == "em":
                parent = element.parent_element
                while parent is not None and elements[parent].tag != "p":
                    parent = elements[parent].parent_element
                if parent is not None:
                    emphasis.setdefault(parent, []).append(index)
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
                (elements[child] for child in emphasis.get(index, [])),
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
            boundary_scope=f"heading:{fragment.fragment_idx}",
        )
        sections.append(section)
        by_element[(fragment.fragment_idx, index)] = [section]


def _bind_containers(
    fragments: Sequence[EpubStructureFragment],
    sections: list[_Section],
    by_element: dict[tuple[int, int], list[_Section]],
) -> dict[tuple[int, int], _Section]:
    """Bind complete authored divisions; a title wrapper proves no body end."""
    by_container: dict[tuple[int, int], _Section] = {}
    for fragment in fragments:
        elements = fragment.canonical.elements
        for index, container in enumerate(elements):
            if container.tag not in STRUCTURAL_TAGS | {"div", "main"} or container.in_navigation:
                continue
            labelled = {
                fragment.canonical.anchors[label]
                for label in container.labelled_by
                if label in fragment.canonical.anchors
            }
            owners = by_element.get((fragment.fragment_idx, index), [])
            if not owners:
                candidates = [
                    section
                    for section in sections
                    if section.fragment is fragment
                    and section.element_index is not None
                    and section.source != "InferredNumberedEntry"
                    and (
                        section.element_index in labelled
                        if labelled
                        else section.target.offset == container.start_offset
                    )
                    and container.start_offset <= section.target.offset < container.end_offset
                ]
                heading_elements = {section.element_index for section in candidates}
                if len(heading_elements) == 1:
                    owners = candidates
            if not owners:
                continue
            if container.tag in {"div", "main"}:
                owners = [owner for owner in owners if owner.source == "Both"]
                if not owners:
                    continue
            headings = [
                element
                for element in elements
                if element.tag in HEADING_TAGS
                and container.start_offset <= element.start_offset < container.end_offset
            ]
            opening_end = container.start_offset
            for heading in headings:
                if fragment.canonical.text[opening_end : heading.start_offset].strip():
                    break
                opening_end = heading.end_offset
            if not fragment.canonical.text[opening_end : container.end_offset].strip():
                continue
            owner = next((section for section in owners if section.source == "Both"), owners[0])
            by_container[(fragment.fragment_idx, index)] = owner
            owner.owns_container = True
            end = DocumentPoint(
                fragment.fragment_idx,
                min(
                    (
                        element.start_offset
                        for element in elements
                        if opening_end <= element.start_offset < container.end_offset
                        and (
                            element.tag == "footer"
                            or (element.roles - container.roles) & _PARATEXT_ROLES
                        )
                    ),
                    default=container.end_offset,
                ),
            )
            owner.container_end = (
                max(owner.container_end, end) if owner.container_end is not None else end
            )
    return by_container


def _assign_parents(
    sections: list[_Section],
    by_element: dict[tuple[int, int], list[_Section]],
    by_container: dict[tuple[int, int], _Section],
) -> None:
    """Use source containment and proved division relationships, then local ranks."""
    by_id = {section.location_id: section for section in sections}
    for section in sections:
        if section.publisher_parent is None:
            continue
        parent = by_id[section.publisher_parent]
        if parent.element_index is None:
            continue
        element = parent.fragment.canonical.elements[parent.element_index]
        if element.in_navigation or element.roles & {"titlepage", "doc-titlepage", "cover"}:
            continue
        if element.roles & {"part", "doc-part", "volume"}:
            section.parent = parent.location_id
        elif parent.source == "Both" and re.match(
            r"^(?:part|book|volume)\b", _match_label(parent.label)
        ):
            # An authored designation corroborates declared child membership;
            # the word alone neither creates a division nor assigns a child.
            section.parent = parent.location_id
        elif (
            section.fragment is parent.fragment
            and parent.container_end is not None
            and parent.target <= section.target < parent.container_end
        ):
            section.parent = parent.location_id

    sections.sort(
        key=lambda section: (
            section.target,
            section.element_index if section.element_index is not None else -1,
        )
    )
    declared_parents = {
        section.publisher_parent for section in sections if section.publisher_parent is not None
    }
    divisions: list[tuple[str, _Section]] = []
    for section in sections:
        if section.source not in {"Publisher", "Both"}:
            continue
        kind = _division_kind(section)
        if kind in {"volume", "book", "part"}:
            while divisions and (
                kind == "volume"
                or kind == divisions[-1][0]
                or (kind == "book" and divisions[-1][0] == "part")
            ):
                divisions.pop()
        if kind is not None and divisions and section.parent is None:
            parent = divisions[-1][1]
            if section.publisher_parent in {parent.location_id, parent.publisher_parent}:
                section.parent = parent.location_id
        if kind in {"volume", "book", "part"} and section.location_id in declared_parents:
            divisions.append((kind, section))
        elif kind is None and divisions and section.parent != divisions[-1][1].location_id:
            divisions.clear()

    stack: list[_Section] = []
    fragment_idx = None
    processed_elements: set[tuple[int, int]] = set()
    for section in sections:
        if fragment_idx != section.fragment.fragment_idx:
            stack.clear()
            fragment_idx = section.fragment.fragment_idx
        element_key = (
            (section.fragment.fragment_idx, section.element_index)
            if section.element_index is not None
            else None
        )
        if element_key is not None and element_key in processed_elements:
            first = by_element.get(element_key, [section])[0]
            if section.parent is None:
                section.parent = first.parent
            continue
        if element_key is not None:
            processed_elements.add(element_key)
        while stack:
            previous = stack[-1]
            ceiling = previous.container_end
            ancestor = (
                previous.fragment.canonical.elements[previous.element_index].parent_element
                if previous.element_index is not None
                else None
            )
            while ceiling is None and ancestor is not None:
                owner = by_container.get((previous.fragment.fragment_idx, ancestor))
                if owner is not None:
                    ceiling = owner.container_end
                ancestor = previous.fragment.canonical.elements[ancestor].parent_element
            if (ceiling is not None and ceiling <= section.target) or (
                section.heading_rank is not None
                and previous.heading_rank is not None
                and previous.heading_rank >= section.heading_rank
            ):
                stack.pop()
            else:
                break
        if section.parent is None and section.element_index is not None:
            ancestor = section.fragment.canonical.elements[section.element_index].parent_element
            while ancestor is not None:
                owner = by_container.get((section.fragment.fragment_idx, ancestor))
                if (
                    owner is not None
                    and owner.location_id != section.location_id
                    and owner.container_end is not None
                    and owner.target <= section.target < owner.container_end
                ):
                    section.parent = owner.location_id
                    break
                ancestor = section.fragment.canonical.elements[ancestor].parent_element
        if (
            section.parent is None
            and not section.owns_container
            and section.heading_rank is not None
            and stack
        ):
            section.parent = stack[-1].location_id
        source_element = (
            section.fragment.canonical.elements[section.element_index]
            if section.element_index is not None
            else None
        )
        if (section.heading_rank is not None or section.owns_container) and not (
            source_element is not None
            and source_element.roles & {"titlepage", "doc-titlepage", "cover"}
        ):
            stack.append(section)


def _division_kind(section: _Section) -> str | None:
    """Read an authored designation only at an independently matched boundary."""
    if section.source != "Both" or section.element_index is None:
        return None
    element = section.fragment.canonical.elements[section.element_index]
    for kind in ("chapter", "part", "volume"):
        if element.roles & {kind, "doc-" + kind}:
            return kind
    label = section.fragment.canonical.text[element.start_offset : element.end_offset]
    match = re.match(r"(part|book|volume|chapter)\b", _match_label(label))
    return match[1] if match is not None else None
