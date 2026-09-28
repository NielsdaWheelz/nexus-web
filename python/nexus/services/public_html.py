"""The closed HTML policy for anonymously shared article and EPUB fragments."""

from __future__ import annotations

import re
from collections.abc import Callable
from urllib.parse import urlparse

from lxml.html import fragment_fromstring

from nexus.services.html_tree import inner_html

_DROP_WITH_CONTENT = frozenset(
    "script style iframe object embed form input button select option textarea video audio"
    " source track canvas svg math link meta base template".split()
)
_ALLOWED_TAGS = frozenset(
    "a abbr b blockquote br cite code dd del details dfn div dl dt em figcaption figure"
    " h1 h2 h3 h4 h5 h6 hr i img kbd li mark ol p pre q s samp small span strong sub"
    " summary sup table tbody td tfoot th thead tr u ul var".split()
)
_GLOBAL_ATTRIBUTES = frozenset({"id", "title", "lang", "dir", "role"})
_TAG_ATTRIBUTES = {
    "a": frozenset({"href"}),
    "blockquote": frozenset({"cite"}),
    "q": frozenset({"cite"}),
    "img": frozenset({"alt", "title", "width", "height", "src"}),
    "ol": frozenset({"start", "reversed", "type"}),
    "li": frozenset({"value"}),
    "td": frozenset({"colspan", "rowspan", "headers"}),
    "th": frozenset({"colspan", "rowspan", "headers", "scope", "abbr"}),
}
_MEDIA_ASSET_RE = re.compile(
    r"^/api/media/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/assets/([A-Za-z0-9_./-]+)$"
)


def sanitize_public_html(
    raw_html: str, asset_handle_for_key: Callable[[str], str | None] | None = None
) -> str:
    """Keep only allowlisted tags and attributes; external links open referrer-free in a new tab.

    Every image loses its source. An EPUB image whose source is exactly a private
    asset path the caller can hand out gets that handle as
    `data-nexus-public-asset-handle` instead.
    """
    root = fragment_fromstring(raw_html, create_parent=True)
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
            name = attr.lower().rsplit("}", 1)[-1]
            if name.startswith("on") or name not in allowed:
                del element.attrib[attr]

        if tag == "a" and (href := element.get("href")) is not None:
            parsed = urlparse(href)
            if (
                parsed.scheme.lower() in {"http", "https"}
                and parsed.hostname
                and parsed.username is None
                and parsed.password is None
            ):
                element.set("target", "_blank")
                element.set("rel", "noopener noreferrer")
                element.set("referrerpolicy", "no-referrer")
            elif href:
                del element.attrib["href"]
        elif tag == "img":
            src = element.get("src")
            for attr in ("src", "srcset", "sizes", "loading", "fetchpriority"):
                element.attrib.pop(attr, None)
            match = _MEDIA_ASSET_RE.fullmatch(src or "")
            if match and asset_handle_for_key and (handle := asset_handle_for_key(match[1])):
                element.set("data-nexus-public-asset-handle", handle)
    return inner_html(root)
