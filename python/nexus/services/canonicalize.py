"""Canonical text generation from sanitized HTML.

Canonicalization runs on a browser-equivalent HTML5 fragment parse so the
persisted canonical_text matches the frontend DOM walk exactly.

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
from bisect import bisect_left
from collections import defaultdict, deque
from dataclasses import dataclass
from xml.dom import Node
from xml.dom.minidom import Element

import html5lib

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


@dataclass(frozen=True, slots=True)
class _Token:
    char: str
    sources: tuple[int, ...]


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

    fragment = html5lib.parseFragment(
        f"<div>{html_sanitized}</div>",
        treebuilder="dom",
        namespaceHTMLElements=False,
    )

    root = None
    for child in fragment.childNodes:
        if child.nodeType == Node.ELEMENT_NODE:
            root = child
            break

    if root is None:
        return "", {}

    tokens: list[_Token] = []
    raw_offsets: dict[str, int] = {}

    _walk_element(root, tokens, element_ids, raw_offsets)
    final_tokens = _canonical_tokens(tokens)
    text = "".join(token.char for token in final_tokens)
    source_starts = sorted(min(token.sources) for token in final_tokens)
    offsets = {
        element_id: bisect_left(source_starts, raw_offset)
        for element_id, raw_offset in raw_offsets.items()
    }
    return text, offsets


def _walk_element(
    element: Element,
    tokens: list[_Token],
    element_ids: set[str],
    raw_offsets: dict[str, int],
) -> None:
    """Recursively walk a DOM element tree and extract text."""
    tag = element.tagName.lower()

    if _is_hidden(element):
        return

    if tag in SKIP_ELEMENTS:
        return

    is_block = tag in BLOCK_ELEMENTS

    if is_block and tokens:
        last_char = tokens[-1].char
        if last_char not in ("\n", ""):
            _append_tokens(tokens, "\n")

    for attribute in ("id", "name"):
        value = element.getAttribute(attribute)
        if value in element_ids:
            raw_offsets.setdefault(value, len(tokens))

    if tag == "br":
        _append_tokens(tokens, "\n")
        return

    for child in element.childNodes:
        if child.nodeType == Node.TEXT_NODE:
            normalized = _normalize_text(child.data or "")
            if normalized:
                _append_tokens(tokens, normalized)
        elif child.nodeType == Node.ELEMENT_NODE:
            _walk_element(child, tokens, element_ids, raw_offsets)

    if is_block and tokens:
        last_char = tokens[-1].char
        if last_char not in ("\n", ""):
            _append_tokens(tokens, "\n")


def _append_tokens(tokens: list[_Token], text: str) -> None:
    for char in text:
        tokens.append(_Token(char=char, sources=(len(tokens),)))


def _canonical_tokens(tokens: list[_Token]) -> list[_Token]:
    normalized = _normalize_nfc(tokens)
    collapsed: list[_Token] = []
    index = 0
    while index < len(normalized):
        token = normalized[index]
        if token.char != "\n":
            collapsed.append(token)
            index += 1
            continue
        end = index + 1
        newline_count = 1
        while end < len(normalized) and _is_whitespace(normalized[end].char):
            if normalized[end].char == "\n":
                newline_count += 1
            end += 1
        if newline_count < 2:
            collapsed.append(token)
            index += 1
            continue
        sources = tuple(
            sorted({source for item in normalized[index:end] for source in item.sources})
        )
        collapsed.extend([_Token("\n", sources), _Token("\n", sources)])
        index = end

    line_trimmed: list[_Token] = []
    line_start = 0
    for index in range(len(collapsed) + 1):
        if index < len(collapsed) and collapsed[index].char != "\n":
            continue
        first = line_start
        while first < index and _is_whitespace(collapsed[first].char):
            first += 1
        last = index - 1
        while last >= first and _is_whitespace(collapsed[last].char):
            last -= 1
        line_trimmed.extend(collapsed[first : last + 1])
        if index < len(collapsed):
            line_trimmed.append(collapsed[index])
        line_start = index + 1

    start = 0
    while start < len(line_trimmed) and _is_whitespace(line_trimmed[start].char):
        start += 1
    end = len(line_trimmed)
    while end > start and _is_whitespace(line_trimmed[end - 1].char):
        end -= 1
    return line_trimmed[start:end]


def _normalize_nfc(tokens: list[_Token]) -> list[_Token]:
    text = "".join(token.char for token in tokens)
    if not text:
        return []
    decomposed_by_char: dict[str, deque[_Token]] = defaultdict(deque)
    for token in tokens:
        for char in unicodedata.normalize("NFD", token.char):
            decomposed_by_char[char].append(_Token(char, token.sources))
    reordered = [decomposed_by_char[char].popleft() for char in unicodedata.normalize("NFD", text)]

    normalized: list[_Token] = []
    nfd_offset = 0
    for char in unicodedata.normalize("NFC", text):
        decomposition = unicodedata.normalize("NFD", char)
        sources = tuple(
            sorted(
                {
                    source
                    for token in reordered[nfd_offset : nfd_offset + len(decomposition)]
                    for source in token.sources
                }
            )
        )
        normalized.append(_Token(char, sources))
        nfd_offset += len(decomposition)
    return normalized


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


def _is_hidden(element: Element) -> bool:
    """Check if element is hidden (hidden attr or aria-hidden="true")."""
    if element.hasAttribute("hidden"):
        return True

    aria_hidden = element.getAttribute("aria-hidden").lower()
    if aria_hidden == "true":
        return True

    return False
