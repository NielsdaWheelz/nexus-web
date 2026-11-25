"""Derive routine reading divisions from verified publisher and source facts.

Contents destinations remain distinct from section ownership. Authored roles,
complete containers and corroborated divisions prove parents; ranks organize
only a local source container, publisher-backed file root or corroborated part.
unproved parents or ranges stay absent.
publisher intervals do not change when routine unheaded prose is split into spine
files. this convention requires a corroborated authored part and a proved closing
publisher peer; headings, new divisions, framing, navigation and note bodies remain
barriers. no guessed continuation or eof supplies an end.
An anchored `[n] <em>incipit` sequence remains a supported source division.
"""

import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Collection, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, replace
from hashlib import sha256
from itertools import islice, pairwise
from typing import Literal
from urllib.parse import unquote
from uuid import UUID, uuid4, uuid5

from lxml.etree import iterwalk
from lxml.html import HtmlElement

from nexus.errors import ResourceLimitError
from nexus.schemas.reader_apparatus import NoteRegion
from nexus.services.canonicalize import (
    HEADING_TAGS,
    STRUCTURAL_TAGS,
    STRUCTURE_CAPTURE_TAGS,
    CanonicalElement,
    CanonicalStructure,
    canonicalize_structure,
    generate_canonical_text,
)
from nexus.services.html_apparatus import is_printed_note_heading, reading_title_key
from nexus.services.html_tree import parse_html_document, serialize_html
from nexus.services.reader_structure import (
    DocumentPoint,
    DomCut,
    FragmentIntervals,
    NavigationNoteIndex,
    SectionBoundary,
    SectionEnd,
    SectionRangeInput,
    resolve_section_extents,
)
from nexus.services.sanitize_html import element_id, hides, sanitize_epub_chapter
from nexus.text import normalize_whitespace

type SectionSource = Literal["Publisher", "Heading", "Both", "InferredNumberedEntry"]
type _SourceKey = tuple[str, str]
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
_NON_CONTENTS_ROLES = frozenset(
    {
        "page-list",
        "pagelist",
        "landmarks",
        "bibliography",
        "biblioentry",
        "index",
        "glossary",
        "footnote",
        "footnotes",
        "endnote",
        "endnotes",
    }
)
_OPENING_REFERENCE_LABEL = re.compile(r"(?:\[?\d{1,4}\]?\.?|[*†‡])")


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
    start_cut: DomCut | None
    end_cut: DomCut | None


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
    boundary_scope: str | None
    owns_container: bool = False
    publisher_parent: str | None = None
    publisher_depth: int | None = None
    start_cut: DomCut | None = None
    container_end_cut: DomCut | None = None


def _aria_heading_level(node: HtmlElement) -> int | None:
    if (node.get("role") or "").strip().lower() != "heading":
        return None
    level = (node.get("aria-level") or "").strip()
    if not re.fullmatch(r"[0-9]+", level):
        return None
    try:
        return int(level) or None
    except ValueError:
        return None


def _declared_division(node: HtmlElement) -> Literal["chapter", "part", "volume"] | None:
    types = set(
        (node.get("epub:type") or node.get("{http://www.idpf.org/2007/ops}type") or "")
        .lower()
        .split()
    )
    roles = set((node.get("role") or "").lower().split())
    divisions: list[Literal["chapter", "part", "volume"]] = []
    if "chapter" in types or "doc-chapter" in roles:
        divisions.append("chapter")
    if "part" in types or "doc-part" in roles:
        divisions.append("part")
    if "volume" in types:
        divisions.append("volume")
    return divisions[0] if len(divisions) == 1 else None


def bind_epub_source_structure(
    *, structure: CanonicalStructure, source_html: str
) -> CanonicalStructure:
    """Bind authored roles and heading groups without changing retained coordinates.

    Temporary ids track authored facts and heading groups through the sanitizer.
    Other nodes keep their authored ids and sanitization behavior. Equal canonical
    text permits ordered element correspondence. Otherwise an exact body and
    surrounding text must identify one retained occurrence. An ambiguous authored
    fact refuses publication.
    """
    source = parse_html_document(source_html)
    body = source.body if source.body is not None else source
    body_id = element_id(body)

    body_roles = frozenset(
        token
        for attribute in ("role", "epub:type", "{http://www.idpf.org/2007/ops}type", "type")
        for token in (body.get(attribute) or "").lower().split()
    )
    facts: list[tuple[HtmlElement, frozenset[str], bool, HtmlElement | None]] = []
    original_nodes = [node for node in body.iterdescendants() if isinstance(node, HtmlElement)]
    body_id_reused = body_id is not None and any(
        body_id in (element_id(node), node.get("name")) for node in original_nodes
    )
    identities = {
        node: tuple(
            identity
            for identity in (element_id(node), node.get("name"))
            if identity and identity != body_id
        )
        for node in original_nodes
    }
    for node in original_nodes:
        tag = str(node.tag).lower()
        if (
            tag not in HEADING_TAGS | STRUCTURE_CAPTURE_TAGS
            and not (
                (tag in {"p", "em"} or identities[node] or tag == "a" and node.get("href"))
                and (_aria_heading_level(node) is not None or _declared_division(node) is not None)
            )
        ) or tag == "hgroup":
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
                group = ancestor
            ancestor = ancestor.getparent()
        in_navigation |= bool(roles & {"toc", "doc-toc", "landmarks", "page-list"})
        if roles or in_navigation or group is not None:
            facts.append((node, frozenset(roles), in_navigation, group))
    if not facts and body_id is None and not body_roles:
        return structure

    marked = {node for node, _roles, _navigation, _group in facts}
    marked.update(group for _node, _roles, _navigation, group in facts if group is not None)
    prefix = "nexus-structure-" + uuid4().hex + "-"
    marker_ids = {node: prefix + str(index) for index, node in enumerate(marked)}
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

    grouped_headings: dict[HtmlElement, list[CanonicalElement]] = {}
    for node, _source_roles, _navigation, group in facts:
        src = source_structure.anchors.get(marker_ids[node])
        if (
            group is not None
            and src is not None
            and (node.tag in HEADING_TAGS or _aria_heading_level(node) is not None)
        ):
            grouped_headings.setdefault(group, []).append(source_structure.elements[src])
    for node, source_roles, in_navigation, group in facts:
        names = identities[node]
        source_index = source_structure.anchors.get(marker_ids[node])
        if source_index is None:
            continue
        source_element = source_structure.elements[source_index]
        tag = source_element.tag
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
        element.roles = source_roles
        element.in_navigation = in_navigation
        element.declared_division = _declared_division(node)
        if tag not in HEADING_TAGS:
            element.heading_level = _aria_heading_level(node)
        if group is not None and element.heading_level is not None:
            group_index = source_structure.anchors.get(marker_ids[group])
            if group_index is not None:
                source_group = source_structure.elements[group_index]
                headings = grouped_headings[group]
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
    anchors = dict(structure.anchors)
    if body_id is not None and not body_id_reused:
        if body_id in anchors:
            if elements[anchors[body_id]].start_offset != 0:
                raise ValueError("EPUB authored body boundary disagrees with its retained anchor")
        elif same_text:
            anchors[body_id] = len(elements)
            elements.append(CanonicalElement("span", 0, 0, None, None, (), False, dom_path=()))
    body_labels = tuple((body.get("aria-labelledby") or "").split())
    if body_roles and body_id is None:
        start, end = retained_span(0, 0)
        elements.append(
            CanonicalElement(
                "span",
                start,
                end,
                None,
                None,
                body_labels,
                False,
                roles=body_roles,
                declared_division=_declared_division(body),
                in_navigation=bool(body_roles & {"toc", "doc-toc", "landmarks", "page-list"}),
                dom_path=(),
            )
        )
    if body_roles and body_id is not None and body_id in anchors:
        element = elements[anchors[body_id]]
        start, end = retained_span(0, 0)
        if element.tag != "span" or (element.start_offset, element.end_offset) != (start, end):
            raise ValueError("EPUB authored body anchor has no retained marker correspondence")
        element.declared_division = _declared_division(body)
        element.labelled_by = body_labels
        element.roles = body_roles
        element.in_navigation = bool(element.roles & {"toc", "doc-toc", "landmarks", "page-list"})
    return CanonicalStructure(
        structure.text,
        tuple(elements),
        anchors,
        structure.apparatus_items,
        structure.x_embed_slots,
        structure.tables,
    )


def _heading_location_id(media_id: UUID, fragment_id: UUID, start_offset: int, rank: int) -> str:
    return "heading:" + str(uuid5(media_id, f"{fragment_id}:{start_offset}:{rank}"))


@dataclass(frozen=True)
class SourceDivisionStarts:
    """Raw source anchors, never retained DOM paths."""

    element_ids: frozenset[str]
    at_file_start: bool


@dataclass(frozen=True)
class EpubContents:
    nodes: tuple[EpubStructureTocNode, ...]
    entry_anchors: dict[str, dict[str, str | None]]
    division_starts: dict[str, SourceDivisionStarts]
    # Source order. If an editorial opening has no return key, its position
    # constrains a gap but cannot close a note.
    editorial_openings: tuple[_SourceKey, ...]
    chapter_sequences: tuple[tuple[_SourceKey, ...], ...]
    opening_returns: dict[_SourceKey, _SourceKey]
    file_start_openings: frozenset[_SourceKey]
    note_collection_ends: dict[str, bool]
    last_spine_member: str | None
    independent_openings: frozenset[str]
    printed_note_members: frozenset[str]
    # Keyed by reading member, and only carried within one unique published title.
    reading_titles: dict[str, str]
    published_navigation: dict[str, set[str]]


@dataclass(frozen=True)
class _ContentsEntry:
    identity: str
    position: tuple[int, int]
    source_href: str
    anchors: tuple[str, ...]
    label: str
    target: str | None
    parent_id: str | None


@dataclass(frozen=True)
class _Return:
    position: tuple[int, int]
    href: str
    designation: str
    standalone: bool
    at_file_start: bool
    visible_names: tuple[str, ...]


def _link_key(href: str) -> _SourceKey:
    path, _, anchor = href.partition("#")
    return path, unquote(anchor)


