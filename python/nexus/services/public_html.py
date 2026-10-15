"""The closed HTML policy for anonymously shared article, transcript and EPUB units."""

from __future__ import annotations

import re
from collections.abc import Mapping
from urllib.parse import urlparse

from lxml.html import fragment_fromstring

from nexus.services.html_tree import inner_html

_DROP_WITH_CONTENT = frozenset(
    "script style iframe object embed form input button select option textarea video audio"
    " source track canvas svg math link meta base template".split()
)
# The structural containers ingest keeps stay too: an in-document link may target their id.
_ALLOWED_TAGS = frozenset(
    "a abbr article aside b blockquote br cite code dd del details dfn div dl dt em figcaption"
    " figure footer h1 h2 h3 h4 h5 h6 header hr i img kbd li main mark nav ol p pre q s samp"
    " section small span strong sub summary sup table tbody td tfoot th thead tr u ul var".split()
)
_GLOBAL_ATTRIBUTES = frozenset({"id", "title", "lang", "dir", "role"})
_TAG_ATTRIBUTES = {
    "a": frozenset({"href"}),
    "blockquote": frozenset({"cite"}),
    "q": frozenset({"cite"}),
    "img": frozenset({"alt", "title", "width", "height"}),
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
    raw_html: str, *, units: Mapping[str, str], assets: Mapping[str, str]
) -> str:
    """Keep only allowlisted tags and attributes; nothing private crosses.

    External http(s) links open referrer-free in a new tab; `#id` links stay in their unit; an
    EPUB link to another unit becomes `#` naming that unit's ordinal (`units`: private id ->
    ordinal). Every image loses its source; an EPUB image whose source is exactly a private
    asset path gets its public ordinal (`assets`: asset key -> ordinal) as
    `data-nexus-public-asset`.
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
        unit = units.get(element.get("data-nexus-fragment-id") or "")
        anchor = element.get("data-nexus-anchor-id")
        asset = _MEDIA_ASSET_RE.fullmatch(element.get("src") or "")
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
            elif unit is not None:
                element.set("href", "#")
                element.set("data-nexus-fragment-id", unit)
                if anchor:
                    element.set("data-nexus-anchor-id", anchor)
            elif not (href.startswith("#") and len(href) > 1):
                del element.attrib["href"]
        elif tag == "img" and asset and (ordinal := assets.get(asset[1])) is not None:
            element.set("data-nexus-public-asset", ordinal)
    return inner_html(root)
