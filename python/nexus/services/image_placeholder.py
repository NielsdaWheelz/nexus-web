"""Replace an unavailable image without changing source text coordinates."""

from lxml.html import Element, HtmlElement


def replace_image_with_placeholder(element: HtmlElement) -> None:
    replacement = Element("span")
    for name in ("id", "name", "hidden", "aria-hidden", "data-reader-source-warning"):
        if name in element.attrib:
            replacement.set(name, element.attrib[name])
    alt = (element.get("alt") or "").strip()
    label = f"image unavailable: {alt}" if alt else "image unavailable"
    replacement.set("role", "img")
    replacement.set("aria-label", label)
    decoration = Element("span")
    decoration.set("aria-hidden", "true")
    decoration.text = label
    replacement.append(decoration)
    replacement.tail = element.tail
    element.getparent().replace(element, replacement)