def _source_anchor_names(element: HtmlElement) -> set[str]:
    return {
        name
        for name in (element_id(element), element.get("name") if element.tag == "a" else None)
        if name
    }


def _first_content(root: HtmlElement, *, prose_only: bool = False) -> HtmlElement | None:
    for event, element in iterwalk(root, events=("start", "end")):
        if not isinstance(element, HtmlElement):
            continue
        if event == "start" and (
            not prose_only
            and element.tag in {"img", "svg", "table"}
            or (element.text or "").strip()
        ):
            return element
        if event == "end" and (element.tail or "").strip():
            return element.getparent()
    return None


def _leading_link(root: HtmlElement) -> HtmlElement | None:
    first = _first_content(root)
    if first is not None:
        for owner in (first, *first.iterancestors()):
            if owner.tag == "a":
                return owner
            if owner is root:
                break
    return None


def _contents_roles(element: HtmlElement) -> frozenset[str]:
    return frozenset(
        (
            element.get("epub:type") or element.get("{http://www.idpf.org/2007/ops}type") or ""
        ).split()
    ) | set((element.get("role") or "").split())


def _visible_contents_link(element: HtmlElement) -> bool:
    for owner in (element, *element.iterancestors()):
        roles = {role.removeprefix("doc-") for role in _contents_roles(owner)}
        style = re.sub(r"\s+", "", owner.get("style", "")).lower()
        if (
            roles & _NON_CONTENTS_ROLES
            or owner.tag in {"fn", "footnote", "script", "template"}
            or hides(owner)
            or owner.get("aria-hidden", "").strip().lower() == "true"
            or "display:none" in style
            or "visibility:hidden" in style
        ):
            return False
    return True


def _visible_contents_text(element: HtmlElement) -> Iterator[str]:
    walk = iterwalk(element, events=("start", "end", "comment", "pi"))
    for event, node in walk:
        if event == "start":
            if not isinstance(node, HtmlElement) or not _visible_contents_link(node):
                walk.skip_subtree()
            elif node.text:
                yield node.text
        elif node is not element and node.tail:
            yield node.tail


