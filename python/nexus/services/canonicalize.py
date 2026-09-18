"""Canonical text generation from sanitized HTML.

Canonicalization runs on a streaming libxml2 (lxml) HTML fragment parse, fed the
already-sanitized HTML. Both producers of that input (`sanitize_html` and the
EPUB sanitizer) themselves parse and re-serialize through lxml, so canonicalize
receives an lxml fixed point and agrees with the frontend DOM walk for every
construct those sanitizers normalize. Divergence from browser tree construction
is possible only for constructs preserved verbatim by the sanitizers (notably
inline SVG); that equivalence is not currently proven by a test.

Canonicalization Rules:
1. Walk text nodes in document order
2. Normalize:
   - Unicode NFC normalization
   - All whitespace → space
   - Collapse consecutive spaces
3. Block boundaries insert newline:
   - p, li, ul, ol, h1..h6, blockquote, pre, div, section, article,
     header, footer, nav, aside
4. <br> inserts newline
5. Trim lines; collapse multiple blank lines
6. Exclude:
   - script, style elements
   - Nodes with hidden or aria-hidden="true" attributes

After ready_for_reading, canonical_text is immutable.
"""

import re
import unicodedata
from array import array
from bisect import bisect_right
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass

import regex
from lxml.etree import HTMLParser

from nexus.schemas.presence import Presence, Present, absent, present

HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})
STRUCTURAL_TAGS = frozenset({"section", "article"})
_NFC_BATCHES = regex.compile(r"(?:\X){1,4096}")


@dataclass(frozen=True)
class CanonicalElement:
    """A source element retained for structure or exact named navigation."""

    tag: str
    start_offset: int
    end_offset: int
    parent_container: Presence[int]
    parent_element: Presence[int]
    labelled_by: tuple[str, ...]
    numbering_allowed: bool


@dataclass(frozen=True)
class CanonicalStructure:
    text: str
    elements: tuple[CanonicalElement, ...]
    anchors: dict[str, int]


@dataclass
class _RawElement:
    tag: str
    start_offset: int
    end_offset: int
    parent_container: Presence[int]
    parent_element: Presence[int]
    labelled_by: tuple[str, ...]
    numbering_allowed: bool


# Block-level elements that introduce line breaks
BLOCK_ELEMENTS = frozenset(
    {
        "p",
        "li",
        "ul",
        "ol",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "pre",
        "div",
        "section",
        "article",
        "header",
        "footer",
        "nav",
        "aside",
        "figure",
        "figcaption",
        "table",
        "tr",
        "td",
        "th",
    }
)

# Elements to skip entirely (including their content)
SKIP_ELEMENTS = frozenset({"script", "style", "noscript", "template"})

# Whitespace regex (all Unicode whitespace including nbsp)
WHITESPACE_RE = re.compile(r"[\s\u00a0]+")


class _RawTextBuilder:
    """Build the pre-canonical text without one Python object per character."""

    __slots__ = ("_chunks", "last_char", "length")

    def __init__(self) -> None:
        self._chunks: list[str] = []
        self.last_char = ""
        self.length = 0

    def append(self, text: str) -> None:
        if not text:
            return
        self._chunks.append(text)
        self.last_char = text[-1]
        self.length += len(text)

    def build(self) -> str:
        return "".join(self._chunks)


