"""Pure proof for canonical reader-document positions."""

from uuid import UUID

import pytest

from nexus.services.canonicalize import (
    canonicalize_structure,
    generate_canonical_text_with_element_offsets,
    repair_historical_html_structure,
)
from nexus.services.epub_read import rewrite_epub_fragment_links
from nexus.services.web_article_structure import add_heading_anchors, build_web_article_index_blocks


def test_historical_text_node_boundaries_keep_persisted_epub_coordinates() -> None:
    html = (
        '<p><a id="bookmark13">\u00a0</a><a href="#footnote13">13</a>'
        '   \u00a0\u00a0\u00a0Ibid.. 540.</p><h2 id="after">Next</h2>'
    )
    expected_text = "13  Ibid.. 540.\nNext"

    repaired = repair_historical_html_structure(html, expected_text)

    assert repaired == (
        '<p><a id="bookmark13">\u00a0</a><a href="#footnote13">13</a>'
        '   <span>\u00a0\u00a0\u00a0Ibid.. 540.</span></p><h2 id="after">Next</h2>'
    )
    structure = canonicalize_structure(repaired)
    assert structure.text == expected_text
    assert [
        (element.tag, element.start_offset, element.end_offset) for element in structure.elements
    ] == [
        ("p", 0, 15),
        ("a", 0, 0),
        ("h2", 16, 20),
    ]
    assert structure.anchors == {"bookmark13": 1, "after": 2}
    delivered = rewrite_epub_fragment_links(
        repaired,
        href_path="chapter.xhtml",
        fragment_ids_by_path={"chapter.xhtml": UUID("018f0000-0000-7000-8000-000000000001")},
    )
    assert 'data-nexus-anchor-id="footnote13"' in delivered
    assert canonicalize_structure(delivered) == structure


def test_historical_structure_keeps_unicode_source_ranks_and_following_heading() -> None:
    html = (
        '<p id="body"><a>13</a> \u00a0q<span id="first">\u0315</span>'
        '<span id="second">\u0300</span></p><h2 id="after">e\u0301</h2>'
    )
    expected_text = "13  q\u0300\u0315\né"

    structure = canonicalize_structure(repair_historical_html_structure(html, expected_text))

    assert structure.text == expected_text
    assert {
        name: (structure.elements[index].start_offset, structure.elements[index].end_offset)
        for name, index in structure.anchors.items()
    } == {"body": (0, 7), "first": (5, 6), "second": (6, 7), "after": (8, 9)}


def test_historical_html_repair_refuses_unexplained_text_changes() -> None:
    with pytest.raises(ValueError, match="disagrees with persisted canonical text"):
        repair_historical_html_structure("<p>Alpha beta</p>", "Alpha  beta")


def test_historical_web_repair_survives_current_heading_and_index_consumers() -> None:
    html = (
        '<h2 id="nexus-web-heading-0-0-notes">Notes</h2>'
        '<p><a href="#footnote13">13</a> \u00a0Ibid.</p>'
        '<h2 id="nexus-web-heading-0-1-next">Next</h2>'
    )
    expected_text = "Notes\n13  Ibid.\nNext"

    repaired = repair_historical_html_structure(html, expected_text)

    assert add_heading_anchors(repaired, fragment_idx=0) == repaired
    assert repair_historical_html_structure(repaired, expected_text) == repaired
    blocks = build_web_article_index_blocks(
        html_sanitized=repaired, canonical_text=expected_text, fragment_idx=0
    )
    assert [(block.block_kind, block.start_offset, block.end_offset) for block in blocks] == [
        ("heading", 0, 6),
        ("paragraph", 6, 16),
        ("heading", 16, 20),
    ]


def test_requested_element_starts_survive_canonical_unicode_and_whitespace_normalization() -> None:
    """Anchor starts must index the exact canonical text rendered by every reader owner."""
    canonical_text, starts = generate_canonical_text_with_element_offsets(
        '<h1 id="opening">Café</h1>'
        "<p>Alpha   beta</p>"
        '<h2 name="second">Second</h2>'
        "<p>Omega</p>"
        '<p id="hidden" hidden>Not reader text</p>',
        {"opening", "second", "hidden", "missing"},
    )
    expected = "Café\nAlpha beta\nSecond\nOmega"

    assert canonical_text == expected
    assert starts == {
        "opening": expected.index("Café"),
        "second": expected.index("Second"),
    }, f"element starts do not index the canonical reader text: {starts!r}"