def recognize_epub_contents(
    *,
    media_id: UUID,
    book_title: str,
    documents: Iterable[tuple[str, str]],
    toc_nodes: Sequence[EpubStructureTocNode],
    package_navigation_hrefs: Collection[str],
    declared_contents_hrefs: Collection[str],
    spine_positions: Mapping[str, int],
    last_spine_member: str | None,
    resolve_href: Callable[[str, str], str | None],
) -> EpubContents:
    """Read one bounded source document at a time; no apparatus evidence is needed.

    A typed contents list authors its own entries. An untyped run needs individual
    reciprocal, ordered chapter designations. Preserve the actual link destination
    even when the index and printed title use different words.
    """
    package: dict[str, list[EpubStructureTocNode]] = {}
    publisher_targets: set[_SourceKey] = set()
    verified_package_headings: dict[str, str] = {}
    independent_openings: set[str] = set()
    printed_note_members: set[str] = set()
    promotional_cards: dict[bytes, list[str]] = {}
    for node in toc_nodes:
        if node.nav_type == "toc" and node.href is not None:
            path, name = _link_key(node.href)
            package.setdefault(path, []).append(node)
            if name:
                publisher_targets.add((path, name))
    title_paths: dict[str, set[str]] = {}
    for path, published in package.items():
        for node in published:
            if key := reading_title_key(node.label):
                title_paths.setdefault(key, set()).add(path)
    verified_titles: dict[str, str] = {}
    published_navigation: dict[str, set[str]] = {}
    guide_scopes: dict[str, set[str]] = {}
    for href in declared_contents_hrefs:
        path, name = _link_key(href)
        guide_scopes.setdefault(path, set()).add(name)
    guide_arrivals: dict[str, set[_SourceKey]] = {}
    physical_publisher_targets: set[_SourceKey] = set()
    printed_links: dict[_SourceKey, _SourceKey] = {}
    printed_openings: dict[_SourceKey, tuple[tuple[int, int], _SourceKey | None, bool]] = {}
    chapter_sequences: list[tuple[_SourceKey, ...]] = []
    opening_returns: dict[_SourceKey, _SourceKey] = {}
    file_start_openings: set[_SourceKey] = set()
    readable_spine: dict[str, int] = {}
    entries: list[_ContentsEntry] = []
    runs: list[list[_ContentsEntry]] = []
    returns: dict[_SourceKey, _Return] = {}
    file_openings: set[str] = set()
    note_group_openings: set[str] = set()
    raw_starts: dict[str, set[str]] = {}
    by_id = {node.node_id: node for node in toc_nodes}
    material_bytes = 0
    material_count = 0

    def account(*values: str | None) -> None:
        nonlocal material_bytes, material_count
        material_count += 1
        material_bytes += sum(len(value.encode("utf-8")) for value in values if value)
        if material_count > 10_000 or material_bytes > 8 * 1024 * 1024:
            raise ResourceLimitError(
                "EPUB embedded contents exceed the source evidence budget", dimension="Output"
            )

    def opening_title_key(title: str) -> str:
        # Publisher navigation can insert spacing around typography or a
        # subtitle colon. Preserve punctuation between numbers.
        return "".join(
            re.sub(r"(?<=[^\W\d_]):(?=\s+[^\W\d_])", "", title.casefold(), count=1).split()
        )

    work_title = opening_title_key(book_title)

    def grouped_opening_title_keys(heading: HtmlElement) -> set[str]:
        label = normalize_whitespace("".join(heading.itertext())).casefold()
        if not re.fullmatch(
            r"(?:[1-9][0-9]{0,3}\.?|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)"
            r" (?:chapter|essay|part|book|volume))",
            label,
        ):
            return set()
        prefix = label.rstrip(".")
        title_parts = []
        keys: set[str] = set()
        for _ in range(2):
            following = heading.getnext()
            if (
                not isinstance(following, HtmlElement)
                or following.tag != heading.tag
                or not _visible_contents_link(following)
                or (heading.tail or "").strip()
            ):
                break
            label = normalize_whitespace("".join(following.itertext()))
            if (
                len(following)
                and (link := following[-1]).tag == "a"
                and link.get("href")
                and len(link) == 1
                and link[0].tag == "sup"
                and not (link.tail or "").strip()
                and _OPENING_REFERENCE_LABEL.fullmatch(
                    glyph := normalize_whitespace("".join(link.itertext()))
                )
            ):
                label = label.removesuffix(glyph).rstrip()
            if not label:
                break
            if "continued" in opening_title_key(label):
                return set()
            title_parts.append(label)
            subtitle = " ".join(title_parts)
            keys.update(
                opening_title_key(title)
                for title in (f"{prefix} {subtitle}", f"{prefix}: {subtitle}")
            )
            heading = following
        return keys

    def read_document(spine_index: int, source_href: str, source_html: str) -> None:
        source = parse_html_document(source_html)
        original_body = source.body if source.body is not None else source
        body_id = element_id(original_body)
        if (
            source_href in package
            and not (original_body.text or "").strip()
            and all(
                not (block.tail or "").strip()
                and (
                    not isinstance(block, HtmlElement)
                    or hides(block)
                    or _first_content(block) is None
                    or block.tag == "p"
                    and any(
                        re.fullmatch(r"(?:foot|end)?notes?[0-9]*[a-z]?", style)
                        for style in (block.get("class") or "").casefold().split()
                    )
                )
                for block in original_body
            )
        ):
            printed_note_members.add(source_href)
        if "announcement_page" in (original_body.get("class") or "").casefold().split():
            first = _first_content(original_body)
            if (
                first is not None
                and first.tag == "img"
                and any(
                    node.tag == "a"
                    and (node.get("href") or "").casefold().startswith(("https://", "http://"))
                    for node in first.iterancestors()
                )
            ):
                independent_openings.add(source_href)
        if any(
            node.label.casefold().strip() == "copyright" for node in package.get(source_href, ())
        ):
            first = _first_content(original_body, prose_only=True)
            if first is not None:
                block = next(
                    (node for node in (first, *first.iterancestors()) if node.tag == "p"), None
                )
                if (
                    block is not None
                    and normalize_whitespace("".join(block.itertext())).casefold() == "copyright"
                    and any(
                        isinstance(line, HtmlElement)
                        and normalize_whitespace("".join(line.itertext()))
                        .casefold()
                        .startswith("copyright ©")
                        for line in block.itersiblings()
                    )
                ):
                    independent_openings.add(source_href)
        # Only these direct source declarations need transfer through sanitation.
        # Transient titles leave the real ids and link identities intact.
        stamp = "nexus-source-" + uuid4().hex
        original_anchors: dict[str, HtmlElement | None] = {}
        original_order: dict[str, int] = {}
        printed_scopes: set[HtmlElement] = set()
        for index, element in enumerate(original_body.iter()):
            if not isinstance(element, HtmlElement):
                continue
            for name in _source_anchor_names(element):
                original_anchors[name] = element if name not in original_anchors else None
                if (source_href, name) in publisher_targets:
                    original_order[name] = index
            roles = _contents_roles(element)
            if roles & {"toc", "doc-toc"}:
                element.set("title", stamp + "-toc")
                printed_scopes.add(element)
            elif {role.removeprefix("doc-") for role in roles} & _NON_CONTENTS_ROLES:
                element.set("title", stamp + "-other")
            elif (
                _aria_heading_level(element) is not None or _declared_division(element) is not None
            ):
                element.set("title", stamp + "-division")
        if guide_scopes:
            physical_publisher_targets.update(
                (source_href, name)
                for name in original_order
                if (anchor := original_anchors[name]) is not None and _visible_contents_link(anchor)
            )
        # The sanitizer drops half-title classes. Join the original first
        # title and its physical anchor to the publisher's contents here.
        if (first := _first_content(original_body)) is not None:
            for title in (first, *first.iterancestors()):
                if title.tag != "p" or not any(
                    re.fullmatch(r"halftitle[0-9]*", style)
                    for style in (title.get("class") or "").casefold().split()
                ):
                    continue
                printed = opening_title_key("".join(title.itertext()))
                if "continued" in printed:
                    continue
                for node in package.get(source_href, ()):
                    if node.href is None or opening_title_key(node.label) != printed:
                        continue
                    _, name = _link_key(node.href)
                    target = original_anchors.get(name)
                    if (
                        not name
                        or target is not None
                        and (target is title or title in target.iterancestors())
                    ):
                        independent_openings.add(source_href)
                        break
            if (
                scope := next(
                    (
                        node
                        for node in (first, *first.iterancestors())
                        if node.getparent() is original_body
                    ),
                    None,
                )
            ) is not None and _visible_contents_link(scope):
                if scope.tag in HEADING_TAGS and not (scope.text or "").strip():
                    printed = opening_title_key("".join(_visible_contents_text(scope)))
                    if printed and "continued" not in printed:
                        for node in package.get(source_href, ()):
                            if node.href is None or opening_title_key(node.label) != printed:
                                continue
                            _, name = _link_key(node.href)
                            owner = original_anchors.get(name)
                            if (
                                owner is not None
                                and owner.tag == "a"
                                and owner.getparent() is scope
                                and not (
                                    owner.get("href") or len(owner) or (owner.text or "").strip()
                                )
                                and _visible_contents_link(owner)
                                and all(
                                    _first_content(peer) is None
                                    for peer in owner.itersiblings(preceding=True)
                                )
                            ):
                                independent_openings.add(source_href)
                                break
                publisher_title = None
                if (
                    scope.tag == "div"
                    and "noteontext" in (scope.get("class") or "").casefold().split()
                    and _first_content(scope, prose_only=True) is first
                    and _visible_contents_link(first)
                ):
                    publisher_title = r"notes? on (?:the )?text"
                elif (
                    scope.tag == "section"
                    and _declared_division(scope) in {"part", "volume"}
                    and first.tag == "img"
                    and _visible_contents_link(first)
                    and re.search(r"\S\s+logo$", (first.get("alt") or "").strip(), re.IGNORECASE)
                    and _first_content(original_body, prose_only=True) is None
                    and sum(1 for _ in original_body.iter("img", "svg", "table")) == 1
                ):
                    publisher_title = r"(?:part|volume) [a-z0-9]+"
                if publisher_title is not None:
                    for node in package.get(source_href, ()):
                        if not node.href or not re.fullmatch(
                            publisher_title, _match_label(node.label)
                        ):
                            continue
                        _, name = _link_key(node.href)
                        if original_anchors.get(name) in {scope, original_body} or (
                            not name and scope.tag == "div"
                        ):
                            independent_openings.add(source_href)
                            break
                if (
                    work_title
                    and scope.tag == "h1"
                    and opening_title_key("".join(_visible_contents_text(scope))) == work_title
                ):
                    lead = next(
                        (
                            block
                            for block in scope.itersiblings()
                            if isinstance(block, HtmlElement) and _first_content(block) is not None
                        ),
                        None,
                    )
                    if (
                        lead is not None
                        and lead.tag == "p"
                        and "center" in (lead.get("class") or "").split()
                        and re.match(
                            r"^dedicated to the memory of\b",
                            _match_label("".join(_visible_contents_text(lead))),
                        )
                        and (dedicatee := lead.getnext()) is not None
                        and dedicatee.tag == "p"
                        and dedicatee.get("class") == lead.get("class")
                        and len(dedicatee) == 1
                        and dedicatee[0].tag in {"b", "strong"}
                        and not (dedicatee.text or "").strip()
                        and not (dedicatee[0].tail or "").strip()
                        and any(text.strip() for text in _visible_contents_text(dedicatee[0]))
                    ):
                        independent_openings.add(source_href)
        if (
            source_href in spine_positions
            and first is not None
            and first.tag == "h1"
            and first.getparent() is original_body
        ):
            blocks = list(
                islice(
                    (
                        child
                        for child in original_body
                        if isinstance(child, HtmlElement) and _first_content(child) is not None
                    ),
                    6,
                )
            )
            if [block.tag for block in blocks] == ["h1", "p", "ul", "p", "ul"] and not any(
                (child.tail or "").strip() for child in original_body
            ):
                _, account_block, services, site, resources = blocks
                links = list(
                    islice((link for link in original_body.iter("a") if link.get("href")), 2)
                )
                if (
                    all(_visible_contents_link(block) for block in blocks)
                    and all(
                        (label := _first_content(block)) is not None
                        and label.tag == "strong"
                        and label.getparent() is block
                        and _visible_contents_link(label)
                        for block in (account_block, site)
                    )
                    and re.match(
                        r"^公众号[：:]\s*\S",
                        _match_label("".join(_visible_contents_text(account_block))),
                    )
                    and re.match(
                        r"^网站[：:]\s*\S", _match_label("".join(_visible_contents_text(site)))
                    )
                    and len(links) == 1
                    and links[0].getparent() is site
                    and any(text.strip() for text in _visible_contents_text(links[0]))
                    and re.match(r"^https?://[^\s/#?]+", links[0].get("href") or "", re.IGNORECASE)
                    and all(
                        any(
                            child.tag == "li"
                            and any(text.strip() for text in _visible_contents_text(child))
                            for child in menu
                        )
                        for menu in (services, resources)
                    )
                ):
                    digest = sha256()
                    chunk_chars = 64 * 1024
                    for offset in range(0, len(source_html), chunk_chars):
                        digest.update(source_html[offset : offset + chunk_chars].encode())
                    promotional_cards.setdefault(digest.digest(), []).append(source_href)
        for name in guide_scopes.get(source_href, ()):
            scope = original_anchors.get(name) if name else original_body
            if scope is not None:
                printed_scopes.add(scope)
                if (
                    name
                    and first is not None
                    and _first_content(scope) is first
                    and (
                        heading := next(
                            (
                                node
                                for node in (first, *first.iterancestors())
                                if node.tag in HEADING_TAGS | {"p"}
                            ),
                            None,
                        )
                    )
                    is not None
                    and _match_label("".join(_visible_contents_text(heading)))
                    in {"contents", "table of contents"}
                ):
                    guide_arrivals.setdefault(source_href, set()).update(
                        key
                        for link in scope.iter("a")
                        if (href := link.get("href"))
                        and (target := resolve_href(source_href, href)) is not None
                        and (key := _link_key(target)) in publisher_targets
                        and any(text.strip() for text in _visible_contents_text(link))
                    )
        body_toc = original_body.get("title") == stamp + "-toc"
        if original_body.get("title") == stamp + "-division":
            file_openings.add(source_href)
        clean = sanitize_epub_chapter(serialize_html(source))
        if not clean.strip():
            return
        if (original_index := spine_positions.get(source_href)) is not None:
            readable_spine[source_href] = original_index
        doc = parse_html_document(clean)
        body = doc.body if doc.body is not None else doc
        elements = [e for e in body.iter() if isinstance(e, HtmlElement)]
        position = {e: i for i, e in enumerate(elements)}
        anchors: dict[str, HtmlElement | None] = {}
        for element in elements:
            for name in _source_anchor_names(element):
                anchors[name] = element if name not in anchors else None
        if body_id:
            anchors[body_id] = body if body_id not in anchors else None
        if printed_scopes and source_href not in package_navigation_hrefs:
            for original_link in original_body.iter("a"):
                name = element_id(original_link) or original_link.get("name")
                if (
                    not name
                    or original_anchors.get(name) is not original_link
                    or (clean_link := anchors.get(name)) is None
                    or not (raw_href := original_link.get("href"))
                    or not (target := resolve_href(source_href, raw_href))
                    or (key := _link_key(target)) not in publisher_targets
                    or not normalize_whitespace("".join(clean_link.itertext()))
                    or not any(owner in printed_scopes for owner in original_link.iterancestors())
                    or not _visible_contents_link(original_link)
                ):
                    continue
                account(source_href, name, *key)
                printed_links[(source_href, name)] = key
        suppliers: dict[HtmlElement, list[str]] = {}
        for node in package.get(source_href, []):
            assert node.href is not None
            _, name = _link_key(node.href)
            source_element = anchors.get(name) if name else body
            if source_element is not None:
                suppliers.setdefault(source_element, []).append(node.node_id)
                if name and original_anchors.get(name) is not None:
                    published_navigation.setdefault(source_href, set()).add(name)

        def source_nodes(element: HtmlElement) -> list[str]:
            for owner in (element, *element.iterancestors()):
                candidates = suppliers.get(owner, [])
                if candidates:
                    return candidates
                previous = owner.getprevious()
                if previous is not None:
                    candidates = [n for k in previous.iter() for n in suppliers.get(k, [])]
                    if candidates:
                        return candidates
            return []

        def row_names(link: HtmlElement, row: HtmlElement) -> tuple[str, ...]:
            return tuple(
                name
                for el in (link, row)
                if (name := element_id(el) or el.get("name")) and anchors.get(name) is el
            )

        def authored_return(name: str) -> str | None:
            owner = original_anchors.get(name)
            link = _leading_link(owner) if owner is not None else None
            if (
                link is not None
                and _visible_contents_link(link)
                and not any(scope in printed_scopes for scope in link.iterancestors())
            ):
                return link.get("href") or None
            return None

        def return_key(href: str | None) -> _SourceKey | None:
            resolved = resolve_href(source_href, href) if href else None
            return _link_key(resolved) if resolved else None

        def only_glyphs(full: str, title: str, links: list[HtmlElement]) -> bool:
            labels = [normalize_whitespace("".join(link.itertext())) for link in links]
            return (
                bool(labels)
                and all(_OPENING_REFERENCE_LABEL.fullmatch(label) for label in labels)
                and full.replace(" ", "") == "".join([title, *labels]).replace(" ", "")
            )

        def entry(
            element: HtmlElement,
            names: tuple[str, ...],
            label: str,
            href: str | None,
            parent: str | None,
        ) -> _ContentsEntry:
            origin = "#" + names[0] if names else "@" + element.getroottree().getpath(element)
            identity = str(uuid5(media_id, "contents:" + source_href + origin))
            target = resolve_href(source_href, href) if href else None
            account(identity, *names, target, label[:512])
            return _ContentsEntry(
                identity,
                (spine_index, position[element]),
                source_href,
                names,
                label[:512],
                target,
                parent,
            )

        visited_lists: set[HtmlElement] = set()

        def read_list(parent: HtmlElement, parent_id: str | None, depth: int) -> None:
            for ol in [parent] if parent.tag in {"ol", "ul"} else parent:
                if ol.tag not in {"ol", "ul"} or ol in visited_lists:
                    continue
                visited_lists.add(ol)
                if depth > 16:
                    raise ResourceLimitError(
                        "EPUB embedded contents exceed navigation depth", dimension="Structure"
                    )
                for li in ol:
                    if li.tag != "li":
                        continue
                    label = next((child for child in li if child.tag in {"a", "span"}), None)
                    if label is None:
                        continue
                    printed = normalize_whitespace("".join(label.itertext()))
                    if printed:
                        item = entry(
                            label,
                            row_names(label, li),
                            printed,
                            label.get("href") if label.tag == "a" else None,
                            parent_id,
                        )
                        entries.append(item)
                        read_list(li, item.identity, depth + 1)

        marked = {e for e in elements if e.get("title") == stamp + "-toc"}
        if body_toc:
            marked.add(body)
        if source_href not in package_navigation_hrefs:
            for nav in sorted(marked, key=position.__getitem__):
                supplying = source_nodes(nav)
                read_list(nav, supplying[0] if len(supplying) == 1 else None, 0)
        excluded = marked | {e for e in elements if e.get("title") == stamp + "-other"}
        if original_body.get("title") == stamp + "-other":
            excluded.add(body)
        # An element before any text need not be the first meaningful block:
        # images and tables are content too; a framing rule contains no prose.
        first = _first_content(body)
        first_chain = set((first, *first.iterancestors())) if first is not None else set()
        if first is not None and (toc := package.get(source_href)):
            lead = first
            after_logo = first.tag == "img"
            if after_logo:
                # An authored logo can frame the heading, a figure cannot.
                logo = _first_content(original_body)
                lead = _first_content(body, prose_only=True)
                if (
                    logo is None
                    or logo.tag != "img"
                    or not logo.get("src")
                    or not re.search(r"\S\s+logo$", (logo.get("alt") or "").strip(), re.IGNORECASE)
                    or logo.get("alt") != first.get("alt")
                    or not _visible_contents_link(logo)
                    or lead is None
                    or lead not in position
                    or any(
                        element.tag in {"img", "svg", "table"}
                        for element in elements[position[first] + 1 : position[lead]]
                    )
                ):
                    lead = None
            if lead is not None:
                heading_chain = (lead, *lead.iterancestors())
                start_heading = next(
                    (node for node in heading_chain if node.tag in HEADING_TAGS), None
                )
                if (
                    start_heading is not None
                    and _visible_contents_link(start_heading)
                    and (title_keys := grouped_opening_title_keys(start_heading))
                ):
                    for node in toc:
                        if not node.href or opening_title_key(node.label) not in title_keys:
                            continue
                        _, anchor = _link_key(node.href)
                        owner = anchors.get(anchor)
                        if anchor and original_anchors.get(anchor) is None:
                            continue
                        if not (
                            owner is start_heading
                            if after_logo
                            else not anchor or owner in heading_chain
                        ):
                            continue
                        independent_openings.add(source_href)
                        break
        for heading in first_chain:
            if heading.tag not in {"p", "div"} or set(
                (heading.get("class") or "").casefold().split()
            ).isdisjoint({"fmht", "bmht"}):
                continue
            printed = normalize_whitespace("".join(heading.itertext())).casefold()
            if "continued" not in printed and any(
                node.href is not None
                and _link_key(node.href)[1] in {"", element_id(heading)}
                and " ".join(node.label.casefold().split()) == printed
                for node in package.get(source_href, ())
            ):
                independent_openings.add(source_href)
        first_note_heading = None
        if any(is_printed_note_heading(node.label) for node in package.get(source_href, ())):
            first_prose = _first_content(body, prose_only=True)
            if first_prose is not None:
                first_note_heading = next(
                    (
                        node
                        for node in (first_prose, *first_prose.iterancestors())
                        if node.tag in HEADING_TAGS
                    ),
                    None,
                )
        for heading in elements:
            if heading.tag in HEADING_TAGS or heading.get("title") == stamp + "-division":
                if any(owner in excluded for owner in (heading, *heading.iterancestors())):
                    continue
                name = element_id(heading)
                if name and anchors.get(name) is heading:
                    raw_starts.setdefault(source_href, set()).add(name)
                if heading in first_chain or heading is first_note_heading:
                    file_openings.add(source_href)
                    heading_text = normalize_whitespace("".join(heading.itertext()))
                    if heading.tag in HEADING_TAGS and (
                        is_printed_note_heading(heading_text)
                        or re.match(r"^(?:chapter|part|book|volume)\b", heading_text, re.IGNORECASE)
                        or (
                            len(paths := title_paths.get(reading_title_key(heading_text), set()))
                            == 1
                            and (prior := spine_positions.get(next(iter(paths)))) is not None
                            and prior < spine_index
                            and verified_titles.get(next(iter(paths)))
                            == reading_title_key(heading_text)
                        )
                    ):
                        first_entry = next(
                            (
                                peer
                                for peer in heading.itersiblings()
                                if isinstance(peer, HtmlElement)
                                and peer.tag not in HEADING_TAGS
                                and _first_content(peer) is not None
                            ),
                            None,
                        )
                        if (
                            first_entry is not None
                            and (lead := _leading_link(first_entry)) is not None
                        ):
                            printed = normalize_whitespace("".join(lead.itertext()))
                            destination = return_key(lead.get("href"))
                            if (
                                _OPENING_REFERENCE_LABEL.fullmatch(printed)
                                and destination
                                and destination[1]
                                and (prior := spine_positions.get(destination[0])) is not None
                                and prior < spine_index
                            ):
                                note_group_openings.add(source_href)
                    if heading.tag in HEADING_TAGS:
                        label = heading_text.casefold()
                        compact_label = opening_title_key(label)
                        title_key = (
                            reading_title_key(heading_text) if len(heading_text) <= 512 else ""
                        )
                        for node in package.get(source_href, ()):
                            name = _link_key(node.href or "")[1]
                            owner = anchors.get(name) if name else None
                            if (
                                name
                                and owner not in first_chain
                                and not (heading is first_note_heading and owner is heading)
                            ):
                                continue
                            if (
                                compact_label
                                and "continued" not in compact_label
                                and opening_title_key(node.label) == compact_label
                            ):
                                verified_package_headings[source_href] = label
                            if (
                                title_key
                                and reading_title_key(node.label) == title_key
                                and title_paths.get(title_key) == {source_href}
                            ):
                                verified_titles[source_href] = title_key
        if source_href in package_navigation_hrefs:
            return
        run: list[_ContentsEntry] = []
        last_block: HtmlElement | None = None
        for block in elements:
            regular_block = (
                block.tag in {"p", "li"} | HEADING_TAGS or block.get("title") == stamp + "-division"
            )
            if not regular_block and block.tag != "figcaption":
                continue
            all_links = [a for a in block.iterdescendants("a") if isinstance(a, HtmlElement)]
            if not all_links or any(owner in excluded for owner in (block, *block.iterancestors())):
                continue
            links = [a for a in all_links if a.get("href")]
            if original_order and (title := _leading_link(block)) is not None:
                names = [name for name in row_names(title, block) if name in original_order]
                if names:
                    printed = normalize_whitespace("".join(title.itertext()))
                    full = normalize_whitespace("".join(block.itertext()))
                    glyphs = [other for other in links if other is not title]
                    if (
                        0 < len(printed) <= 512
                        and any(char.isalpha() for char in printed)
                        and (full == printed and not glyphs or only_glyphs(full, printed, glyphs))
                        and not block.xpath(".//img|.//svg|.//table")
                    ):
                        clean_key = return_key(title.get("href"))
                        for name in names:
                            key = source_href, name
                            if key in printed_openings or not (raw_href := authored_return(name)):
                                continue
                            authored_key = return_key(raw_href)
                            account(*key, *(authored_key or ()))
                            printed_openings[key] = (
                                (spine_index, original_order[name]),
                                authored_key,
                                authored_key is not None and authored_key == clean_key,
                            )
            if not regular_block or not links:
                continue
            link = links[0]
            printed = normalize_whitespace("".join(link.itertext()))
            if not printed:
                continue
            full = normalize_whitespace("".join(block.itertext()))
            names = row_names(link, block)
            raw_href = link.get("href")
            assert raw_href is not None
            target = resolve_href(source_href, raw_href)
            if not target:
                continue
            if (
                block in first_chain
                and link in first_chain
                and full == printed
                and any(
                    _match_label(by_id[n].label) == _match_label(printed)
                    for n in suppliers.get(body, [])
                )
            ):
                file_openings.add(source_href)
            if not names or len(printed) > 512:
                continue
            unique_link = len(links) == 1 and full == printed
            designation = _boundary_label(printed)
            numbered_title = re.fullmatch(r"chapter [1-9][0-9]*", designation) is not None
            # The designation is a whole opening. An attached reference glyph,
            # as in Norton's chapter 41, adds no prose to that opening.
            if unique_link or numbered_title and only_glyphs(full, printed, links[1:]):
                account(*names, target, designation)
                opening = _Return(
                    (spine_index, position[link]),
                    target,
                    designation,
                    unique_link,
                    link in first_chain,
                    tuple(
                        name
                        for name in names
                        if numbered_title and return_key(authored_return(name)) == _link_key(target)
                    ),
                )
                for name in names:
                    returns[(source_href, name)] = opening
            if not unique_link or block.tag not in {"p", "li"} or source_href not in package:
                continue
            adjacent = last_block is not None and last_block is block.getprevious()
            supplying = source_nodes(block)
            if len(supplying) == 1:
                source_node = supplying[0]
            elif not supplying and adjacent:
                source_node = run[-1].parent_id
            else:
                continue
            if not adjacent or run[-1].parent_id != source_node:
                run = []
                runs.append(run)
            last_block = block
            run.append(entry(link, names, printed, raw_href, source_node))

    for index, (href, html) in enumerate(documents):
        read_document(index, href, html)
    for members in promotional_cards.values():
        if len(members) > 1:
            independent_openings.update(members)
    independent_openings.update(
        path
        for path, targets in guide_arrivals.items()
        if len(targets & physical_publisher_targets) >= 2
    )

    spine_segments: dict[str, int] = {}
    previous_spine = -2
    segment_start = -1
    for path, position in sorted(readable_spine.items(), key=lambda item: item[1]):
        if position != previous_spine + 1:
            segment_start = position
        spine_segments[path] = segment_start
        previous_spine = position

    def accept_sequence(sequence: list[_SourceKey]) -> None:
        if len(sequence) >= 2:
            chapter_sequences.append(tuple(sequence))

    for run in runs:
        accepted: list[tuple[int, _ContentsEntry, _Return, int | None]] = []
        previous_number: str | None = None
        numbers = 0
        for row, item in enumerate(run):
            if item.parent_id is None or item.target is None:
                continue
            candidate = returns.get(_link_key(item.target))
            if candidate is None:
                continue
            origin, anchor = _link_key(candidate.href)
            if origin != item.source_href or anchor not in item.anchors:
                continue
            number = re.match(r"([1-9][0-9]*)(?:\s|$)", _boundary_label(item.label))
            if number is not None:
                n = number[1]
                if candidate.designation != "chapter " + n:
                    continue
                if previous_number is not None and (len(n), n) <= (
                    len(previous_number),
                    previous_number,
                ):
                    break
                previous_number = n
                numbers += 1
            elif not candidate.standalone or candidate.designation != _boundary_label(item.label):
                continue
            if accepted and candidate.position <= accepted[-1][2].position:
                break
            accepted.append((row, item, candidate, int(number[1]) if number is not None else None))
        else:
            if numbers >= 2:
                target_counts = Counter(_link_key(item.target) for item in run if item.target)
                sequence: list[_SourceKey] = []
                previous: tuple[int, int, int] | None = None
                for row, item, opening, number in accepted:
                    entries.append(item)
                    assert item.target is not None
                    path, name = _link_key(item.target)
                    raw_starts.setdefault(path, set()).add(name)
                    if opening.at_file_start:
                        file_openings.add(path)
                    key = path, name
                    segment = spine_segments.get(path)
                    if (
                        number is None
                        or not name
                        or name not in opening.visible_names
                        or target_counts[key] != 1
                        or segment is None
                    ):
                        continue
                    if previous != (row - 1, number - 1, segment):
                        accept_sequence(sequence)
                        sequence = []
                    return_key = _link_key(opening.href)
                    account(*key, *return_key)
                    sequence.append(key)
                    opening_returns[key] = return_key
                    if opening.at_file_start:
                        file_start_openings.add(key)
                    previous = row, number, segment
                accept_sequence(sequence)

    editorial_openings: list[_SourceKey] = []
    printed_targets = set(printed_links.values())
    for key, (_, expected, matched) in sorted(
        printed_openings.items(), key=lambda item: item[1][0]
    ):
        if expected is None:
            if key in printed_targets:
                editorial_openings.append(key)
        elif printed_links.get(expected) == key:
            editorial_openings.append(key)
            if matched:
                opening_returns[key] = expected

    nodes: list[EpubStructureTocNode] = []
    next_order: dict[str | None, int] = {}
    for node in toc_nodes:
        if node.nav_type == "toc":
            parent = node.parent_node_id
            next_order[parent] = max(
                next_order.get(parent, 0), int(node.order_key.rsplit(".", 1)[-1]) + 1
            )
    entry_anchors: dict[str, dict[str, str | None]] = {}
    package_arrivals: dict[tuple[tuple[str, str], str], list[EpubStructureTocNode]] = {}
    for node in toc_nodes:
        if node.nav_type == "toc" and node.href:
            package_arrivals.setdefault((_link_key(node.href), node.label), []).append(node)
    for item in sorted(entries, key=lambda entry: entry.position):
        for anchor in item.anchors:
            entry_anchors.setdefault(item.source_href, {})[anchor] = item.target
        parent = by_id[item.parent_id] if item.parent_id is not None else None
        represented = (
            package_arrivals.get((_link_key(item.target), item.label), []) if item.target else []
        )
        if len(represented) == 1 and (
            parent is None or represented[0].parent_node_id == parent.node_id
        ):
            by_id[item.identity] = represented[0]
            continue
        parent_id = parent.node_id if parent else None
        ordinal = next_order.get(parent_id, 0)
        depth = parent.depth + 1 if parent else 0
        if depth > 16 or ordinal > 9999:
            raise ResourceLimitError(
                "EPUB embedded contents exceed navigation depth or order", dimension="Structure"
            )
        next_order[parent_id] = ordinal + 1
        node = EpubStructureTocNode(
            "toc",
            item.identity,
            parent_id,
            item.label,
            item.target,
            None,
            depth,
            (parent.order_key + "." if parent else "") + f"{ordinal:04d}",
        )
        nodes.append(node)
        by_id[node.node_id] = node
    note_collection_ends: dict[str, bool] = {}
    package_starts = sorted(package.keys() & readable_spine.keys(), key=readable_spine.__getitem__)
    spine_at = {index: path for path, index in readable_spine.items()}
    for start, stop in pairwise([*package_starts, None]):
        label = verified_package_headings.get(start, "") if start is not None else ""
        if start is None or not is_printed_note_heading(label):
            continue
        if stop is None:
            boundary = max(spine_positions.values(), default=-1) + 1
            if any(index not in spine_at for index in range(readable_spine[start], boundary)):
                continue
            boundary = next(
                (
                    index
                    for index in range(readable_spine[start] + 1, boundary)
                    if spine_at[index] in file_openings
                    and spine_at[index] not in note_group_openings
                    and not is_printed_note_heading(
                        verified_package_headings.get(spine_at[index], "")
                    )
                ),
                boundary,
            )
        else:
            if spine_segments[start] != spine_segments[stop]:
                continue
            boundary = readable_spine[stop]
        for index in range(readable_spine[start], boundary):
            # The next package entry limits the scope, but only its own
            # verified opening can close an otherwise unbounded final note.
            note_collection_ends[spine_at[index]] = (
                index + 1 not in spine_at or spine_at[index + 1] in file_openings
            ) and (stop is None or index + 1 < boundary or stop in verified_package_headings)

    reading_titles: dict[str, str] = {}
    current_title = None
    previous_spine_index = -2
    for index, path in sorted(spine_at.items()):
        if index != previous_spine_index + 1 or path in package:
            current_title = verified_titles.get(path)
        if current_title is not None:
            reading_titles[path] = current_title
        previous_spine_index = index

    chapter_openings = {key for sequence in chapter_sequences for key in sequence}
    return EpubContents(
        tuple(nodes),
        entry_anchors,
        {
            path: SourceDivisionStarts(
                frozenset(raw_starts.get(path, set())), path in file_openings
            )
            for path in raw_starts.keys() | file_openings
        },
        tuple(editorial_openings),
        tuple(chapter_sequences),
        {
            key: opening_returns[key]
            for key in chapter_openings.union(editorial_openings)
            if key in opening_returns
        },
        frozenset(file_start_openings & chapter_openings),
        note_collection_ends,
        last_spine_member if last_spine_member in readable_spine else None,
        frozenset(independent_openings | verified_package_headings.keys()),
        frozenset(printed_note_members),
        reading_titles,
        published_navigation,
    )


