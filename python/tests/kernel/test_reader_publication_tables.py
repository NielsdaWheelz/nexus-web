"""Independent HTML table-model examples; no browser-sized dense slot matrix."""

import hashlib
import json
import resource
from pathlib import Path
from time import perf_counter

import pytest
from lxml import html

from nexus.services.reader_publication_tables import (
    ReaderTableHeaderProjection,
    project_reader_table,
)


def test_table_geometry_preserves_spans_group_growth_and_deferred_footer() -> None:
    # WHATWG forming-a-table: rowspan=0 reaches the implied last row of its
    # group; tfoot follows the later tbody even when authored before it.
    source = html.fromstring(
        '<table><colgroup span=" +3ignored"></colgroup>'
        '<tfoot><tr><td id="foot">F</td></tr></tfoot>'
        '<tbody><tr><th id="grow" rowspan="-0">G</th>'
        '<td id="wide" colspan="2more">W</td></tr>'
        '<tr><td id="deep" rowspan="3">D</td></tr></tbody>'
        '<tbody><tr><td id="next">N</td></tr></tbody></table>'
    )
    model = project_reader_table(source)
    observed = {
        cell.element.get("id"): (
            cell.row,
            cell.column,
            cell.row_span,
            cell.column_span,
            cell.row_group,
        )
        for cell in model.cells
    }
    assert observed == {
        "grow": (0, 0, 4, 1, 0),
        "wide": (0, 1, 1, 2, 0),
        "deep": (1, 1, 3, 1, 0),
        "next": (4, 0, 1, 1, 1),
        "foot": (5, 0, 1, 1, 2),
    }
    assert (model.row_count, model.column_count) == (6, 3)
    assert [(group.start, group.end) for group in model.row_groups] == [(0, 4), (4, 5), (5, 6)]
    assert [(group.start, group.end) for group in model.column_groups] == [(0, 3)]


def test_table_geometry_keeps_model_error_overlap_and_ignores_nested_cells() -> None:
    source = html.fromstring(
        '<table><tr><td id="a">A</td><td id="b" rowspan="2">B</td></tr>'
        '<tr><td id="overlap" colspan="2">'
        '<table><tr><td id="nested">nested</td></tr></table></td>'
        '<td id="after">C</td></tr><tr><td id="reset">D</td></tr></table>'
    )
    model = project_reader_table(source)
    assert [(cell.element.get("id"), cell.row, cell.column) for cell in model.cells] == [
        ("a", 0, 0),
        ("b", 0, 1),
        ("overlap", 1, 0),
        ("after", 1, 2),
        ("reset", 2, 0),
    ]
    assert (model.row_count, model.column_count) == (3, 3)
    assert model.row_groups == ()


def test_table_occupied_prefix_expires_and_does_not_cover_disjoint_gaps() -> None:
    source = html.fromstring(
        '<table><tbody><tr><td id="a" colspan="2" rowspan="3">a</td>'
        '<td id="b" colspan="2">b</td></tr>'
        '<tr><td id="c" rowspan="5">c</td></tr>'
        '<tr><td id="d" colspan="3" rowspan="2">d</td></tr>'
        '<tr><td id="e">e</td><td id="f">f</td><td id="g">g</td></tr>'
        '<tr><td id="h" colspan="4">h</td><td id="i">i</td></tr></tbody></table>'
    )
    model = project_reader_table(source)
    assert [(cell.element.get("id"), cell.row, cell.column) for cell in model.cells] == [
        ("a", 0, 0),
        ("b", 0, 2),
        ("c", 1, 2),
        ("d", 2, 3),
        ("e", 3, 0),
        ("f", 3, 1),
        ("g", 3, 6),
        ("h", 4, 0),
        ("i", 4, 4),
    ]
    assert (model.row_count, model.column_count) == (6, 7)
    cycling = project_reader_table(
        html.fromstring(
            "<table><tbody>" + '<tr><td rowspan="3">x</td></tr>' * 40 + "</tbody></table>"
        )
    )
    assert [(cell.row, cell.column) for cell in cycling.cells] == [
        (row, row % 3) for row in range(40)
    ]


def test_table_short_overlap_cannot_erase_an_older_long_span() -> None:
    model = project_reader_table(
        html.fromstring(
            '<table><tbody><tr><td id="a">a</td><td id="b" rowspan="6">b</td></tr>'
            '<tr><td id="c" colspan="2" rowspan="2">c</td><td id="d">d</td></tr>'
            '<tr><td id="e">e</td></tr><tr><td id="f">f</td><td id="g">g</td></tr>'
            "</tbody></table>"
        )
    )
    assert [(cell.element.get("id"), cell.row, cell.column) for cell in model.cells] == [
        ("a", 0, 0),
        ("b", 0, 1),
        ("c", 1, 0),
        ("d", 1, 2),
        ("e", 2, 2),
        ("f", 3, 0),
        ("g", 3, 2),
    ]
    assert (model.row_count, model.column_count) == (6, 3)


def test_table_geometry_clamps_html_ascii_prefix_spans_without_materializing_slots() -> None:
    source = html.fromstring(
        '<table><tbody><tr><td id="large" colspan="999999999999999999999999"'
        ' rowspan="999999999999999999999999">x</td>'
        '<td id="default" colspan="\u00a02" rowspan="-2">y</td>'
        '<td id="prefix" colspan="1_000" rowspan="+2rest">z</td></tr></tbody>'
        '<tr><td id="later">last</td></tr></table>'
    )
    model = project_reader_table(source)
    assert [(cell.row, cell.column, cell.row_span, cell.column_span) for cell in model.cells] == [
        (0, 0, 65534, 1000),
        (0, 1000, 1, 1),
        (0, 1001, 2, 1),
        (65534, 0, 1, 1),
    ]
    assert (model.row_count, model.column_count) == (65535, 1002)


