"""Partition sanitized DOM ranges while retaining original canonical coordinates."""

from __future__ import annotations

from array import array
from bisect import bisect_left, bisect_right
from collections import deque
from collections.abc import Iterator, Mapping
from copy import deepcopy
from dataclasses import dataclass
from tempfile import TemporaryFile
from urllib.parse import quote
from uuid import UUID

import lxml.etree as etree
import regex
from lxml import html

from nexus.config import ReaderPublicationLimits
from nexus.errors import ReaderContentTooLargeError
from nexus.schemas.media import DocumentEmbedSource
from nexus.schemas.offline_reading_package import OFFLINE_READING_URL_ATTRIBUTES
from nexus.schemas.reader import ReaderEpubTarget
from nexus.schemas.reader_publication import (
    READER_PUBLICATION_MOUNT_NODES,
    ReaderPublicationAnchor,
    ReaderPublicationAssetRef,
    ReaderPublicationCapturedAsset,
    ReaderPublicationRenderElement,
    ReaderPublicationRenderNode,
    ReaderPublicationSourceRange,
    ReaderPublicationTableCell,
    ReaderPublicationTableContext,
    ReaderPublicationTableMetadataRecord,
    ReaderPublicationUnitBody,
)
from nexus.services.canonicalize import (
    WHITESPACE_RE,
    CanonicalTextBuilder,
    validate_canonical_text_with_element_offsets,
)
from nexus.services.media_document_metrics import (
    canonical_word_boundary_ordinal,
    is_canonical_word_separator,
)
from nexus.services.reader_publication_lists import project_reader_list_ordinals
from nexus.services.reader_publication_render import (
    canonical_element_ids_from_render_nodes,
    canonical_text_from_render_nodes,
    normalize_reader_tables,
    project_reader_render_nodes,
    set_reader_source_attribute,
)
from nexus.services.reader_publication_table_source import (
    READER_TABLE_LAYOUT_SLOTS,
    ReaderTableSource,
)
from nexus.services.reader_word_boundaries import reader_word_boundaries

_ATOMIC_ELEMENTS = frozenset(
    {"svg", "math", "table", "picture", "audio", "video", "iframe", "object"}
)


class _BoundaryWindow:
    """Keep Unicode boundaries only for the current bounded candidate window."""

    def __init__(self, positions: Iterator[int]) -> None:
        self.positions = positions
        self.pending = next(positions, None)
        self.retained: deque[int] = deque()

    def through(self, start: int, end: int) -> tuple[int, ...]:
        while self.retained and self.retained[0] < start:
            self.retained.popleft()
        while self.pending is not None and self.pending <= end:
            if self.pending >= start:
                self.retained.append(self.pending)
            self.pending = next(self.positions, None)
        return tuple(self.retained)


@dataclass(slots=True)
class _ElementRange:
    """DOM-only partition coordinates and bottom-up costs; never locators."""

    element: etree._Element
    start: int
    text_start: int
    children: tuple[tuple[_ElementRange, int], ...]
    end: int
    raw_size: int
    nodes: int
    atomic: bool
    own_slots: int
    layout_slots: int
    contains_excerpts: bool = False


