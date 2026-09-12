"""Pure proof for canonical reader-document positions."""

import pytest

from nexus.services.canonicalize import (
    canonicalize_structure,
    generate_canonical_text_with_element_offsets,
)


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