def test_table_geometry_does_not_expand_rowgroup_header_associations() -> None:
    source = html.fromstring(
        "<table><tbody>"
        + "".join(
            f'<tr><th scope="rowgroup">Header {index}</th></tr><tr><td>Value {index}</td></tr>'
            for index in range(1000)
        )
        + "</tbody></table>"
    )
    model = project_reader_table(source)
    assert len(model.cells) == 2000
    assert (model.row_count, model.column_count) == (2000, 1)
    assert len(model.row_groups) == 1
    assert model.cells[-1].row_group == 0


def test_table_header_roles_use_complete_source_intervals_and_explicit_scope() -> None:
    model = project_reader_table(
        html.fromstring(
            "<table><tr><th>first</th><th>second</th></tr>"
            "<tr><th>row</th><td>value</td></tr></table>"
        )
    )
    projection = ReaderTableHeaderProjection(model, {})
    assert [projection.for_cell(cell).kind for cell in model.cells] == [
        "column",
        "column",
        "row",
        "data",
    ]
    model = project_reader_table(
        html.fromstring(
            "<table><tr><td>data</td><th>neither</th></tr>"
            "<tr><td>data</td><td>data</td></tr>"
            '<tr><th scope="COL">column</th><th scope="row">row</th></tr>'
            '<tr><th scope="rowgroup">group</th><th scope="colgroup">group</th></tr>'
            '<tr><th scope=" row ">invalid keyword</th></tr></table>'
        )
    )
    projection = ReaderTableHeaderProjection(model, {})
    assert [projection.for_cell(cell).kind for cell in model.cells] == [
        "data",
        "none",
        "data",
        "data",
        "column",
        "row",
        "rowgroup",
        "colgroup",
        "column",
    ]


def test_table_explicit_headers_preserve_document_id_shadowing_and_data_cell_targets() -> None:
    source = html.fragment_fromstring(
        '<div id="shadow">first document id</div><table><tr>'
        '<th id="shadow">shadowed</th><td id="data">data can be an explicit header</td>'
        '<th id="header">header</th></tr><tr>'
        '<td id="principal" headers="shadow header data header principal missing">value</td>'
        '<td headers="">explicitly no headers</td><td>automatic</td></tr></table>',
        create_parent=True,
    )
    source_ids = {}
    for element in source.iter():
        if element.get("id"):
            source_ids.setdefault(element.get("id"), element)
    model = project_reader_table(source.find("table"))
    projection = ReaderTableHeaderProjection(model, source_ids)
    assert projection.for_cell(model.cells[3]).explicit_targets == ((0, 2), (0, 1))
    assert projection.for_cell(model.cells[4]).explicit_targets == ()
    assert projection.for_cell(model.cells[5]).explicit_targets is None


def test_table_empty_headers_use_child_elements_and_ascii_whitespace() -> None:
    model = project_reader_table(
        html.fromstring(
            "<table><tr><th> \t<!--not child text-->\n</th><th>&nbsp;</th>"
            "<th><span></span></th><th><!--comment-->tail</th></tr></table>"
        )
    )
    projection = ReaderTableHeaderProjection(model, {})
    assert [projection.for_cell(cell).empty for cell in model.cells] == [True, False, False, False]


@pytest.mark.parametrize(
    "profile", ["dense-2mib", "span-4096", "span-8192", "span-65536", "expire-2048", "expire-4096"]
)
def test_table_geometry_source_cost_characterization(profile: str, tmp_path: Path) -> None:
    """Measure the current source-sized candidate, not a release budget."""
    if profile == "dense-2mib":
        corpus = json.loads(
            (Path(__file__).parents[3] / "testdata/capacity/reader-tables.json").read_text()
        )
        shape = corpus["profiles"][-1]
        markup = corpus["prefix"] + corpus["row"] * shape["rows"] + corpus["suffix"]
        assert hashlib.sha256(markup.encode()).hexdigest() == shape["sha256"]
        expected_cells = 4 * (shape["rows"] + 1)
        expected_rows, expected_columns = shape["rows"] + 1, 4
    elif profile.startswith("span-"):
        rows = {"span-4096": 4096, "span-8192": 8192, "span-65536": 65536}[profile]
        markup = "<table><tbody>" + '<tr><td rowspan="0">x</td></tr>' * rows + "</tbody></table>"
        expected_cells = expected_rows = expected_columns = rows
    else:
        span = 2048 if profile == "expire-2048" else 4096
        markup = (
            "<table><tbody>"
            + f'<tr><td rowspan="{span}">x</td></tr>' * (span * 2)
            + "</tbody></table>"
        )
        expected_cells, expected_rows, expected_columns = span * 2, span * 3 - 1, span
    before_peak_kib = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    start = perf_counter()
    source = html.fromstring(markup)
    parsed = perf_counter()
    model = project_reader_table(source)
    finished = perf_counter()
    assert len(model.cells) == expected_cells
    assert (model.row_count, model.column_count) == (expected_rows, expected_columns)
    (tmp_path / f"{profile}.json").write_text(
        json.dumps(
            {
                "profile": profile,
                "source_bytes": len(markup.encode()),
                "source_sha256": hashlib.sha256(markup.encode()).hexdigest(),
                "cells": len(model.cells),
                "rows": model.row_count,
                "columns": model.column_count,
                "parse_seconds": parsed - start,
                "geometry_seconds": finished - parsed,
                "process_peak_before_kib": before_peak_kib,
                "process_peak_after_kib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
            },
            indent=2,
        )
        + "\n"
    )