def _index(
    element: etree._Element,
    start: int,
    limits: ReaderPublicationLimits,
    tables: ReaderTableSource,
    table_indices: dict[etree._Element, _ElementRange],
    table_slots: Mapping[etree._Element, int],
) -> _ElementRange:
    table = element in table_slots
    atomic = not isinstance(element.tag, str) or (
        element.tag.rsplit("}", 1)[-1].lower() in _ATOMIC_ELEMENTS and not table
    )
    if atomic:
        raw_size = 0
        nodes = 0
        layout_slots = 0
        for node in element.iter():
            raw_size += 1 + len(node.text or "")
            nodes += 1 + bool(node.text)
            if node is not element:
                raw_size += len(node.tail or "")
                nodes += bool(node.tail)
            raw_size += sum(len(key) + len(value) for key, value in node.attrib.items())
            layout_slots += table_slots.get(node, 0)
            if raw_size > limits.unit_bytes:
                raise ReaderContentTooLargeError(
                    "Reader element exceeds qualified unit capacity",
                    limit="unit_bytes",
                    limit_value=limits.unit_bytes,
                    measured=raw_size,
                )
        return _ElementRange(
            element,
            start,
            start + 1,
            (),
            start + 1,
            raw_size,
            nodes,
            True,
            0,
            layout_slots,
        )
    attributes = sum(len(key) + len(value) for key, value in element.attrib.items())
    # Excerpts retain the complete authored header list in sparse source records.
    # The operative DOM attribute is removed before construction.
    displayed_attributes = attributes - (
        len(element.get("headers", "")) if element in tables.cells else 0
    )
    if displayed_attributes > limits.unit_bytes:
        raise ReaderContentTooLargeError(
            "Reader attributes exceed unit capacity",
            limit="unit_bytes",
            limit_value=limits.unit_bytes,
            measured=displayed_attributes,
        )
    position = start + 1 + len(element.text or "")
    raw_size = 1 + len(element.text or "") + attributes
    nodes = 1 + bool(element.text)
    children: list[tuple[_ElementRange, int]] = []
    layout_slots = 0
    for child in element:
        indexed = _index(child, position, limits, tables, table_indices, table_slots)
        children.append((indexed, indexed.end))
        position = indexed.end + len(child.tail or "")
        raw_size += indexed.raw_size + len(child.tail or "")
        nodes += indexed.nodes + bool(child.tail)
        layout_slots += indexed.layout_slots
    own_slots = table_slots.get(element, 0)
    contains_excerpts = any(child.contains_excerpts for child, _tail in children)
    atomic = table and (
        not contains_excerpts
        and own_slots <= READER_TABLE_LAYOUT_SLOTS
        and raw_size <= limits.unit_bytes
        and nodes + READER_PUBLICATION_MOUNT_NODES <= limits.unit_dom_nodes
    )
    own_slots = own_slots if atomic else 0
    result = _ElementRange(
        element,
        start,
        start + 1,
        tuple(children),
        position,
        raw_size,
        nodes,
        atomic,
        own_slots,
        layout_slots + own_slots,
        contains_excerpts or (table and not atomic),
    )
    if table:
        table_indices[element] = result
    return result


def _rounded_end(index: _ElementRange, end: int) -> int:
    if index.atomic and index.start < end < index.end:
        return index.end
    for child, _tail in _intersecting_children(index, end - 1, end):
        if child.start < end < child.end:
            return _rounded_end(child, end)
    return end


def _layout_slots(index: _ElementRange, start: int, end: int) -> int:
    if index.end <= start or index.start >= end:
        return 0
    if index.atomic or (start <= index.start and index.end <= end):
        return index.layout_slots
    return index.own_slots + sum(
        _layout_slots(child, start, end)
        for child, _tail in _intersecting_children(index, start, end)
    )


def _excerpt_first_table_atom(
    index: _ElementRange,
    start: int,
    end: int,
    table_indices: Mapping[etree._Element, _ElementRange],
) -> int | None:
    """Demote the first fitting atom and subtract its slots along this source path.

    Updating ancestors on return avoids parent/child cycles retaining an entire
    fragment DOM after its splitter has finished.
    """
    if index.end <= start or index.start >= end:
        return None
    if index.atomic and index.element in table_indices:
        slots = index.own_slots
        index.atomic = False
        index.own_slots = 0
        index.layout_slots -= slots
        index.contains_excerpts = True
        return slots
    for child, _tail in _intersecting_children(index, start, end):
        slots = _excerpt_first_table_atom(child, start, end, table_indices)
        if slots is not None:
            index.layout_slots -= slots
            index.contains_excerpts = True
            return slots
    return None