class _CanonicalTextTarget:
    """Stream sanitized HTML into canonical raw text without retaining a DOM."""

    def __init__(self, *, capture_structure: bool = False) -> None:
        self.builder = _RawTextBuilder()
        self._visible_stack: list[bool] = []
        self._tag_stack: list[str] = []
        self.capture_structure = capture_structure
        self.elements: list[_RawElement] = []
        self.anchors: dict[str, int] = {}
        self._ambiguous_anchors: set[str] = set()
        self._element_stack: list[Presence[int]] = []
        self._container_stack: list[int] = []
        self._numbering_stack: list[bool] = []
        self._captured_stack: list[int] = []

    def start(self, tag: str, attributes: Mapping[str, str]) -> None:
        normalized_tag = tag.lower()
        parent_visible = self._visible_stack[-1] if self._visible_stack else True
        visible = (
            parent_visible
            and normalized_tag not in SKIP_ELEMENTS
            and "hidden" not in attributes
            and str(attributes.get("aria-hidden") or "").lower() != "true"
        )
        self._visible_stack.append(visible)
        self._tag_stack.append(normalized_tag)
        if self.capture_structure:
            self._element_stack.append(absent())
            self._numbering_stack.append(
                (self._numbering_stack[-1] if self._numbering_stack else True)
                and normalized_tag not in {"aside", "li", "ol", "ul", "blockquote"}
                and not attributes.get("data-reader-apparatus-kind")
            )
        if not visible:
            return
        if (
            normalized_tag in BLOCK_ELEMENTS
            and self.builder.length
            and self.builder.last_char != "\n"
        ):
            self.builder.append("\n")
        if self.capture_structure and (
            normalized_tag in HEADING_TAGS | STRUCTURAL_TAGS | {"p", "em"}
            or any(attributes.get(attribute) for attribute in ("id", "name"))
        ):
            index = len(self.elements)
            self.elements.append(
                _RawElement(
                    normalized_tag,
                    self.builder.length,
                    self.builder.length,
                    present(self._container_stack[-1]) if self._container_stack else absent(),
                    present(self._captured_stack[-1]) if self._captured_stack else absent(),
                    tuple(attributes.get("aria-labelledby", "").split()),
                    self._numbering_stack[-1],
                )
            )
            self._element_stack[-1] = present(index)
            self._captured_stack.append(index)
            for attribute in ("id", "name"):
                value = str(attributes.get(attribute) or "")
                if not value or value in self._ambiguous_anchors:
                    continue
                previous = self.anchors.get(value)
                if previous is not None and previous != index:
                    del self.anchors[value]
                    self._ambiguous_anchors.add(value)
                else:
                    self.anchors[value] = index
            if normalized_tag in STRUCTURAL_TAGS:
                self._container_stack.append(index)
        if normalized_tag == "br":
            self.builder.append("\n")

    def data(self, text: str) -> None:
        if not self._visible_stack or not self._visible_stack[-1]:
            return
        normalized = WHITESPACE_RE.sub(" ", text)
        if normalized:
            self.builder.append(normalized)

    def end(self, _tag: str) -> None:
        normalized_tag = self._tag_stack.pop()
        visible = self._visible_stack.pop()
        if self.capture_structure:
            element = self._element_stack.pop()
            self._numbering_stack.pop()
            if isinstance(element, Present):
                self._captured_stack.pop()
                self.elements[element.value].end_offset = self.builder.length
                if normalized_tag in STRUCTURAL_TAGS:
                    self._container_stack.pop()
        if (
            visible
            and normalized_tag in BLOCK_ELEMENTS
            and self.builder.length
            and self.builder.last_char != "\n"
        ):
            self.builder.append("\n")

    def close(self) -> None:
        return None


def generate_canonical_text(html_sanitized: str) -> str:
    """Generate canonical text from sanitized HTML.

    This function extracts text content from HTML following the
    canonicalization rules above.

    Args:
        html_sanitized: The sanitized HTML from the sanitizer.

    Returns:
        Canonical text string with proper block boundaries.

    """
    if not html_sanitized or not html_sanitized.strip():
        return ""

    target = _CanonicalTextTarget()
    parser = HTMLParser(target=target)
    parser.feed("<div>")
    parser.feed(html_sanitized)
    parser.feed("</div>")
    parser.close()
    raw_text = target.builder.build()
    del parser, target
    return _canonical_text_without_sources(raw_text)


def canonicalize_structure(html_sanitized: str) -> CanonicalStructure:
    """Bind source structure to the same normalization used by text anchors."""
    target = _CanonicalTextTarget(capture_structure=True)
    parser = HTMLParser(target=target)
    parser.feed("<div>")
    parser.feed(html_sanitized)
    parser.feed("</div>")
    parser.close()
    raw_text = target.builder.build()
    elements = target.elements
    anchors = target.anchors
    del parser, target
    return _canonical_structure(raw_text, elements, anchors)


