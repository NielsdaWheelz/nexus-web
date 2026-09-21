"""Stored HTML, titles and descriptions for official X snapshots."""

from __future__ import annotations

import html as html_lib
from collections.abc import Mapping
from dataclasses import dataclass

from nexus.services.x_identity import classify_x_url
from nexus.services.x_types import (
    XAuthorThreadSnapshot,
    XMediaSnapshot,
    XPostSnapshot,
    XQuoteReference,
    XResolvedQuoteReference,
    XUrlEntity,
    XUserSnapshot,
    canonical_x_post_url,
)


@dataclass(frozen=True, slots=True)
class RenderedXQuoteOccurrence:
    ordinal: int
    occurrence_key: str
    post_id: str
    placeholder_text: str
    reference: XQuoteReference


@dataclass(frozen=True, slots=True)
class RenderedXFragment:
    post: XPostSnapshot
    html: str
    quote_occurrences: tuple[RenderedXQuoteOccurrence, ...]


def render_author_thread_fragment_html(
    snapshot: XAuthorThreadSnapshot,
) -> list[RenderedXFragment]:
    """One fragment per thread post, each carrying its embedded quote marker."""
    rendered: list[RenderedXFragment] = []
    quote_ordinal = 0
    for ordinal, post in enumerate(snapshot.posts, start=1):
        occurrences: list[RenderedXQuoteOccurrence] = []
        for quoted_id in post.quoted_post_ids:
            reference = snapshot.quote_references[quoted_id]
            occurrences.append(
                RenderedXQuoteOccurrence(
                    ordinal=quote_ordinal,
                    occurrence_key=f"x-quote:{post.id}:{quoted_id}",
                    post_id=quoted_id,
                    placeholder_text=_placeholder_text(snapshot, reference),
                    reference=reference,
                )
            )
            quote_ordinal += 1
        rendered.append(
            RenderedXFragment(
                post=post,
                html=_render_post_article(
                    post,
                    users=snapshot.users,
                    media=snapshot.media,
                    quote_occurrences=tuple(occurrences),
                    external_quotes=False,
                    ordinal=ordinal,
                ),
                quote_occurrences=tuple(occurrences),
            )
        )
    return rendered


def render_single_post_html(
    post: XPostSnapshot,
    *,
    users: Mapping[str, XUserSnapshot],
    media: Mapping[str, XMediaSnapshot],
) -> str:
    return _render_post_article(
        post, users=users, media=media, quote_occurrences=(), external_quotes=True, ordinal=1
    )


def thread_title(snapshot: XAuthorThreadSnapshot) -> str:
    return f"X thread by {snapshot.author.name or '@' + snapshot.author.username}".strip()


def post_title(post: XPostSnapshot, users: Mapping[str, XUserSnapshot]) -> str:
    author = users.get(post.author_id)
    if author is None:
        return f"X post {post.id}"
    return f"X post by {author.name}" if author.name else f"X post by @{author.username}"


def thread_description(snapshot: XAuthorThreadSnapshot) -> str:
    return "\n\n".join(
        text for post in snapshot.posts if (text := _text_without_quote_urls(post))
    ).strip()[:2000]


def post_description(post: XPostSnapshot) -> str:
    return _text_without_quote_urls(post)[:2000]


def _placeholder_text(snapshot: XAuthorThreadSnapshot, reference: XQuoteReference) -> str:
    if isinstance(reference, XResolvedQuoteReference):
        author = snapshot.users[reference.post.author_id]
        return f"Quoted X post by @{author.username} \N{EM DASH} Open in Nexus"
    return "Quoted X post unavailable \N{EM DASH} Open on X"


def _render_post_article(
    post: XPostSnapshot,
    *,
    users: Mapping[str, XUserSnapshot],
    media: Mapping[str, XMediaSnapshot],
    quote_occurrences: tuple[RenderedXQuoteOccurrence, ...],
    external_quotes: bool,
    ordinal: int,
) -> str:
    author = users.get(post.author_id)
    username = author.username if author is not None else ""
    parts = [
        "<article>",
        f"<h2>Post {ordinal}</h2>",
        "<p>",
        f"<strong>{_esc(author.name if author is not None else 'Unknown author')}</strong>",
    ]
    if username:
        parts.append(f' <a href="https://x.com/{_attr(username)}">@{_esc(username)}</a>')
    if post.created_at:
        parts.append(f" - {_esc(post.created_at)}")
    parts.append(f' - <a href="{_attr(post.permalink)}">Open on X</a>')
    parts.append("</p>")
    parts.append(_paragraph(_text_without_quote_urls(post)))
    for entity in post.urls:
        if _is_quote_url(post, entity):
            continue
        href = entity.expanded_url or entity.url
        parts.append(
            f'<p><a href="{_attr(href)}">{_esc(entity.display_url or entity.title or href)}</a></p>'
        )
    for media_key in post.media_keys:
        item = media.get(media_key)
        image_url = (item.url or item.preview_image_url) if item is not None else None
        if item is not None and image_url:
            parts.append(
                "<figure>"
                f'<img src="{_attr(image_url)}" alt="{_attr(item.alt_text or item.type)}">'
                f"<figcaption>{_esc(item.type)}</figcaption>"
                "</figure>"
            )
    if external_quotes:
        parts.extend(
            '<p class="x-quote-reference">'
            f'<a href="{_attr(canonical_x_post_url(quoted_id))}">'
            f"Quotes another X post \N{EM DASH} Open on X"
            "</a></p>"
            for quoted_id in post.quoted_post_ids
        )
    else:
        parts.extend(
            '<figure class="x-quote-reference" '
            f'data-nexus-document-embed-id="{_attr(occurrence.occurrence_key)}" '
            'data-nexus-document-embed-kind="x_post">'
            f"<figcaption>{_esc(occurrence.placeholder_text)}</figcaption>"
            "</figure>"
            for occurrence in quote_occurrences
        )
    parts.append("</article>")
    return "".join(parts)


def _text_without_quote_urls(post: XPostSnapshot) -> str:
    text = post.text
    for entity in post.urls:
        if _is_quote_url(post, entity):
            text = text.replace(entity.url, "")
    return text.strip()


def _is_quote_url(post: XPostSnapshot, entity: XUrlEntity) -> bool:
    quoted_post_ids = set(post.quoted_post_ids)
    if not quoted_post_ids:
        return False
    for url in (entity.expanded_url, entity.url):
        identity = classify_x_url(url) if url is not None else None
        if identity is not None and identity.provider_id in quoted_post_ids:
            return True
    return False


def _paragraph(text: str) -> str:
    if not text.strip():
        return "<p></p>"
    return f"<p>{'<br>'.join(_esc(line) for line in text.splitlines())}</p>"


def _esc(value: str) -> str:
    return html_lib.escape(value, quote=False)


def _attr(value: str) -> str:
    return html_lib.escape(value, quote=True)
