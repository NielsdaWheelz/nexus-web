"""Generic lxml HTML tree manipulation helpers."""

from __future__ import annotations

import re
from html import escape

from lxml.html import HtmlElement, document_fromstring, tostring

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


def serialize_html(element: HtmlElement) -> str:
    """Serialize an element and its subtree as an HTML fragment.

    `method="html"` keeps HTML semantics such as void elements, and
    `encoding="unicode"` is the documented way to get text rather than bytes.
    The typed signature still admits bytes, so the impossible branch is a defect
    rather than a decode that would guess an encoding.
    """
    rendered = tostring(element, encoding="unicode", method="html")
    if not isinstance(rendered, str):
        raise AssertionError("unicode HTML serialization returned bytes")
    return rendered


def inner_html(element: HtmlElement) -> str:
    """Serialize an element's children as an HTML fragment, without its own tag.

    Use this instead of serializing the element and slicing its wrapper off: the
    wrapper form silently keeps the tag whenever it carries attributes.

    `element.text` is character data, not markup. `serialize_html` escapes each
    child's text and tail; the leading text must be escaped the same way or
    source prose containing `<` or `&` is re-emitted as live markup, which both
    corrupts canonical-text offsets and reintroduces markup downstream.
    """
    parts = [escape(element.text or "", quote=False)]
    parts.extend(serialize_html(child) for child in element)
    return "".join(parts)


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