def _canonical_structure(
    raw_text: str, elements: list[_RawElement], anchors: dict[str, int]
) -> CanonicalStructure:
    if not elements:
        return CanonicalStructure(_canonical_text_without_sources(raw_text), (), {})
    text, offsets = _canonical_text_with_offsets(
        raw_text,
        (offset for element in elements for offset in (element.start_offset, element.end_offset)),
    )
    return CanonicalStructure(
        text,
        tuple(
            CanonicalElement(
                element.tag,
                offsets[element.start_offset],
                offsets[element.end_offset],
                element.parent_container,
                element.parent_element,
                element.labelled_by,
                element.numbering_allowed,
            )
            for element in elements
        ),
        anchors,
    )


def _canonical_text_without_sources(raw_text: str) -> str:
    """Apply the exact canonical transform without per-character source arrays."""
    normalized_text = "".join(
        normalized for _start, _raw, normalized in _normalized_batches(raw_text)
    )
    return _trim_lines_without_sources(_collapse_blank_lines_without_sources(normalized_text))


def _normalized_batches(text: str) -> Iterator[tuple[int, str, str]]:
    """Normalize across whole grapheme clusters, whose boundaries survive NFC."""
    if text.isascii():
        yield 0, text, text
        return
    for match in _NFC_BATCHES.finditer(text):
        raw = match[0]
        yield match.start(), raw, unicodedata.normalize("NFC", raw)


def _collapse_blank_lines_without_sources(text: str) -> str:
    chunks: list[str] = []
    start = 0
    for first, end in _blank_line_runs(text):
        if end - first == 2:
            continue
        chunks.append(text[start:first])
        chunks.append("\n\n")
        start = end
    if not chunks:
        return text
    chunks.append(text[start:])
    return "".join(chunks)


def _blank_line_runs(text: str) -> Iterator[tuple[int, int]]:
    """Yield whitespace runs containing at least two newlines."""
    index = 0
    while index < len(text):
        newline = text.find("\n", index)
        if newline == -1:
            break
        end = newline + 1
        newline_count = 1
        while end < len(text) and _is_whitespace(text[end]):
            if text[end] == "\n":
                newline_count += 1
            end += 1
        if newline_count < 2:
            index = newline + 1
            continue
        yield newline, end
        index = end


def _trim_lines_without_sources(text: str) -> str:
    return "".join(text[start:end] for start, end in _trimmed_spans(text))


def _trimmed_spans(text: str) -> Iterator[tuple[int, int]]:
    """Yield contiguous source spans after line and document-edge whitespace trim."""
    start = 0
    while start < len(text) and _is_whitespace(text[start]):
        start += 1
    end = len(text)
    while end > start and _is_whitespace(text[end - 1]):
        end -= 1
    span_start = start
    line_start = start
    while line_start < end:
        newline = text.find("\n", line_start, end)
        line_end = end if newline == -1 else newline
        first = line_start
        while first < line_end and _is_whitespace(text[first]):
            first += 1
        last = line_end
        while last > first and _is_whitespace(text[last - 1]):
            last -= 1
        if first > line_start:
            if span_start < line_start:
                yield span_start, line_start
            span_start = first
        if last < line_end:
            if span_start < last:
                yield span_start, last
            span_start = line_end
        if newline == -1:
            break
        line_start = newline + 1
    if span_start < end:
        yield span_start, end


