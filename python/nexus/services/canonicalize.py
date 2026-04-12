"""Canonical text generation from sanitized HTML.

Produces fragment.canonical_text from fragment.html_sanitized per constitution §7.

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

# Multiple newlines regex
MULTI_NEWLINE_RE = re.compile(r"\n\s*\n+")


def generate_canonical_text(html_sanitized: str) -> str:
    """Generate canonical text from sanitized HTML.

    This function extracts text content from HTML following the
    canonicalization rules in the constitution.

    Args:
        html_sanitized: The sanitized HTML from the sanitizer.

    Returns:
        Canonical text string with proper block boundaries.

    Raises:
        ValueError: If HTML cannot be parsed.
    """
    if not html_sanitized or not html_sanitized.strip():
        return ""

    try:
        fragment = html5lib.parseFragment(
            f"<div>{html_sanitized}</div>",
            treebuilder="dom",
            namespaceHTMLElements=False,
        )
    except Exception as e:
        raise ValueError(f"Failed to parse HTML: {e}") from e

    root = None
    for child in fragment.childNodes:
        if child.nodeType == Node.ELEMENT_NODE:
            root = child
            break

    if root is None:
        return ""

    # Collect text parts
    parts: list[str] = []

    # Walk the detached fragment root
    _walk_element(root, parts)

    # Join and normalize
    text = "".join(parts)

    # Unicode NFC normalization
    text = unicodedata.normalize("NFC", text)

    # Collapse multiple consecutive blank lines to single blank line
    text = MULTI_NEWLINE_RE.sub("\n\n", text)

    # Trim lines
    lines = [line.strip() for line in text.split("\n")]
    text = "\n".join(lines)

    # Remove leading/trailing whitespace
    text = text.strip()

    return text


def _walk_element(element: Element, parts: list[str]) -> None:
    """Recursively walk a DOM element tree and extract text."""
    tag = element.tagName.lower()

    if _is_hidden(element):
        return

    if tag in SKIP_ELEMENTS:
        return

    is_block = tag in BLOCK_ELEMENTS

    if tag == "br":
        parts.append("\n")
        return

    if is_block and parts:
        last_char = parts[-1][-1:]
        if last_char not in ("\n", ""):
            parts.append("\n")

    for child in element.childNodes:
        if child.nodeType == Node.TEXT_NODE:
            normalized = _normalize_text(child.data or "")
            if normalized:
                parts.append(normalized)
        elif child.nodeType == Node.ELEMENT_NODE:
            _walk_element(child, parts)

    if is_block and parts:
        last_char = parts[-1][-1:]
        if last_char not in ("\n", ""):
            parts.append("\n")


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
