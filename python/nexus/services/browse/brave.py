"""Brave web search for Browse, and a safe public-article Preview."""

from __future__ import annotations

from urllib.parse import urljoin, urlsplit

from llm_tools import (
    WebSearchError,
    WebSearchErrorCode,
    WebSearchProvider,
    WebSearchRequest,
    WebSearchResultType,
)
from lxml import html

from nexus.schemas.browse import (
    PreviewResolution,
    WebArticleCandidate,
    WebArticleFacts,
    WebArticlePreview,
    WebArticlePreviewFacts,
)
from nexus.schemas.presence import absent
from nexus.schemas.presence import presence_from_nullable as maybe
from nexus.services.browse.targets import (
    BraveWebArticleTarget,
    BrowseFailureKind,
    BrowseProviderFailure,
    BrowseTargetNotFound,
    instant,
    proxied_image,
    public_url,
    retry_at,
    seal_target,
    single_credit,
)
from nexus.services.net.safe_fetch import SafeFetchNotFound, safe_get
from nexus.services.sealed_handles import DiscoveryTargetHandle


async def search(
    provider: WebSearchProvider | None, q: str, *, limit: int
) -> list[WebArticleCandidate]:
    """One page of public web articles; a malformed provider item is skipped."""
    if provider is None:
        raise BrowseProviderFailure(BrowseFailureKind.Unavailable)
    try:
        result = await provider.search(
            WebSearchRequest(query=q, result_type=WebSearchResultType.MIXED, limit=limit)
        )
    except WebSearchError as exc:
        if exc.code is WebSearchErrorCode.RATE_LIMITED:
            raise BrowseProviderFailure(
                BrowseFailureKind.RateLimited, retry_at=retry_at(exc.retry_after)
            ) from exc
        if exc.code in (WebSearchErrorCode.TIMEOUT, WebSearchErrorCode.PROVIDER_DOWN):
            raise BrowseProviderFailure(BrowseFailureKind.Unavailable) from exc
        raise RuntimeError(f"Brave Browse provider defect: {exc.code.value}") from exc
    items = []
    for hit in result.results:
        url = public_url(hit.url)
        try:
            published = None if hit.published_at is None else instant(hit.published_at)
        except ValueError:
            continue
        if url is None or not hit.title.strip():
            continue
        items.append(
            WebArticleCandidate(
                resolution=PreviewResolution(
                    target=seal_target(BraveWebArticleTarget(canonicalUrl=url))
                ),
                title=hit.title,
                contributors=[],
                description=maybe(hit.snippet or None),
                published_at=maybe(published),
                image=absent(),
                kind_facts=WebArticleFacts(
                    site_name=maybe(hit.source_name or urlsplit(url).hostname or "")
                ),
            )
        )
    return items


def preview(target: BraveWebArticleTarget, handle: DiscoveryTargetHandle) -> WebArticlePreview:
    """The article's own title, byline, description, date and image, fetched safely."""
    try:
        fetched = safe_get(target.canonical_url, max_bytes=2 * 1024 * 1024, timeout_s=15.0)
    except SafeFetchNotFound as exc:
        raise BrowseTargetNotFound from exc
    source_href = public_url(fetched.final_url)
    if fetched.content_type not in {"text/html", "application/xhtml+xml"} or source_href is None:
        raise RuntimeError("Brave Web Article target is not a public HTML page")
    try:
        document = html.document_fromstring(fetched.content)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Brave Web Article target returned malformed HTML") from exc
    title = _first(document.xpath("//title/text()")) or _meta(document, "property", "og:title")
    if title is None:
        raise RuntimeError("Brave Web Article target has no title")
    published = _meta(document, "property", "article:published_time")
    image = _meta(document, "property", "og:image")
    description = _meta(document, "name", "description") or _meta(
        document, "property", "og:description"
    )
    return WebArticlePreview(
        target=handle,
        title=title,
        contributors=single_credit(_meta(document, "name", "author"), "author"),
        description=maybe(description),
        published_at=maybe(None if published is None else instant(published)),
        image=maybe(proxied_image(image and public_url(urljoin(source_href, image)))),
        source_href=source_href,
        resolution=PreviewResolution(target=handle),
        kind_facts=WebArticlePreviewFacts(
            canonical_url=target.canonical_url, site_name=maybe(urlsplit(source_href).hostname)
        ),
    )


def _first(values: list[object]) -> str | None:
    return next((" ".join(str(v).split()) for v in values if " ".join(str(v).split())), None)


def _meta(document, attribute: str, value: str) -> str | None:
    lower = "translate(@{0}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')"
    return _first(document.xpath(f"//meta[{lower.format(attribute)}='{value}']/@content"))