@dataclass(frozen=True)
class _Arrival:
    fragment: EpubStructureFragment
    anchor: str
    element_index: int | None
    point: DocumentPoint


def _resolve_arrival(
    href: str | None, fragments: dict[str, EpubStructureFragment]
) -> _Arrival | None:
    if not href:
        return None
    path, anchor = _link_key(href)
    fragment = fragments.get(path)
    if fragment is None:
        return None
    index = fragment.canonical.anchors.get(anchor) if anchor else None
    if anchor and index is None:
        return None
    offset = fragment.canonical.elements[index].start_offset if index is not None else 0
    return _Arrival(fragment, anchor, index, DocumentPoint(fragment.fragment_idx, offset))


def _contents_regions(
    fragments: Sequence[EpubStructureFragment],
    toc_nodes: Sequence[EpubStructureTocNode],
    contents: EpubContents,
) -> FragmentIntervals:
    """Corroborate an untyped contents page against the authored contents itself."""
    by_href = {fragment.package_href: fragment for fragment in fragments}

    destinations = {
        (arrival.point, _boundary_label(node.label))
        for node in toc_nodes
        if node.nav_type == "toc"
        if (arrival := _resolve_arrival(node.href, by_href)) is not None
    }
    regions: dict[int, list[tuple[int, int]]] = {}
    for fragment in fragments:
        elements = fragment.canonical.elements
        spans = regions.setdefault(fragment.fragment_idx, [])
        for name in contents.entry_anchors.get(fragment.package_href, ()):
            index = fragment.canonical.anchors.get(name)
            if index is not None:
                el = elements[index]
                spans.append((el.start_offset, el.end_offset))
        spans.extend(
            (el.start_offset, el.end_offset)
            for el in elements
            if el.in_navigation and el.end_offset > el.start_offset
        )
        if any(
            element.roles & {"chapter", "doc-chapter", "part", "doc-part", "volume"}
            for element in elements
        ):
            continue
        headings = [element for element in elements if element.heading_level is not None]
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
        targets: set[tuple[DocumentPoint, str]] = set()
        for link in links:
            assert link.link_href is not None
            href = (
                fragment.package_href + link.link_href
                if link.link_href.startswith("#")
                else link.link_href
            )
            arrival = _resolve_arrival(href, by_href)
            if arrival is None:
                break
            label = _boundary_label(fragment.canonical.text[link.start_offset : link.end_offset])
            targets.add((arrival.point, label))
        else:
            if len({target for target, _ in targets}) >= 2 and targets <= destinations:
                cursor = 0
                for el in sorted([*headings, *links], key=lambda el: el.start_offset):
                    if fragment.canonical.text[cursor : el.start_offset].strip():
                        break
                    cursor = max(cursor, el.end_offset)
                else:
                    if not fragment.canonical.text[cursor:].strip():
                        spans[:] = [(0, len(fragment.canonical.text))]
    return FragmentIntervals(regions)


