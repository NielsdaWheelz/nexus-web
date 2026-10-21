"""The one html sanitizer: one walker with a web policy, an epub policy and svg assets.

Its output is the stored `fragments.html_sanitized` and every apparatus body: the input
to canonicalization, and the reader's xss boundary (the web client injects it as is).
Each policy is part of the persisted byte contract. web lowercases tag names, drops svg,
absolutizes urls, keeps a link of any scheme but javascript, vbscript, data and file, and
keeps only http(s) images, proxied. epub reads local tag names, keeps only relative and
http(s) urls, svg (with its text, which canonical text counts), and a span for an unknown
element with an id. Both strip event handlers, `style`, `class`, script-capable elements and
inert `template` content, then emit shapes libxml2 and html5 parse alike.

Nothing is stored that the reader would not show, nor shown that canonical text would not
count (one exception: the image placeholder's decoration, `aria-hidden` so that neither
canonical text nor the reader's cursor counts it). An element `hidden` hides goes with its
content, in any state but `until-found` (content meant to be found: it keeps its content and
loses the attribute). `hidden` is an html rendering rule, so svg, and an svg element inside
it, keeps its content too. web drops `noscript` with its content (tracking pixels, script
nags: a page's fallback, not its article); epub keeps it, the fallback a reading system that
runs no scripts shows. epub also drops `aria-hidden`, which hides nothing on screen, and the
text svg never draws: its `title`, `desc` and `metadata`, and character data outside `text`
(whitespace aside).
"""

import re
from urllib.parse import quote, urldefrag, urljoin, urlparse
from xml.etree import ElementTree as ET

from lxml.etree import LxmlError, ParserError
from lxml.html import HtmlElement

from nexus import web_paths
from nexus.services.html_tree import (
    inner_html,
    normalize_html5_shape,
    parse_html_document,
    serialize_html,
)

_FORBIDDEN_SCHEMES = frozenset({"javascript", "vbscript", "data", "file"})
_EVENT_HANDLER_RE = re.compile(r"^on", re.IGNORECASE)
_HTML_SPACE = " \t\n\r\f"
_STAMPS = frozenset(
    "data-reader-apparatus-item-id data-reader-apparatus-kind"
    " data-reader-apparatus-confidence".split()
)
_EMBED_ATTRS = frozenset("data-nexus-document-embed-id data-nexus-document-embed-kind".split())

_WEB_TAGS = frozenset(
    "p br strong em b i u s cite blockquote pre code ul ol li h1 h2 h3 h4 h5 h6 hr a img"
    " table thead tbody tr th td sup sub xref"
    " div span section article header footer nav aside figure figcaption".split()
)
_WEB_DROPPED = frozenset(
    "script style iframe form object embed svg meta link base template noscript".split()
)
_WEB_ATTRS = {
    "a": frozenset({"href", "title"}),
    "img": frozenset({"src", "alt"}),
    "th": frozenset({"colspan", "rowspan"}),
    "td": frozenset({"colspan", "rowspan"}),
}

_EPUB_TAGS = frozenset(
    "p br strong em b i u s blockquote pre code ul ol li dl dt dd h1 h2 h3 h4 h5 h6 hr a"
    " img table thead tbody tfoot tr th td sup sub xref div span section article header"
    " footer nav aside figure figcaption main".split()
)
_EPUB_DROPPED = frozenset(
    "script iframe object embed form meta base link style template foreignobject"
    " animate set feimage title desc metadata".split()
)
_EPUB_GLOBAL_ATTRS = frozenset(
    "id title lang dir xml:lang aria-labelledby data-reader-source-warning"
    " data-reader-apparatus-item-id data-reader-apparatus-kind"
    " data-reader-apparatus-confidence".split()
)
_EPUB_ATTRS = {
    "a": frozenset("href title name".split()),
    "img": frozenset("src srcset alt title width height".split()),
    "th": frozenset("colspan rowspan scope".split()),
    "td": frozenset("colspan rowspan".split()),
}
_SVG_TAGS = frozenset(
    "svg g image path circle ellipse line polyline polygon rect use defs symbol"
    " clippath lineargradient radialgradient stop text tspan".split()
)
_SVG_TEXT_ATTRS = frozenset(
    "x y dx dy rotate transform fill stroke stroke-width opacity font-family font-size"
    " font-style font-weight text-anchor dominant-baseline".split()
)
_SVG_ASSET_FORBIDDEN = frozenset(
    "script animate animatemotion animatetransform set foreignobject iframe object embed"
    " audio video source track style".split()
)
# Attribute names are matched lowercased, so every entry here is lowercase.
_SVG_ATTRS = {
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
    "clippath": frozenset({"id"}),
    "lineargradient": frozenset("id x1 x2 y1 y2 gradientunits gradienttransform".split()),
    "radialgradient": frozenset("id cx cy r fx fy gradientunits gradienttransform".split()),
    "stop": frozenset("offset stop-color stop-opacity".split()),
    "text": _SVG_TEXT_ATTRS,
    "tspan": _SVG_TEXT_ATTRS,
}


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


