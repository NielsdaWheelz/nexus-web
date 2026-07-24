"""Dedicated closed sanitizer for anonymous article and EPUB HTML."""

from __future__ import annotations

import re
from collections.abc import Callable
from urllib.parse import urlparse

from lxml.html import HtmlElement, fragment_fromstring, tostring

_DROP_WITH_CONTENT = frozenset(
    {
        "script",
        "style",
        "iframe",
        "object",
        "embed",
        "form",
        "input",
        "button",
        "select",
        "option",
        "textarea",
        "video",
        "audio",
        "source",
        "track",
        "canvas",
        "svg",
        "math",
        "link",
        "meta",
        "base",
        "template",
    }
)
_ALLOWED_TAGS = frozenset(
    {
        "a",
        "abbr",
        "b",
        "blockquote",
        "br",
        "cite",
        "code",
        "dd",
        "del",
        "details",
        "dfn",
        "div",
        "dl",
        "dt",
        "em",
        "figcaption",
        "figure",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "i",
        "img",
        "kbd",
        "li",
        "mark",
        "ol",
        "p",
        "pre",
        "q",
        "s",
        "samp",
        "small",
        "span",
        "strong",
        "sub",
        "summary",
        "sup",
        "table",
        "tbody",
        "td",
        "tfoot",
        "th",
        "thead",
        "tr",
        "u",
        "ul",
        "var",
    }
)
_GLOBAL_ATTRIBUTES = frozenset({"id", "title", "lang", "dir", "role"})
_TAG_ATTRIBUTES = {
    "a": frozenset({"href"}),
    "blockquote": frozenset({"cite"}),
    "q": frozenset({"cite"}),
    # src is admitted only long enough for _sanitize_image to translate an
    # exact private EPUB asset path into an inert public handle, then removed.
    "img": frozenset({"alt", "title", "width", "height", "src"}),
    "ol": frozenset({"start", "reversed", "type"}),
    "li": frozenset({"value"}),
    "td": frozenset({"colspan", "rowspan", "headers"}),
    "th": frozenset({"colspan", "rowspan", "headers", "scope", "abbr"}),
}
_MEDIA_ASSET_RE = re.compile(
    r"^/api/media/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/assets/(?P<asset_key>[A-Za-z0-9_./-]+)$"
)
_PUBLIC_ASSET_HANDLE_RE = re.compile(r"^nxpa1_[A-Za-z0-9_-]{48}$")


def sanitize_public_article_html(raw_html: str) -> str:
    return _sanitize(raw_html, asset_handle_for_key=None)


def sanitize_public_epub_html(
    raw_html: str,
    *,
    asset_handle_for_key: Callable[[str], str | None],
) -> str:
    return _sanitize(raw_html, asset_handle_for_key=asset_handle_for_key)


def _sanitize(
    raw_html: str,
    *,
    asset_handle_for_key: Callable[[str], str | None] | None,
) -> str:
    root = fragment_fromstring(raw_html, create_parent="div")
    for element in list(root.iterdescendants()):
        if not isinstance(element.tag, str):
            element.drop_tree()
            continue
        tag = element.tag.lower().rsplit("}", 1)[-1]
        if tag in _DROP_WITH_CONTENT:
            element.drop_tree()
            continue
        if tag not in _ALLOWED_TAGS:
            element.drop_tag()
            continue

        allowed = _GLOBAL_ATTRIBUTES | _TAG_ATTRIBUTES.get(tag, frozenset())
        for attr in list(element.attrib):
            normalized = attr.lower().rsplit("}", 1)[-1]
            if normalized.startswith("on") or normalized not in allowed:
                del element.attrib[attr]

        if tag == "a":
            _sanitize_link(element)
        elif tag == "img":
            _sanitize_image(element, asset_handle_for_key=asset_handle_for_key)

    chunks: list[str] = []
    if root.text:
        chunks.append(root.text)
    for child in root:
        rendered = tostring(child, encoding="unicode", method="html")
        chunks.append(rendered.decode("utf-8") if isinstance(rendered, bytes) else rendered)
    return "".join(chunks)


def _sanitize_link(element: HtmlElement) -> None:
    href = element.get("href")
    if href is None:
        return
    if href.startswith("#"):
        element.attrib.pop("href", None)
        return
    parsed = urlparse(href)
    if parsed.scheme:
        if (
            parsed.scheme.lower() not in {"http", "https"}
            or parsed.username is not None
            or parsed.password is not None
            or not parsed.hostname
        ):
            element.attrib.pop("href", None)
            return
        element.set("target", "_blank")
        element.set("rel", "noopener noreferrer")
        element.set("referrerpolicy", "no-referrer")
        return
    if href.startswith("//") or href:
        element.attrib.pop("href", None)


def _sanitize_image(
    element: HtmlElement,
    *,
    asset_handle_for_key: Callable[[str], str | None] | None,
) -> None:
    raw_src = element.get("src")
    for attr in ("src", "srcset", "sizes", "loading", "fetchpriority"):
        element.attrib.pop(attr, None)
    if raw_src is None or asset_handle_for_key is None:
        return
    match = _MEDIA_ASSET_RE.fullmatch(raw_src)
    if match is None:
        return
    handle = asset_handle_for_key(match.group("asset_key"))
    if handle is not None and _PUBLIC_ASSET_HANDLE_RE.fullmatch(handle):
        element.set("data-nexus-public-asset-handle", handle)