def _intersecting_children(
    index: _ElementRange, start: int, end: int
) -> tuple[tuple[_ElementRange, int], ...]:
    # A preceding child may own the tail containing start. No earlier sibling
    # can intersect this crop; walking all of them repeats whole-source work.
    first = max(0, bisect_right(index.children, start, key=lambda item: item[0].start) - 1)
    last = bisect_left(index.children, end, key=lambda item: item[0].start)
    return index.children[first:last]


def _slice(text: str | None, text_start: int, start: int, end: int) -> str:
    if not text:
        return ""
    first, last = max(start - text_start, 0), min(end - text_start, len(text))
    return text[first:last] if last > first else ""


def _crop(
    index: _ElementRange,
    start: int,
    end: int,
    retained: dict[etree._Element, tuple[_ElementRange, etree._Element]],
) -> etree._Element | None:
    if index.end <= start or index.start >= end:
        return None
    source = index.element
    if not isinstance(source.tag, str):
        # Sanitizers normally remove comments; preserving them still must not
        # turn their text into visible canonical content.
        return etree.Comment(source.text or "")
    if index.atomic:
        return deepcopy(source)
    result = etree.Element(source.tag, nsmap=source.nsmap)
    retained[source] = (index, result)
    for name, value in source.attrib.items():
        set_reader_source_attribute(result, name, value)
    if start > index.start:
        result.attrib.pop("id", None)
        result.attrib.pop("name", None)
        result.attrib.pop("data-nexus-document-embed-id", None)
        if source.tag.lower() == "li":
            result.attrib["data-nexus-continuation"] = "list-item"
    result.text = _slice(source.text, index.text_start, start, end) or None
    intersecting = _intersecting_children(index, start, end)
    for child, tail_start in intersecting:
        cropped_child = _crop(child, start, end, retained)
        tail = _slice(child.element.tail, tail_start, start, end)
        if cropped_child is not None:
            cropped_child.tail = tail or None
            result.append(cropped_child)
        elif tail:
            if len(result):
                result[-1].tail = (result[-1].tail or "") + tail
            else:
                result.text = (result.text or "") + tail
    return result


def _mapped_crop_canonical(index: _ElementRange, start: int, end: int) -> tuple[str, array, int]:
    """Map only one bounded crop through the existing canonicalization owner.

    Synthetic separators identify their source element event. Normalized text
    identifies its original DOM codepoint. NFC/whitespace transformations use
    the same source-start projection as retained navigation, not quote matching.
    """
    target = CanonicalTextBuilder(set())
    raw_sources = array("Q")

    def begin(element: etree._Element, position: int) -> None:
        before = target.builder.length
        target.start(element.tag.rsplit("}", 1)[-1], element.attrib)
        raw_sources.extend([position] * (target.builder.length - before))

    def finish(element: etree._Element, position: int) -> None:
        before = target.builder.length
        target.end(element.tag.rsplit("}", 1)[-1])
        raw_sources.extend([position] * (target.builder.length - before))

    def data(value: str, position: int, *, atomic: bool = False) -> None:
        before = target.builder.length
        target.data(value)
        added = target.builder.length - before
        if not added:
            return
        if atomic:
            raw_sources.extend([position] * added)
            return
        previous = 0
        for whitespace in WHITESPACE_RE.finditer(value):
            raw_sources.extend(range(position + previous, position + whitespace.start()))
            raw_sources.append(position + whitespace.start())
            previous = whitespace.end()
        raw_sources.extend(range(position + previous, position + len(value)))

    def atom(element: etree._Element, first: int, last: int) -> None:
        if not isinstance(element.tag, str):
            return
        begin(element, first)
        data(element.text or "", first, atomic=True)
        for child in element:
            atom(child, first, last)
            data(child.tail or "", first, atomic=True)
        finish(element, last)

    def visit(current: _ElementRange) -> None:
        if current.end <= start or current.start >= end:
            return
        element = current.element
        if not isinstance(element.tag, str):
            return
        if current.atomic:
            atom(element, current.start, current.end)
            return
        begin(element, max(start, current.start))
        data(
            _slice(element.text, current.text_start, start, end),
            max(start, current.text_start),
        )
        for child, tail_start in _intersecting_children(current, start, end):
            visit(child)
            data(_slice(child.element.tail, tail_start, start, end), max(start, tail_start))
        finish(element, min(end, current.end))

    visit(index)
    canonical, starts = target.build_with_source_starts()
    if len(raw_sources) != target.builder.length:
        raise AssertionError("Mapped crop differs from canonical source events")
    # The canonical owner trims pending whitespace. Its original event still
    # owns a possible cut before a following combining mark in the full source.
    raw = target.builder.build()
    tail = len(raw)
    while tail and raw[tail - 1].isspace():
        tail -= 1
    pending_start = min(raw_sources[tail:], default=end)
    return canonical, array("Q", (raw_sources[point] for point in starts)), pending_start


