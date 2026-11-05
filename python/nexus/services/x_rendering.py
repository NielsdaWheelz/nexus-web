"""Literal X post and article HTML derived from accepted source content.

Attribution, reply/quote relations, provenance and capture messages belong to the
reader projection. Foreign words and generated placeholders never enter this body.
"""

from __future__ import annotations

import json
import re
from html import escape
from urllib.parse import parse_qs, urlparse
from uuid import UUID

from nexus.schemas.x_source import (
    XArticleExcerptCapture,
    XArticleText,
    XCompletePostCapture,
    XPostContent,
    XSourcePost,
)
from nexus.services.html_tree import parse_html_document, serialize_html
from nexus.services.sanitize_html import sanitize_html


def render_article(article: XArticleText) -> str:
    """Keep every prose line break; no inferred structure, metadata, media or notices."""
    return "<p>" + escape(article.plain_text, quote=False).replace("\n", "<br>") + "</p>"


def render_post_text(content: XPostContent) -> str:
    """Link observed URL tokens without adding labels to the authored paragraph."""
    words = "\n".join(content.text.splitlines())
    urls = {entity.url: entity.expanded_url or entity.url for entity in content.urls}
    pattern = "|".join(re.escape(url) for url in sorted(urls, key=len, reverse=True))
    parts = ["<p>"]
    start = 0
    for match in re.finditer(pattern, words) if urls else ():
        parts.append(escape(words[start : match.start()], quote=False).replace("\n", "<br>"))
        parts.append(
            f'<a href="{escape(urls[match[0]], quote=True)}">{escape(match[0], quote=False)}</a>'
        )
        start = match.end()
    parts.append(escape(words[start:], quote=False).replace("\n", "<br>"))
    parts.append("</p>")
    return "".join(parts)


def render_post(post: XSourcePost) -> str:
    content = post.content
    parts = [render_post_text(content)]
    for attachment in content.attachments:
        image = attachment.url or attachment.preview_image_url
        if image is None:
            continue
        alt = attachment.alt_text if attachment.alt_text is not None else attachment.type
        parts.append(
            f'<figure><img src="{escape(image, quote=True)}" alt="{escape(alt, quote=True)}"></figure>'
        )
    return "".join(parts)


def capture_image_urls(payload: dict[str, object]) -> dict[str, str]:
    """The immutable payload is the only image manifest; videos expose posters only."""
    if payload["kind"] == "article_excerpt":
        excerpt = XArticleExcerptCapture.model_validate_json(json.dumps(payload))
        return {image.asset_key: image.source_url for image in excerpt.images}
    complete = XCompletePostCapture.model_validate_json(json.dumps(payload))
    return {
        image.media_key: url
        for image in complete.content.attachments
        if (url := image.url if image.type == "photo" else image.preview_image_url) is not None
    }


def normalized_capture_html(
    html: str, *, payload: dict[str, object], revision_id: str, capture_id: UUID | None
) -> str:
    """Compare literal markup independently of its per-capture archive URLs."""
    images = capture_image_urls(payload)
    owned = (
        {}
        if capture_id is None
        else {f"/api/x/captures/{capture_id}/assets/{key}": url for key, url in images.items()}
    )
    document = parse_html_document(html)
    for image in document.iter("img"):
        src = image.get("src") or ""
        upstream = parse_qs(urlparse(src).query).get("url")
        if src in owned:
            image.set("src", owned[src])
        elif upstream:
            image.set("src", upstream[0])
    return sanitize_html(
        serialize_html(document),
        f"https://x.com/i/status/{revision_id}",
        document_url=f"https://x.com/i/status/{revision_id}",
        capture_assets={url: f"nexus-capture-image:{key}" for key, url in images.items()},
    )
