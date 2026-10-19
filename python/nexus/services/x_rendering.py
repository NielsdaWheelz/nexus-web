"""Reader HTML derived only from normalized X evidence."""

from __future__ import annotations

import html as html_lib
from collections.abc import Mapping
from dataclasses import dataclass

from nexus.schemas.x_source import XSourcePost, XSourceSnapshot
from nexus.services.x_identity import canonical_x_article_url, canonical_x_post_url
from nexus.services.x_source import authored_text


@dataclass(frozen=True, slots=True)
class RenderedQuote:
    ordinal: int
    occurrence_key: str
    post_id: str
    placeholder_text: str


@dataclass(frozen=True, slots=True)
class RenderedArticle:
    ordinal: int
    occurrence_key: str
    article_id: str
    placeholder_text: str


@dataclass(frozen=True, slots=True)
class RenderedPost:
    post: XSourcePost
    html: str
    quotes: tuple[RenderedQuote, ...]
    articles: tuple[RenderedArticle, ...]


def render_source(
    snapshot: XSourceSnapshot, *, embed_quotes: bool, article_ids: Mapping[str, str]
) -> tuple[RenderedPost, ...]:
    """One fragment per primary; direct context remains attributed to its own author."""
    rendered: list[RenderedPost] = []
    ordinal = 0
    for number, post_id in enumerate(snapshot.primary_post_ids, start=1):
        post = snapshot.posts[post_id]
        quotes: list[RenderedQuote] = []
        articles: list[RenderedArticle] = []
        if embed_quotes:
            for reference in post.references:
                if reference.kind != "quoted":
                    continue
                quoted = snapshot.posts.get(reference.post_id)
                if snapshot.source_kind == "post":
                    placeholder = "Quotes another X post \N{EM DASH} Open on X"
                elif quoted is not None:
                    placeholder = (
                        f"Quoted X post by @{quoted.author.username} \N{EM DASH} Open in Nexus"
                    )
                else:
                    placeholder = "Quoted X post unavailable \N{EM DASH} Open on X"
                quotes.append(
                    RenderedQuote(
                        ordinal,
                        f"x-quote:{post.id}:{reference.post_id}",
                        reference.post_id,
                        placeholder,
                    )
                )
                ordinal += 1
        article_id = article_ids.get(post_id)
        if article_id is not None:
            articles.append(
                RenderedArticle(
                    ordinal, f"x-article:{post.id}:{article_id}", article_id, "x article"
                )
            )
            ordinal += 1
        parts = [f"<article><h2>Post {number}</h2>", _byline(post), _body(post)]
        if embed_quotes:
            parts.extend(
                f'<figure class="x-quote-reference" data-nexus-document-embed-id='
                f'"{_attr(quote.occurrence_key)}" data-nexus-document-embed-kind="x_post">'
                f"<figcaption>{_esc(quote.placeholder_text)}</figcaption></figure>"
                for quote in quotes
            )
        else:
            parts.extend(
                f'<p class="x-quote-reference"><a href="{_attr(canonical_x_post_url(reference.post_id))}">'
                "Quotes another X post — Open on X</a></p>"
                for reference in post.references
                if reference.kind == "quoted"
            )
        parts.extend(
            f'<figure id="{_attr(article.occurrence_key)}" '
            f'data-nexus-document-embed-id="{_attr(article.occurrence_key)}" '
            'data-nexus-document-embed-kind="link_preview"><figcaption>'
            f'<a href="{_attr(canonical_x_article_url(article.article_id))}">'
            f"{_esc(article.placeholder_text)}</a></figcaption></figure>"
            for article in articles
        )
        for reference in post.references:
            if reference.kind == "quoted" or reference.post_id in snapshot.primary_post_ids:
                continue
            relation = "Replying to" if reference.kind == "replied_to" else "Reposted"
            target = snapshot.posts.get(reference.post_id)
            url = canonical_x_post_url(reference.post_id)
            if target is not None:
                parts.append(
                    f"<blockquote><p>{relation}</p>{_byline(target)}{_body(target)}</blockquote>"
                )
            else:
                availability = (
                    "unavailable" if reference.availability == "unavailable" else "not captured"
                )
                parts.append(
                    f'<p>{relation} an X post ({availability}) — <a href="{_attr(url)}">Open on X</a></p>'
                )
        parts.append("</article>")
        rendered.append(RenderedPost(post, "".join(parts), tuple(quotes), tuple(articles)))
    return tuple(rendered)


def _byline(post: XSourcePost) -> str:
    author = post.author
    parts = [
        f"<p><strong>{_esc(author.name)}</strong>" if author.name else "<p>",
        f' <a href="https://x.com/{_attr(author.username)}">@{_esc(author.username)}</a>',
    ]
    if post.created_at is not None:
        timestamp = post.created_at.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        parts.append(f" - {_esc(timestamp)}")
    parts.append(f' - <a href="{_attr(canonical_x_post_url(post.id))}">Open on X</a></p>')
    return "".join(parts)


def _body(post: XSourcePost) -> str:
    value = authored_text(post, remove_attachment_urls=False)
    parts = [f"<p>{'<br>'.join(_esc(line) for line in value.splitlines())}</p>"]
    # Reader text retains attachment links, including saved positions in older publications.
    retained = {entity.url for entity in post.urls if entity.url in value}
    for entity in post.urls:
        if entity.url not in retained:
            continue
        href = entity.expanded_url if entity.expanded_url is not None else entity.url
        label = (
            entity.display_url
            if entity.display_url is not None
            else entity.title
            if entity.title is not None
            else href
        )
        parts.append(f'<p><a href="{_attr(href)}">{_esc(label)}</a></p>')
    for item in post.attachments:
        image = item.url if item.url is not None else item.preview_image_url
        if image is not None:
            alt = item.alt_text if item.alt_text is not None else item.type
            parts.append(
                f'<figure><img src="{_attr(image)}" alt="{_attr(alt)}">'
                f"<figcaption>{_esc(item.type)}</figcaption></figure>"
            )
    return "".join(parts)


def _esc(value: str) -> str:
    return html_lib.escape(value, quote=False)


def _attr(value: str) -> str:
    return html_lib.escape(value, quote=True)
