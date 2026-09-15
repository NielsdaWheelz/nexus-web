"""Equivalence proof for canonical text against browser HTML5 tree construction.

`canonical_text` is immutable after `ready_for_reading` and every reader highlight
anchors to its offsets, so `canonicalize.py` (libxml2 through lxml) must agree with
the browser DOM walk in `apps/web/src/lib/highlights/domTextCursor.ts` for every
document the production sanitizers emit. Any divergence permanently splits the
corpus into two offset regimes.

The oracle is html5lib: the reference implementation of the HTML5 tree-construction
algorithm every browser implements, and the parser canonicalize itself used before
the lxml cutover. It owns the two stages the cutover replaced -- tree construction
and the document-order walk of the canonicalization rules in the `canonicalize`
module docstring. It deliberately reuses canonicalize's post-walk transform (NFC,
blank-line collapse, line trim, offset projection), so this proof isolates parse
and walk divergence. Literal kernel cases independently own normalization offsets.

Inputs are produced by the real sanitizers -- the only producers of canonicalize
input in production -- because both parse and re-serialize through lxml, and the
claim under proof is about that fixed point rather than about raw HTML.
"""

from __future__ import annotations

import random
import re
import unicodedata
import zipfile
from pathlib import Path
from xml.dom import Node
from xml.dom.minidom import Element

import html5lib
import pytest

from nexus.services.canonicalize import (
    BLOCK_ELEMENTS,
    SKIP_ELEMENTS,
    # The post-walk transform is shared with the oracle on purpose: the cutover
    # replaced only tree construction and the walk, so this isolates parser divergence.
    _canonical_text_with_offsets,
    generate_canonical_text,
    generate_canonical_text_with_element_offsets,
)

# The EPUB chapter sanitizer is module-private but is the sanitizer
# `build_epub_extraction_plan` applies to every chapter before canonicalization.
from nexus.services.epub_ingest import _epub_sanitize
from nexus.services.sanitize_html import sanitize_html
from nexus.services.web_article_structure import prepare_web_article_fragment

_BASE_URL = "https://example.invalid/canonical-equivalence"
_ANCHOR_ATTRIBUTE_RE = re.compile(r'(?:id|name)="([^"]+)"')
_WHITESPACE_RE = re.compile("[\\s\\u00a0]+")
_ABSENT_ANCHOR = "anchor-that-no-document-declares"


class _RawText:
    """Accumulate the pre-canonical raw text of the browser-equivalent walk."""

    def __init__(self) -> None:
        self.chunks: list[str] = []
        self.last_char = ""
        self.length = 0

    def append(self, text: str) -> None:
        if not text:
            return
        self.chunks.append(text)
        self.last_char = text[-1]
        self.length += len(text)

    def build(self) -> str:
        return "".join(self.chunks)


def _walk(
    element: Element,
    raw: _RawText,
    element_ids: set[str],
    raw_offsets: dict[str, int],
) -> None:
    """Apply the canonicalization rules to one HTML5-constructed element."""
    tag = element.tagName.lower()
    if element.hasAttribute("hidden") or element.getAttribute("aria-hidden").lower() == "true":
        return
    if tag in SKIP_ELEMENTS:
        return

    is_block = tag in BLOCK_ELEMENTS
    if is_block and raw.length and raw.last_char != "\n":
        raw.append("\n")

    for attribute in ("id", "name"):
        value = element.getAttribute(attribute)
        if value in element_ids:
            raw_offsets.setdefault(value, raw.length)

    if tag == "br":
        raw.append("\n")
        return

    for child in element.childNodes:
        if child.nodeType == Node.TEXT_NODE:
            raw.append(_WHITESPACE_RE.sub(" ", child.data or ""))
        elif child.nodeType == Node.ELEMENT_NODE:
            _walk(child, raw, element_ids, raw_offsets)

    if is_block and raw.length and raw.last_char != "\n":
        raw.append("\n")


def browser_canonical(html: str, element_ids: set[str]) -> tuple[str, dict[str, int]]:
    """Canonicalize HTML over the HTML5 tree a browser would build for it."""
    fragment = html5lib.parseFragment(
        f"<div>{html}</div>",
        treebuilder="dom",
        namespaceHTMLElements=False,
    )
    root = next(
        (child for child in fragment.childNodes if child.nodeType == Node.ELEMENT_NODE),
        None,
    )
    if root is None:
        return "", {}

    raw = _RawText()
    raw_offsets: dict[str, int] = {}
    _walk(root, raw, element_ids, raw_offsets)
    text, offsets = _canonical_text_with_offsets(raw.build(), raw_offsets.values())
    return text, {element_id: offsets[raw_offset] for element_id, raw_offset in raw_offsets.items()}


