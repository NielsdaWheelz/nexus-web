"""Pure proof for canonical reader-document positions."""

from nexus.services.canonicalize import generate_canonical_text_with_element_offsets


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
