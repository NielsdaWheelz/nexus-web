"""Canonical text: the coordinate system every stored offset anchors on.

Canonicalization streams the already-sanitized HTML through libxml2 and walks
visible text in document order: NFC, every whitespace run to one space, a
newline at each block boundary and `<br>`, then trimmed lines and collapsed
blank lines. `script`/`style`/`noscript`/`template` and anything `hidden` or
`aria-hidden="true"` contribute nothing.

Both policies of the one sanitizer (`sanitize_html`) parse and re-serialize
through lxml, so this receives an lxml fixed point and agrees with the frontend
DOM walk for every construct the sanitizer normalizes.

After publication canonical text is immutable: highlights, chat quotes and
apparatus locators are stored as offsets into it. It is a function of this
module and of the locked interpreter and libraries (python 3.12's unicodedata
15.0, lxml 6.1.0 on libxml2 2.14.6, regex): an upgrade of any of them first
proves, on a restored backup, that every stored fragment recanonicalizes to itself.

Structural capture adds element ancestry, links and verified EPUB source facts
without changing the canonical text walk. The parser's artificial root wrapper
is not an authored division. X embed figures are source-link metadata: their
text is excluded, their block boundary remains, and their occurrence keys record
exact insertion offsets.
"""

import re
import unicodedata
from array import array
from bisect import bisect_right
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass

import regex
from lxml.etree import HTMLParser

HEADING_TAGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})
STRUCTURAL_TAGS = frozenset({"section", "article"})
STRUCTURE_CAPTURE_TAGS = STRUCTURAL_TAGS | {
    "div",
    "nav",
    "header",
    "footer",
    "hgroup",
    "main",
    "aside",
}
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
    parent_container: int | None
    parent_element: int | None
    labelled_by: tuple[str, ...]
    numbering_allowed: bool
    roles: frozenset[str] = frozenset()
    in_navigation: bool = False
    heading_group: tuple[int, int] | None = None
    link_href: str | None = None
    dom_path: tuple[int, ...] | None = None


@dataclass(frozen=True)
class CanonicalStructure:
    text: str
    elements: tuple[CanonicalElement, ...]
    anchors: dict[str, int]
    apparatus_items: dict[str, int]
    x_embed_slots: dict[str, int]


