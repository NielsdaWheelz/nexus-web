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
from bisect import bisect_left
from collections import defaultdict, deque
from collections.abc import Mapping

from lxml.etree import HTMLParser

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

    def __init__(self, element_ids: set[str]) -> None:
        self.builder = _RawTextBuilder()
        self.element_ids = element_ids
        self.raw_offsets: dict[str, int] = {}
        self._visible_stack: list[bool] = []
        self._tag_stack: list[str] = []

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
        if not visible:
            return
        if (
            normalized_tag in BLOCK_ELEMENTS
            and self.builder.length
            and self.builder.last_char != "\n"
        ):
            self.builder.append("\n")
        for attribute in ("id", "name"):
            value = str(attributes.get(attribute) or "")
            if value in self.element_ids:
                self.raw_offsets.setdefault(value, self.builder.length)
        if normalized_tag == "br":
            self.builder.append("\n")

    def data(self, text: str) -> None:
        if not self._visible_stack or not self._visible_stack[-1]:
            return
        normalized = _normalize_text(text)
        if normalized:
            self.builder.append(normalized)

    def end(self, _tag: str) -> None:
        normalized_tag = self._tag_stack.pop()
        visible = self._visible_stack.pop()
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
    text, _offsets = generate_canonical_text_with_element_offsets(html_sanitized, set())
    return text


def generate_canonical_text_with_element_offsets(
    html_sanitized: str,
    element_ids: set[str],
) -> tuple[str, dict[str, int]]:
    """Generate canonical text and exact starts for requested element IDs/names."""
    if not html_sanitized or not html_sanitized.strip():
        return "", {}

    target = _CanonicalTextTarget(element_ids)
    parser = HTMLParser(target=target)
    parser.feed("<div>")
    parser.feed(html_sanitized)
    parser.feed("</div>")
    parser.close()
    raw_text = target.builder.build()
    raw_offsets = target.raw_offsets
    del parser, target
    if not raw_offsets:
        return _canonical_text_without_sources(raw_text), {}
    text, final_source_starts = _canonical_text_with_sources(raw_text)
    source_starts = sorted(final_source_starts)
    offsets = {
        element_id: bisect_left(source_starts, raw_offset)
        for element_id, raw_offset in raw_offsets.items()
    }
    return text, offsets


def _canonical_text_without_sources(raw_text: str) -> str:
    """Apply the exact canonical transform without per-character source arrays."""
    normalized_text = unicodedata.normalize("NFC", raw_text)
    return _trim_lines_without_sources(_collapse_blank_lines_without_sources(normalized_text))


def _collapse_blank_lines_without_sources(text: str) -> str:
    chunks: list[str] = []
    index = 0
    while index < len(text):
        newline = text.find("\n", index)
        if newline == -1:
            chunks.append(text[index:])
            break
        if newline > index:
            chunks.append(text[index:newline])
        index = newline

        end = index + 1
        newline_count = 1
        while end < len(text) and _is_whitespace(text[end]):
            if text[end] == "\n":
                newline_count += 1
            end += 1
        if newline_count < 2:
            chunks.append("\n")
            index += 1
            continue
        chunks.append("\n\n")
        index = end
    return "".join(chunks)


def _trim_lines_without_sources(text: str) -> str:
    chunks: list[str] = []
    line_start = 0
    while line_start <= len(text):
        newline = text.find("\n", line_start)
        line_end = len(text) if newline == -1 else newline
        first = line_start
        while first < line_end and _is_whitespace(text[first]):
            first += 1
        last = line_end - 1
        while last >= first and _is_whitespace(text[last]):
            last -= 1
        if first <= last:
            chunks.append(text[first : last + 1])
        if newline == -1:
            break
        chunks.append("\n")
        line_start = newline + 1
    line_trimmed = "".join(chunks)
    start = 0
    while start < len(line_trimmed) and _is_whitespace(line_trimmed[start]):
        start += 1
    end = len(line_trimmed)
    while end > start and _is_whitespace(line_trimmed[end - 1]):
        end -= 1
    return line_trimmed[start:end]


