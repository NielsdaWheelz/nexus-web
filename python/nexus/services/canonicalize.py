"""Canonical text: the coordinate system every stored offset anchors on.

Canonicalization streams the already-sanitized HTML through libxml2 and walks
visible text in document order: NFC, every whitespace run to one space, a
newline at each block boundary and `<br>`, then trimmed lines and collapsed
blank lines. `script`/`style`/`noscript`/`template` and anything `hidden` or
`aria-hidden="true"` contribute nothing.

Both producers of the input (`sanitize_html` and the EPUB sanitizer) parse and
re-serialize through lxml, so this receives an lxml fixed point and agrees with
the frontend DOM walk for every construct those sanitizers normalize.

After publication canonical text is immutable: highlights, chat quotes and
apparatus locators are stored as offsets into it.
"""

import re
import unicodedata
from array import array
from bisect import bisect_right
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass

import regex
from lxml.etree import HTMLParser

from nexus.schemas.presence import Presence, Present, absent, present

HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})
STRUCTURAL_TAGS = frozenset({"section", "article"})
BLOCK_ELEMENTS = frozenset(
    "p li ul ol h1 h2 h3 h4 h5 h6 blockquote pre div section article header footer nav"
    " aside figure figcaption table tr td th".split()
)
SKIP_ELEMENTS = frozenset({"script", "style", "noscript", "template"})
WHITESPACE_RE = re.compile(r"[\s\u00a0]+")
_NFC_BATCHES = regex.compile(r"(?:\X){1,4096}")


@dataclass(slots=True)
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