class _CanonicalTextTarget:
    """Stream sanitized HTML into canonical raw text without retaining a DOM."""

    def __init__(self, *, capture_structure: bool = False, capture_native: bool = False) -> None:
        self.native_runs = array("I") if capture_native else None
        self.chunks: list[str] = []
        self.last_char = ""
        self.length = 0
        self.capture_structure = capture_structure
        self.elements: list[CanonicalElement] = []
        self.anchors: dict[str, int] = {}
        self.apparatus_items: dict[str, int] = {}
        self.x_embed_slots: dict[str, int] = {}
        self._visible_stack: list[bool] = []
        self._tag_stack: list[str] = []
        self._ambiguous_anchors: set[str] = set()
        self._ambiguous_apparatus_items: set[str] = set()
        self._element_stack: list[int | None] = []
        self._container_stack: list[int] = []
        self._numbering_stack: list[bool] = []
        self._captured_stack: list[int] = []
        self._root_wrapper_seen = False
        self._dom_paths: list[tuple[int, ...] | None] = []
        self._dom_child_counts: list[int] = []

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
        x_slot = (
            attributes.get("data-nexus-document-embed-id")
            if normalized_tag == "figure"
            and attributes.get("data-nexus-document-embed-kind") == "x_post"
            else None
        )
        if visible and x_slot is not None:
            if self.length and self.last_char != "\n":
                self._append("\n")
            if self.capture_structure:
                if x_slot in self.x_embed_slots:
                    raise ValueError("X embed occurrence key is repeated")
                self.x_embed_slots[x_slot] = self.length
            visible = False
        self._visible_stack.append(visible)
        self._tag_stack.append(normalized_tag)
        root_wrapper = normalized_tag == "div" and not self._root_wrapper_seen
        if root_wrapper:
            self._root_wrapper_seen = True
            dom_path = ()
        elif self._dom_paths and (parent_path := self._dom_paths[-1]) is not None:
            dom_path = parent_path + (self._dom_child_counts[-1],)
            self._dom_child_counts[-1] += 1
        else:
            dom_path = None
        self._dom_paths.append(dom_path)
        self._dom_child_counts.append(0)
        if self.capture_structure:
            self._element_stack.append(None)
            self._numbering_stack.append(
                (self._numbering_stack[-1] if self._numbering_stack else True)
                and normalized_tag not in {"aside", "li", "ol", "ul", "blockquote"}
                and not attributes.get("data-reader-apparatus-kind")
            )
        if not visible:
            return
        if normalized_tag in BLOCK_ELEMENTS and self.length and self.last_char != "\n":
            self._append("\n")
        if (
            self.capture_structure
            and not root_wrapper
            and (
                normalized_tag in HEADING_TAGS | STRUCTURE_CAPTURE_TAGS | {"p", "em"}
                or (normalized_tag == "a" and attributes.get("href"))
                or any(attributes.get(attribute) for attribute in ("id", "name"))
                or attributes.get("data-reader-apparatus-item-id")
            )
        ):
            index = len(self.elements)
            self.elements.append(
                CanonicalElement(
                    normalized_tag,
                    self.length,
                    self.length,
                    self._container_stack[-1] if self._container_stack else None,
                    self._captured_stack[-1] if self._captured_stack else None,
                    tuple(attributes.get("aria-labelledby", "").split()),
                    self._numbering_stack[-1],
                    link_href=attributes.get("href") if normalized_tag == "a" else None,
                    dom_path=dom_path,
                )
            )
            self._element_stack[-1] = index
            self._captured_stack.append(index)
            for attribute, identities, ambiguous in (
                ("id", self.anchors, self._ambiguous_anchors),
                ("name", self.anchors, self._ambiguous_anchors),
                (
                    "data-reader-apparatus-item-id",
                    self.apparatus_items,
                    self._ambiguous_apparatus_items,
                ),
            ):
                value = str(attributes.get(attribute) or "")
                if not value or value in ambiguous:
                    continue
                previous = identities.get(value)
                if previous is not None and previous != index:
                    del identities[value]
                    ambiguous.add(value)
                else:
                    identities[value] = index
            if normalized_tag in STRUCTURAL_TAGS:
                self._container_stack.append(index)
        if normalized_tag == "br":
            self._append("\n")

    def data(self, text: str, native_start: int | None = None) -> None:
        if not self._visible_stack or not self._visible_stack[-1]:
            return
        collapsed = WHITESPACE_RE.sub(" ", text)
        first = self.length
        self._append(collapsed)
        if native_start is None or self.native_runs is None:
            return
        raw = first
        source = native_start

        def run(raw_end: int, source_end: int) -> None:
            nonlocal raw, source
            runs = self.native_runs
            if runs is None:
                raise ValueError("Native source capture is disabled")
            affine = raw_end - raw == source_end - source
            if (
                runs
                and affine
                and runs[-3] == raw
                and runs[-1] == source
                and runs[-3] - runs[-4] == runs[-1] - runs[-2]
            ):
                runs[-3], runs[-1] = raw_end, source_end
            else:
                runs.extend((raw, raw_end, source, source_end))
            raw, source = raw_end, source_end

        cursor = 0
        for match in WHITESPACE_RE.finditer(text):
            if match.start() > cursor:
                count = match.start() - cursor
                run(raw + count, source + count)
            run(raw + 1, source + match.end() - match.start())
            cursor = match.end()
        if cursor < len(text):
            run(raw + len(text) - cursor, source + len(text) - cursor)

    def end(self, _tag: str) -> None:
        normalized_tag = self._tag_stack.pop()
        visible = self._visible_stack.pop()
        self._dom_paths.pop()
        self._dom_child_counts.pop()
        if self.capture_structure:
            element = self._element_stack.pop()
            self._numbering_stack.pop()
            if element is not None:
                self._captured_stack.pop()
                self.elements[element].end_offset = self.length
                if normalized_tag in STRUCTURAL_TAGS:
                    self._container_stack.pop()
        if visible and normalized_tag in BLOCK_ELEMENTS and self.length and self.last_char != "\n":
            self._append("\n")

    def close(self) -> None:
        return None


