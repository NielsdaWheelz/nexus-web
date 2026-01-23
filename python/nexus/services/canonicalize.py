"""Canonical text generation from sanitized HTML.

Produces fragment.canonical_text from fragment.html_sanitized per constitution §7:

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

from lxml.html import HtmlElement, document_fromstring

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
        doc = document_fromstring(html_sanitized)
    except Exception as e:
        raise ValueError(f"Failed to parse HTML: {e}") from e

    # Collect text parts
    parts: list[str] = []

    # Walk the document tree
    _walk_element(doc.body, parts)

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


def _walk_element(element: HtmlElement, parts: list[str]) -> None:
    """Recursively walk element tree and extract text.

    Args:
        element: Current element to process.
        parts: List to append text parts to.
    """
    tag = element.tag.lower() if isinstance(element.tag, str) else ""

    # Skip hidden elements
    if _is_hidden(element):
        return

    # Skip script/style entirely
    if tag in SKIP_ELEMENTS:
        return

    # Check if this is a block element
    is_block = tag in BLOCK_ELEMENTS

    # Handle <br> specially - inserts newline
    if tag == "br":
        parts.append("\n")
        # Process tail text
        if element.tail:
            parts.append(_normalize_text(element.tail))
        return

    # Add newline before block elements (if we have content already)
    if is_block and parts and parts[-1] not in ("\n", ""):
        parts.append("\n")

    # Process text content
    if element.text:
        parts.append(_normalize_text(element.text))

    # Process children
    for child in element:
        if isinstance(child, HtmlElement):
            _walk_element(child, parts)
        # Tail text of child is handled in the child's processing

    # Add newline after block elements
    if is_block:
        if parts and parts[-1] not in ("\n", ""):
            parts.append("\n")

    # Process tail text (text after this element's closing tag)
    if element.tail:
        parts.append(_normalize_text(element.tail))


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


def _is_hidden(element: HtmlElement) -> bool:
    """Check if element is hidden (hidden attr or aria-hidden="true")."""
    # Check hidden attribute
    if element.get("hidden") is not None:
        return True

    # Check aria-hidden
    aria_hidden = element.get("aria-hidden", "").lower()
    if aria_hidden == "true":
        return True

    return False
