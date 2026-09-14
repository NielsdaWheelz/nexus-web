"""Actual source tables keep text, source geometry and forward caption identity."""

from uuid import UUID

from nexus.config import ReaderPublicationLimits
from nexus.schemas.reader_publication import (
    ReaderPublicationRenderElement,
    ReaderPublicationTableCellMetadata,
    ReaderPublicationTableMetadata,
    ReaderPublicationUnitBody,
)
from nexus.services.reader_publication_units import split_reader_publication_fragment

FRAGMENT = UUID("00000000-0000-4000-8000-000000000051")


def test_opening_only_cell_keeps_its_emitted_separator_in_its_first_unit() -> None:
    parts = list(
        split_reader_publication_fragment(
            fragment_id=FRAGMENT,
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized="<table><tr><td>first</td></tr><tr><td>second</td></tr></table>",
            canonical_text="first\nsecond",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=6000,
                unit_codepoints=7,
                unit_dom_nodes=80,
                index_bytes=3000,
                descriptor_bytes=1500,
            ),
        )
    )
    units = [part for part in parts if isinstance(part, ReaderPublicationUnitBody)]
    cell = next(
        part
        for part in parts
        if isinstance(part, ReaderPublicationTableCellMetadata) and part.row == 1
    )
    assert "".join(unit.canonical_text for unit in units) == "first\nsecond"
    first = next(index for index, unit in enumerate(units) if unit.canonical_text)
    unit = units[first]
    assert unit.canonical_text == "first\n"
    assert (unit.render_end_cp, unit.end_cp, cell.range.start_cp) == (5, 6, 6)
    assert cell.range.unit_key == f"units/{FRAGMENT}/0-6-0.json"
    assert any(
        cell.row == 1 and cell.continued_before
        for context in units[first + 1].table_contexts
        for cell in context.cells
    )


def test_oversized_table_keeps_every_cell_and_later_caption_in_bounded_units() -> None:
    rows = [f"row {index}: " + "x" * 70 for index in range(32)]
    canonical = "\n".join(rows) + "\nlate caption"
    markup = (
        "<table>"
        + "".join(
            f'<tr><td id="cell-{index}">{value}</td></tr>' for index, value in enumerate(rows)
        )
        + '<caption id="caption">late caption</caption></table>'
    )
    limits = ReaderPublicationLimits(
        unit_bytes=6000,
        unit_codepoints=160,
        unit_dom_nodes=80,
        index_bytes=3000,
        descriptor_bytes=1500,
    )
    parts = list(
        split_reader_publication_fragment(
            fragment_id=FRAGMENT,
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text=canonical,
            assets_by_url={},
            limits=limits,
        )
    )
    units = [part for part in parts if isinstance(part, ReaderPublicationUnitBody)]
    metadata = [part for part in parts if isinstance(part, ReaderPublicationTableMetadata)]
    cells = [part for part in parts if isinstance(part, ReaderPublicationTableCellMetadata)]
    assert len(units) > 10
    assert "".join(unit.canonical_text for unit in units) == canonical
    assert len(metadata) == 1 and metadata[0].row_count == 32 and metadata[0].column_count == 1
    assert [(cell.row, cell.column, cell.row_group) for cell in cells] == [
        (index, 0, 0) for index in range(32)
    ]
    keyed = {}
    extents = {}
    for unit in units:
        extent = (unit.start_cp, unit.end_cp)
        part = extents.get(extent, 0)
        extents[extent] = part + 1
        key = f"units/{FRAGMENT}/{unit.start_cp}-{unit.end_cp}-{part}.json"
        keyed[key] = unit
        assert len(unit.model_dump_json().encode()) <= limits.unit_bytes
        assert len(unit.render_nodes) + 2 <= limits.unit_dom_nodes
        assert len(unit.canonical_text) <= limits.unit_codepoints
    for cell, text in zip(cells, rows, strict=True):
        assert canonical[cell.range.start_cp : cell.range.end_cp] == text
        first = keyed[cell.range.unit_key]
        assert first.start_cp <= cell.range.start_cp <= first.end_cp
    caption = metadata[0].caption
    assert caption is not None and caption.start_cp == canonical.index("late caption")
    assert caption.unit_key != next(iter(keyed)), "late caption must not borrow the first cell unit"
    assert all(context.caption == caption for unit in units for context in unit.table_contexts)
    assert any(
        cell.continued_after
        for unit in units
        for context in unit.table_contexts
        for cell in context.cells
    )
    assert any(
        cell.continued_before
        for unit in units
        for context in unit.table_contexts
        for cell in context.cells
    )


