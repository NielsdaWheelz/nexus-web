"""Freeze actual source geometry for the independent native association oracle."""

import hashlib
import json
import os
from pathlib import Path

from lxml import html

from nexus.services.canonicalize import generate_canonical_text
from nexus.services.epub_ingest import _epub_sanitize
from nexus.services.reader_publication_render import normalize_reader_tables
from nexus.services.reader_publication_tables import (
    ReaderTableHeaderProjection,
    project_reader_table,
)


def test_native_header_corpus_uses_actual_source_geometry() -> None:
    source_path = Path(__file__).parents[3] / "testdata/offline-reading/table-headers.json"
    source = source_path.read_bytes()
    corpus = json.loads(source)
    cases = []
    for case in corpus["cases"]:
        root = html.fragment_fromstring(case["html"], create_parent=True)
        tables = normalize_reader_tables(root)
        ids = {}
        for element in root.iter():
            if element.get("id"):
                ids.setdefault(element.get("id"), element)
        table = project_reader_table(tables[0])
        headers = ReaderTableHeaderProjection(table, ids)
        cells = []
        source_order = {element: ordinal for ordinal, element in enumerate(root.iter())}
        for cell in sorted(table.cells, key=lambda cell: source_order[cell.element]):
            projected = headers.for_cell(cell)
            cells.append(
                {
                    "id": cell.element.get("id"),
                    "row": cell.row,
                    "column": cell.column,
                    "row_span": cell.row_span,
                    "column_span": cell.column_span,
                    "row_group": cell.row_group,
                    "header_kind": projected.kind,
                    "empty": projected.empty,
                    "explicit_targets": projected.explicit_targets,
                }
            )
        cases.append(
            {
                "id": case["id"],
                "principal_id": case["principal_id"],
                "expected_header_ids": case["expected_header_ids"],
                "cells": cells,
                "column_groups": [(group.start, group.end) for group in table.column_groups],
            }
        )
    # Independent coordinates of the overlap and different-group examples.
    overlap = next(case for case in cases if case["id"] == "overlap-slot-is-skipped")
    assert [
        (cell["id"], cell["row"], cell["column"], cell["row_span"], cell["column_span"])
        for cell in overlap["cells"]
        if cell["id"] is not None
    ] == [("over", 0, 1, 2, 1), ("wide", 1, 0, 1, 2), ("p", 2, 1, 1, 1)]
    different = next(
        case for case in cases if case["id"] == "different-group-between-nearest-and-barrier"
    )
    assert next(
        (cell["row"], cell["column"]) for cell in different["cells"] if cell["id"] == "p"
    ) == (4, 2)
    encoded = (
        json.dumps(
            {
                "version": 1,
                "source_sha256": hashlib.sha256(source).hexdigest(),
                "cases": cases,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    ).encode()
    directory = Path(os.environ["NEXUS_TEST_RESULTS_DIR"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "table-header-geometry.json").write_bytes(encoded)
    (directory / "table-header-geometry-provenance.json").write_text(
        json.dumps(
            {
                "run_id": os.environ["NEXUS_TEST_RUN_ID"],
                "scope": "actual effective-tree scalar geometry for independently expected native headers; no capacity claim",
                "input_sha256": hashlib.sha256(source).hexdigest(),
                "output_sha256": hashlib.sha256(encoded).hexdigest(),
            },
            indent=2,
        )
        + "\n"
    )


def test_overlapping_header_workload_is_actual_bounded_source_html(tmp_path: Path) -> None:
    observations = []
    for count in (1000, 2000, 8000):
        rows = []
        for position in range(count):
            column = 1000 - position % 1000
            remaining = min(count - position, column)
            principal = '<td id="p" rowspan="0">p</td>' if position == 0 else ""
            rows.append(
                f'<tr><td colspan="{column}"></td>'
                f'<th scope="row" colspan="1000" rowspan="{remaining}">h</th>'
                f"{principal}</tr>"
            )
        source = "<table><tbody>" + "".join(rows) + "</tbody></table>"
        sanitized = _epub_sanitize(source)
        root = html.fragment_fromstring(sanitized, create_parent=True)
        table = project_reader_table(normalize_reader_tables(root)[0])
        headers = ReaderTableHeaderProjection(table, {"p": root.get_element_by_id("p")})
        principal = next(cell for cell in table.cells if cell.element.get("id") == "p")
        assert (principal.row, principal.column, principal.row_span, principal.column_span) == (
            0,
            2000,
            count,
            1,
        )
        candidates = [cell for cell in table.cells if cell.element.tag == "th"]
        assert len(candidates) == count
        padding = [
            cell for cell in table.cells if cell.element.tag == "td" and cell is not principal
        ]
        assert len(padding) == count
        for position, cell in enumerate(padding):
            assert (cell.row, cell.column, cell.row_span, cell.column_span) == (
                position,
                0,
                1,
                1000 - position % 1000,
            )
            projected = headers.for_cell(cell)
            assert projected.kind == "data" and projected.empty
        for position, cell in enumerate(candidates):
            assert (cell.row, cell.column, cell.row_span, cell.column_span) == (
                position,
                1000 - position % 1000,
                min(count - position, 1000 - position % 1000),
                1000,
            )
            projected = headers.for_cell(cell)
            assert projected.kind == "row" and not projected.empty
        canonical = generate_canonical_text(sanitized)
        reader = {
            "readerContractVersion": 1,
            "mediaId": "00000000-0000-4000-8000-000000000001",
            "mediaKind": "Epub",
            "title": "Header workload",
            "navigation": [{"sectionId": "table", "label": "Table"}],
            "sections": [
                {
                    "sectionId": "table",
                    "fragmentId": "table",
                    "fragmentIdx": 0,
                    "hrefPath": "EPUB/table.xhtml",
                    "anchorId": None,
                    "startOffset": 0,
                    "endOffset": len(canonical),
                    "ordinal": 0,
                    "htmlSanitized": sanitized,
                    "canonicalText": canonical,
                    "assetPaths": [],
                }
            ],
        }
        reader_bytes = json.dumps(reader, ensure_ascii=False, separators=(",", ":")).encode()
        assert len(source.encode()) < 16 * 1024 * 1024
        assert len(reader_bytes) < 64 * 1024 * 1024
        observations.append(
            {
                "rows": count,
                "cells": len(table.cells),
                "source_bytes": len(source.encode()),
                "sanitized_bytes": len(sanitized.encode()),
                "canonical_cp": len(canonical),
                "reader_json_bytes": len(reader_bytes),
                "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
                "reader_sha256": hashlib.sha256(reader_bytes).hexdigest(),
            }
        )
    (tmp_path / "overlapping-header-source.json").write_text(
        json.dumps(observations, indent=2) + "\n"
    )
