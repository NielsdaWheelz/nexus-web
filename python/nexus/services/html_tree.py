"""Generic lxml HTML tree manipulation helpers."""

from __future__ import annotations

import re

from lxml.html import HtmlElement, document_fromstring

_LEADING_XML_ENCODING_DECLARATION_RE = re.compile(
    r"""\A
    (?P<prefix>\ufeff?[ \t\r\n]*)
    <\?xml\b
    (?=[^>]*\bencoding\s*=\s*["'][^"']+["'])
    [^>]*\?>
    """,
    re.IGNORECASE | re.VERBOSE,
)


def parse_html_document(html: str | bytes) -> HtmlElement:
    """Parse HTML while preserving byte encodings and accepted Unicode XML prologs."""
    if isinstance(html, str):
        html = _LEADING_XML_ENCODING_DECLARATION_RE.sub(
            lambda match: match.group("prefix"),
            html,
            count=1,
        )
    return document_fromstring(html)


def remove_element(element: HtmlElement) -> None:
    """Remove an element entirely from the tree."""
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def unwrap_element(element: HtmlElement) -> None:
    """Remove element tag but keep its children and text."""
    parent = element.getparent()
    if parent is None:
        return

    index = list(parent).index(element)
    tail = element.tail or ""

    for i, child in enumerate(element):
        parent.insert(index + i, child)

    text = element.text or ""
    if index > 0:
        prev = parent[index - 1]
        prev.tail = (prev.tail or "") + text
    else:
        parent.text = (parent.text or "") + text

    if len(element) > 0:
        last_child = element[-1]
        last_child.tail = (last_child.tail or "") + tail
    elif index > 0:
        prev = parent[index - 1]
        prev.tail = (prev.tail or "") + tail
    else:
        parent.text = (parent.text or "") + tail

    parent.remove(element)
