"""Body-anchor projection preserves the publisher's first browser target."""

import pytest

from nexus.services.canonicalize import canonicalize_structure, repair_epub_body_anchor
from nexus.services.epub_ingest import _materialize_epub_body_anchor
from nexus.services.html_tree import inner_html, parse_html_document


@pytest.mark.parametrize(
    ("tail", "text", "targets"),
    [
        ("", "", {"chapter": ("span", 0, 0)}),
        (
            '<p id="paragraph">Cafe\u0301.</p><h2 name="next">Next</h2>',
            "Café.\nNext",
            {"chapter": ("span", 0, 0), "paragraph": ("p", 0, 5), "next": ("h2", 6, 10)},
        ),
    ],
)
def test_historical_body_marker_keeps_identity_text_and_following_coordinates(
    tail: str, text: str, targets: dict[str, tuple[str, int, int]]
) -> None:
    html = '<span id="chapter"></span>\n<div id="chapter"></div>\n' + tail

    repaired = repair_epub_body_anchor(html, text, "chapter")

    assert repaired == '<span id="chapter"></span>\n<div></div>\n' + tail
    structure = canonicalize_structure(repaired)
    assert structure.text == text
    assert {
        name: (
            structure.elements[index].tag,
            structure.elements[index].start_offset,
            structure.elements[index].end_offset,
        )
        for name, index in structure.anchors.items()
    } == targets


@pytest.mark.parametrize(
    "html",
    [
        '<div id="chapter"></div><span id="chapter"></span>',
        'Before<span id="chapter"></span><div id="chapter"></div>',
        '<span id="chapter" hidden></span><div id="chapter"></div>',
        '<span id="chapter">Text</span><div id="chapter"></div>',
        '<span id="chapter"></span><div id="chapter">Text</div>',
        '<span id="chapter"></span><div id="chapter"><span></span></div>',
        '<span id="chapter"></span><div id="chapter" name="other"></div>',
        '<span id="chapter"></span><span id="chapter"></span>',
        '<span id="chapter"></span>',
        '<span id="chapter"></span><div id="chapter"></div><a name="chapter"></a>',
    ],
)
def test_historical_body_repair_refuses_other_duplicate_shapes(html: str) -> None:
    with pytest.raises(ValueError, match="EPUB body anchor repair"):
        repair_epub_body_anchor(html, canonicalize_structure(html).text, "chapter")


def test_historical_body_repair_refuses_wrong_persisted_text() -> None:
    with pytest.raises(ValueError, match="persisted text"):
        repair_epub_body_anchor(
            '<span id="chapter"></span><div id="chapter"></div><p>Text</p>',
            "Different text",
            "chapter",
        )


def test_historical_body_repair_leaves_unrelated_anchor_ambiguity_unresolved() -> None:
    html = (
        '<span id="chapter"></span><div id="chapter"></div>'
        '<p id="other">First</p><p id="other">Second</p>'
    )

    structure = canonicalize_structure(repair_epub_body_anchor(html, "First\nSecond", "chapter"))

    assert structure.anchors == {"chapter": 0}


def test_new_epub_materialization_keeps_body_identity_and_unrelated_duplicates() -> None:
    document = parse_html_document(
        '<body id="chapter">\n<div id="chapter"></div>'
        '<section><p id="chapter">Text</p></section>'
        '<p id="other">First</p><p id="other">Second</p></body>'
    )
    body = document.body
    assert body is not None

    _materialize_epub_body_anchor(body)

    html = inner_html(body)
    assert html == (
        '<span id="chapter"></span>\n<div></div>'
        '<section><p>Text</p></section><p id="other">First</p><p id="other">Second</p>'
    )
    structure = canonicalize_structure(html)
    assert structure.text == "Text\nFirst\nSecond"
    assert structure.anchors == {"chapter": 0}