def _first_divergence(produced: str, expected: str) -> str:
    """Describe the first divergent character with enough surrounding context."""
    limit = min(len(produced), len(expected))
    index = next((i for i in range(limit) if produced[i] != expected[i]), limit)
    window = slice(max(0, index - 60), index + 60)
    return (
        f"at offset {index}: canonicalize {produced[window]!r} "
        f"vs browser parse {expected[window]!r}"
    )


def assert_browser_equivalent(html: str, element_ids: set[str], *, case: str) -> str:
    """Assert canonical text and element offsets match the browser-equivalent parse."""
    text, offsets = generate_canonical_text_with_element_offsets(html, element_ids)
    expected_text, expected_offsets = browser_canonical(html, element_ids)

    assert text == expected_text, (
        f"{case}: canonical text diverged from browser tree construction "
        f"{_first_divergence(text, expected_text)}"
    )
    assert offsets == expected_offsets, (
        f"{case}: element offsets diverged from browser tree construction: "
        f"{offsets!r} vs {expected_offsets!r}"
    )
    assert generate_canonical_text(html) == text, (
        f"{case}: the offset-free canonical entry point disagreed with the offset-bearing one"
    )
    return text


def _requested_anchors(html: str) -> set[str]:
    return set(_ANCHOR_ATTRIBUTE_RE.findall(html)) | {_ABSENT_ANCHOR}


def test_real_epub_chapters_canonicalize_exactly_like_a_browser_parse() -> None:
    """A whole real book must anchor identically in ingest and in the reader DOM."""
    fixture_path = Path(__file__).parents[1] / "fixtures/epub/moby-dick-epub3.epub"
    canonicalized_chapters = 0
    with zipfile.ZipFile(fixture_path) as archive:
        for entry in archive.namelist():
            if not entry.endswith((".xhtml", ".html")):
                continue
            html_sanitized = _epub_sanitize(archive.read(entry).decode("utf-8"))
            canonical_text = assert_browser_equivalent(
                html_sanitized,
                _requested_anchors(html_sanitized),
                case=f"moby-dick chapter {entry}",
            )
            if canonical_text.strip():
                canonicalized_chapters += 1

    assert canonicalized_chapters >= 10, (
        f"real EPUB fixture yielded too few readable chapters: {canonicalized_chapters}"
    )


def test_real_web_article_fragment_canonicalizes_exactly_like_a_browser_parse() -> None:
    """The persisted web-article canonical text must equal the reader's DOM walk."""
    capture = (
        Path(__file__).parents[1] / "fixtures/real_media/nasa-water-on-moon-capture.html"
    ).read_text(encoding="utf-8")
    prepared = prepare_web_article_fragment(
        html=capture,
        base_url="https://www.nasa.gov/news-release/water-on-the-moon",
        fragment_idx=0,
    )
    anchors = _requested_anchors(prepared.html_sanitized)

    canonical_text = assert_browser_equivalent(
        prepared.html_sanitized,
        anchors,
        case="nasa water-on-the-moon capture",
    )

    assert canonical_text == prepared.canonical_text, (
        "the persisted fragment canonical text is not the text this proof compared"
    )
    assert "There's Water on the Moon?" in canonical_text, (
        f"web article capture lost its known opening heading: {canonical_text[:120]!r}"
    )


_PRESERVED_CONSTRUCTS = (
    pytest.param(
        '<p>Before</p><svg viewBox="0 0 8 8"><title id="svg-title">Chart of tides</title>'
        "<desc>Long description</desc><g><text>Label</text></g></svg><p>After</p>",
        id="inline-svg-title-desc",
    ),
    pytest.param(
        "<p>Before</p><svg><foreignObject><div>Escaped into HTML</div></foreignObject></svg>"
        "<p>After</p>",
        id="inline-svg-foreign-object",
    ),
    pytest.param(
        '<p>Before</p><template><p id="templated">Never rendered</p></template><p>After</p>',
        id="template",
    ),
    pytest.param(
        "<p>Before</p><noscript><p>Scriptless fallback</p></noscript><p>After</p>",
        id="noscript",
    ),
    pytest.param(
        '<table><tr><td id="outer-cell">Outer<table><tr><td id="inner-cell">Inner</td></tr>'
        "</table>Trailing</td></tr></table>",
        id="nested-table",
    ),
    pytest.param(
        '<div>lead <span>inline</span><p id="block">block</p> tail <em>emphasis</em>'
        "<br>after break</div>",
        id="mixed-block-and-inline-siblings",
    ),
    pytest.param(
        '<section><h2 id="heading">Cafe\u0301 heading</h2><p>alpha&nbsp;&nbsp;beta &#8212; '
        'gamma</p><p hidden>hidden</p><p aria-hidden="true">aria hidden</p></section>',
        id="decomposed-unicode-entities-and-hidden-nodes",
    ),
    pytest.param(
        "<blockquote><pre>line one\n\nline three</pre></blockquote><ul><li>one<li>two</ul>",
        id="preformatted-and-implied-list-close",
    ),
)


