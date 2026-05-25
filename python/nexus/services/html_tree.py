"""Generic lxml HTML tree manipulation helpers."""

from __future__ import annotations

from lxml.html import HtmlElement


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
