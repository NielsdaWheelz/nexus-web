"""The closed HTML policy for anonymously shared article, transcript and EPUB units."""

from __future__ import annotations

import re
from collections.abc import Mapping
from urllib.parse import urlparse, urlsplit

from lxml.html import fragment_fromstring

from nexus.services.canonicalize import generate_canonical_text
from nexus.services.epub_ingest import srcset_candidates
from nexus.services.html_tree import inner_html, serialize_html
from nexus.services.sanitize_html import sanitize_epub_chapter

_DROP_WITH_CONTENT = frozenset(
    "script style iframe object embed form input button select option textarea video audio"
    " source track canvas math link meta base template".split()
)
# The structural containers ingest keeps stay too: an in-document link may target their id.
_ALLOWED_TAGS = frozenset(
    "a abbr article aside b blockquote br cite code dd del details dfn div dl dt em figcaption"
    " figure footer h1 h2 h3 h4 h5 h6 header hr i img kbd li main mark nav ol p pre q s samp"
    " section small span strong sub summary sup table tbody td tfoot th thead tr u ul var".split()
)
_GLOBAL_ATTRIBUTES = frozenset({"id", "title", "lang", "dir", "role", "aria-hidden", "hidden"})
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
    raw_html: str,
    *,
    units: Mapping[str, str],
    assets: Mapping[str, str],
    embed_slots: Mapping[str, str] | None = None,
    apparatus: Mapping[str, str] | None = None,
    anchors: Mapping[str, str],
    expected_identity: str,
) -> str:
    """Keep only allowlisted tags and attributes; nothing private crosses.

    External http(s) links open referrer-free in a new tab; `#id` links stay in their unit; an
    EPUB link to another unit becomes `#` naming that unit's ordinal (`units`: private id ->
    ordinal). Every image loses its source; an EPUB image whose source is exactly a private
    asset path gets its public ordinal (`assets`: asset key -> ordinal) as
    `data-nexus-public-asset`.
    """
    root = fragment_fromstring(raw_html, create_parent=True)
    # The existing retained-DOM policy owns safe SVG primitives and drawn text.
    # Apply it only to SVG, retaining reader-owned link and embed bindings elsewhere.
    for svg in root.xpath(".//svg[not(ancestor::svg)]"):
        tail = svg.tail
        svg.tail = None
        safe = fragment_fromstring(sanitize_epub_chapter(serialize_html(svg)))
        svg.tail = tail
        safe.tail = tail
        svg.getparent().replace(svg, safe)
    svg_nodes = {node for svg in root.xpath(".//svg") for node in svg.iter()}

    for element in list(root.iterdescendants()):
        if not isinstance(element.tag, str):
            element.drop_tree()
            continue
        tag = element.tag.lower().rsplit("}", 1)[-1]
        original_id = element.get("id")
        if original_id is not None:
            if original_id in anchors:
                element.set("id", anchors[original_id])
            else:
                element.attrib.pop("id", None)
        if element in svg_nodes:
            labelled_by = element.get("aria-labelledby")
            for name in list(element.attrib):
                if name.startswith("data-reader-") or name == "aria-labelledby":
                    del element.attrib[name]
            if labelled_by:
                labels = [anchors[value] for value in labelled_by.split() if value in anchors]
                if labels:
                    element.set("aria-labelledby", " ".join(labels))
            # Sanitization above removed scripts, unsafe URL references and attributes.
            # SVG image sources still pass through the same public asset manifest.
            if tag == "image":
                src = element.get("href") or element.get("xlink:href") or ""
                for key in ("href", "xlink:href"):
                    element.attrib.pop(key, None)
                source_asset = _MEDIA_ASSET_RE.fullmatch(urlsplit(src).path)
                if (ordinal := assets.get(source_asset[1] if source_asset else src)) is not None:
                    element.set("data-nexus-public-asset", ordinal)
                    element.set("data-nexus-public-identity", expected_identity)
            for attribute, value in list(element.attrib.items()):
                if value.startswith("#"):
                    target = anchors.get(value[1:])
                    if target is None:
                        element.attrib.pop(attribute, None)
                    else:
                        element.set(attribute, "#" + target)
                elif "url(#" in value:
                    element.set(
                        attribute,
                        re.sub(
                            r"url\(#([^)]*)\)",
                            lambda match: "url(#" + anchors[match[1]] + ")"
                            if match[1] in anchors
                            else "none",
                            value,
                        ),
                    )
            continue
        if tag in _DROP_WITH_CONTENT:
            element.drop_tree()
            continue
        if tag not in _ALLOWED_TAGS:
            element.drop_tag()
            continue
        unit = units.get(element.get("data-nexus-fragment-id") or "")
        anchor = anchors.get(element.get("data-nexus-anchor-id") or "")
        slot = (embed_slots or {}).get(element.get("data-nexus-document-embed-id") or "")
        x_slot = element.get("data-nexus-document-embed-kind") == "x_post"
        src = element.get("src") or next(
            (url for url, _ in srcset_candidates(element.get("srcset") or "")), ""
        )
        asset = _MEDIA_ASSET_RE.fullmatch(urlsplit(src).path)
        note = (apparatus or {}).get(element.get("data-reader-apparatus-item-id") or "")
        if element.get("headers") is not None:
            header_ids = [
                anchors[value] for value in element.get("headers", "").split() if value in anchors
            ]
            if header_ids:
                element.set("headers", " ".join(header_ids))
            else:
                element.attrib.pop("headers", None)
        allowed = _GLOBAL_ATTRIBUTES | _TAG_ATTRIBUTES.get(tag, frozenset())
        for attr in list(element.attrib):
            name = attr.lower().rsplit("}", 1)[-1]
            if name.startswith("on") or name not in allowed:
                del element.attrib[attr]

        if note is not None:
            element.set("data-reader-apparatus-item-id", note)
            element.set("data-nexus-public-identity", expected_identity)
            if tag == "a":
                element.set("href", "#")
        if slot is not None:
            element.set("data-nexus-document-embed-id", slot)
            if x_slot:
                element.set("data-nexus-document-embed-kind", "x_post")

        if tag == "a" and note is None and (href := element.get("href")) is not None:
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
            elif href.startswith("#") and href[1:] in anchors:
                element.set("href", "#" + anchors[href[1:]])
            else:
                del element.attrib["href"]
        elif tag == "img" and (ordinal := assets.get(asset[1] if asset else src)) is not None:
            element.set("data-nexus-public-asset", ordinal)
            element.set("data-nexus-public-identity", expected_identity)
    result = inner_html(root)
    if generate_canonical_text(result) != generate_canonical_text(raw_html):
        raise ValueError("public policy cannot faithfully represent this text")
    return result