@pytest.mark.parametrize("source", _PRESERVED_CONSTRUCTS)
def test_sanitized_constructs_canonicalize_exactly_like_a_browser_parse(source: str) -> None:
    """Constructs the sanitizers keep must canonicalize the way the reader renders them."""
    epub_sanitized = _epub_sanitize(source)
    web_sanitized = sanitize_html(source, _BASE_URL, preserve_anchor_targets=True)

    assert_browser_equivalent(
        epub_sanitized,
        _requested_anchors(epub_sanitized),
        case="epub sanitizer output",
    )
    assert_browser_equivalent(
        web_sanitized,
        _requested_anchors(web_sanitized),
        case="web article sanitizer output",
    )


_RANDOM_TEXTS = (
    "Alpha",
    "beta  gamma",
    "   ",
    "\n\t",
    "Cafe\u0301",
    "Caf\u00e9",
    "漢字とかな",
    "x&amp;y",
    "ligature ﬁnal",
    "",
)
_RANDOM_BLOCKS = (
    "div",
    "section",
    "article",
    "aside",
    "blockquote",
    "figure",
    "figcaption",
    "header",
    "footer",
    "nav",
    "main",
    "dl",
)
_RANDOM_INLINES = ("span", "em", "strong", "a", "code", "sup", "sub", "b", "i")
_RANDOM_ATTRIBUTES = (
    "",
    " hidden",
    ' aria-hidden="true"',
    ' aria-hidden="false"',
    ' id="{anchor}"',
    ' name="{anchor}"',
    ' class="ignored"',
)


def _random_inline(rng: random.Random, depth: int) -> str:
    if depth >= 2 or rng.random() < 0.5:
        return rng.choice(_RANDOM_TEXTS)
    tag = rng.choice(_RANDOM_INLINES)
    attributes = rng.choice(_RANDOM_ATTRIBUTES).format(anchor=f"anchor-{rng.randint(0, 24)}")
    if rng.random() < 0.15:
        return f"<br{attributes}>"
    return f"<{tag}{attributes}>{_random_inline(rng, depth + 1)}</{tag}>"


def _random_document(rng: random.Random, depth: int = 0) -> str:
    """Generate reader-shaped markup: paragraphs hold inline runs, tables stay well formed.

    The grammar excludes exactly the shapes the two divergence catalogues below
    already own -- stray table cells, HTML blocks inside inline SVG, paragraphs
    nested by unwrapping, and text carrying a bare `<`. Everything else a
    sanitizer can emit is fair game.
    """
    parts: list[str] = []
    for _ in range(rng.randint(1, 4)):
        roll = rng.random()
        anchor = f"anchor-{rng.randint(0, 24)}"
        attributes = rng.choice(_RANDOM_ATTRIBUTES).format(anchor=anchor)
        if roll < 0.3 or depth >= 3:
            parts.append(_random_inline(rng, depth))
        elif roll < 0.45:
            tag = rng.choice(("p", "h2", "h3", "pre", "li", "dt", "dd"))
            parts.append(f"<{tag}{attributes}>{_random_inline(rng, depth)}</{tag}>")
        elif roll < 0.55:
            rows = "".join(
                "<tr>"
                + "".join(f"<td>{_random_inline(rng, depth + 1)}</td>" for _ in range(2))
                + "</tr>"
                for _ in range(rng.randint(1, 2))
            )
            parts.append(f"<table{attributes}>{rows}</table>")
        elif roll < 0.65:
            svg_children = "".join(
                f"<{tag}>{rng.choice(_RANDOM_TEXTS)}</{tag}>"
                for tag in rng.sample(("title", "desc", "text", "g"), k=2)
            )
            parts.append(f"<svg{attributes}>{svg_children}</svg>")
        elif roll < 0.72:
            tag = rng.choice(("script", "style", "noscript", "template"))
            parts.append(f"<{tag}{attributes}>{rng.choice(_RANDOM_TEXTS)}</{tag}>")
        else:
            tag = rng.choice(_RANDOM_BLOCKS)
            parts.append(f"<{tag}{attributes}>{_random_document(rng, depth + 1)}</{tag}>")
    return "".join(parts)


