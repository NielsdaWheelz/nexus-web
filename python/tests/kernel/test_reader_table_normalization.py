"""Geometry sees the same effective row groups as direct DOM construction."""

from lxml import html

from nexus.services.canonicalize import generate_canonical_text
from nexus.services.reader_publication_render import (
    canonical_text_from_render_nodes,
    normalize_reader_tables,
    project_reader_render_nodes,
)
from nexus.services.reader_publication_tables import (
    ReaderTableHeaderProjection,
    project_reader_table,
)


def test_effective_table_rows_preserve_caption_tail_and_foreign_namespace() -> None:
    source = (
        '<table>lead<tr><th scope="rowgroup">group</th><td>first</td></tr>tail'
        "<caption>middle caption</caption><tr><td>last</td></tr>end</table>"
        "<svg><table><tr><td>foreign</td></tr></table>"
        "<foreignObject><table><tr><td>html island</td></tr></table></foreignObject></svg>"
    )
    root = html.fragment_fromstring(source, create_parent="div")
    expected = generate_canonical_text(source)
    tables = normalize_reader_tables(root)
    assert len(tables) == 2
    assert [child.tag for child in tables[0]] == ["tbody", "caption", "tbody"]
    assert tables[0][0][0].tail == "tail" and tables[0][2][0].tail == "end"
    model = project_reader_table(tables[0])
    assert [(cell.row, cell.column, cell.row_group) for cell in model.cells] == [
        (0, 0, 0),
        (0, 1, 0),
        (1, 0, 1),
    ]
    assert ReaderTableHeaderProjection(model, {}).for_cell(model.cells[0]).kind == "rowgroup"
    foreign = root[1][0]
    assert foreign.tag == "table" and foreign[0].tag == "tr"
    nodes = project_reader_render_nodes(root)
    assert canonical_text_from_render_nodes(nodes) == expected
    assert (
        len(
            [
                node
                for node in nodes
                if node.kind == "Element" and node.namespace == "html" and node.name == "tbody"
            ]
        )
        == 3
    )
    assert normalize_reader_tables(root) == tables