@pytest.mark.parametrize(
    ("html", "expected_text", "expected_ranges"),
    [
        pytest.param(
            '<p id="body">q<span id="first">\u0315</span><span id="second">\u0300</span></p>',
            "q\u0300\u0315",
            {"body": (0, 3), "first": (1, 2), "second": (2, 3)},
            id="reordered-source-origins",
        ),
        pytest.param(
            '<p id="body"> <span id="expanded">\u0344</span>'
            '<br><a id="gap"></a><br>X <a id="end"></a></p>',
            "\u0308\u0301\n\nX",
            {"body": (0, 5), "expanded": (0, 2), "gap": (4, 4), "end": (5, 5)},
            id="repeated-origins-whitespace-and-eof",
        ),
        pytest.param(
            '<p id="body"><span id="starter">e</span>'
            '<span id="accent">\u0301</span><a id="end"></a></p>',
            "\u00e9",
            {"body": (0, 1), "starter": (0, 1), "accent": (1, 1), "end": (1, 1)},
            id="composition-across-source-elements",
        ),
        pytest.param(
            '<p id="body"><span id="lead">\u1100</span>'
            '<span id="vowel">\u1161</span><span id="tail">\u11a8</span>'
            '<a id="end"></a></p>',
            "\uac01",
            {
                "body": (0, 1),
                "lead": (0, 1),
                "vowel": (1, 1),
                "tail": (1, 1),
                "end": (1, 1),
            },
            id="hangul-composition-across-starters",
        ),
        pytest.param(
            '<p id="body"><span id="composed">\u00e9</span>'
            '<span id="below">\u0316</span> <span id="later">e\u0301</span>'
            '<a id="end"></a></p>',
            "\u00e9\u0316 \u00e9",
            {
                "body": (0, 4),
                "composed": (0, 1),
                "below": (1, 2),
                "later": (3, 4),
                "end": (4, 4),
            },
            id="composition-keeps-intervening-mark-origin",
        ),
        pytest.param(
            '<p id="body">'
            + "x" * 4095
            + '<span id="starter">e</span><span id="accent">\u0301</span>'
            '<span id="after">Z</span><a id="end"></a></p>',
            "x" * 4095 + "\u00e9Z",
            {
                "body": (0, 4097),
                "starter": (4095, 4096),
                "accent": (4096, 4096),
                "after": (4096, 4097),
                "end": (4097, 4097),
            },
            id="batch-boundary-keeps-accent-and-global-origins",
        ),
        pytest.param(
            '<p id="body">'
            + "x" * 4095
            + '<span id="lead">\u1100</span><span id="vowel">\u1161</span>'
            '<span id="tail">\u11a8</span><span id="after">Z</span><a id="end"></a></p>',
            "x" * 4095 + "\uac01Z",
            {
                "body": (0, 4097),
                "lead": (4095, 4096),
                "vowel": (4096, 4096),
                "tail": (4096, 4096),
                "after": (4096, 4097),
                "end": (4097, 4097),
            },
            id="batch-boundary-keeps-hangul-starter-composition",
        ),
        pytest.param(
            '<p id="body">'
            + "x" * 4095
            + '<span id="first">\u09c7</span><span id="second">\u09be</span>'
            'Y<span id="after">Z</span><a id="end"></a></p>',
            "x" * 4095 + "\u09cbYZ",
            {
                "body": (0, 4098),
                "first": (4095, 4096),
                "second": (4096, 4096),
                "after": (4097, 4098),
                "end": (4098, 4098),
            },
            id="batch-boundary-keeps-bengali-starter-composition",
        ),
    ],
)
def test_source_boundaries_keep_exact_ranks_through_unicode_normalization(
    html: str, expected_text: str, expected_ranges: dict[str, tuple[int, int]]
) -> None:
    """Boundaries count surviving origins strictly before their raw source position."""
    text, starts = generate_canonical_text_with_element_offsets(html, set(expected_ranges))
    structure = canonicalize_structure(html)

    assert text == structure.text == expected_text
    assert starts == {name: start for name, (start, _end) in expected_ranges.items()}
    assert {
        name: (
            structure.elements[structure.anchors[name]].start_offset,
            structure.elements[structure.anchors[name]].end_offset,
        )
        for name in expected_ranges
    } == expected_ranges


def test_book_sized_epub_anchor_projection_remains_exact() -> None:
    """Book-sized navigation retains every independently modeled anchor start."""
    paragraph = ("Call me Ishmael. " * 250).strip()
    anchor_count = 160
    html = "".join(f'<p id="anchor-{index}">{paragraph}</p>' for index in range(anchor_count))
    expected_text = "\n".join(paragraph for _ in range(anchor_count))
    expected_starts = {
        f"anchor-{index}": index * (len(paragraph) + 1) for index in range(anchor_count)
    }

    canonical_text, starts = generate_canonical_text_with_element_offsets(
        html,
        set(expected_starts),
    )

    assert canonical_text == expected_text
    assert starts == expected_starts, (
        f"book-sized element starts diverged from the independent paragraph model: {starts!r}"
    )
