"""Stored HTML rendering for official X snapshots."""

from __future__ import annotations

import html as html_lib
from collections.abc import Mapping
from uuid import UUID

from nexus.services.x_types import (
    XAuthorThreadSnapshot,
    XMediaSnapshot,
    XPostSnapshot,
    XUrlEntity,
    XUserSnapshot,
    canonical_x_post_url,
)


def render_author_thread_fragment_html(
    snapshot: XAuthorThreadSnapshot,
    *,
    quoted_media_ids: Mapping[str, UUID],
    app_public_url: str,
) -> list[tuple[XPostSnapshot, str]]:
    rendered: list[tuple[XPostSnapshot, str]] = []
    for idx, post in enumerate(snapshot.posts, start=1):
        rendered.append(
            (
                post,
                _render_post_article(
                    post,
                    users=snapshot.users,
                    media=snapshot.media,
                    quoted_posts=snapshot.quoted_posts,
                    quoted_media_ids=quoted_media_ids,
                    app_public_url=app_public_url,
                    ordinal=idx,
                ),
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
        quoted_posts={},
        quoted_media_ids={},
        app_public_url="",
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
    return "\n\n".join(post.text for post in snapshot.posts if post.text).strip()[:2000]


def post_description(post: XPostSnapshot) -> str:
    return post.text.strip()[:2000]


def _render_post_article(
    post: XPostSnapshot,
    *,
    users: Mapping[str, XUserSnapshot],
    media: Mapping[str, XMediaSnapshot],
    quoted_posts: Mapping[str, XPostSnapshot],
    quoted_media_ids: Mapping[str, UUID],
    app_public_url: str,
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

    parts = ["<article>", *header, _paragraph(post.text)]
    parts.extend(_render_links(post.urls))
    parts.extend(_render_media(post.media_keys, media))
    for quoted_id in post.quoted_post_ids:
        parts.append(
            _render_quote_block(
                quoted_id,
                quoted_posts=quoted_posts,
                users=users,
                media=media,
                quoted_media_ids=quoted_media_ids,
                app_public_url=app_public_url,
            )
        )
    parts.append("</article>")
    return "".join(parts)


def _render_quote_block(
    quoted_id: str,
    *,
    quoted_posts: Mapping[str, XPostSnapshot],
    users: Mapping[str, XUserSnapshot],
    media: Mapping[str, XMediaSnapshot],
    quoted_media_ids: Mapping[str, UUID],
    app_public_url: str,
) -> str:
    quoted = quoted_posts.get(quoted_id)
    if quoted is None:
        return (
            "<blockquote>"
            "<p>Quoted post unavailable in this archival snapshot.</p>"
            f'<p><a href="{_attr(canonical_x_post_url(quoted_id))}">Open quoted post on X</a></p>'
            "</blockquote>"
        )

    author = users.get(quoted.author_id)
    author_label = "Unknown author"
    if author is not None:
        author_label = f"{author.name} (@{author.username})"

    link = canonical_x_post_url(quoted.id)
    media_id = quoted_media_ids.get(quoted.id)
    if media_id is not None and app_public_url:
        link = f"{app_public_url.rstrip('/')}/media/{media_id}"

    return "".join(
        [
            "<blockquote>",
            f"<p><strong>Quoted post by {_esc(author_label)}</strong></p>",
            _paragraph(quoted.text),
            *_render_links(quoted.urls),
            *_render_media(quoted.media_keys, media),
            f'<p><a href="{_attr(link)}">Open quoted post</a></p>',
            "</blockquote>",
        ]
    )


def _render_links(urls: tuple[XUrlEntity, ...]) -> list[str]:
    rendered: list[str] = []
    for entity in urls:
        href = entity.expanded_url or entity.url
        label = entity.display_url or entity.title or href
        rendered.append(f'<p><a href="{_attr(href)}">{_esc(label)}</a></p>')
    return rendered


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
