"""Source-sized table geometry; spans never allocate a dense logical grid.

The HTML table-forming algorithm owns coordinates, including malformed overlaps,
deferred footers and implied rows. Source DOM order remains the reading order.
Header relationships are queried for a selected cell, never expanded for every
cell during publication.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Literal

from lxml import etree
from sortedcontainers import SortedDict, SortedSet


@dataclass(frozen=True, slots=True)
class ReaderTableCell:
    element: etree._Element
    row: int
    column: int
    row_span: int
    column_span: int
    row_group: int | None


@dataclass(frozen=True, slots=True)
class ReaderTableGroup:
    element: etree._Element
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class ReaderTable:
    cells: tuple[ReaderTableCell, ...]
    row_count: int
    column_count: int
    row_groups: tuple[ReaderTableGroup, ...]
    column_groups: tuple[ReaderTableGroup, ...]


ReaderTableHeaderKind = Literal["data", "none", "row", "column", "rowgroup", "colgroup"]


@dataclass(frozen=True, slots=True)
class ReaderTableCellHeaders:
    kind: ReaderTableHeaderKind
    empty: bool
    # None means automatic association. An authored empty/invalid list remains
    # empty and MUST NOT fall back to automatic association.
    explicit_targets: tuple[tuple[int, int], ...] | None


def _merged_intervals(intervals: list[tuple[int, int]]) -> tuple[tuple[int, int], ...]:
    merged: list[tuple[int, int]] = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return tuple(merged)


def _intersects(intervals: tuple[tuple[int, int], ...], start: int, end: int) -> bool:
    previous = bisect_right(intervals, start, key=lambda interval: interval[0]) - 1
    return (previous >= 0 and intervals[previous][1] > start) or (
        previous + 1 < len(intervals) and intervals[previous + 1][0] < end
    )


class ReaderTableHeaderProjection:
    """Classify source cells once without expanding automatic header pairs.

    Source IDs are the document's FIRST element for each ID, supplied by the
    publication owner once for all tables. A non-cell outside this table can
    shadow a later header. Auto classification asks whether any data cell
    covers the relevant row/column interval, never allocates its logical slots.
    """

    def __init__(self, table: ReaderTable, source_ids: Mapping[str, etree._Element]) -> None:
        self.source_ids = source_ids
        self.cells = {cell.element: cell for cell in table.cells if cell.element.get("id")}
        self.data_rows = _merged_intervals(
            [
                (cell.row, cell.row + cell.row_span)
                for cell in table.cells
                if cell.element.tag == "td"
            ]
        )
        self.data_columns = _merged_intervals(
            [
                (cell.column, cell.column + cell.column_span)
                for cell in table.cells
                if cell.element.tag == "td"
            ]
        )

    def for_cell(self, cell: ReaderTableCell) -> ReaderTableCellHeaders:
        element = cell.element
        scope = element.get("scope", "").lower()
        kind: ReaderTableHeaderKind
        if element.tag == "td":
            kind = "data"
        elif scope == "row":
            kind = "row"
        elif scope == "col":
            kind = "column"
        elif scope == "rowgroup":
            kind = "rowgroup"
        elif scope == "colgroup":
            kind = "colgroup"
        elif not _intersects(self.data_rows, cell.row, cell.row + cell.row_span):
            kind = "column"
        elif not _intersects(self.data_columns, cell.column, cell.column + cell.column_span):
            kind = "row"
        else:
            kind = "none"
        # Comments are not elements and their own text is not child text.
        # Their tails are child text, including non-ASCII whitespace.
        empty = not any(
            isinstance(child.tag, str)
            or any(point not in "\t\n\f\r " for point in child.tail or "")
            for child in element
        ) and not any(point not in "\t\n\f\r " for point in element.text or "")
        raw = element.get("headers")
        targets: dict[tuple[int, int], None] = {}
        if raw is not None:
            for token in re.finditer(r"[^\t\n\f\r ]+", raw):
                source = self.source_ids.get(token.group())
                target = self.cells.get(source) if source is not None else None
                if target is not None and target.element is not element:
                    targets.setdefault((target.row, target.column), None)
        return ReaderTableCellHeaders(kind, empty, tuple(targets) if raw is not None else None)


def _span(value: str | None, maximum: int, *, allow_zero: bool = False) -> int:
    # HTML parses the ASCII integer prefix, including -0, then clamps. Avoid
    # converting an arbitrarily long authored integer into a Python big integer.
    if value is None:
        return 1
    position = 0
    while position < len(value) and value[position] in "\t\n\f\r ":
        position += 1
    negative = position < len(value) and value[position] == "-"
    if position < len(value) and value[position] in "+-":
        position += 1
    if position == len(value) or not "0" <= value[position] <= "9":
        return 1
    number = 0
    while position < len(value) and "0" <= value[position] <= "9":
        number = min(maximum, number * 10 + ord(value[position]) - ord("0"))
        if number == maximum or (negative and number):
            break
        position += 1
    if negative and number:
        return 1
    return number if number or allow_zero else 1


class _TableOccupancy:
    """Disjoint column intervals holding the latest occupied row boundary.

    Zero is free; None lasts to the row-group end. Every interval has at most
    one live expiry entry. Source rectangles stay separate, including overlaps.
    Normative colspan <= 1000 bounds each update to <= 1002 integer boundaries.
    """

    def __init__(self) -> None:
        self.boundaries: SortedDict[int, int | None] = SortedDict({0: 0})
        self.expiries: SortedSet[tuple[int, int]] = SortedSet()
        self.free: SortedSet[int] = SortedSet([0])

    def clear(self) -> None:
        self.boundaries.clear()
        self.expiries.clear()
        self.free.clear()
        self._put(0, 0)

    def _remove(self, start: int) -> None:
        until = self.boundaries.pop(start)
        if until == 0:
            self.free.remove(start)
        elif until is not None:
            self.expiries.remove((until, start))

    def _put(self, start: int, until: int | None) -> None:
        if start in self.boundaries:
            self._remove(start)
        self.boundaries[start] = until
        if until == 0:
            self.free.add(start)
        elif until is not None:
            self.expiries.add((until, start))

    def _coalesce(self, start: int) -> None:
        if start not in self.boundaries:
            return
        index = self.boundaries.bisect_left(start)
        until = self.boundaries[start]
        if index > 0 and self.boundaries.peekitem(index - 1)[1] == until:
            self._remove(start)
            index -= 1
        if index + 1 < len(self.boundaries):
            following, value = self.boundaries.peekitem(index + 1)
            if value == until:
                self._remove(following)

    def expire(self, row: int) -> None:
        while self.expiries and self.expiries[0][0] <= row:
            _until, start = self.expiries[0]
            self._put(start, 0)
            self._coalesce(start)

    def next_free(self, column: int) -> int:
        _start, until = self.boundaries.peekitem(self.boundaries.bisect_right(column) - 1)
        return column if until == 0 else self.free[self.free.bisect_left(column)]

    def cover(self, start: int, end: int, until: int | None) -> None:
        for point in (start, end):
            if point not in self.boundaries:
                _previous, value = self.boundaries.peekitem(self.boundaries.bisect_right(point) - 1)
                self._put(point, value)
        affected = tuple(self.boundaries.irange(start, end))
        for point in affected[:-1]:
            previous = self.boundaries[point]
            self._put(point, None if previous is None or until is None else max(previous, until))
        for point in affected:
            self._coalesce(point)


def project_reader_table(table: etree._Element) -> ReaderTable:
    """Apply WHATWG forming-a-table with a source-sized occupancy projection.

    Only direct table rows and row-group children belong to this table. Nested
    tables have independent models. Overlapping cells retain their rectangles;
    a header ray must subsequently skip multiply covered slots.
    """
    if table.tag != "table":
        raise ValueError("Table geometry requires an HTML table element")
    cells: list[ReaderTableCell] = []
    row_groups: list[ReaderTableGroup] = []
    column_groups: list[ReaderTableGroup] = []
    row = height = width = 0
    occupancy = _TableOccupancy()
    downward: list[int] = []

    def end_group() -> None:
        nonlocal row
        for index in downward:
            cell = cells[index]
            cells[index] = replace(cell, row_span=height - cell.row)
        downward.clear()
        occupancy.clear()
        row = height

    def process_row(element: etree._Element, group: int | None) -> None:
        nonlocal row, height, width
        occupancy.expire(row)
        height = max(height, row + 1)
        column = 0
        for child in element:
            if child.tag not in {"td", "th"}:
                continue
            column = occupancy.next_free(column)
            column_span = _span(child.get("colspan"), 1000)
            row_span = _span(child.get("rowspan"), 65534, allow_zero=True)
            index = len(cells)
            cells.append(ReaderTableCell(child, row, column, max(1, row_span), column_span, group))
            if row_span != 1:
                occupancy.cover(column, column + column_span, row + row_span if row_span else None)
                if row_span == 0:
                    downward.append(index)
            height = max(height, row + max(1, row_span))
            column += column_span
            width = max(width, column)
        row += 1

    def process_group(element: etree._Element) -> None:
        start = height
        group = len(row_groups)
        for child in element:
            if child.tag == "tr":
                process_row(child, group)
        if height > start:
            row_groups.append(ReaderTableGroup(element, start, height))
        end_group()

    footers: list[etree._Element] = []
    rows_started = False
    for child in table:
        if not rows_started and child.tag == "colgroup":
            start = width
            columns = (column for column in child if column.tag == "col")
            first = next(columns, None)
            if first is None:
                width += _span(child.get("span"), 1000)
            else:
                width += _span(first.get("span"), 1000)
                for column in columns:
                    width += _span(column.get("span"), 1000)
            column_groups.append(ReaderTableGroup(child, start, width))
        elif child.tag == "tr":
            rows_started = True
            process_row(child, None)
        elif child.tag in {"thead", "tbody", "tfoot"}:
            rows_started = True
            end_group()
            if child.tag == "tfoot":
                footers.append(child)
            else:
                process_group(child)
    end_group()
    for footer in footers:
        process_group(footer)
    return ReaderTable(tuple(cells), height, width, tuple(row_groups), tuple(column_groups))
