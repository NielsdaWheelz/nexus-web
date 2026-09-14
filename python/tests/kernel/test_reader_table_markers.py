"""Sparse table markers retain exact NFC and separator source-start semantics."""

import pytest
from lxml.etree import HTMLParser

from nexus.services.canonicalize import (
    CanonicalTextBuilder,
    generate_canonical_text_with_element_offsets,
)


def test_sparse_markers_preserve_source_positions_inside_normalization_clusters() -> None:
    from nexus.services.canonicalize import validate_canonical_text_with_element_offsets

    cases = [
        ('<p>a</p><p id="x">e<span id="y">́</span>b</p>', "a\néb", {"x": 2, "y": 3}),
        ('<p>a<span id="x">́</span><b id="y">̣</b></p>', "ạ́", {"x": 1, "y": 2}),
        ('<p>👩<span id="x">\u200d💻</span></p>', "👩\u200d💻", {"x": 1}),
        ('<p>ᄀ<span id="x">ᅡ</span><b id="y">ᆨ</b></p>', "각", {"x": 1, "y": 1}),
        ('<p>a</p>  <br>  <p id="x">b</p>', "a\n\nb", {"x": 3}),
        ('<p hidden id="x">omitted</p><p id="y">kept</p>', "kept", {"y": 0}),
        ('<p> a<span id="x"> </span><b id="y"> b </b></p>', "a  b", {"x": 1, "y": 2}),
    ]
    for markup, expected, offsets in cases:
        assert (
            validate_canonical_text_with_element_offsets(markup, None, expected=expected) == offsets
        ), markup
        assert (
            validate_canonical_text_with_element_offsets(markup, set(), expected=expected) == {}
        ), markup
        assert generate_canonical_text_with_element_offsets(markup, {"x", "y"}) == (
            expected,
            offsets,
        ), markup
        target = CanonicalTextBuilder({"x", "y"})
        parser = HTMLParser(target=target)
        parser.feed("<div>" + markup + "</div>")
        parser.close()
        projected = target.project_markers(
            set(target.raw_offsets.values()), expected=expected, chunk_codepoints=2
        )
        actual = {name: projected[raw] for name, raw in target.raw_offsets.items()}
        assert actual == offsets, markup
        # Endpoint projection shares the same retained-scalar rule at every
        # raw position, including blank-line collapse and the trimmed suffix.
        text, sources = target.build_with_source_starts()
        assert text == expected
        all_markers = target.project_markers(
            set(range(target.builder.length + 1)), expected=expected, chunk_codepoints=2
        )
        assert all_markers == {
            point: sum(source < point for source in sources)
            for point in range(target.builder.length + 1)
        }, markup


@pytest.mark.parametrize(
    ("markup", "wrong_text"),
    [
        ("<p>alpha</p>", "alph"),
        ("<p>alpha</p>", "alpha!"),
        ("<p>alpha</p>", "alphx"),
        ("<p>a</p><p>b</p>", "a\n\nb"),
        ("<p> \u00a0 </p>", "x"),
        ("", "x"),
    ],
)
def test_empty_marker_projection_still_validates_retained_text(
    markup: str, wrong_text: str
) -> None:
    target = CanonicalTextBuilder(set())
    parser = HTMLParser(target=target)
    parser.feed("<div>" + markup + "</div>")
    parser.close()
    with pytest.raises(ValueError, match="Canonical marker projection"):
        target.project_markers(set(), expected=wrong_text, chunk_codepoints=2)


@pytest.mark.parametrize(
    ("markup", "offsets"),
    [("", {}), (" \t\u00a0", {}), ("<p> \u00a0 </p>", {}), ("<p id='x'> </p>", {"x": 0})],
)
def test_retained_empty_canonical_text_preserves_whitespace_only_source(
    markup: str, offsets: dict[str, int]
) -> None:
    from nexus.services.canonicalize import validate_canonical_text_with_element_offsets

    assert generate_canonical_text_with_element_offsets(markup, None) == ("", offsets)
    assert validate_canonical_text_with_element_offsets(markup, None, expected="") == offsets
