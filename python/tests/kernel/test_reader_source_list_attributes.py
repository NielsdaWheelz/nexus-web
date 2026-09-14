"""Source sanitization preserves list meaning before bounded publication."""

from uuid import UUID

import pytest

from nexus.config import ReaderPublicationLimits
from nexus.services.canonicalize import generate_canonical_text
from nexus.services.epub_ingest import _epub_sanitize
from nexus.services.reader_publication_units import split_reader_publication_fragment
from nexus.services.sanitize_html import sanitize_html


@pytest.mark.parametrize("kind", ["web", "epub"])
def test_sanitized_lists_retain_authored_numbers_across_publication_cuts(kind: str) -> None:
    markup = (
        '<ol start="5junk" reversed style="display:none" class="custom">'
        "<li>"
        + "first " * 20
        + '</li><li value="-3junk">'
        + "second " * 20
        + "</li><li>"
        + "third " * 20
        + "</li></ol>"
    )
    cleaned = (
        sanitize_html(markup, "https://example.invalid/")
        if kind == "web"
        else _epub_sanitize(markup)
    )
    assert "style=" not in cleaned and "class=" not in cleaned
    canonical = generate_canonical_text(cleaned)
    units = list(
        split_reader_publication_fragment(
            fragment_id=UUID("00000000-0000-4000-8000-000000000033"),
            fragment_idx=0,
            fragment_document_start_cp=0,
            fragment_document_word_start=0,
            epub_target=None,
            document_embeds=(),
            html_sanitized=cleaned,
            canonical_text=canonical,
            assets_by_url={},
            limits=ReaderPublicationLimits(
                unit_bytes=3000,
                unit_codepoints=30,
                unit_dom_nodes=30,
                index_bytes=3000,
                descriptor_bytes=1000,
            ),
        )
    )
    assert len(units) > 3
    assert "".join(unit.canonical_text for unit in units) == canonical
    numbers = []
    for unit in units:
        for node in unit.render_nodes:
            if node.kind != "Element" or node.name != "li":
                continue
            attributes = {item.name: item.value for item in node.attributes}
            number = attributes.get("value")
            if not numbers or number != numbers[-1]:
                numbers.append(number)
    assert numbers == ["5", "-3", "-4"], "source sanitizer discarded authored list numbers"