@dataclass(frozen=True)
class _NamedOpening:
    label: str
    members: tuple[int, ...]
    end: int


def _named_openings(
    fragment: EpubStructureFragment, contents: EpubContents
) -> dict[int, _NamedOpening]:
    """Only the division's own visible opening names, or one authored title group."""
    canonical = fragment.canonical
    elements = canonical.elements
    groups: dict[int, _NamedOpening] = {}
    seen: set[int] = set()
    for index, element in enumerate(elements):
        if element.declared_division is None or not element.labelled_by or element.in_navigation:
            continue
        members = tuple(canonical.anchors.get(name, -1) for name in element.labelled_by)
        if -1 in members or len(set(members)) != len(members):
            continue
        names = [elements[m] for m in members]
        if len(names) == 1 and names[0].heading_level is not None:
            # A division naming its own heading corroborates that heading. A
            # separate section here would split an authored number/title header.
            continue
        body_marker = element.tag == "span" and element.start_offset == element.end_offset == 0
        if not body_marker and any(
            n.dom_path is None
            or element.dom_path is None
            or n.dom_path[: len(element.dom_path)] != element.dom_path
            or n.dom_path == element.dom_path
            for n in names
        ):
            continue
        cursor = element.start_offset
        for n in sorted(names, key=lambda e: e.start_offset):
            if n.end_offset <= n.start_offset or n.start_offset < cursor:
                break
            if canonical.text[cursor : n.start_offset].strip():
                # A labelled title can follow its number in a single opening header.
                parent = n.parent_element
                while parent is not None and elements[parent].tag != "header":
                    parent = elements[parent].parent_element
                if parent is None or elements[parent].start_offset != cursor:
                    break
            cursor = n.end_offset
        else:
            label = normalize_whitespace(
                " ".join(canonical.text[n.start_offset : n.end_offset] for n in names)
            )
            if label:
                groups[index] = _NamedOpening(label, members, cursor)
                seen.update(members)
    by_group: dict[tuple[int, int], list[int]] = {}
    for i, el in enumerate(elements):
        if el.heading_group is not None and el.heading_level is not None:
            by_group.setdefault(el.heading_group, []).append(i)
    for (lo, hi), headings in by_group.items():
        if len(headings) > 1 and not any(i in seen for i in headings):
            groups[headings[0]] = _NamedOpening(
                normalize_whitespace(canonical.text[lo:hi]), tuple(headings), hi
            )
    # Source headings split across adjacent blocks can name one embedded index
    # destination. The two return links, not textual similarity, establish it.
    previous: dict[tuple[str, str], tuple[int, int, int]] = {}
    for i, link in enumerate(elements):
        if not link.link_href:
            continue
        origin, anchor = _link_key(
            fragment.package_href + link.link_href
            if link.link_href.startswith("#")
            else link.link_href
        )
        destination = contents.entry_anchors.get(origin, {}).get(anchor)
        if destination is None:
            continue
        path, target_name = _link_key(destination)
        if path != fragment.package_href:
            continue
        block_index = link.parent_element
        while block_index is not None:
            block = elements[block_index]
            if block.tag == "p" or block.heading_level is not None:
                break
            block_index = block.parent_element
        if block_index is None:
            continue
        block = elements[block_index]
        if block.start_offset != link.start_offset or block.dom_path is None or not block.dom_path:
            continue
        key = origin, anchor
        if canonical.anchors.get(target_name) in {i, block_index}:
            owner = block_index if block.heading_level is not None else i
            previous[key] = (owner, block_index, i)
            continue
        prior = previous.pop(key, None)
        if prior is None:
            continue
        owner, first, first_link = prior
        left = elements[first]
        if (
            left.dom_path is None
            or left.dom_path[:-1] != block.dom_path[:-1]
            or left.dom_path[-1] + 1 != block.dom_path[-1]
            or left.heading_level is None
            and block.heading_level is None
            or owner in groups
            or owner in seen
            or block_index in seen
            or canonical.text[left.end_offset : block.start_offset].strip()
        ):
            continue
        labels = (elements[first_link], link)
        groups[owner] = _NamedOpening(
            normalize_whitespace(
                " ".join(canonical.text[h.start_offset : h.end_offset] for h in labels)
            ),
            (first, block_index),
            block.end_offset,
        )
    return groups