def sanitize_html(
    html: str,
    base_url: str,
    *,
    document_url: str | None,
    allow_reader_apparatus_attrs: bool = False,
    allow_document_embed_attrs: bool = False,
) -> str:
    """The web policy. Resolve assets against base_url; only document_url identifies
    local links, which become `#fragment`."""
    if not html or not html.strip():
        return ""
    try:
        doc = parse_html_document(html)
    except ParserError as exc:
        raise ValueError(f"Failed to parse HTML: {exc}") from exc
    body = doc.body
    if body is None:
        return ""
    document_url = urldefrag(document_url).url if document_url is not None else None

    def visit(element: HtmlElement, tag: str) -> None:
        if tag not in _WEB_TAGS:
            element.drop_tag()
            return
        for attr in list(element.attrib):
            name = attr.lower()
            if name in _STAMPS:
                keep = allow_reader_apparatus_attrs
            elif name in _EMBED_ATTRS:
                keep = allow_document_embed_attrs and tag in {"figure", "figcaption"}
            elif name == "aria-labelledby":
                keep = True
            elif name == "id" or (name == "name" and tag == "a"):
                value = element.attrib[attr]
                keep = bool(value) and not any(c.isspace() or ord(c) < 32 for c in value)
            else:
                keep = name in _WEB_ATTRS.get(tag, ())
            if not keep:
                del element.attrib[attr]
        if tag == "a" and (href := element.get("href", "")):
            absolute_url = urljoin(base_url, href)
            if urlparse(absolute_url).scheme.lower() in _FORBIDDEN_SCHEMES:
                del element.attrib["href"]
            elif (
                document_url is not None
                and urldefrag(absolute_url).url == document_url
                and "#" in href
            ):
                element.set("href", f"#{urldefrag(absolute_url).fragment}")
            else:
                element.set("href", absolute_url)
                _open_outbound(element)
        elif tag == "img" and (src := element.get("src", "")):
            absolute_url = urljoin(base_url, src)
            if urlparse(absolute_url).scheme.lower() not in {"http", "https"}:
                del element.attrib["src"]
            else:
                element.set("src", web_paths.media_image_url(quote(absolute_url, safe="")))

    _browser_newlines(body)
    for child in list(body):
        if isinstance(child, HtmlElement):
            _walk(child, visit, _WEB_DROPPED, str.lower)
    normalize_html5_shape(body)
    return inner_html(body)


def sanitize_epub_chapter(html: str) -> str:
    """The epub policy: package-local links and assets stay, inline svg is scrubbed."""
    if not html or not html.strip():
        return ""
    try:
        doc = parse_html_document(html)
    except LxmlError as exc:
        raise ValueError(f"Failed to parse EPUB HTML: {exc}") from exc
    body = doc.body
    if body is None:
        if isinstance(doc, HtmlElement):
            _browser_newlines(doc)
            _walk(doc, _visit_epub, _EPUB_DROPPED, local_name)
            return serialize_html(doc)
        return ""
    _browser_newlines(body)
    for child in list(body):
        if isinstance(child, HtmlElement):
            _walk(child, _visit_epub, _EPUB_DROPPED, local_name)
    normalize_html5_shape(body)
    _drop_undrawn_svg_text(body, in_svg=False)
    return inner_html(body)


def sanitize_svg_asset_element(element: ET.Element) -> bool:
    """Scrub one parsed svg asset tree in place; True means drop this element."""
    for child in list(element):
        if sanitize_svg_asset_element(child):
            element.remove(child)
    tag = local_name(element.tag)
    if tag in _SVG_ASSET_FORBIDDEN:
        return True
    for attr in list(element.attrib):
        name = normalized_attr_name(attr)
        value = element.attrib.get(attr, "")
        if _EVENT_HANDLER_RE.match(name) or name == "style":
            del element.attrib[attr]
        elif name in {"href", "xlink:href"}:
            if not _safe_svg_href(tag, value):
                del element.attrib[attr]
        elif "url(" in value.lower() and not _safe_svg_url_reference(value):
            del element.attrib[attr]
    return False