class NativeCanonicalTarget(_CanonicalTextTarget):
    """Source-owner walk with sparse native codepoint runs, never display nodes."""

    def __init__(self) -> None:
        super().__init__(capture_native=True)

    def projection(self) -> "NativeCanonicalProjection":
        if self.native_runs is None:
            raise ValueError("Native source capture is disabled")
        return NativeCanonicalProjection("".join(self.chunks), self.native_runs)


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
    apparatus_items = target.apparatus_items
    x_embed_slots = target.x_embed_slots
    del target
    if not elements and not x_embed_slots:
        text, _sources = _transform(raw_text, None)
        return CanonicalStructure(text, (), {}, {}, {})
    boundaries = sorted(
        {offset for element in elements for offset in (element.start_offset, element.end_offset)}
        | set(x_embed_slots.values())
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
    return CanonicalStructure(
        text,
        tuple(elements),
        anchors,
        apparatus_items,
        {key: offsets[raw_offset] for key, raw_offset in x_embed_slots.items()},
    )


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
    source_type = "B" if len(boundaries) <= 255 else "H" if len(boundaries) <= 65_535 else "I"
    chunks: list[str] = []
    sources = array(source_type)
    for start, raw, normalized in _normalized_batches(text):
        chunks.append(normalized)
        sources.extend(
            bisect_right(boundaries, first)
            for first, _last in _nfc_contributors(start, raw, normalized)
        )
    return "".join(chunks), sources


def _nfc_contributors(start: int, raw: str, normalized: str) -> Iterator[tuple[int, int]]:
    """Complete raw contributor bounds under the publication's NFC queue policy."""
    if normalized == raw:
        for source in range(start, start + len(raw)):
            yield source, source + 1
        return
    decomposed_sources: dict[str, array] = {}
    for source, original_char in enumerate(raw, start=start):
        for decomposed_char in unicodedata.normalize("NFD", original_char):
            if decomposed_char not in decomposed_sources:
                decomposed_sources[decomposed_char] = array("I")
            decomposed_sources[decomposed_char].append(source)
    positions = dict.fromkeys(decomposed_sources, 0)
    for char in normalized:
        first, last = start + len(raw), start
        for decomposed_char in unicodedata.normalize("NFD", char):
            queue = decomposed_sources[decomposed_char]
            position = positions[decomposed_char]
            source = queue[position]
            first, last = min(first, source), max(last, source + 1)
            if position + 1 == len(queue):
                del decomposed_sources[decomposed_char]
                del positions[decomposed_char]
            elif (position + 1) * 2 >= len(queue):
                del queue[: position + 1]
                positions[decomposed_char] = 0
            else:
                positions[decomposed_char] = position + 1
        yield first, last


class NativeCanonicalProjection:
    """Sparse inverse queries through the publication's existing transforms.

    Flat source/normalized strings are retained. Provenance is affine/atomic
    runs plus requested intervals, never a character-sized origin array.
    """

    def __init__(self, raw: str, runs: array) -> None:
        self.raw = raw
        self.runs = runs
        normalized, _ = _normalize_nfc(raw, None)
        collapsed, _ = _collapse_blank_lines(normalized, None)
        self.text, _ = _trim_lines(collapsed, None)
        # Columns: canonical start/end, normalized start/end, atomic flag.
        self.spans = array("I")
        normalized_spans = array("I")
        source = output = 0
        for first, end in _blank_line_runs(normalized):
            if first > source:
                normalized_spans.extend((output, output + first - source, source, first, 0))
                output += first - source
            normalized_spans.extend((output, output + 2, first, end, 1))
            output += 2
            source = end
        if source < len(normalized):
            normalized_spans.extend(
                (output, output + len(normalized) - source, source, len(normalized), 0)
            )
        index = canonical = 0
        for first, end in _trimmed_spans(collapsed):
            while index < len(normalized_spans) and normalized_spans[index + 1] <= first:
                index += 5
            at = index
            while at < len(normalized_spans) and normalized_spans[at] < end:
                lo, hi = max(first, normalized_spans[at]), min(end, normalized_spans[at + 1])
                if normalized_spans[at + 4]:
                    left, right = normalized_spans[at + 2], normalized_spans[at + 3]
                else:
                    left = normalized_spans[at + 2] + lo - normalized_spans[at]
                    right = left + hi - lo
                self.spans.extend(
                    (canonical, canonical + hi - lo, left, right, normalized_spans[at + 4])
                )
                canonical += hi - lo
                at += 5

    def _native(self, first: int, end: int) -> tuple[int, int]:
        runs = self.runs
        lo, hi = 0, len(runs) // 4
        while lo < hi:
            mid = (lo + hi) // 2
            if runs[mid * 4 + 1] <= first:
                lo = mid + 1
            else:
                hi = mid
        start = 0xFFFFFFFF
        finish = 0
        at = lo * 4
        while at < len(runs) and runs[at] < end:
            raw_start, raw_end, native_start, native_end = runs[at : at + 4]
            if raw_end - raw_start == native_end - native_start:
                native_start += max(0, first - raw_start)
                native_end -= max(0, raw_end - end)
            start, finish = min(start, native_start), max(finish, native_end)
            at += 4
        return start, finish

    def bounds(self, intervals: list[tuple[int, int]]) -> list[tuple[int, int]]:
        queries = []
        for index, (first, end) in enumerate(intervals):
            for at in range(0, len(self.spans), 5):
                lo, hi = max(first, self.spans[at]), min(end, self.spans[at + 1])
                if lo >= hi:
                    continue
                left, right = self.spans[at + 2], self.spans[at + 3]
                if not self.spans[at + 4]:
                    left += lo - self.spans[at]
                    right = left + hi - lo
                queries.append((left, right, index))
        result = [(0xFFFFFFFF, 0) for _ in intervals]
        normalized_offset = 0
        for raw_start, original, normalized in _normalized_batches(self.raw):
            batch_end = normalized_offset + len(normalized)
            active = [
                (
                    max(lo, normalized_offset) - normalized_offset,
                    min(hi, batch_end) - normalized_offset,
                    index,
                )
                for lo, hi, index in queries
                if lo < batch_end and hi > normalized_offset
            ]
            if original == normalized:
                for lo, hi, index in active:
                    first, end = self._native(raw_start + lo, raw_start + hi)
                    before = result[index]
                    result[index] = min(before[0], first), max(before[1], end)
            elif active:
                for offset, (lo, hi) in enumerate(
                    _nfc_contributors(raw_start, original, normalized)
                ):
                    selected = [index for first, end, index in active if first <= offset < end]
                    if selected:
                        first, end = self._native(lo, hi)
                        for index in selected:
                            before = result[index]
                            result[index] = min(before[0], first), max(before[1], end)
            normalized_offset = batch_end
        return result

    def prefixes(self, points: list[int]) -> list[int]:
        raw_points = []
        for point in points:
            lo, hi = 0, len(self.runs) // 4
            while lo < hi:
                mid = (lo + hi) // 2
                if self.runs[mid * 4 + 3] <= point:
                    lo = mid + 1
                else:
                    hi = mid
            at = lo * 4
            if at == len(self.runs):
                raw_points.append(len(self.raw))
            elif point <= self.runs[at + 2]:
                raw_points.append(self.runs[at])
            elif self.runs[at + 1] - self.runs[at] == self.runs[at + 3] - self.runs[at + 2]:
                raw_points.append(self.runs[at] + point - self.runs[at + 2])
            else:
                raw_points.append(self.runs[at + 1])
        normalized_points = [0] * len(points)
        normalized_offset = 0
        for start, original, normalized in _normalized_batches(self.raw):
            for index, point in enumerate(raw_points):
                if point >= start + len(original):
                    normalized_points[index] = normalized_offset + len(normalized)
                elif point >= start:
                    if original == normalized:
                        normalized_points[index] = normalized_offset + point - start
                    else:
                        normalized_points[index] = normalized_offset + sum(
                            first < point
                            for first, _end in _nfc_contributors(start, original, normalized)
                        )
            normalized_offset += len(normalized)
        output = []
        for point in normalized_points:
            count = 0
            for at in range(0, len(self.spans), 5):
                first, end = self.spans[at + 2], self.spans[at + 3]
                if self.spans[at + 4]:
                    if first < point:
                        count += self.spans[at + 1] - self.spans[at]
                else:
                    count += max(0, min(point, end) - first)
            output.append(count)
        return output


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
