"""Authored safe web header roles survive capture and publication."""

from uuid import UUID

from lxml import html

from nexus.services.sanitize_html import sanitize_html


def test_web_capture_preserves_authored_table_header_scope() -> None:
    for scope, expected in (
        ("row", "row"),
        ("COL", "column"),
        ("rowgroup", "rowgroup"),
        ("colgroup", "colgroup"),
    ):
        source = (
            f'<table><tbody><tr><td>before</td><th scope="{scope}" onclick="alert(1)" style="color:red">header</th><td>after</td></tr>'
            "<tr><td>one</td><td>two</td><td>three</td></tr></tbody></table>"
        )
        sanitized = sanitize_html(source, "https://example.invalid/article")
        source_header = html.fromstring(sanitized).xpath(".//th")[0]
        assert source_header.get("scope") == scope, (
            "web source sanitizer discarded authored table scope"
        )
        # BASE reaches the actual sanitizer assertion before new publication
        # types are needed. The candidate additionally proves its display path.
        from nexus.config import ReaderPublicationLimits
        from nexus.services.canonicalize import generate_canonical_text
        from nexus.services.reader_publication_tables import (
            ReaderTableHeaderProjection,
            project_reader_table,
        )
        from nexus.services.reader_publication_units import split_reader_publication_fragment

        table = project_reader_table(html.fromstring(sanitized))
        header = table.cells[1]
        assert ReaderTableHeaderProjection(table, {}).for_cell(header).kind == expected, (
            "web source sanitizer discarded authored table scope"
        )
        assert header.element.get("onclick") is None and header.element.get("style") is None
        canonical = generate_canonical_text(sanitized)
        units = list(
            split_reader_publication_fragment(
                fragment_id=UUID("00000000-0000-4000-8000-000000000044"),
                fragment_idx=0,
                fragment_document_start_cp=0,
                fragment_document_word_start=0,
                epub_target=None,
                document_embeds=(),
                html_sanitized=sanitized,
                canonical_text=canonical,
                assets_by_url={},
                limits=ReaderPublicationLimits(
                    unit_bytes=8192,
                    unit_codepoints=1024,
                    unit_dom_nodes=100,
                    index_bytes=8192,
                    descriptor_bytes=1024,
                ),
            )
        )
        headers = [
            node
            for unit in units
            for node in unit.render_nodes
            if node.kind == "Element" and node.name == "th"
        ]
        assert len(headers) == 1
        attributes = {attribute.name: attribute.value for attribute in headers[0].attributes}
        assert attributes.get("scope") == scope
        assert "onclick" not in attributes and "style" not in attributes
        assert "".join(unit.canonical_text for unit in units) == canonical