def test_randomized_reader_documents_canonicalize_exactly_like_a_browser_parse() -> None:
    """Nesting, whitespace, Unicode, and skipped subtrees combine without splitting offsets."""
    rng = random.Random(20260808)
    for iteration in range(200):
        source = _random_document(rng)
        epub_sanitized = _epub_sanitize(source)
        web_sanitized = prepare_web_article_fragment(
            html=source,
            base_url=_BASE_URL,
            fragment_idx=0,
        ).html_sanitized

        assert_browser_equivalent(
            epub_sanitized,
            _requested_anchors(epub_sanitized),
            case=f"random document {iteration} through the epub sanitizer: {source!r}",
        )
        assert_browser_equivalent(
            web_sanitized,
            _requested_anchors(web_sanitized),
            case=f"random document {iteration} through the web sanitizer: {source!r}",
        )


_TREE_CONSTRUCTION_SHAPES = (
    pytest.param(
        'Alpha<td id="cell">Beta</td>Gamma',
        "AlphaBetaGamma",
        id="table-cell-outside-a-table",
    ),
    pytest.param(
        '<svg><section id="inside">Alpha<hr>Beta</section></svg>Gamma',
        '<svg><section id="inside">Alpha</section></svg><hr>BetaGamma',
        id="html-breakout-element-inside-inline-svg",
    ),
    pytest.param(
        "<p>Alpha<noscript><p>Beta</p><strong>Gamma</strong></noscript></p>Delta",
        "<p>Alpha</p><p>Beta</p><strong>Gamma</strong>Delta",
        id="paragraph-nested-by-sanitizer-unwrapping",
    ),
)


@pytest.mark.parametrize(("source", "expected_sanitized"), _TREE_CONSTRUCTION_SHAPES)
def test_sanitizers_normalize_shapes_whose_tree_construction_rules_differ(
    source: str,
    expected_sanitized: str,
) -> None:
    """Prove the sanitizer emits only shapes both parsers read identically.

    A stray table cell, an HTML breakout element inside inline SVG, and a paragraph
    nested in a paragraph are each handled differently by HTML5 tree construction
    than by libxml2: HTML5 drops the stray cell, pops the SVG at the breakout
    element, and closes the open paragraph. Every one of those differences moves a
    block newline, so storing such a shape would anchor every later highlight in
    the fragment at the wrong offset.

    Canonicalization uses a streaming libxml2 parse for its memory envelope, so
    instead of reconciling the parsers the sanitizers normalize these shapes to the
    form HTML5 produces. The expectations below are exactly that form, and the
    equivalence assertion proves the normalized output still walks identically.
    """
    sanitized = _epub_sanitize(source)
    assert sanitized == expected_sanitized, (
        f"the sanitizer stopped normalizing this shape: {sanitized!r}"
    )
    assert_browser_equivalent(
        sanitized,
        _requested_anchors(sanitized),
        case=f"tree-construction shape {source!r}",
    )


def test_web_article_leading_text_is_stored_escaped_and_keeps_canonical_offsets() -> None:
    """Article text before the first element is character data, not markup.

    `web_article_structure._inner_html` serializes child elements through `tostring`
    but concatenates the fragment's leading text directly, so that text must be
    escaped the same way. Without it, escaped article prose becomes live markup in
    the stored `html_sanitized` -- turning `&lt;td&gt;` into a real block element
    that inserts newlines and anchors every later highlight in the fragment one
    newline off, besides re-injecting markup the sanitizer had already neutralized.
    """
    prepared = prepare_web_article_fragment(
        html="<dl>Alpha &lt;td&gt;Beta&lt;/td&gt; Gamma</dl><p>Delta</p>",
        base_url=_BASE_URL,
        fragment_idx=0,
    )

    assert prepared.html_sanitized == "Alpha &lt;td&gt;Beta&lt;/td&gt; Gamma<p>Delta</p>", (
        f"leading article text is stored as markup again: {prepared.html_sanitized!r}"
    )
    assert prepared.canonical_text == "Alpha <td>Beta</td> Gamma\nDelta", (
        f"escaped prose no longer reads as one text run: {prepared.canonical_text!r}"
    )
    assert_browser_equivalent(
        prepared.html_sanitized,
        set(),
        case="web article leading text",
    )


def test_decomposed_unicode_keeps_anchor_offsets_on_both_parses() -> None:
    """NFC composition must not shift an anchor that follows composed characters."""
    source = '<p id="opening">Cafe\u0301 au lait</p><p id="second">Beta</p>'
    sanitized = _epub_sanitize(source)
    assert not unicodedata.is_normalized("NFC", sanitized), (
        "fixture no longer carries decomposed characters through the sanitizer"
    )

    canonical_text = assert_browser_equivalent(
        sanitized,
        {"opening", "second"},
        case="decomposed unicode anchors",
    )
    assert canonical_text == "Caf\u00e9 au lait\nBeta", (
        f"canonical text did not compose to NFC: {canonical_text!r}"
    )
