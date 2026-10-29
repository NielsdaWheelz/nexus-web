"""Literal X post and article HTML derived from accepted source content.

Attribution, reply/quote relations, provenance and capture messages belong to the
reader projection. Foreign words and generated placeholders never enter this body.
"""

from __future__ import annotations

import json
from html import escape
from urllib.parse import parse_qs, urlparse
from uuid import UUID

from nexus.schemas.x_source import (
    XArticleExcerptCapture,
    XArticleText,
    XCompletePostCapture,
    XSourcePost,
)
from nexus.services.html_tree import parse_html_document, serialize_html
from nexus.services.sanitize_html import sanitize_html


def render_article(article: XArticleText) -> str:
    """Keep every prose line break; no inferred structure, metadata, media or notices."""
    return "<p>" + escape(article.plain_text, quote=False).replace("\n", "<br>") + "</p>"


def render_post(post: XSourcePost) -> str:
    content = post.content
    parts = [
        f"<p>{'<br>'.join(escape(line, quote=False) for line in content.text.splitlines())}</p>"
    ]
    for entity in content.urls:
        if entity.url not in content.text:
            continue
        href = entity.expanded_url or entity.url
        label = entity.display_url or entity.title or href
        parts.append(
            f'<p><a href="{escape(href, quote=True)}">{escape(label, quote=False)}</a></p>'
        )
    for attachment in content.attachments:
        image = attachment.url or attachment.preview_image_url
        if image is None:
            continue
        alt = attachment.alt_text if attachment.alt_text is not None else attachment.type
        parts.append(
            f'<figure><img src="{escape(image, quote=True)}" alt="{escape(alt, quote=True)}"><figcaption>{escape(attachment.type, quote=False)}</figcaption></figure>'
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