def _canonical_text_with_offsets(
    raw_text: str, raw_offsets: Iterable[int]
) -> tuple[str, dict[int, int]]:
    """Count surviving characters before each boundary, including reordered sources.

    Bucket prefix counts equal the historical bisect_left(sorted(origins), boundary):
    only surviving origins strictly before that raw boundary contribute.
    """
    boundaries = sorted(set(raw_offsets))
    source_type = "B"
    if len(boundaries) > 255:
        source_type = "H"
    if len(boundaries) > 65_535:
        source_type = "I"
    if len(boundaries) > 4_294_967_295:
        source_type = "Q"
    normalized_text, normalized_sources = _normalize_nfc_with_sources(
        raw_text, boundaries, source_type
    )
    collapsed_text, collapsed_sources = _collapse_blank_lines(
        normalized_text,
        normalized_sources,
    )
    del normalized_text, normalized_sources
    text, sources = _trim_lines(collapsed_text, collapsed_sources)
    counts = [0] * (len(boundaries) + 1)
    for source in sources:
        counts[source] += 1
    offsets: dict[int, int] = {}
    preceding = 0
    for index, boundary in enumerate(boundaries):
        preceding += counts[index]
        offsets[boundary] = preceding
    return text, offsets


def _collapse_blank_lines(text: str, sources: array) -> tuple[str, array]:
    chunks: list[str] = []
    text_start = 0
    source_start = 0
    written = 0
    # Move surviving spans within the packed buffer; slicing an array copies it.
    with memoryview(sources) as source_view:
        for first, end in _blank_line_runs(text):
            length = first - source_start
            source_view[written : written + length] = source_view[source_start:first]
            written += length
            collapsed_source = min(source_view[first:end])
            sources[written] = collapsed_source
            sources[written + 1] = collapsed_source
            written += 2
            source_start = end
            if end - first > 2:
                chunks.append(text[text_start:first])
                chunks.append("\n\n")
                text_start = end
        length = len(text) - source_start
        source_view[written : written + length] = source_view[source_start:]
        written += length
    del sources[written:]
    if not chunks:
        return text, sources
    chunks.append(text[text_start:])
    return "".join(chunks), sources


def _trim_lines(text: str, sources: array) -> tuple[str, array]:
    chunks: list[str] = []
    written = 0
    with memoryview(sources) as source_view:
        for start, end in _trimmed_spans(text):
            chunks.append(text[start:end])
            length = end - start
            source_view[written : written + length] = source_view[start:end]
            written += length
    del sources[written:]
    return "".join(chunks), sources


def _normalize_nfc_with_sources(
    text: str, boundaries: Sequence[int], source_type: str
) -> tuple[str, array]:
    normalized_chunks: list[str] = []
    normalized_sources = array(source_type)
    for start, raw, normalized in _normalized_batches(text):
        normalized_chunks.append(normalized)
        if normalized == raw:
            normalized_sources.extend(
                bisect_right(boundaries, source) for source in range(start, start + len(raw))
            )
            continue

        # Monotone boundary buckets preserve source order and composition minima.
        # Queues belong to this normalization-safe batch, not the whole document.
        decomposed_sources: dict[str, array] = {}
        for source, original_char in enumerate(raw, start=start):
            source_bucket = bisect_right(boundaries, source)
            for decomposed_char in unicodedata.normalize("NFD", original_char):
                if decomposed_char not in decomposed_sources:
                    decomposed_sources[decomposed_char] = array(source_type)
                decomposed_sources[decomposed_char].append(source_bucket)
        source_positions = dict.fromkeys(decomposed_sources, 0)
        for char in normalized:
            source_start = len(boundaries)
            for decomposed_char in unicodedata.normalize("NFD", char):
                positions = decomposed_sources[decomposed_char]
                position = source_positions[decomposed_char]
                source_start = min(source_start, positions[position])
                if position + 1 == len(positions):
                    del decomposed_sources[decomposed_char]
                    del source_positions[decomposed_char]
                elif (position + 1) * 2 >= len(positions):
                    del positions[: position + 1]
                    source_positions[decomposed_char] = 0
                else:
                    source_positions[decomposed_char] = position + 1
            normalized_sources.append(source_start)
    return "".join(normalized_chunks), normalized_sources


def _is_whitespace(char: str) -> bool:
    return WHITESPACE_RE.fullmatch(char) is not None