class _CanonicalTextTarget:
    """Stream sanitized HTML into canonical raw text without retaining a DOM."""

    def __init__(self, *, capture_structure: bool = False) -> None:
        self.chunks: list[str] = []
        self.last_char = ""
        self.length = 0
        self.capture_structure = capture_structure
        self.elements: list[CanonicalElement] = []
        self.anchors: dict[str, int] = {}
        self._visible_stack: list[bool] = []
        self._tag_stack: list[str] = []
        self._ambiguous_anchors: set[str] = set()
        self._element_stack: list[Presence[int]] = []
        self._container_stack: list[int] = []
        self._numbering_stack: list[bool] = []
        self._captured_stack: list[int] = []

    def _append(self, text: str) -> None:
        if not text:
            return
        self.chunks.append(text)
        self.last_char = text[-1]
        self.length += len(text)

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
        if normalized_tag in BLOCK_ELEMENTS and self.length and self.last_char != "\n":
            self._append("\n")
        if self.capture_structure and (
            normalized_tag in HEADING_TAGS | STRUCTURAL_TAGS | {"p", "em"}
            or any(attributes.get(attribute) for attribute in ("id", "name"))
        ):
            index = len(self.elements)
            self.elements.append(
                CanonicalElement(
                    normalized_tag,
                    self.length,
                    self.length,
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
            self._append("\n")

    def data(self, text: str) -> None:
        if not self._visible_stack or not self._visible_stack[-1]:
            return
        self._append(WHITESPACE_RE.sub(" ", text))

    def end(self, _tag: str) -> None:
        normalized_tag = self._tag_stack.pop()
        visible = self._visible_stack.pop()
        if self.capture_structure:
            element = self._element_stack.pop()
            self._numbering_stack.pop()
            if isinstance(element, Present):
                self._captured_stack.pop()
                self.elements[element.value].end_offset = self.length
                if normalized_tag in STRUCTURAL_TAGS:
                    self._container_stack.pop()
        if visible and normalized_tag in BLOCK_ELEMENTS and self.length and self.last_char != "\n":
            self._append("\n")

    def close(self) -> None:
        return None


def _walk(html_sanitized: str, *, capture_structure: bool) -> _CanonicalTextTarget:
    target = _CanonicalTextTarget(capture_structure=capture_structure)
    parser = HTMLParser(target=target)
    parser.feed("<div>")
    parser.feed(html_sanitized)
    parser.feed("</div>")
    parser.close()
    return target


def generate_canonical_text(html_sanitized: str) -> str:
    """Canonical text for one sanitized HTML fragment."""
    if not html_sanitized or not html_sanitized.strip():
        return ""
    target = _walk(html_sanitized, capture_structure=False)
    raw_text = "".join(target.chunks)
    del target
    text, _sources = _transform(raw_text, None)
    return text


def canonicalize_structure(html_sanitized: str) -> CanonicalStructure:
    """Bind source structure to the same normalization used by text anchors."""
    target = _walk(html_sanitized, capture_structure=True)
    raw_text = "".join(target.chunks)
    elements = target.elements
    anchors = target.anchors
    del target
    if not elements:
        text, _sources = _transform(raw_text, None)
        return CanonicalStructure(text, (), {})
    boundaries = sorted(
        {offset for element in elements for offset in (element.start_offset, element.end_offset)}
    )
    text, sources = _transform(raw_text, boundaries)
    # Bucket prefix counts equal bisect_left(sorted(origins), boundary): only
    # surviving origins strictly before that raw boundary contribute.
    counts = [0] * (len(boundaries) + 1)
    for source in sources or ():
        counts[source] += 1
    offsets: dict[int, int] = {}
    preceding = 0
    for index, boundary in enumerate(boundaries):
        preceding += counts[index]
        offsets[boundary] = preceding
    for element in elements:
        element.start_offset = offsets[element.start_offset]
        element.end_offset = offsets[element.end_offset]
    return CanonicalStructure(text, tuple(elements), anchors)


def _transform(raw_text: str, boundaries: Sequence[int] | None) -> tuple[str, array | None]:
    """Normalize, collapse blank lines, trim — carrying source buckets when asked.

    With `boundaries`, the second result holds, for every surviving codepoint,
    the index of the raw boundary bucket it came from, which is what turns a raw
    offset into a canonical one.
    """
    text, sources = _normalize_nfc(raw_text, boundaries)
    text, sources = _collapse_blank_lines(text, sources)
    return _trim_lines(text, sources)


def _normalize_nfc(text: str, boundaries: Sequence[int] | None) -> tuple[str, array | None]:
    if boundaries is None:
        return "".join(normalized for _start, _raw, normalized in _normalized_batches(text)), None
    source_type = "B"
    if len(boundaries) > 255:
        source_type = "H"
    if len(boundaries) > 65_535:
        source_type = "I"
    if len(boundaries) > 4_294_967_295:
        source_type = "Q"
    chunks: list[str] = []
    sources = array(source_type)
    for start, raw, normalized in _normalized_batches(text):
        chunks.append(normalized)
        if normalized == raw:
            sources.extend(
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
            sources.append(source_start)
    return "".join(chunks), sources


def _normalized_batches(text: str) -> Iterator[tuple[int, str, str]]:
    """Normalize across whole grapheme clusters, whose boundaries survive NFC."""
    if text.isascii():
        yield 0, text, text
        return
    for match in _NFC_BATCHES.finditer(text):
        raw = match[0]
        yield match.start(), raw, unicodedata.normalize("NFC", raw)


def _collapse_blank_lines(text: str, sources: array | None) -> tuple[str, array | None]:
    chunks: list[str] = []
    kept = None if sources is None else array(sources.typecode)
    text_start = 0
    source_start = 0
    for first, end in _blank_line_runs(text):
        if sources is not None and kept is not None:
            kept.extend(sources[source_start:first])
            collapsed = min(sources[first:end])
            kept.append(collapsed)
            kept.append(collapsed)
        source_start = end
        if end - first > 2:
            chunks.append(text[text_start:first])
            chunks.append("\n\n")
            text_start = end
    if sources is not None and kept is not None:
        kept.extend(sources[source_start:])
    if not chunks:
        return text, kept
    chunks.append(text[text_start:])
    return "".join(chunks), kept


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


def _trim_lines(text: str, sources: array | None) -> tuple[str, array | None]:
    chunks: list[str] = []
    kept = None if sources is None else array(sources.typecode)
    for start, end in _trimmed_spans(text):
        chunks.append(text[start:end])
        if sources is not None and kept is not None:
            kept.extend(sources[start:end])
    return "".join(chunks), kept


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


def _is_whitespace(char: str) -> bool:
    return WHITESPACE_RE.fullmatch(char) is not None