def build_epub_structure(
    *,
    media_id: UUID,
    fragments: Sequence[EpubStructureFragment],
    toc_nodes: Sequence[EpubStructureTocNode],
    note_regions: Iterable[NoteRegion],
    contents: EpubContents,
) -> EpubStructureResult:
    """Build the exact semantic rows one publication installs."""
    by_href = {fragment.package_href: fragment for fragment in fragments}
    fragment_order = {fragment.fragment_id: fragment.fragment_idx for fragment in fragments}
    note_index = NavigationNoteIndex(note_regions, fragment_order)
    contents_regions = _contents_regions(fragments, toc_nodes, contents)

    def routine(point: DocumentPoint) -> bool:
        return note_index.is_routine(point) and not contents_regions.contains(point)

    openings = {f.fragment_idx: _named_openings(f, contents) for f in fragments}
    embedded = {n.node_id for n in contents.nodes}
    package_nodes = toc_nodes
    toc_nodes = [*toc_nodes, *contents.nodes]
    by_toc = {node.node_id: node for node in toc_nodes}
    sections: list[_Section] = []
    by_source_node: dict[str, _Section] = {}
    publisher_boundaries: dict[tuple[DocumentPoint, str, DomCut | None], _Section] = {}
    by_arrival: dict[DocumentPoint, list[_Section]] = {}
    by_element: dict[tuple[int, int], list[_Section]] = {}
    used_ids: set[str] = set()
    claimed_headings: set[tuple[int, int]] = set()
    detached_note_boundaries: list[SectionBoundary] = []
    checked_note_members: dict[int, bool] = {}

    headings_by_label: dict[str, list[tuple[EpubStructureFragment, int]]] = {}
    for fragment in fragments:
        for index, element in enumerate(fragment.canonical.elements):
            if (
                element.heading_level is not None
                and not element.in_navigation
                and routine(DocumentPoint(fragment.fragment_idx, element.start_offset))
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
        arrival = _resolve_arrival(node.href, by_href)
        node.fragment_idx = None
        if arrival is None:
            continue
        fragment = arrival.fragment
        href_fragment = arrival.anchor
        arrival_index = arrival.element_index
        element_index = arrival_index
        node.fragment_idx = fragment.fragment_idx
        node.target_offset = arrival.point.offset
        if arrival_index is not None:
            ancestor = fragment.canonical.elements[arrival_index].parent_element
            while ancestor is not None:
                element = fragment.canonical.elements[ancestor]
                if element.heading_level is not None:
                    if element.start_offset == node.target_offset:
                        element_index = ancestor
                    break
                ancestor = element.parent_element
        arrival_path = (
            fragment.canonical.elements[arrival_index].dom_path if arrival_index is not None else ()
        )
        arrival_cut = DomCut(arrival_path, "before") if arrival_path is not None else None
        arrival_target = arrival.point
        node.resolution = "SourceTarget"
        if node.nav_type != "toc":
            continue
        opening = next(
            (
                idx
                for idx, value in openings[fragment.fragment_idx].items()
                if fragment.canonical.elements[idx].start_offset == node.target_offset
                and _boundary_label(value.label) == _boundary_label(node.label)
            ),
            None,
        )
        match = (
            (opening,)
            if opening is not None
            else _matching_heading(fragment, node.target_offset, node.label)
        )
        if match is not None and node.node_id in embedded:
            path = fragment.canonical.elements[match[0]].dom_path
            if path is None or not _same_rich_start(arrival_cut, DomCut(path, "before")):
                match = None
        if match is not None:
            element_index = match[0]
            node.target_offset = fragment.canonical.elements[match[0]].start_offset
            node.resolution = "BoundaryMatch"
            claimed_headings.update((fragment.fragment_idx, index) for index in match)
        else:
            candidates = headings_by_label.get(_match_label(node.label), [])
            if (
                node.node_id not in embedded
                and len(candidates) == 1
                and _source_target_incompatible(
                    node, fragment, candidates[0], package_nodes, by_href
                )
                and _repair_has_neighbor_agreement(
                    node,
                    DocumentPoint(
                        candidates[0][0].fragment_idx,
                        candidates[0][0].canonical.elements[candidates[0][1]].start_offset,
                    ),
                    package_nodes,
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
                if current.heading_level is not None and (
                    (
                        node.node_id in embedded
                        and current.dom_path is not None
                        and _same_rich_start(arrival_cut, DomCut(current.dom_path, "before"))
                    )
                    or _match_label(
                        fragment.canonical.text[current.start_offset : current.end_offset]
                    )
                    == _match_label(node.label)
                ):
                    claimed_headings.add((fragment.fragment_idx, element_index))
        target = DocumentPoint(fragment.fragment_idx, node.target_offset)
        if not routine(target) or not fragment.canonical.text.strip():
            if (
                node.node_id not in embedded
                and target == arrival.point == DocumentPoint(fragment.fragment_idx, 0)
                and fragment.package_href in contents.printed_note_members
            ):
                if fragment.fragment_idx not in checked_note_members:
                    checked_note_members[fragment.fragment_idx] = note_index.covers_member(
                        fragment.fragment_idx, fragment.canonical.text
                    )
                if checked_note_members[fragment.fragment_idx]:
                    detached_note_boundaries.append(
                        SectionBoundary(
                            "publisher", node.depth, SectionEnd(target, DomCut((), "before"))
                        )
                    )
            continue
        if DocumentPoint(fragment.fragment_idx, node.target_offset) != arrival_target:
            repaired_path = (
                fragment.canonical.elements[element_index].dom_path
                if element_index is not None
                else None
            )
            arrival_cut = DomCut(repaired_path, "before") if repaired_path is not None else None
        boundary = (
            DocumentPoint(fragment.fragment_idx, node.target_offset),
            _match_label(node.label),
            arrival_cut,
        )
        prior = publisher_boundaries.get(boundary)
        if prior is None and node.node_id in embedded and arrival_cut is not None:
            same = [
                s
                for s in by_arrival.get(boundary[0], [])
                if _same_rich_start(s.start_cut, arrival_cut)
            ]
            if len(same) == 1:
                prior = same[0]
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
            boundary_scope=None if node.node_id in embedded else "publisher",
            publisher_depth=None if node.node_id in embedded else node.depth,
            start_cut=arrival_cut,
        )
        sections.append(section)
        publisher_boundaries[boundary] = section
        by_arrival.setdefault(boundary[0], []).append(section)
        node.section_id = section.location_id
        by_source_node[node.node_id] = section
        if element_index is not None and (
            fragment.canonical.elements[element_index].heading_level is None
            or (fragment.fragment_idx, element_index) in claimed_headings
        ):
            by_element.setdefault((fragment.fragment_idx, element_index), []).append(section)

    parented_sections: set[str] = set()
    for node in package_nodes:
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

    competing_openings: set[DocumentPoint] = set()
    for fragment in fragments:
        local_groups = openings[fragment.fragment_idx]
        grouped = {m for owner, g in local_groups.items() for m in g.members if m != owner}
        for index, element in enumerate(fragment.canonical.elements):
            opening_group = local_groups.get(index)
            if (element.heading_level is None and opening_group is None) or index in grouped:
                continue
            if element.in_navigation or not routine(
                DocumentPoint(fragment.fragment_idx, element.start_offset)
            ):
                continue
            label = (
                opening_group.label
                if opening_group
                else normalize_whitespace(
                    fragment.canonical.text[element.start_offset : element.end_offset]
                )
            )
            if not label:
                continue
            rank = element.heading_level
            scope: str | None = f"heading:{fragment.fragment_idx}"
            if opening_group is not None and element.declared_division is not None:
                body_end = (
                    len(fragment.canonical.text) if element.tag == "span" else element.end_offset
                )
                if not fragment.canonical.text[opening_group.end : body_end].strip():
                    scope = None
            if rank is not None and element.declared_division in {"part", "volume"}:
                # A title head alone cannot delimit the work it introduces.
                scope = None
            if scope is None:
                competing_openings.add(DocumentPoint(fragment.fragment_idx, element.start_offset))
            matched = by_element.get((fragment.fragment_idx, index))
            if matched:
                for section in matched:
                    section.heading_rank = rank
                    section.source = "Both"
                    if section.boundary_scope is None:
                        section.boundary_scope = scope
                continue
            if (fragment.fragment_idx, index) in claimed_headings:
                continue
            location_id = (
                _heading_location_id(media_id, fragment.fragment_id, element.start_offset, rank)
                if rank is not None
                else "heading:"
                + str(uuid5(media_id, f"division:{fragment.fragment_id}:{element.dom_path}"))
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
                boundary_scope=scope,
            )
            sections.append(section)
            by_element[(fragment.fragment_idx, index)] = [section]

    _add_inferred_numbered_entries(
        media_id,
        fragments,
        sections,
        by_element,
        routine,
    )
    for section in sections:
        if section.source in {"Publisher", "Both"}:
            continue
        assert section.element_index is not None
        element = section.fragment.canonical.elements[section.element_index]
        if element.dom_path is not None:
            section.start_cut = DomCut(element.dom_path, "before")
    # Contents-only arrivals participate in neither ownership nor peer/range inference.
    eligible = [section for section in sections if section.boundary_scope is not None]
    eligible_elements = {
        key: [s for s in ss if s.boundary_scope is not None] for key, ss in by_element.items()
    }
    by_container = _bind_containers(fragments, eligible, eligible_elements, openings)
    _assign_parents(eligible, by_container)
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
                ancestor.container_end_cut = None
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
                section.container_end_cut = owner.container_end_cut
                break
            ancestor = section.fragment.canonical.elements[ancestor].parent_element

    if not fragments:
        return EpubStructureResult([], [])
    last = max(fragments, key=lambda fragment: fragment.fragment_idx)
    for section in sections:
        if section.fragment is not last or section.element_index is None or section.owns_container:
            continue
        element = last.canonical.elements[section.element_index]
        if element.heading_level is None or element.parent_element is not None:
            continue
        following = [
            item for item in last.canonical.elements if item.start_offset >= element.end_offset
        ]
        if (
            not any(
                item.tag == "p"
                and last.canonical.text[item.start_offset : item.end_offset].strip()
                and routine(DocumentPoint(last.fragment_idx, item.start_offset))
                for item in following
            )
            or any(
                item.tag in STRUCTURE_CAPTURE_TAGS
                or item.heading_level is not None
                or item.roles & _PARATEXT_ROLES
                for item in following
            )
            or note_index.has_notes(last.fragment_idx)
        ):
            continue
        section.container_end = DocumentPoint(last.fragment_idx, len(last.canonical.text))
        section.container_end_cut = DomCut((), "after")
    range_inputs = [
        SectionRangeInput(
            section.location_id,
            section.target,
            section.parent,
            section.container_end,
            section.owns_container,
            section.boundary_scope,
            section.start_cut,
            section.container_end_cut,
            source_rank=section.publisher_depth,
        )
        for section in eligible
    ]
    ends = resolve_section_extents(
        range_inputs,
        None,
        unproved_boundaries=[
            *competing_openings,
            *_unproved_spine_boundaries(fragments, eligible, range_inputs, note_index),
        ],
        closing_boundaries=detached_note_boundaries,
    )
    for section in sections:
        if section.publisher_parent is None:
            continue
        ancestor = section.parent
        while ancestor is not None and ancestor != section.publisher_parent:
            ancestor = by_section_id[ancestor].parent
        if ancestor is None and not by_section_id[section.publisher_parent].owns_container:
            ends[section.publisher_parent] = None
    sections.sort(key=lambda s: (s.target, s.element_index if s.element_index is not None else -1))
    published_sections: list[EpubStructureSection] = []
    for section in sections:
        end = ends.get(section.location_id)
        published_sections.append(
            EpubStructureSection(
                location_id=section.location_id,
                label=section.label,
                fragment_idx=section.fragment.fragment_idx,
                href_path=section.fragment.package_href,
                href_fragment=section.href_fragment,
                start_offset=section.target.offset,
                parent_section_id=section.parent,
                end=end.point if end is not None else None,
                source=section.source,
                start_cut=section.start_cut,
                end_cut=end.cut if end is not None else None,
            )
        )
    return EpubStructureResult(
        published_sections,
        [
            *contents.nodes,
            *_supplemental_toc_nodes(media_id, fragments, toc_nodes, sections, note_index),
        ],
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
        if element.heading_level is not None and target_offset <= element.start_offset
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
            if elements[index].heading_level is not None
            and elements[index].start_offset <= node.target_offset
        ),
        None,
    )
    if nearest_heading is None:
        return False
    for other in toc_nodes:
        if other.node_id == node.node_id or other.nav_type != "toc" or other.href is None:
            continue
        arrival = _resolve_arrival(other.href, by_href)
        if arrival is None or arrival.fragment is not source:
            continue
        matched = _matching_heading(source, arrival.point.offset, other.label)
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
        arrival = _resolve_arrival(sibling.href, by_href)
        if arrival is None:
            return None
        fragment = arrival.fragment
        matched = _matching_heading(fragment, arrival.point.offset, sibling.label)
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
    note_index: NavigationNoteIndex,
) -> list[EpubStructureTocNode]:
    """Publish source-only apparatus headings beneath their note collection."""
    by_fragment_id = {fragment.fragment_id: fragment for fragment in fragments}
    groups = note_index.groups
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
        assert element.heading_level is not None
        node_id = _heading_location_id(
            media_id, fragment.fragment_id, element.start_offset, element.heading_level
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
                    if element.heading_level is not None and element.start_offset == point.offset
                ),
                None,
            )
            if section is None or index is None:
                continue
            existing = add_heading(fragment, index, None, section.location_id)
        group_nodes[(heading.fragment_id, heading.offset)] = existing

    for fragment in fragments:
        for index, element in enumerate(fragment.canonical.elements):
            if element.heading_level is None:
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
    routine: Callable[[DocumentPoint], bool],
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
            if not routine(DocumentPoint(fragment.fragment_idx, element.start_offset)):
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


