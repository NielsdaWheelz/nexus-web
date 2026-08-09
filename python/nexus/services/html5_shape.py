"""Reshape a sanitized lxml tree into the shape an HTML5 parser would build.

Canonical text is produced by a streaming libxml2 parse, but the frontend walks
the browser's DOM, so the persisted offsets are only trustworthy where libxml2
and HTML5 tree construction agree. They disagree on a small, enumerable set of
shapes that survive sanitization -- and sanitization can even create one of them
by unwrapping a disallowed wrapper.

Rather than reconcile the parsers, the sanitizers emit only shapes both parsers
read identically. Each rule below reproduces what HTML5 tree construction does
with the shape, so a later libxml2 parse of the serialized output lands on the
same tree the browser builds.
"""

from __future__ import annotations

from lxml.html import HtmlElement

# Table-structure elements are only valid inside a table. HTML5 ignores their
# start tag anywhere else; libxml2 keeps the element, and because these are block
# elements that changes where canonical newlines fall.
TABLE_STRUCTURE_TAGS = frozenset(
    {"td", "th", "tr", "tbody", "thead", "tfoot", "caption", "col", "colgroup"}
)

# Foreign content roots. HTML5 switches to foreign-content insertion inside these.
FOREIGN_ROOT_TAGS = frozenset({"svg", "math"})

# HTML start tags that force a breakout from foreign content, per the HTML5
# "any other start tag" rule for foreign content. Restricted to tags the
# sanitizers actually allow, since anything else is dropped before this runs.
FOREIGN_BREAKOUT_TAGS = frozenset(
    {
        "b",
        "blockquote",
        "br",
        "code",
        "div",
        "em",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "i",
        "img",
        "li",
        "ol",
        "p",
        "pre",
        "s",
        "small",
        "span",
        "strong",
        "sub",
        "sup",
        "table",
        "u",
        "ul",
    }
)


def normalize_html5_shape(root: HtmlElement) -> None:
    """Rewrite `root` in place so libxml2 and HTML5 build the same tree."""
    _split_foreign_breakouts(root)
    _split_nested_paragraphs(root)
    _unwrap_stray_table_structure(root)


def _tag(element: object) -> str | None:
    tag = getattr(element, "tag", None)
    return tag if isinstance(tag, str) else None


def _split_at(element: HtmlElement, ancestor: HtmlElement) -> None:
    """Move `element` and everything after it out to just after `ancestor`.

    This is what HTML5 does when a start tag implicitly closes an open element:
    the new element becomes the ancestor's next sibling rather than its child.
    """
    parent = ancestor.getparent()
    if parent is None:
        return
    insert_at = parent.index(ancestor) + 1

    # Everything from `element` up to the end of its own parent, then each
    # enclosing level up to `ancestor`, moves out in document order.
    # The breakout element and everything after it moves; the content already
    # parsed before it stays where it is, exactly as HTML5 leaves it when the
    # start tag pops the open elements.
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


def _split_foreign_breakouts(root: HtmlElement) -> None:
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


def _split_nested_paragraphs(root: HtmlElement) -> None:
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
            return
        outer = nested.getparent()
        while outer is not None and _tag(outer) != "p":
            outer = outer.getparent()
        if outer is None:
            return
        _split_at(nested, outer)


def _unwrap_stray_table_structure(root: HtmlElement) -> None:
    for element in list(root.iter()):
        tag = _tag(element)
        if tag not in TABLE_STRUCTURE_TAGS:
            continue
        ancestor = element.getparent()
        while ancestor is not None and _tag(ancestor) != "table":
            ancestor = ancestor.getparent()
        if ancestor is None:
            element.drop_tag()
