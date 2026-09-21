"""The EPUB chapter sanitizer and the referenced-SVG-asset sanitizer.

Chapter output is the stored `fragments.html_sanitized`, so these allowlists are
part of the persisted byte contract that canonical offsets depend on.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse
from xml.etree import ElementTree as ET

from lxml.etree import LxmlError
from lxml.html import Element, HtmlElement

from nexus import web_paths
from nexus.services.html_tree import (
    inner_html,
    normalize_html5_shape,
    parse_html_document,
    serialize_html,
)

ALLOWED_HTML_TAGS = frozenset(
    "p br strong em b i u s blockquote pre code ul ol li dl dt dd h1 h2 h3 h4 h5 h6 hr a"
    " img table thead tbody tfoot tr th td sup sub xref div span section article header"
    " footer nav aside figure figcaption main".split()
)
ALLOWED_SVG_TAGS = frozenset(
    "svg g image path circle ellipse line polyline polygon rect use defs symbol title"
    " desc clippath lineargradient radialgradient stop".split()
)
DROPPED_WITH_CONTENT = frozenset(
    "script iframe object embed form meta base link style foreignobject animate set feimage".split()
)
SVG_FORBIDDEN_TAGS = frozenset(
    "script animate animatemotion animatetransform set foreignobject iframe object embed"
    " audio video source track style".split()
)
GLOBAL_ATTRS = frozenset(
    "id title lang dir xml:lang hidden aria-hidden aria-labelledby"
    " data-reader-apparatus-item-id data-reader-apparatus-kind"
    " data-reader-apparatus-confidence".split()
)
ALLOWED_ATTRS = {
    "a": frozenset("href title name".split()),
    "img": frozenset("src srcset alt title width height".split()),
    "th": frozenset("colspan rowspan scope".split()),
    "td": frozenset("colspan rowspan".split()),
}
# Attribute names are matched lowercased, so every entry here is lowercase.
ALLOWED_SVG_ATTRS = {
    "svg": frozenset("viewbox width height preserveaspectratio xmlns xmlns:xlink version".split()),
    "g": frozenset("transform fill stroke stroke-width opacity clip-path".split()),
    "path": frozenset(
        "d transform fill stroke stroke-width stroke-linecap stroke-linejoin"
        " stroke-dasharray stroke-dashoffset fill-rule opacity clip-path".split()
    ),
    "circle": frozenset("cx cy r fill stroke stroke-width opacity transform".split()),
    "ellipse": frozenset("cx cy rx ry fill stroke stroke-width opacity".split()),
    "line": frozenset("x1 y1 x2 y2 stroke stroke-width stroke-linecap opacity transform".split()),
    "polyline": frozenset(
        "points fill stroke stroke-width stroke-linecap stroke-linejoin opacity transform".split()
    ),
    "polygon": frozenset(
        "points fill stroke stroke-width stroke-linejoin opacity transform".split()
    ),
    "rect": frozenset("x y width height rx ry fill stroke stroke-width opacity transform".split()),
    "image": frozenset("href xlink:href x y width height transform opacity".split()),
    "use": frozenset("href xlink:href x y width height transform".split()),
    "defs": frozenset(),
    "symbol": frozenset(),
    "title": frozenset(),
    "desc": frozenset(),
    "clippath": frozenset({"id"}),
    "lineargradient": frozenset("id x1 x2 y1 y2 gradientunits gradienttransform".split()),
    "radialgradient": frozenset("id cx cy r fx fy gradientunits gradienttransform".split()),
    "stop": frozenset("offset stop-color stop-opacity".split()),
}
FORBIDDEN_URL_SCHEMES = frozenset({"javascript", "vbscript", "data", "file"})
EVENT_HANDLER_RE = re.compile(r"^on", re.IGNORECASE)


def local_name(name: str | None) -> str:
    if not name:
        return ""
    if "}" in name:
        return name.rsplit("}", 1)[1].lower()
    return name.lower()


def normalized_attr_name(attr: str) -> str:
    if attr.startswith("{"):
        namespace, local = attr[1:].split("}", 1)
        if namespace == "http://www.w3.org/1999/xlink":
            return f"xlink:{local.lower()}"
        return local.lower()
    return attr.lower()


def element_id(element: HtmlElement) -> str | None:
    for attr, value in element.attrib.items():
        if normalized_attr_name(attr) == "id" and value.strip():
            return value
    return None


def materialize_epub_body_anchor(body: HtmlElement) -> None:
    """Move a source body ID onto a safe child before apparatus extracts its contents."""
    body_id = element_id(body)
    if body_id is None:
        return
    # The source body is the first browser target for its ID. Keep that identity
    # on the marker rather than copying a descendant collision into the reader.
    for element in body.iterdescendants():
        for attr, value in list(element.attrib.items()):
            if normalized_attr_name(attr) == "id" and value == body_id:
                del element.attrib[attr]
    marker = Element("span", id=body_id)
    marker.tail = body.text
    body.text = None
    body.insert(0, marker)


def sanitize_epub_chapter(html: str) -> str:
    """Sanitize EPUB chapter HTML while preserving EPUB-local assets and SVG."""
    if not html or not html.strip():
        return ""
    try:
        doc = parse_html_document(html)
    except LxmlError as exc:
        raise ValueError(f"Failed to parse EPUB HTML: {exc}") from exc

    body = doc.body
    if body is None:
        if isinstance(doc, HtmlElement):
            _sanitize_element(doc)
            return serialize_html(doc)
        return ""
    for child in list(body):
        if isinstance(child, HtmlElement):
            _sanitize_element(child)
    normalize_html5_shape(body)
    return inner_html(body)


def _sanitize_element(element: HtmlElement) -> None:
    for child in list(element):
        if isinstance(child, HtmlElement):
            _sanitize_element(child)

    tag = local_name(element.tag)
    if tag in DROPPED_WITH_CONTENT:
        element.drop_tree()
        return
    if tag not in ALLOWED_HTML_TAGS and tag not in ALLOWED_SVG_TAGS:
        if element_id(element) is not None:
            element.tag = "span"
            _sanitize_attributes(element, "span")
            return
        if element.getparent() is not None:
            element.drop_tag()
        return
    _sanitize_attributes(element, tag)


def _sanitize_attributes(element: HtmlElement, tag: str) -> None:
    allowed = set(GLOBAL_ATTRS)
    if tag in ALLOWED_HTML_TAGS:
        allowed.update(ALLOWED_ATTRS.get(tag, frozenset()))
    if tag in ALLOWED_SVG_TAGS:
        allowed.update(ALLOWED_SVG_ATTRS.get(tag, frozenset()))

    for attr in list(element.attrib):
        name = normalized_attr_name(attr)
        value = element.attrib.get(attr, "")
        if (
            EVENT_HANDLER_RE.match(name)
            or name in {"style", "class"}
            or name not in allowed
            or (name in {"id", "name"} and not value.strip())
        ):
            del element.attrib[attr]

    if tag == "a":
        _sanitize_link(element)
    elif tag == "img":
        _sanitize_image(element)
    if tag in ALLOWED_SVG_TAGS:
        _sanitize_svg_attributes(element, tag)


def _sanitize_link(element: HtmlElement) -> None:
    href = element.get("href", "")
    if not href:
        return
    if href.startswith("//"):
        del element.attrib["href"]
        return
    scheme = urlparse(href).scheme.lower()
    if scheme in FORBIDDEN_URL_SCHEMES or (scheme and scheme not in {"http", "https"}):
        del element.attrib["href"]
        return
    if scheme in {"http", "https"}:
        rel_values = set(element.get("rel", "").split()) | {"noopener", "noreferrer"}
        element.set("rel", " ".join(sorted(rel_values)))
        element.set("target", "_blank")
        element.set("referrerpolicy", "no-referrer")


def _sanitize_image(element: HtmlElement) -> None:
    src = element.get("src", "")
    if not src:
        return
    scheme = urlparse(src).scheme.lower()
    if src.startswith("//") or scheme in FORBIDDEN_URL_SCHEMES:
        del element.attrib["src"]
        return
    if scheme and scheme not in {"http", "https"}:
        del element.attrib["src"]


def _sanitize_svg_attributes(element: HtmlElement, tag: str) -> None:
    for attr in list(element.attrib):
        name = normalized_attr_name(attr)
        value = element.attrib.get(attr, "")
        if name in {"href", "xlink:href"}:
            safe = is_safe_svg_image_href(value) if tag == "image" else is_safe_svg_href(value)
            if not safe:
                del element.attrib[attr]
            continue
        if name in {"clip-path", "fill", "stroke"} and "url(" in value.lower():
            if not is_safe_svg_url_reference(value):
                del element.attrib[attr]


def sanitize_svg_asset_element(element: ET.Element) -> bool:
    """Scrub one parsed SVG asset tree in place; True means drop this element."""
    for child in list(element):
        if sanitize_svg_asset_element(child):
            element.remove(child)

    tag = local_name(element.tag)
    if tag in SVG_FORBIDDEN_TAGS:
        return True

    for attr in list(element.attrib):
        name = normalized_attr_name(attr)
        value = element.attrib.get(attr, "")
        if EVENT_HANDLER_RE.match(name) or name == "style":
            del element.attrib[attr]
            continue
        if name in {"href", "xlink:href"}:
            safe = is_safe_svg_image_href(value) if tag == "image" else is_safe_svg_href(value)
            if not safe:
                del element.attrib[attr]
            continue
        if "url(" in value.lower() and not is_safe_svg_url_reference(value):
            del element.attrib[attr]
    return False


def is_safe_svg_href(value: str) -> bool:
    return bool(value) and value.startswith("#")


def is_safe_svg_image_href(value: str) -> bool:
    if not value or value.startswith("//") or urlparse(value).scheme:
        return False
    return web_paths.is_media_asset_path(value)


def is_safe_svg_url_reference(value: str) -> bool:
    return bool(re.fullmatch(r"url\(#[-A-Za-z0-9_:.]+\)", value.strip().replace(" ", "")))