def _same_rich_start(left: DomCut | None, right: DomCut | None) -> bool:
    """same canonical point and an uninterrupted initial-child chain share an edge."""
    if left is None or right is None or left.edge != "before" or right.edge != "before":
        return False
    short, long = sorted((left.path, right.path), key=len)
    return long[: len(short)] == short and all(child == 0 for child in long[len(short) :])


def _unproved_spine_boundaries(
    fragments: Sequence[EpubStructureFragment],
    sections: Sequence[_Section],
    inputs: Sequence[SectionRangeInput],
    note_index: NavigationNoteIndex,
) -> list[DocumentPoint]:
    """keep real competing structure; ordinary file splitting cannot create a division.

    only a source-authored part corroborated by a publisher heading may own
    routine unheaded spine content until an already-proved publisher boundary.
    no filename, adjacency, label alone or missing closing peer supplies scope.
    """
    unindexed = [
        fragment
        for fragment in fragments
        if not any(section.fragment is fragment for section in sections)
    ]
    natural = resolve_section_extents(inputs, None)
    publisher_edges = {
        (section.target, section.start_cut)
        for section in sections
        if section.source in {"Publisher", "Both"} and section.start_cut is not None
    }

    def competing_structure(fragment: EpubStructureFragment) -> bool:
        return any(
            element.heading_level is not None
            or element.tag in STRUCTURAL_TAGS | {"nav"}
            or element.in_navigation
            or element.roles
            & (
                _PARATEXT_ROLES
                | {
                    "chapter",
                    "doc-chapter",
                    "part",
                    "doc-part",
                    "volume",
                    "preface",
                    "foreword",
                    "afterword",
                    "introduction",
                    "appendix",
                    "acknowledgments",
                    "epigraph",
                    "doc-preface",
                    "doc-foreword",
                    "doc-afterword",
                    "doc-introduction",
                    "doc-appendix",
                    "doc-acknowledgments",
                    "doc-epigraph",
                    "footnote",
                    "doc-footnote",
                    "footnotes",
                    "doc-footnotes",
                    "endnote",
                    "doc-endnote",
                    "endnotes",
                    "doc-endnotes",
                    "rearnote",
                    "doc-rearnote",
                    "rearnotes",
                    "doc-rearnotes",
                    "note",
                    "doc-note",
                    "notes",
                    "doc-notes",
                }
            )
            for element in fragment.canonical.elements
        ) or note_index.has_notes(fragment.fragment_idx)

    intervals: list[tuple[DocumentPoint, DocumentPoint]] = []
    for section in sections:
        end = natural[section.location_id]
        if (
            section.source != "Both"
            or section.element_index is None
            or section.start_cut is None
            or section.start_cut.edge != "before"
            or end is None
            or (end.point, end.cut) not in publisher_edges
        ):
            continue
        ancestor = section.fragment.canonical.elements[section.element_index].parent_element
        authored_part = False
        while ancestor is not None:
            container = section.fragment.canonical.elements[ancestor]
            path = container.dom_path
            if (
                container.roles & {"part", "doc-part", "volume"}
                and container.start_offset == section.target.offset
                and path is not None
                and _same_rich_start(section.start_cut, DomCut(path, "before"))
            ):
                authored_part = True
                break
            ancestor = container.parent_element
        if not authored_part:
            continue
        between = [
            fragment
            for fragment in unindexed
            if section.target < DocumentPoint(fragment.fragment_idx, 0) < end.point
        ]
        if any(competing_structure(fragment) for fragment in between):
            continue
        intervals.append((section.target, end.point))
    return [
        DocumentPoint(fragment.fragment_idx, 0)
        for fragment in unindexed
        if (fragment.canonical.text.strip() or competing_structure(fragment))
        and not any(
            start < DocumentPoint(fragment.fragment_idx, 0) < end for start, end in intervals
        )
    ]