def _browser_newlines(root: HtmlElement) -> None:
    """A `&#13;` reference leaves a carriage return where libxml2 splits text, so canonical
    text would miscount whitespace against the reader's dom (L12): each CRLF pair or lone CR
    becomes one line feed, the newline normalization html gives its input."""
    for node in root.iter():
        if node.text and "\r" in node.text:
            node.text = node.text.replace("\r\n", "\n").replace("\r", "\n")
        if node.tail and "\r" in node.tail:
            node.tail = node.tail.replace("\r\n", "\n").replace("\r", "\n")


def hides(element: HtmlElement, tag_name=local_name) -> bool:
    """`hidden` hides an html element in any state but until-found; svg, and an svg
    element inside it, ignores it (the rendering rule is html's alone)."""
    hidden = element.get("hidden")
    if hidden is None or hidden.lower() == "until-found":
        return False
    tag = tag_name(element.tag)
    return tag not in _SVG_TAGS or (
        tag != "svg" and all(tag_name(a.tag) != "svg" for a in element.iterancestors())
    )


def _walk(element: HtmlElement, visit, dropped: frozenset[str], tag_name) -> None:
    """An element the policy drops, or one `hidden` hides, goes with its content; any other
    is visited after its children, named by the policy. (A body-less document's root
    stays: it has no parent to leave.)"""
    tag = tag_name(element.tag)
    if tag in dropped or (hides(element, tag_name) and element.getparent() is not None):
        element.drop_tree()
        return
    for child in list(element):
        if isinstance(child, HtmlElement):
            _walk(child, visit, dropped, tag_name)
    visit(element, tag)


def _drop_undrawn_svg_text(element: HtmlElement, *, in_svg: bool) -> None:
    """svg draws character data only inside `text`; any other inside an svg goes, but
    whitespace, which adds at most a collapsible space, stays as stored. Runs on the
    normalized tree, where an svg holds what html5 parsing puts in it."""
    tag = local_name(element.tag)
    in_svg = in_svg or tag == "svg"
    if tag == "text":
        return
    if in_svg:
        if (element.text or "").strip(_HTML_SPACE):
            element.text = None
        for child in element:
            if (child.tail or "").strip(_HTML_SPACE):
                child.tail = None
    for child in element:
        if isinstance(child, HtmlElement):
            _drop_undrawn_svg_text(child, in_svg=in_svg)


def _visit_epub(element: HtmlElement, tag: str) -> None:
    if tag not in _EPUB_TAGS and tag not in _SVG_TAGS:
        if element_id(element) is None:
            if element.getparent() is not None:
                element.drop_tag()
            return
        element.tag = tag = "span"
    allowed = (
        _EPUB_GLOBAL_ATTRS | _EPUB_ATTRS.get(tag, frozenset()) | _SVG_ATTRS.get(tag, frozenset())
    )
    if tag == "span" and element.get("data-reader-source-warning") is not None:
        allowed |= {"name", "role", "aria-label"}
    parent = element.getparent()
    if parent is not None and parent.get("data-reader-source-warning") is not None:
        allowed |= {"aria-hidden"}  # the placeholder's decoration
    for attr in list(element.attrib):
        name = normalized_attr_name(attr)
        value = element.attrib.get(attr, "")
        if name not in allowed or (name in {"id", "name"} and not value.strip()):
            del element.attrib[attr]
        elif tag in _SVG_TAGS and name in {"href", "xlink:href"}:
            if not _safe_svg_href(tag, value):
                del element.attrib[attr]
        elif tag in _SVG_TAGS and name in {"clip-path", "fill", "stroke"}:
            if "url(" in value.lower() and not _safe_svg_url_reference(value):
                del element.attrib[attr]
    if tag == "a" and (href := element.get("href", "")):
        scheme = "" if href.startswith("//") else urlparse(href).scheme.lower()
        if href.startswith("//") or (scheme and scheme not in {"http", "https"}):
            del element.attrib["href"]
        elif scheme:
            _open_outbound(element)
    elif tag == "img" and (src := element.get("src", "")):
        scheme = urlparse(src).scheme.lower()
        if src.startswith("//") or (scheme and scheme not in {"http", "https"}):
            del element.attrib["src"]


def _open_outbound(link: HtmlElement) -> None:
    # `rel` is never allowed, so the policies have already removed any authored value.
    link.set("rel", "noopener noreferrer")
    link.set("target", "_blank")
    link.set("referrerpolicy", "no-referrer")


def _safe_svg_href(tag: str, value: str) -> bool:
    if tag != "image":
        return bool(value) and value.startswith("#")
    if not value or value.startswith("//") or urlparse(value).scheme:
        return False
    return web_paths.is_media_asset_path(value)


def _safe_svg_url_reference(value: str) -> bool:
    return bool(re.fullmatch(r"url\(#[-A-Za-z0-9_:.]+\)", value.strip().replace(" ", "")))
