"""Stored HTML rendering for official X snapshots."""

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
    XUnavailableQuoteReference,
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
    rendered: list[RenderedXFragment] = []
    quote_ordinal = 0
    for idx, post in enumerate(snapshot.posts, start=1):
        occurrences: list[RenderedXQuoteOccurrence] = []
        quoted_post_ids = post.quoted_post_ids
        if len(quoted_post_ids) > 1:
            # justify-defect: X posts own at most one direct quoted-post
            # reference, which makes the containing-post identity a stable key.
            raise AssertionError("X post returned multiple direct quote references")
        for post_id in quoted_post_ids:
            reference = snapshot.quote_references.get(post_id)
            if reference is None:
                # justify-defect: the provider boundary returns one classified
                # result for every direct quote in the selected thread.
                raise AssertionError("X thread quote reference was not classified")
            if isinstance(reference, XResolvedQuoteReference):
                author = snapshot.users.get(reference.post.author_id)
                if author is None:
                    # justify-defect: resolved provider quote snapshots include
                    # the author used by their compact reference.
                    raise AssertionError("resolved X quote author is missing")
                placeholder_text = f"Quoted X post by @{author.username} \N{EM DASH} Open in Nexus"
            elif isinstance(reference, XUnavailableQuoteReference):
                placeholder_text = "Quoted X post unavailable \N{EM DASH} Open on X"
            else:
                # justify-defect: XQuoteReference is a closed owned union.
                raise AssertionError("unknown X quote reference variant")
            occurrences.append(
                RenderedXQuoteOccurrence(
                    ordinal=quote_ordinal,
                    occurrence_key=f"x-quote:{post.id}:{post_id}",
                    post_id=post_id,
                    placeholder_text=placeholder_text,
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
                    ordinal=idx,
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
        post,
        users=users,
        media=media,
        quote_occurrences=(),
        external_quotes=True,
        ordinal=1,
    )


def thread_title(snapshot: XAuthorThreadSnapshot) -> str:
    return f"X thread by {snapshot.author.name or '@' + snapshot.author.username}".strip()


def post_title(post: XPostSnapshot, users: Mapping[str, XUserSnapshot]) -> str:
    author = users.get(post.author_id)
    if author is not None and author.name:
        return f"X post by {author.name}"
    if author is not None and author.username:
        return f"X post by @{author.username}"
    return f"X post {post.id}"


def thread_description(snapshot: XAuthorThreadSnapshot) -> str:
    return "\n\n".join(
        text for post in snapshot.posts if (text := _text_without_quote_urls(post))
    ).strip()[:2000]


def post_description(post: XPostSnapshot) -> str:
    return _text_without_quote_urls(post)[:2000]


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
    author_name = author.name if author is not None else "Unknown author"
    username = author.username if author is not None else ""
    header = [
        f"<h2>Post {ordinal}</h2>",
        "<p>",
        f"<strong>{_esc(author_name)}</strong>",
    ]
    if username:
        header.append(f' <a href="https://x.com/{_attr(username)}">@{_esc(username)}</a>')
    if post.created_at:
        header.append(f" - {_esc(post.created_at)}")
    header.append(f' - <a href="{_attr(post.permalink)}">Open on X</a>')
    header.append("</p>")

    parts = ["<article>", *header, _paragraph(_text_without_quote_urls(post))]
    parts.extend(
        _render_links(tuple(entity for entity in post.urls if not _is_quote_url(post, entity)))
    )
    parts.extend(_render_media(post.media_keys, media))
    if external_quotes:
        for post_id in post.quoted_post_ids:
            parts.append(
                '<p class="x-quote-reference">'
                f'<a href="{_attr(canonical_x_post_url(post_id))}">'
                f"Quotes another X post \N{EM DASH} Open on X"
                "</a></p>"
            )
    else:
        for occurrence in quote_occurrences:
            parts.append(
                '<figure class="x-quote-reference" '
                f'data-nexus-document-embed-id="{_attr(occurrence.occurrence_key)}" '
                'data-nexus-document-embed-kind="x_post">'
                f"<figcaption>{_esc(occurrence.placeholder_text)}</figcaption>"
                "</figure>"
            )
    parts.append("</article>")
    return "".join(parts)


def _render_links(urls: tuple[XUrlEntity, ...]) -> list[str]:
    rendered: list[str] = []
    for entity in urls:
        href = entity.expanded_url or entity.url
        label = entity.display_url or entity.title or href
        rendered.append(f'<p><a href="{_attr(href)}">{_esc(label)}</a></p>')
    return rendered


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
        if url is None:
            continue
        identity = classify_x_url(url)
        if identity is not None and identity.provider_id in quoted_post_ids:
            return True
    return False


def _render_media(media_keys: tuple[str, ...], media: Mapping[str, XMediaSnapshot]) -> list[str]:
    rendered: list[str] = []
    for media_key in media_keys:
        item = media.get(media_key)
        if item is None:
            continue
        image_url = item.url or item.preview_image_url
        if image_url:
            alt = item.alt_text or item.type
            rendered.append(
                "<figure>"
                f'<img src="{_attr(image_url)}" alt="{_attr(alt)}">'
                f"<figcaption>{_esc(item.type)}</figcaption>"
                "</figure>"
            )
    return rendered


def _paragraph(text: str) -> str:
    if not text.strip():
        return "<p></p>"
    return f"<p>{'<br>'.join(_esc(line) for line in text.splitlines())}</p>"


def _esc(value: str) -> str:
    return html_lib.escape(value, quote=False)


def _attr(value: str) -> str:
    return html_lib.escape(value, quote=True)