def _publisher_file_roots(sections: Sequence[_Section]) -> dict[int, _Section]:
    """unique publisher roots at a real rich content edge, never scalar zero alone."""
    publisher_roots: dict[int, _Section] = {}
    for fragment_idx in {section.fragment.fragment_idx for section in sections}:
        published = {
            section.location_id: section
            for section in sections
            if section.fragment.fragment_idx == fragment_idx
            and section.source in {"Publisher", "Both"}
        }
        roots = [
            section for section in published.values() if section.publisher_parent not in published
        ]
        if len(roots) != 1:
            continue
        owner = roots[0]
        if owner.target.offset != 0 or not _same_rich_start(owner.start_cut, DomCut((), "before")):
            continue
        if owner.element_index is not None:
            element = owner.fragment.canonical.elements[owner.element_index]
            if element.in_navigation or element.roles & {"titlepage", "doc-titlepage", "cover"}:
                continue
        # The publisher's sole local root starts at the actual rich edge. Its
        # declared descendants share that source file; this proves local
        # membership, never a container end or a cross-file reading division.
        publisher_roots[fragment_idx] = owner
    return publisher_roots


def _bind_containers(
    fragments: Sequence[EpubStructureFragment],
    sections: list[_Section],
    by_element: dict[tuple[int, int], list[_Section]],
    openings: dict[int, dict[int, _NamedOpening]],
) -> dict[tuple[int, int], _Section]:
    """Bind complete authored divisions; a title wrapper proves no body end."""
    by_container: dict[tuple[int, int], _Section] = {}
    publisher_roots = _publisher_file_roots(sections)
    for fragment in fragments:
        elements = fragment.canonical.elements
        for index, container in enumerate(elements):
            if (
                container.tag not in STRUCTURAL_TAGS | {"div", "main"}
                and not (container.tag == "span" and index in openings[fragment.fragment_idx])
            ) or container.in_navigation:
                continue
            labelled = {
                fragment.canonical.anchors[label]
                for label in container.labelled_by
                if label in fragment.canonical.anchors
            }
            owners = by_element.get((fragment.fragment_idx, index), [])
            publisher = publisher_roots.get(fragment.fragment_idx)
            if (
                publisher is not None
                and container.dom_path == (0,)
                and container.start_offset == publisher.target.offset == 0
                and container.roles & {"chapter", "doc-chapter", "part", "doc-part", "volume"}
            ):
                # An authored division and its publisher file root outrank an
                # incidental numeric heading after an image-only title.
                owners = [publisher]
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
                owners = [
                    owner
                    for owner in owners
                    if (
                        container.declared_division is not None
                        and index in openings[fragment.fragment_idx]
                        or owner.source == "Both"
                        or (
                            owner is publisher
                            and container.roles
                            & {"chapter", "doc-chapter", "part", "doc-part", "volume"}
                        )
                    )
                    and (
                        container.roles & {"chapter", "doc-chapter", "part", "doc-part", "volume"}
                        or not any(
                            peer.source == "Both"
                            and peer.fragment is fragment
                            and peer.publisher_parent == owner.publisher_parent
                            and peer.heading_rank is not None
                            and owner.heading_rank is not None
                            and peer.heading_rank <= owner.heading_rank
                            and owner.target < peer.target
                            and peer.target.offset < container.end_offset
                            for peer in sections
                        )
                    )
                ]
                if not owners:
                    continue
            headings = [
                element
                for element in elements
                if element.heading_level is not None
                and container.start_offset <= element.start_offset < container.end_offset
            ]
            own_group = openings[fragment.fragment_idx].get(index)
            opening_end = own_group.end if own_group is not None else container.start_offset
            for heading in headings:
                if heading.start_offset < opening_end:
                    continue
                if fragment.canonical.text[opening_end : heading.start_offset].strip():
                    break
                opening_end = heading.end_offset
            body_end = (
                len(fragment.canonical.text) if container.tag == "span" else container.end_offset
            )
            if not fragment.canonical.text[opening_end:body_end].strip():
                continue
            owner = next((section for section in owners if section.source == "Both"), owners[0])
            by_container[(fragment.fragment_idx, index)] = owner
            owner.owns_container = True
            excluded = min(
                (
                    element
                    for element in elements
                    if opening_end <= element.start_offset < body_end
                    and (
                        element.tag == "footer"
                        or (element.roles - container.roles) & _PARATEXT_ROLES
                    )
                ),
                key=lambda element: element.start_offset,
                default=None,
            )
            end = DocumentPoint(
                fragment.fragment_idx,
                excluded.start_offset if excluded is not None else body_end,
            )
            boundary = excluded if excluded is not None else container
            if owner.container_end is None or end > owner.container_end:
                owner.container_end = end
                owner.container_end_cut = (
                    DomCut(
                        ()
                        if boundary is container and container.tag == "span"
                        else boundary.dom_path,
                        "before" if excluded is not None else "after",
                    )
                    if boundary.dom_path is not None
                    else None
                )
            if (
                owner.source not in {"Publisher", "Both"}
                and container.start_offset == owner.target.offset
                and container.dom_path is not None
            ):
                owner.start_cut = DomCut(container.dom_path, "before")
    return by_container


def _assign_parents(
    sections: list[_Section],
    by_container: dict[tuple[int, int], _Section],
) -> None:
    """Use source containment and independently proved division relationships."""
    by_id = {section.location_id: section for section in sections}
    publisher_roots = _publisher_file_roots(sections)
    for section in sections:
        if section.publisher_parent is None:
            continue
        parent = by_id[section.publisher_parent]
        if parent.element_index is None:
            continue
        element = parent.fragment.canonical.elements[parent.element_index]
        parent_rank = parent.heading_rank
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
            parent.source == section.source == "Both"
            and section.fragment is parent.fragment
            and section.element_index is not None
            and parent_rank is not None
            and section.heading_rank is not None
            and parent_rank < section.heading_rank
            and parent.target < section.target
            and element.parent_element
            == section.fragment.canonical.elements[section.element_index].parent_element
            and not any(
                candidate.heading_level is not None
                and candidate.heading_level <= parent_rank
                and parent.target.offset < candidate.start_offset < section.target.offset
                for candidate in parent.fragment.canonical.elements
            )
        ):
            # Declared membership and the local source hierarchy corroborate.
            section.parent = parent.location_id
        elif (
            section.fragment is parent.fragment
            and section.fragment.fragment_idx in publisher_roots
            and parent.target < section.target
        ):
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

    stack: list[tuple[_Section, int | None, int]] = []
    fragment_idx = None
    for section in sections:
        if fragment_idx != section.fragment.fragment_idx:
            stack.clear()
            fragment_idx = section.fragment.fragment_idx
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
        element = (
            section.fragment.canonical.elements[section.element_index]
            if section.element_index is not None
            else None
        )
        if (
            element is None
            or section.heading_rank is None
            or element.roles & {"titlepage", "doc-titlepage", "cover"}
        ):
            stack.clear()
            continue
        scope = element.parent_container
        while stack and (stack[-1][1] != scope or stack[-1][2] >= section.heading_rank):
            stack.pop()
        # An uncontained sequence needs publisher-backed source membership,
        # not a heading label or rank alone.
        if (
            scope is None
            and not stack
            and not (
                (
                    section.location_id in declared_parents
                    and _division_kind(section) in {"part", "book", "volume"}
                )
                or section.fragment.fragment_idx in publisher_roots
            )
        ):
            continue
        if (
            section.parent is None
            and stack
            and (
                scope is None
                or any(
                    candidate.tag == "p"
                    and candidate.parent_container == scope
                    and section.fragment.canonical.text[
                        candidate.start_offset : candidate.end_offset
                    ].strip()
                    for candidate in section.fragment.canonical.elements
                )
            )
        ):
            section.parent = stack[-1][0].location_id
        owner = publisher_roots.get(section.fragment.fragment_idx)
        if section.parent is None and owner is not None and owner.target < section.target:
            section.parent = owner.location_id
        stack.append((section, scope, section.heading_rank))


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
