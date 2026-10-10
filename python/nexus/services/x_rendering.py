"""Stored HTML, titles and descriptions for X snapshots.

The HTML is conservation material: canonical text, quote placeholders and their
offsets derive from it, so every byte is deliberate.
"""

from __future__ import annotations

import html as html_lib
from collections.abc import Mapping
from dataclasses import dataclass

from nexus.services.x_client import XMedia, XPost, XThread, XUrlEntity, XUser
from nexus.services.x_identity import canonical_x_post_url, classify_x_url


@dataclass(frozen=True, slots=True)
class RenderedQuote:
    ordinal: int  # across the whole thread
    occurrence_key: str
    post_id: str
    placeholder_text: str


@dataclass(frozen=True, slots=True)
class RenderedPost:
    post: XPost
    html: str
    quotes: tuple[RenderedQuote, ...]


def render_thread(thread: XThread) -> list[RenderedPost]:
    """One fragment per thread post, each carrying its quote placeholders."""
    rendered: list[RenderedPost] = []
    ordinal = 0
    for number, post in enumerate(thread.posts, start=1):
        quotes: list[RenderedQuote] = []
        for quote_id in post.quoted_post_ids:
            quoted = thread.quotes[quote_id]
            handle = thread.users[quoted.author_id].username if quoted is not None else None
            placeholder = (
                f"Quoted X post by @{handle} \N{EM DASH} Open in Nexus"
                if handle is not None
                else "Quoted X post unavailable \N{EM DASH} Open on X"
            )
            quotes.append(
                RenderedQuote(ordinal, f"x-quote:{post.id}:{quote_id}", quote_id, placeholder)
            )
            ordinal += 1
        html = _article(post, thread.users, thread.media, number=number, quotes=tuple(quotes))
        rendered.append(RenderedPost(post, html, tuple(quotes)))
    return rendered


def render_post(post: XPost, users: Mapping[str, XUser], media: Mapping[str, XMedia]) -> str:
    """A standalone post; its quotes link out to X."""
    return _article(post, users, media, number=1, quotes=None)


def thread_title(thread: XThread) -> str:
    return f"X thread by {thread.author.name or '@' + thread.author.username}".strip()


def post_title(post: XPost, users: Mapping[str, XUser]) -> str:
    author = users.get(post.author_id)
    if author is None:
        return f"X post {post.id}"
    return f"X post by {author.name}" if author.name else f"X post by @{author.username}"


def thread_description(thread: XThread) -> str:
    texts = (_text_without_quote_urls(post) for post in thread.posts)
    return "\n\n".join(text for text in texts if text).strip()[:2000]


def post_description(post: XPost) -> str:
    return _text_without_quote_urls(post)[:2000]


def _article(
    post: XPost,
    users: Mapping[str, XUser],
    media: Mapping[str, XMedia],
    *,
    number: int,
    quotes: tuple[RenderedQuote, ...] | None,
) -> str:
    author = users.get(post.author_id)
    parts = [
        f"<article><h2>Post {number}</h2><p>",
        f"<strong>{_esc(author.name if author is not None else 'Unknown author')}</strong>",
    ]
    if author is not None and author.username:
        parts.append(
            f' <a href="https://x.com/{_attr(author.username)}">@{_esc(author.username)}</a>'
        )
    if post.created_at:
        parts.append(f" - {_esc(post.created_at)}")
    parts.append(f' - <a href="{_attr(canonical_x_post_url(post.id))}">Open on X</a></p>')
    text = _text_without_quote_urls(post)
    parts.append(f"<p>{'<br>'.join(_esc(line) for line in text.splitlines())}</p>")
    for entity in post.urls:
        if not _is_quote_url(post, entity):
            href = entity.expanded_url or entity.url
            label = entity.display_url or entity.title or href
            parts.append(f'<p><a href="{_attr(href)}">{_esc(label)}</a></p>')
    for key in post.media_keys:
        item = media.get(key)
        image_url = (item.url or item.preview_image_url) if item is not None else None
        if item is not None and image_url:
            parts.append(
                f'<figure><img src="{_attr(image_url)}" alt="{_attr(item.alt_text or item.type)}">'
                f"<figcaption>{_esc(item.type)}</figcaption></figure>"
            )
    if quotes is None:
        parts.extend(
            f'<p class="x-quote-reference"><a href="{_attr(canonical_x_post_url(quote_id))}">'
            "Quotes another X post \N{EM DASH} Open on X</a></p>"
            for quote_id in post.quoted_post_ids
        )
    else:
        parts.extend(
            f'<figure class="x-quote-reference" data-nexus-document-embed-id='
            f'"{_attr(quote.occurrence_key)}" data-nexus-document-embed-kind="x_post">'
            f"<figcaption>{_esc(quote.placeholder_text)}</figcaption></figure>"
            for quote in quotes
        )
    parts.append("</article>")
    return "".join(parts)


def _text_without_quote_urls(post: XPost) -> str:
    text = post.text
    for entity in post.urls:
        if _is_quote_url(post, entity):
            text = text.replace(entity.url, "")
    return text.strip()


def _is_quote_url(post: XPost, entity: XUrlEntity) -> bool:
    quoted = set(post.quoted_post_ids)
    return any(
        (identity := classify_x_url(url)) is not None and identity.provider_id in quoted
        for url in (entity.expanded_url, entity.url)
        if url is not None
    )


def _esc(value: str) -> str:
    return html_lib.escape(value, quote=False)


def _attr(value: str) -> str:
    return html_lib.escape(value, quote=True)
