"""The web-article sanitizer: allowlisted tags and attributes, proxied images.

Its output is the stored `fragments.html_sanitized` and therefore the input to
canonicalization, so every rule here is part of the persisted byte contract.
"""

import re
from urllib.parse import quote, urljoin, urlparse

from lxml.etree import ParserError
from lxml.html import HtmlElement

from nexus import web_paths
from nexus.services.html_tree import inner_html, normalize_html5_shape, parse_html_document

ALLOWED_TAGS = frozenset(
    "p br strong em b i u s cite blockquote pre code ul ol li h1 h2 h3 h4 h5 h6 hr a img"
    " table thead tbody tr th td sup sub xref"
    # Container elements, allowed but stripped of attributes.
    " div span section article header footer nav aside figure figcaption".split()
)
ALLOWED_ATTRS = {
    "a": {"href", "title"},
    "img": {"src", "alt"},
    "th": {"colspan", "rowspan"},
    "td": {"colspan", "rowspan"},
}
# Reader clients read these three out of the stored HTML.
READER_APPARATUS_ATTRS = frozenset(
    "data-reader-apparatus-item-id data-reader-apparatus-kind"
    " data-reader-apparatus-confidence".split()
)
DOCUMENT_EMBED_ATTRS = frozenset(
    "data-nexus-document-embed-id data-nexus-document-embed-kind".split()
)
DROPPED_WITH_CONTENT = frozenset("script style iframe form object embed svg meta link base".split())
FORBIDDEN_SCHEMES = frozenset({"javascript", "vbscript", "data", "file"})
EVENT_HANDLER_RE = re.compile(r"^on", re.IGNORECASE)


def sanitize_html(
    html: str,
    base_url: str,
    *,
    allow_reader_apparatus_attrs: bool = False,
    allow_document_embed_attrs: bool = False,
) -> str:
    """Sanitize extracted article HTML into the stored fragment shape."""
    if not html or not html.strip():
        return ""
    try:
        doc = parse_html_document(html)
    except ParserError as exc:
        raise ValueError(f"Failed to parse HTML: {exc}") from exc
    body = doc.body
    if body is None:
        return ""
    for child in list(body):
        if isinstance(child, HtmlElement):
            _sanitize_element(
                child,
                base_url,
                allow_reader_apparatus_attrs=allow_reader_apparatus_attrs,
                allow_document_embed_attrs=allow_document_embed_attrs,
            )
    normalize_html5_shape(body)
    return inner_html(body)


def _sanitize_element(
    element: HtmlElement,
    base_url: str,
    *,
    allow_reader_apparatus_attrs: bool,
    allow_document_embed_attrs: bool,
) -> None:
    for child in list(element):
        if isinstance(child, HtmlElement):
            _sanitize_element(
                child,
                base_url,
                allow_reader_apparatus_attrs=allow_reader_apparatus_attrs,
                allow_document_embed_attrs=allow_document_embed_attrs,
            )

    tag = element.tag.lower() if element.tag else ""
    if tag in DROPPED_WITH_CONTENT:
        element.drop_tree()
        return
    if tag not in ALLOWED_TAGS:
        element.drop_tag()
        return

    allowed = ALLOWED_ATTRS.get(tag, set())
    for attr in list(element.attrib):
        name = attr.lower()
        if name in READER_APPARATUS_ATTRS:
            keep = allow_reader_apparatus_attrs
        elif name in DOCUMENT_EMBED_ATTRS:
            keep = allow_document_embed_attrs and tag in {"figure", "figcaption"}
        else:
            keep = (
                not EVENT_HANDLER_RE.match(name)
                and name not in {"style", "class", "id"}
                and not (name == "name" and tag == "a")
                and name in allowed
            )
        if not keep:
            del element.attrib[attr]

    if tag == "a":
        _sanitize_link(element, base_url)
    elif tag == "img":
        _sanitize_image(element, base_url)


def _sanitize_link(element: HtmlElement, base_url: str) -> None:
    href = element.get("href", "")
    if not href:
        return
    absolute_url = urljoin(base_url, href)
    if urlparse(absolute_url).scheme.lower() in FORBIDDEN_SCHEMES:
        del element.attrib["href"]
        return
    element.set("href", absolute_url)
    rel_values = set(element.get("rel", "").split()) | {"noopener", "noreferrer"}
    element.set("rel", " ".join(sorted(rel_values)))
    element.set("target", "_blank")
    element.set("referrerpolicy", "no-referrer")


def _sanitize_image(element: HtmlElement, base_url: str) -> None:
    src = element.get("src", "")
    if not src:
        return
    absolute_url = urljoin(base_url, src)
    if urlparse(absolute_url).scheme.lower() not in {"http", "https"}:
        del element.attrib["src"]
        return
    element.set("src", web_paths.media_image_url(quote(absolute_url, safe="")))
