"""Frozen 0334 table projection; do not regenerate or import application code.

The visible-text walk and normalization are frozen from canonicalize.py at this
migration. Navigation/native provenance are omitted; table coordinates use the
same raw boundary buckets. No-table fragments need no coordinate conversion.
"""

import re
import unicodedata
from array import array
from bisect import bisect_right
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass

import regex
from lxml.etree import HTMLParser

BLOCK_ELEMENTS = frozenset(
    "p li ul ol h1 h2 h3 h4 h5 h6 blockquote pre div section article header footer nav"
    " aside figure figcaption table tr td th".split()
)
SKIP_ELEMENTS = frozenset({"script", "style", "noscript", "template"})
WHITESPACE_RE = re.compile(r"[\s\u00a0]+")
_NFC_BATCHES = regex.compile(r"(?:\X){1,4096}")


@dataclass
class _Table:
    path: tuple[int, ...]
    start: int
    end: int


class _TablesTarget:
    def __init__(self) -> None:
        self.chunks: list[str] = []
        self.last_char = ""
        self.length = 0
        self.visible: list[bool] = []
        self.tags: list[str] = []
        self.paths: list[tuple[int, ...] | None] = []
        self.child_counts: list[int] = []
        self.root_seen = False
        self.x_slots: set[str] = set()
        self.tables: list[_Table] = []
        self.table_stack: list[int] = []

    def _append(self, value: str) -> None:
        if value:
            self.chunks.append(value)
            self.last_char = value[-1]
            self.length += len(value)

    def start(self, tag: str, attributes: Mapping[str, str]) -> None:
        tag = tag.lower()
        visible = (
            (self.visible[-1] if self.visible else True)
            and tag not in SKIP_ELEMENTS
            and "hidden" not in attributes
            and str(attributes.get("aria-hidden") or "").lower() != "true"
        )
        x_slot = (
            attributes.get("data-nexus-document-embed-id")
            if tag == "figure" and attributes.get("data-nexus-document-embed-kind") == "x_post"
            else None
        )
        if visible and x_slot is not None:
            if self.length and self.last_char != "\n":
                self._append("\n")
            if x_slot in self.x_slots:
                raise ValueError("X embed occurrence key is repeated")
            self.x_slots.add(x_slot)
            visible = False
        self.visible.append(visible)
        self.tags.append(tag)
        if tag == "div" and not self.root_seen:
            self.root_seen = True
            path = ()
        elif self.paths and (parent := self.paths[-1]) is not None:
            path = parent + (self.child_counts[-1],)
            self.child_counts[-1] += 1
        else:
            path = None
        self.paths.append(path)
        self.child_counts.append(0)
        if not visible:
            return
        if tag in BLOCK_ELEMENTS and self.length and self.last_char != "\n":
            self._append("\n")
        if tag == "table":
            if path is None:
                raise ValueError("Table lies outside the retained fragment root")
            self.table_stack.append(len(self.tables))
            self.tables.append(_Table(path, self.length, self.length))
        if tag == "br":
            self._append("\n")

    def data(self, value: str) -> None:
        if self.visible and self.visible[-1]:
            self._append(WHITESPACE_RE.sub(" ", value))

    def end(self, _tag: str) -> None:
        tag = self.tags.pop()
        visible = self.visible.pop()
        self.paths.pop()
        self.child_counts.pop()
        if visible and tag == "table":
            self.tables[self.table_stack.pop()].end = self.length
        if visible and tag in BLOCK_ELEMENTS and self.length and self.last_char != "\n":
            self._append("\n")

    def close(self) -> None:
        return None


def fragment_tables(html_sanitized: str, canonical_text: str) -> list[dict]:
    """Project every visible table; refuse changed coordinates before writing any row."""
    target = _TablesTarget()
    parser = HTMLParser(target=target)
    parser.feed("<div>")
    parser.feed(html_sanitized)
    parser.feed("</div>")
    parser.close()
    if not target.tables:
        return []
    boundaries = sorted({offset for table in target.tables for offset in (table.start, table.end)})
    text, sources = _transform("".join(target.chunks), boundaries)
    if text != canonical_text:
        raise RuntimeError("0330 table-bearing fragment does not reproduce its canonical text")
    counts = [0] * (len(boundaries) + 1)
    for source in sources or ():
        counts[source] += 1
    offsets = {}
    preceding = 0
    for index, boundary in enumerate(boundaries):
        preceding += counts[index]
        offsets[boundary] = preceding
    return [
        {
            "dom_path": list(table.path),
            "start_offset": offsets[table.start],
            "end_offset": offsets[table.end],
        }
        for table in target.tables
    ]


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