def test_complete_source_with_huge_grid_uses_lossless_excerpts() -> None:
    markup = '<table><tr><td rowspan="65534" colspan="1000">one</td></tr></table>'
    parts = list(
        split_reader_publication_fragment(
            fragment_id=FRAGMENT,
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text="one",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=6000,
                unit_codepoints=160,
                unit_dom_nodes=80,
                index_bytes=3000,
                descriptor_bytes=1500,
            ),
        )
    )
    units = [part for part in parts if isinstance(part, ReaderPublicationUnitBody)]
    assert "".join(unit.canonical_text for unit in units) == "one"
    source = next(part for part in parts if isinstance(part, ReaderPublicationTableCellMetadata))
    assert (source.row_span, source.column_span) == (65534, 1000)
    for unit in units:
        for node in unit.render_nodes:
            if isinstance(node, ReaderPublicationRenderElement) and node.name == "td":
                attrs = {attr.name: attr.value for attr in node.attributes}
                assert "rowspan" not in attrs and "colspan" not in attrs
                assert attrs["aria-rowspan"] == "65534" and attrs["aria-colspan"] == "1000"


def test_nested_ordinary_grids_share_one_layout_budget() -> None:
    markup = (
        '<table><tr><td><table><tr><td rowspan="5" colspan="1000">one</td></tr></table>'
        '<table><tr><td rowspan="5" colspan="1000">two</td></tr></table></td></tr></table>'
    )
    parts = list(
        split_reader_publication_fragment(
            fragment_id=FRAGMENT,
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text="one\ntwo",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=12000,
                unit_codepoints=160,
                unit_dom_nodes=100,
                index_bytes=3000,
                descriptor_bytes=1500,
            ),
        )
    )
    units = [part for part in parts if isinstance(part, ReaderPublicationUnitBody)]
    assert "".join(unit.canonical_text for unit in units) == "one\ntwo"
    assert any(
        isinstance(part, ReaderPublicationTableMetadata) and part.table_ordinal == 0
        for part in parts
    )
    for unit in units:
        operative_slots = sum(
            int(attrs.get("rowspan", "1")) * int(attrs.get("colspan", "1"))
            for node in unit.render_nodes
            if isinstance(node, ReaderPublicationRenderElement) and node.name == "td"
            for attrs in [{attr.name: attr.value for attr in node.attributes}]
            if "data-nexus-table" not in attrs
        )
        assert operative_slots <= 8192, "nested ordinary tables share the unit's layout allowance"
    assert (
        sum(
            1
            for unit in units
            for node in unit.render_nodes
            if isinstance(node, ReaderPublicationRenderElement)
            and node.name == "td"
            and any(attr.name == "colspan" and attr.value == "1000" for attr in node.attributes)
        )
        == 2
    ), "both independently fitting inner tables retain operative source spans"


def test_empty_rows_cannot_erase_authored_column_layout_work() -> None:
    markup = "<table>" + '<colgroup span="1000"></colgroup>' * 10 + "<tbody></tbody></table>"
    parts = list(
        split_reader_publication_fragment(
            fragment_id=FRAGMENT,
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text="",
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=6000,
                unit_codepoints=160,
                unit_dom_nodes=80,
                index_bytes=3000,
                descriptor_bytes=1500,
            ),
        )
    )
    table = next(part for part in parts if isinstance(part, ReaderPublicationTableMetadata))
    assert (table.row_count, table.column_count) == (0, 10000)
    units = [part for part in parts if isinstance(part, ReaderPublicationUnitBody)]
    assert all(unit.canonical_text == "" for unit in units)
    assert all(not context.cells for unit in units for context in unit.table_contexts)
    columns = [
        node
        for unit in units
        for node in unit.render_nodes
        if isinstance(node, ReaderPublicationRenderElement) and node.name == "colgroup"
    ]
    assert len(columns) == 10
    assert all(
        any(attr.name == "data-nexus-table" and attr.value == "0" for attr in node.attributes)
        for node in columns
    )
    assert all(not any(attr.name == "span" for attr in node.attributes) for node in columns)


def test_first_table_atom_falls_back_when_only_final_json_exceeds_envelope() -> None:
    markup = '<table><tr><td colspan="2">' + "<span>x</span>" * 24 + "</td></tr></table>"
    parts = list(
        split_reader_publication_fragment(
            fragment_id=FRAGMENT,
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=markup,
            canonical_text="x" * 24,
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=3000,
                unit_codepoints=160,
                unit_dom_nodes=80,
                index_bytes=3000,
                descriptor_bytes=1500,
            ),
        )
    )
    units = [part for part in parts if isinstance(part, ReaderPublicationUnitBody)]
    assert "".join(unit.canonical_text for unit in units) == "x" * 24
    assert all(len(unit.model_dump_json().encode()) <= 3000 for unit in units)
    table = next(part for part in parts if isinstance(part, ReaderPublicationTableMetadata))
    assert (table.row_count, table.column_count) == (1, 2)
    assert sum(bool(unit.table_contexts) for unit in units) > 1
