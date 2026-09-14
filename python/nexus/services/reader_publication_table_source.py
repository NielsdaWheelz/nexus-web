"""Original table facts for bounded excerpts; no expanded header-pair graph."""

from __future__ import annotations

from dataclasses import dataclass

from lxml import etree

from nexus.schemas.reader_publication import (
    ReaderPublicationSourceRange,
    ReaderPublicationTableCellMetadata,
    ReaderPublicationTableColumnGroup,
    ReaderPublicationTableExplicitHeader,
    ReaderPublicationTableMetadata,
)
from nexus.services.canonicalize import CanonicalTextBuilder
from nexus.services.reader_publication_tables import (
    ReaderTable,
    ReaderTableCell,
    ReaderTableCellHeaders,
    ReaderTableHeaderProjection,
    project_reader_table,
)

# Trial producer policy, NOT a qualified release limit. Logical slots charge a
# separate allocation from DOM nodes. Excerpts preserve source grids above it.
READER_TABLE_LAYOUT_SLOTS = 8192


@dataclass(frozen=True, slots=True)
class ReaderSourceCell:
    table_ordinal: int
    cell: ReaderTableCell
    headers: ReaderTableCellHeaders


@dataclass(frozen=True, slots=True)
class ReaderSourceTable:
    ordinal: int
    element: etree._Element
    geometry: ReaderTable
    cells: tuple[ReaderSourceCell, ...]
    caption: etree._Element | None


class ReaderTableSource:
    """One source-sized geometry/range pass, shared by every crop of a fragment."""

    def __init__(
        self, root: etree._Element, tables: tuple[etree._Element, ...], *, chunk_codepoints: int
    ) -> None:
        self.root = root
        self.chunk_codepoints = chunk_codepoints
        self.cells: dict[etree._Element, ReaderSourceCell] = {}
        self.structures: dict[etree._Element, int] = {}
        source_ids: dict[str, etree._Element] = {}
        for element in root.iter():
            if isinstance(element.tag, str) and element.get("id"):
                source_ids.setdefault(element.get("id"), element)
        geometries = []
        for ordinal, element in enumerate(tables):
            self.structures[element] = ordinal
            for child in element:
                if child.tag in {"thead", "tbody", "tfoot", "tr", "colgroup", "col", "caption"}:
                    self.structures[child] = ordinal
                    if child.tag in {"thead", "tbody", "tfoot", "colgroup"}:
                        for descendant in child:
                            if descendant.tag in {"tr", "col"}:
                                self.structures[descendant] = ordinal
            geometry = project_reader_table(element)
            projection = ReaderTableHeaderProjection(geometry, source_ids)
            geometries.append(geometry)
            for cell in geometry.cells:
                self.structures[cell.element] = ordinal
                self.cells[cell.element] = ReaderSourceCell(
                    ordinal, cell, projection.for_cell(cell)
                )
        # The forming algorithm moves footer rows. Metadata keeps original DOM
        # order, which also owns explicit-header first-seen ordering.
        ordered: list[list[ReaderSourceCell]] = [[] for _ in tables]
        for element in root.iter():
            cell = self.cells.get(element)
            if cell is not None:
                ordered[cell.table_ordinal].append(cell)
        self.tables = tuple(
            ReaderSourceTable(
                ordinal,
                element,
                geometry,
                tuple(ordered[ordinal]),
                next((child for child in element if child.tag == "caption"), None),
            )
            for ordinal, (element, geometry) in enumerate(zip(tables, geometries, strict=True))
        )
        self.ranges: dict[etree._Element, tuple[int, int]] | None = None

    def canonical_ranges(self, expected: str) -> dict[etree._Element, tuple[int, int]]:
        if self.ranges is not None:
            return self.ranges
        wanted = set(self.cells)
        wanted.update(table.caption for table in self.tables if table.caption is not None)
        target = CanonicalTextBuilder(set())
        raw: dict[etree._Element, tuple[int, int]] = {}

        def visit(element: etree._Element) -> None:
            if not isinstance(element.tag, str):
                return
            target.start(element.tag.rsplit("}", 1)[-1], element.attrib)
            start = target.builder.length
            target.data(element.text or "")
            for child in element:
                visit(child)
                target.data(child.tail or "")
            if element in wanted:
                raw[element] = (start, target.builder.length)
            target.end(element.tag.rsplit("}", 1)[-1])

        visit(self.root)
        projected = target.project_markers(
            {offset for extent in raw.values() for offset in extent},
            expected=expected,
            chunk_codepoints=self.chunk_codepoints,
        )
        self.ranges = {
            element: (projected[start], projected[end]) for element, (start, end) in raw.items()
        }
        return self.ranges

    def metadata(
        self,
        *,
        fragment_id: str,
        excerpts: set[int],
        first_units: dict[etree._Element, str],
        canonical_text: str,
    ):
        ranges = self.canonical_ranges(canonical_text)

        def source_range(element: etree._Element) -> ReaderPublicationSourceRange:
            start, end = ranges[element]
            return ReaderPublicationSourceRange(
                unit_key=first_units[element], fragment_id=fragment_id, start_cp=start, end_cp=end
            )

        for table in self.tables:
            if table.ordinal not in excerpts:
                continue
            identity = {"fragment_id": fragment_id, "table_ordinal": table.ordinal}
            yield ReaderPublicationTableMetadata(
                **identity,
                row_count=table.geometry.row_count,
                column_count=table.geometry.column_count,
                caption=source_range(table.caption) if table.caption is not None else None,
            )
            for group in table.geometry.column_groups:
                yield ReaderPublicationTableColumnGroup(
                    **identity, start=group.start, end=group.end
                )
            for source in table.cells:
                cell = source.cell
                yield ReaderPublicationTableCellMetadata(
                    **identity,
                    row=cell.row,
                    column=cell.column,
                    row_span=cell.row_span,
                    column_span=cell.column_span,
                    row_group=cell.row_group,
                    header_kind=source.headers.kind,
                    empty=source.headers.empty,
                    explicit_headers=source.headers.explicit_targets is not None,
                    range=source_range(cell.element),
                )
                for row, column in source.headers.explicit_targets or ():
                    yield ReaderPublicationTableExplicitHeader(
                        **identity,
                        row=cell.row,
                        column=cell.column,
                        target_row=row,
                        target_column=column,
                    )
