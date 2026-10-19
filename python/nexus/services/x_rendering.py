"""Literal X post and article HTML derived from accepted source content.

Attribution, reply/quote relations, provenance and capture messages belong to the
reader projection. Foreign words and generated placeholders never enter this body.
"""

from __future__ import annotations

from html import escape

from nexus.schemas.x_source import XArticleText, XSourcePost


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
