"""lxml HTML parse/serialize helpers and the HTML5 shape reconciliation.

Canonical text is produced by a streaming libxml2 parse while the frontend walks
the browser's DOM, so persisted offsets are only trustworthy where libxml2 and
HTML5 tree construction agree. They disagree on a small enumerable set of shapes
that survive sanitization -- sanitization can even create one by unwrapping a
disallowed wrapper -- so each sanitizer emits only shapes both parsers read
identically, by applying `normalize_html5_shape` to its output tree.
"""

from __future__ import annotations

import re
from html import escape
from typing import cast

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

# Table-structure elements are only valid inside a table. HTML5 ignores their
# start tag anywhere else; libxml2 keeps the element, and because these are block
# elements that changes where canonical newlines fall.
TABLE_STRUCTURE_TAGS = frozenset("td th tr tbody thead tfoot caption col colgroup".split())

# Foreign content roots. HTML5 switches to foreign-content insertion inside these.
FOREIGN_ROOT_TAGS = frozenset({"svg", "math"})

# HTML start tags that force a breakout from foreign content, per the HTML5
# "any other start tag" rule. Restricted to tags the sanitizers allow.
FOREIGN_BREAKOUT_TAGS = frozenset(
    "b blockquote br code div em h1 h2 h3 h4 h5 h6 hr i img li ol p pre s small"
    " span strong sub sup table u ul".split()
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
    """
    return cast(str, tostring(element, encoding="unicode", method="html"))


def inner_html(element: HtmlElement) -> str:
    """Serialize an element's children as an HTML fragment, without its own tag.

    Use this instead of serializing the element and slicing its wrapper off: the
    wrapper form silently keeps the tag whenever it carries attributes.

    `element.text` is character data, not markup, and must be escaped exactly as
    `serialize_html` escapes each child's text and tail; otherwise source prose
    containing `<` or `&` is re-emitted as live markup.
    """
    parts = [escape(element.text or "", quote=False)]
    parts.extend(serialize_html(child) for child in element)
    return "".join(parts)


def normalize_html5_shape(root: HtmlElement) -> None:
    """Rewrite `root` in place so libxml2 and HTML5 build the same tree."""
    for foreign in list(root.iter()):
        if _tag(foreign) not in FOREIGN_ROOT_TAGS:
            continue
        while True:
            breakout = next(
                (
                    descendant
                    for descendant in foreign.iterdescendants()
                    if _tag(descendant) in FOREIGN_BREAKOUT_TAGS
                ),
                None,
            )
            if breakout is None:
                break
            _split_at(breakout, foreign)

    # A <p> start tag closes an open <p>, so the inner paragraph is a sibling of
    # the outer one in every browser. Sanitizer unwrapping can create the nested
    # shape after parsing, which is why this runs on the sanitized tree.
    while True:
        nested = next(
            (
                descendant
                for element in root.iter()
                if _tag(element) == "p"
                for descendant in element.iterdescendants()
                if _tag(descendant) == "p"
            ),
            None,
        )
        if nested is None:
            break
        outer = nested.getparent()
        while outer is not None and _tag(outer) != "p":
            outer = outer.getparent()
        if outer is None:
            break
        _split_at(nested, outer)

    for element in list(root.iter()):
        if _tag(element) not in TABLE_STRUCTURE_TAGS:
            continue
        ancestor = element.getparent()
        while ancestor is not None and _tag(ancestor) != "table":
            ancestor = ancestor.getparent()
        if ancestor is None:
            element.drop_tag()


def _tag(element: object) -> str | None:
    tag = getattr(element, "tag", None)
    return tag if isinstance(tag, str) else None


def _split_at(element: HtmlElement, ancestor: HtmlElement) -> None:
    """Move `element` and everything after it out to just after `ancestor`.

    This is what HTML5 does when a start tag implicitly closes an open element:
    the new element becomes the ancestor's next sibling rather than its child,
    and the content parsed before it stays where it is.
    """
    parent = ancestor.getparent()
    if parent is None:
        return
    insert_at = parent.index(ancestor) + 1

    moving: list[HtmlElement] = []
    node: HtmlElement = element
    first = True
    while True:
        holder = node.getparent()
        if holder is None:
            break
        index = holder.index(node)
        moving.extend(holder[index:] if first else holder[index + 1 :])
        first = False
        if holder is ancestor:
            break
        node = holder
    if not moving:
        return

    # `ancestor.tail` is the text that already followed the closing tag, so it has
    # to end up after the moved nodes rather than between them and the ancestor.
    trailing = ancestor.tail
    ancestor.tail = None
    for offset, moved in enumerate(moving):
        parent.insert(insert_at + offset, moved)
    if trailing:
        last = moving[-1]
        last.tail = (last.tail or "") + trailing