def split_reader_publication_fragment(
    *,
    fragment_id: UUID,
    fragment_idx: int,
    fragment_document_start_cp: int,
    fragment_document_word_start: int,
    epub_target: ReaderEpubTarget | None,
    document_embeds: tuple[DocumentEmbedSource, ...],
    html_sanitized: str,
    canonical_text: str,
    assets_by_url: Mapping[str, ReaderPublicationAssetRef],
    limits: ReaderPublicationLimits,
) -> Iterator[
    ReaderPublicationUnitBody | ReaderPublicationTableMetadataRecord | ReaderPublicationAnchor
]:
    """Yield bounded render trees with a lossless partition of canonical text.

    The worker may inspect the source DOM; hosted readers never construct it.
    Cuts clone only intersecting ancestor paths. Canonical matching uses the
    original prefix, never a quote search, so repeated text cannot misanchor it.
    """
    try:
        source_anchors = validate_canonical_text_with_element_offsets(
            html_sanitized,
            None if epub_target is not None else set(),
            expected=canonical_text,
        )
    except ValueError as error:
        raise ValueError("Publication fragment does not match its canonical source text") from error
    # The first boundary runs ICU to completion and spools its binary output.
    # Finish that child before retaining the separate source DOM and index.
    word_window = _BoundaryWindow(reader_word_boundaries(canonical_text))
    root = html.fragment_fromstring(html_sanitized or "<div></div>", create_parent=True)
    effective_tables = normalize_reader_tables(root)
    project_reader_list_ordinals(root)
    tables = ReaderTableSource(root, effective_tables, chunk_codepoints=limits.unit_codepoints)
    table_indices: dict[etree._Element, _ElementRange] = {}
    table_slots = {
        table.element: max(1, table.geometry.row_count) * max(1, table.geometry.column_count)
        for table in tables.tables
    }
    indexed = _index(root, 0, limits, tables, table_indices, table_slots)
    table_ordinals = {table.element: table.ordinal for table in tables.tables}
    source_ranges: dict[etree._Element, tuple[int, int]] = {}
    first_units: dict[etree._Element, str] = {}
    parts: dict[tuple[int, int], int] = {}
    # Reserve a longest possible final key while forward caption targets are
    # still unknown. Logical keys depend on coordinates, never member digests.
    pending_key = f"units/{fragment_id}/" + "9" * 20 + "-" + "9" * 20 + "-" + "9" * 20 + ".json"

    grapheme_window = _BoundaryWindow(
        match.end() for match in regex.finditer(r"\X", canonical_text)
    )
    word_boundaries: tuple[int, ...] = ()
    source_position = 0
    canonical_position = 0
    document_word_start = fragment_document_word_start
    starts_in_word = False
    embed_sources = {item.occurrence_key: item for item in document_embeds}

    def unit_embeds(
        nodes: tuple[ReaderPublicationRenderNode, ...],
    ) -> tuple[DocumentEmbedSource, ...]:
        keys = {
            attribute.value
            for node in nodes
            if isinstance(node, ReaderPublicationRenderElement)
            for attribute in node.attributes
            if attribute.namespace is None and attribute.name == "data-nexus-document-embed-id"
        }
        if not keys <= embed_sources.keys():
            raise ValueError("Reader embed anchor has no accepted source occurrence")
        return tuple(
            sorted((embed_sources[key] for key in keys), key=lambda source: source.ordinal)
        )

    def candidate(
        end: int,
    ) -> tuple[
        tuple[ReaderPublicationRenderNode, ...],
        str,
        tuple[ReaderPublicationAssetRef, ...],
        int,
        tuple[ReaderPublicationTableContext, ...],
        tuple[etree._Element, ...],
    ]:
        nonlocal source_ranges
        if indexed.contains_excerpts and not source_ranges:
            source_ranges = tables.canonical_ranges(canonical_text)
        retained: dict[etree._Element, tuple[_ElementRange, etree._Element]] = {}
        cropped = _crop(indexed, source_position, end, retained)
        assert cropped is not None
        assets: dict[str, ReaderPublicationAssetRef] = {}
        contexts: dict[int, list[ReaderPublicationTableCell]] = {}
        first_elements = []
        for source, (source_index, element) in retained.items():
            structure_ordinal = tables.structures.get(source)
            if structure_ordinal is not None:
                owner = table_indices.get(tables.tables[structure_ordinal].element)
                if owner is not None and not owner.atomic:
                    element.set("data-nexus-table", str(structure_ordinal))
                    if element.tag in {"col", "colgroup"}:
                        element.attrib.pop("span", None)
            ordinal = table_ordinals.get(source)
            if ordinal is not None:
                table = tables.tables[ordinal]
                element.set("data-nexus-table", str(ordinal))
                element.set("aria-rowcount", str(table.geometry.row_count))
                element.set("aria-colcount", str(table.geometry.column_count))
                contexts[ordinal] = []
            if source in source_ranges and source_position <= source_index.start < end:
                first_elements.append(source)
            cell_source = tables.cells.get(source)
            if cell_source is None:
                continue
            table_index = table_indices.get(tables.tables[cell_source.table_ordinal].element)
            if table_index is None or table_index.atomic:
                continue
            cell = cell_source.cell
            for attribute in ("rowspan", "colspan", "headers"):
                element.attrib.pop(attribute, None)
            element.set("data-nexus-table", str(cell_source.table_ordinal))
            element.set("data-nexus-row", str(cell.row))
            element.set("data-nexus-column", str(cell.column))
            element.set("aria-rowindex", str(cell.row + 1))
            element.set("aria-colindex", str(cell.column + 1))
            element.set("aria-rowspan", str(cell.row_span))
            element.set("aria-colspan", str(cell.column_span))
            contexts[cell_source.table_ordinal].append(
                ReaderPublicationTableCell(
                    row=cell.row,
                    column=cell.column,
                    row_span=cell.row_span,
                    column_span=cell.column_span,
                    continued_before=source_index.start < source_position,
                    continued_after=source_index.end > end,
                )
            )
        table_contexts = []
        for ordinal, cells in contexts.items():
            table = tables.tables[ordinal]
            caption = None
            if table.caption is not None:
                caption_start, caption_end = source_ranges[table.caption]
                caption = ReaderPublicationSourceRange(
                    unit_key=pending_key,
                    fragment_id=str(fragment_id),
                    start_cp=caption_start,
                    end_cp=caption_end,
                )
            table_contexts.append(
                ReaderPublicationTableContext(
                    table_ordinal=ordinal,
                    row_count=table.geometry.row_count,
                    column_count=table.geometry.column_count,
                    caption=caption,
                    cells=tuple(cells),
                )
            )

        def member_url(value: str, *, image: bool = False) -> str:
            path, separator, fragment = value.partition("#")
            asset = assets_by_url.get(path)
            if asset is None:
                return value
            if isinstance(asset, ReaderPublicationCapturedAsset):
                assets[asset.member.key] = asset
                return f"nexus-reader-member:{asset.member.key}{separator}{fragment}"
            if not image:
                return value
            assets[asset.source_url] = asset
            return (
                f"nexus-reader-unavailable:{quote(asset.source_url, safe='')}{separator}{fragment}"
            )

        for node in cropped.iter():
            for attribute, value in tuple(node.attrib.items()):
                name = attribute.rsplit("}", 1)[-1].lower()
                if name not in OFFLINE_READING_URL_ATTRIBUTES:
                    continue
                if name == "srcset":
                    candidates = []
                    for part in value.split(","):
                        tokens = part.strip().split()
                        if tokens:
                            candidates.append(" ".join((member_url(tokens[0]), *tokens[1:])))
                    rewritten = ", ".join(candidates)
                else:
                    rewritten = member_url(value, image=node.tag == "img" and name == "src")
                if rewritten != value:
                    set_reader_source_attribute(node, attribute, rewritten)
        nodes = project_reader_render_nodes(cropped)
        rendered = canonical_text_from_render_nodes(nodes)
        return (
            nodes,
            rendered,
            tuple(assets.values()),
            READER_PUBLICATION_MOUNT_NODES + len(nodes),
            tuple(table_contexts),
            tuple(first_elements),
        )

    def fits(
        value: tuple[
            tuple[ReaderPublicationRenderNode, ...],
            str,
            tuple[ReaderPublicationAssetRef, ...],
            int,
            tuple[ReaderPublicationTableContext, ...],
            tuple[etree._Element, ...],
        ],
    ) -> bool:
        body, rendered, assets, nodes, contexts, first = value
        render_start = canonical_position
        if rendered:
            while render_start < len(canonical_text) and canonical_text[render_start].isspace():
                render_start += 1
        text = canonical_text[canonical_position:render_start] + rendered
        marker_end = max(
            (source_ranges[element][0] for element in first), default=canonical_position
        )
        if epub_target is not None:
            marker_end = max(
                marker_end,
                max(
                    (
                        source_anchors[anchor_id]
                        for anchor_id in canonical_element_ids_from_render_nodes(body)
                        if anchor_id in source_anchors
                    ),
                    default=canonical_position,
                ),
            )
        # Opening-only markers can own a trimmed canonical suffix. Charge its
        # complete source extent before accepting the crop. Two extra newlines
        # retain the existing conservative bound for unmarked block boundaries.
        text += " " * max(2, marker_end - canonical_position - len(text))
        if nodes > limits.unit_dom_nodes or len(text) > limits.unit_codepoints:
            return False
        bound = canonical_position
        model = ReaderPublicationUnitBody(
            fragment_id=str(fragment_id),
            epub_target=epub_target,
            document_embeds=unit_embeds(body),
            fragment_idx=fragment_idx,
            fragment_document_start_cp=fragment_document_start_cp,
            fragment_length_cp=max(len(canonical_text), bound + len(text)),
            document_word_start=document_word_start,
            starts_in_word=starts_in_word,
            start_cp=bound,
            end_cp=bound + len(text),
            render_start_cp=render_start,
            render_end_cp=render_start + len(rendered),
            render_nodes=body,
            canonical_text=text,
            word_boundaries=tuple(
                word_boundaries[
                    bisect_left(word_boundaries, bound) : bisect_right(
                        word_boundaries, bound + len(text)
                    )
                ]
            ),
            assets=assets,
            table_contexts=contexts,
        )
        return len(model.model_dump_json().encode("utf-8")) <= limits.unit_bytes

    with TemporaryFile(mode="w+b") as staged, TemporaryFile(mode="w+b") as staged_anchors:
        while source_position < indexed.end:
            window_end = canonical_position + limits.unit_codepoints
            word_boundaries = word_window.through(canonical_position, window_end)
            grapheme_ends = grapheme_window.through(canonical_position, window_end)
            # DOM coordinates charge every text code point and element. The encoded
            # unit cannot contain more of those positions than its byte budget.
            # Starting with half a publication would allocate before checking it.
            lower = source_position + 1
            upper = min(indexed.end, source_position + limits.unit_bytes)
            accepted: int | None = None
            while lower <= upper:
                middle = (lower + upper) // 2
                rounded = _rounded_end(indexed, middle)
                if _layout_slots(
                    indexed, source_position, rounded
                ) <= READER_TABLE_LAYOUT_SLOTS and fits(candidate(rounded)):
                    accepted = rounded
                    lower = middle + 1
                else:
                    upper = middle - 1
            if accepted is None:
                first_end = _rounded_end(indexed, source_position + 1)
                if (
                    _excerpt_first_table_atom(indexed, source_position, first_end, table_indices)
                    is not None
                ):
                    continue
                # No split of this element satisfies the qualified unit profile,
                # so there is no single measured size to report.
                raise ReaderContentTooLargeError(
                    "Reader element exceeds qualified unit capacity",
                    limit="unit_bytes",
                    limit_value=limits.unit_bytes,
                    measured=None,
                )
            corrected = False
            while True:
                if accepted <= source_position:
                    raise ReaderContentTooLargeError(
                        "Canonical text has no boundary within qualified unit capacity",
                        limit="unit_bytes",
                        limit_value=limits.unit_bytes,
                        measured=None,
                    )
                body, rendered, assets, _nodes, contexts, first_elements = candidate(accepted)
                render_start = canonical_position
                while render_start < len(canonical_text) and canonical_text[render_start].isspace():
                    render_start += 1
                if not rendered:
                    render_start = canonical_position
                render_end = render_start + len(rendered)
                unit_anchors = (
                    {
                        anchor_id: source_anchors[anchor_id]
                        for anchor_id in canonical_element_ids_from_render_nodes(body)
                        if anchor_id in source_anchors
                    }
                    if epub_target is not None
                    else {}
                )
                canonical_end = max(
                    render_end,
                    max(
                        (source_ranges[element][0] for element in first_elements),
                        default=render_end,
                    ),
                    max(unit_anchors.values(), default=render_end),
                )
                matches_source = canonical_text.startswith(rendered, render_start)
                if matches_source and canonical_text[render_end:canonical_end].strip():
                    raise AssertionError("Retained source opening skipped canonical text")
                if accepted == indexed.end:
                    if matches_source and canonical_text[canonical_end:].strip():
                        raise ValueError("Partition omitted canonical source content")
                    canonical_end = len(canonical_text)
                end_index = bisect_left(grapheme_ends, canonical_end)
                canonical_ends_grapheme = canonical_end == 0 or (
                    end_index < len(grapheme_ends) and grapheme_ends[end_index] == canonical_end
                )
                grapheme_index = bisect_left(grapheme_ends, render_end)
                ends_grapheme = render_end == 0 or (
                    grapheme_index < len(grapheme_ends)
                    and grapheme_ends[grapheme_index] == render_end
                )
                if (
                    ends_grapheme
                    and canonical_ends_grapheme
                    and matches_source
                    and fits((body, rendered, assets, _nodes, contexts, first_elements))
                ):
                    break
                if corrected:
                    raise AssertionError(
                        "Mapped canonical cut did not preserve its original boundary"
                    )
                mapped, source_starts, pending_start = _mapped_crop_canonical(
                    indexed, source_position, accepted
                )
                if mapped != rendered:
                    raise AssertionError("Mapped crop differs from the final render tree")
                common = 0
                for point, original in zip(
                    rendered, canonical_text[render_start:render_end], strict=False
                ):
                    if point != original:
                        break
                    common += 1
                boundary_index = bisect_right(grapheme_ends, render_start + common) - 1
                boundary = (
                    grapheme_ends[boundary_index] if boundary_index >= 0 else canonical_position
                )
                following = max(0, boundary - render_start)
                if following > len(source_starts):
                    raise AssertionError("Canonical correction has no following source grapheme")
                cut = source_starts[following] if following < len(source_starts) else pending_start
                if cut >= accepted:
                    raise AssertionError("Canonical correction did not move to an earlier source")
                accepted = cut
                corrected = True
            unit = ReaderPublicationUnitBody(
                fragment_id=str(fragment_id),
                epub_target=epub_target,
                document_embeds=unit_embeds(body),
                fragment_idx=fragment_idx,
                fragment_document_start_cp=fragment_document_start_cp,
                fragment_length_cp=len(canonical_text),
                document_word_start=document_word_start,
                starts_in_word=starts_in_word,
                start_cp=canonical_position,
                end_cp=canonical_end,
                render_start_cp=render_start,
                render_end_cp=render_start + len(rendered),
                render_nodes=body,
                canonical_text=canonical_text[canonical_position:canonical_end],
                word_boundaries=tuple(
                    word_boundaries[
                        bisect_left(word_boundaries, canonical_position) : bisect_right(
                            word_boundaries, canonical_end
                        )
                    ]
                ),
                assets=assets,
                table_contexts=contexts,
            )
            if len(unit.model_dump_json().encode("utf-8")) > limits.unit_bytes:
                raise AssertionError("Reader unit exceeded its reserved encoding bound")
            if len(unit.canonical_text) > limits.unit_codepoints or _nodes > limits.unit_dom_nodes:
                raise AssertionError("Reader unit exceeded its qualified expanded bounds")
            extent = (unit.start_cp, unit.end_cp)
            part = parts.get(extent, 0)
            parts[extent] = part + 1
            key = f"units/{fragment_id}/{unit.start_cp}-{unit.end_cp}-{part}.json"
            if epub_target is not None:
                for anchor_id, offset in unit_anchors.items():
                    anchor = ReaderPublicationAnchor(
                        href_path=epub_target.href_path,
                        anchor_id=anchor_id,
                        unit_key=key,
                        offset_cp=offset,
                    )
                    staged_anchors.write(anchor.model_dump_json().encode("utf-8") + b"\n")
                    del source_anchors[anchor_id]
            for element in first_elements:
                first_units.setdefault(element, key)
            staged.write(unit.model_dump_json().encode("utf-8") + b"\n")
            document_word_start += canonical_word_boundary_ordinal(
                unit.canonical_text, len(unit.canonical_text), starts_in_word=starts_in_word
            )
            if unit.canonical_text:
                starts_in_word = not is_canonical_word_separator(unit.canonical_text[-1])
            source_position = accepted
            canonical_position = canonical_end
        if canonical_position != len(canonical_text):
            raise ValueError("Partition omitted canonical source coordinates")
        staged.seek(0)
        for payload in staged:
            unit = ReaderPublicationUnitBody.model_validate_json(payload)
            contexts = []
            for context in unit.table_contexts:
                caption = context.caption
                if caption is not None:
                    element = tables.tables[context.table_ordinal].caption
                    caption = caption.model_copy(update={"unit_key": first_units[element]})
                contexts.append(context.model_copy(update={"caption": caption}))
            unit = unit.model_copy(update={"table_contexts": tuple(contexts)})
            if len(unit.model_dump_json().encode("utf-8")) > limits.unit_bytes:
                raise AssertionError("Final table context exceeded its reserved key bound")
            yield unit
        staged_anchors.seek(0)
        for payload in staged_anchors:
            yield ReaderPublicationAnchor.model_validate_json(payload)
        excerpts = {
            table.ordinal
            for table in tables.tables
            if table.element in table_indices and not table_indices[table.element].atomic
        }
        if excerpts:
            yield from tables.metadata(
                fragment_id=str(fragment_id),
                excerpts=excerpts,
                first_units=first_units,
                canonical_text=canonical_text,
            )