def _canonical_text_with_sources(raw_text: str) -> tuple[str, array]:
    normalized_text, normalized_sources = _normalize_nfc_with_sources(raw_text)
    collapsed_text, collapsed_sources = _collapse_blank_lines(
        normalized_text,
        normalized_sources,
    )
    return _trim_lines(collapsed_text, collapsed_sources)


def _collapse_blank_lines(text: str, sources: array) -> tuple[str, array]:
    chunks: list[str] = []
    collapsed_sources = array("Q")
    index = 0
    while index < len(text):
        newline = text.find("\n", index)
        if newline == -1:
            chunks.append(text[index:])
            collapsed_sources.extend(sources[index:])
            break
        if newline > index:
            chunks.append(text[index:newline])
            collapsed_sources.extend(sources[index:newline])
        index = newline

        end = index + 1
        newline_count = 1
        while end < len(text) and _is_whitespace(text[end]):
            if text[end] == "\n":
                newline_count += 1
            end += 1
        if newline_count < 2:
            chunks.append("\n")
            collapsed_sources.append(sources[index])
            index += 1
            continue
        collapsed_source = min(sources[index:end])
        chunks.append("\n\n")
        collapsed_sources.extend((collapsed_source, collapsed_source))
        index = end

    return "".join(chunks), collapsed_sources


def _trim_lines(text: str, sources: array) -> tuple[str, array]:
    chunks: list[str] = []
    trimmed_sources = array("Q")
    line_start = 0
    while line_start <= len(text):
        newline = text.find("\n", line_start)
        line_end = len(text) if newline == -1 else newline
        first = line_start
        while first < line_end and _is_whitespace(text[first]):
            first += 1
        last = line_end - 1
        while last >= first and _is_whitespace(text[last]):
            last -= 1
        if first <= last:
            chunks.append(text[first : last + 1])
            trimmed_sources.extend(sources[first : last + 1])
        if newline == -1:
            break
        chunks.append("\n")
        trimmed_sources.append(sources[newline])
        line_start = newline + 1

    line_trimmed = "".join(chunks)
    start = 0
    while start < len(line_trimmed) and _is_whitespace(line_trimmed[start]):
        start += 1
    end = len(line_trimmed)
    while end > start and _is_whitespace(line_trimmed[end - 1]):
        end -= 1
    return line_trimmed[start:end], trimmed_sources[start:end]


def _normalize_nfc_with_sources(text: str) -> tuple[str, array]:
    if not text:
        return "", array("Q")
    if unicodedata.is_normalized("NFC", text):
        return text, array("Q", range(len(text)))

    decomposed_sources: dict[str, deque[int]] = defaultdict(deque)
    for source, original_char in enumerate(text):
        for decomposed_char in unicodedata.normalize("NFD", original_char):
            decomposed_sources[decomposed_char].append(source)
    reordered_sources = array(
        "Q",
        (
            decomposed_sources[decomposed_char].popleft()
            for decomposed_char in unicodedata.normalize("NFD", text)
        ),
    )

    normalized_text = unicodedata.normalize("NFC", text)
    normalized_sources = array("Q")
    nfd_offset = 0
    for char in normalized_text:
        decomposition = unicodedata.normalize("NFD", char)
        source_start = reordered_sources[nfd_offset]
        for source_index in range(nfd_offset + 1, nfd_offset + len(decomposition)):
            source_start = min(source_start, reordered_sources[source_index])
        normalized_sources.append(source_start)
        nfd_offset += len(decomposition)
    return normalized_text, normalized_sources


def _is_whitespace(char: str) -> bool:
    return WHITESPACE_RE.fullmatch(char) is not None


def _normalize_text(text: str) -> str:
    """Normalize whitespace in text.

    - Maps all Unicode whitespace to space
    - Collapses consecutive spaces to single space
    """
    if not text:
        return ""

    # Replace all whitespace with single space
    normalized = WHITESPACE_RE.sub(" ", text)

    return normalized
