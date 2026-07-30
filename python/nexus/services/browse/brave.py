"""Read-only Brave Browse and safe public-article Preview adapter."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from urllib.parse import quote, urljoin, urlsplit

from lxml import html
from web_search_tool.types import (
    WebSearchError,
    WebSearchErrorCode,
    WebSearchProvider,
    WebSearchRequest,
    WebSearchResultType,
)

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.schemas.browse import (
    BrowseCandidate,
    BrowseSource,
    PreviewResolution,
    WebArticleCandidate,
    WebArticleFacts,
)
from nexus.schemas.contributors import ContributorCreditOut
from nexus.schemas.presence import absent, present
from nexus.services.browse.models import (
    BrowseProviderFailure,
    BrowseQuery,
    BrowseSectionFailureKind,
    BrowseTargetNotFound,
    brave_target,
    seal_target,
)
from nexus.services.net.safe_fetch import SafeFetchNotFound, safe_get
from nexus.services.url_normalize import normalize_url_for_display, validate_requested_url
from nexus.web_paths import media_image_url

_MAX_PREVIEW_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class BraveArticle:
    canonical_url: str
    source_href: str
    title: str
    description: str | None
    published_at: datetime | None
    image_href: str | None
    contributors: list[ContributorCreditOut]
    site_name: str


@dataclass(frozen=True, slots=True)
class _BrowseWebSearchRequest:
    """Brave request envelope with Browse-owned query validity.

    The shared chat-tool request narrows valid queries to two characters and
    fifty words. Browse owns a different public contract: exact NFC text of
    1–200 code points. The Brave provider consumes this same structural
    envelope and does not own those product-level restrictions.
    """

    query: str
    result_type: WebSearchResultType
    limit: int
    freshness_days: int | None = None
    allowed_domains: tuple[str, ...] = ()
    blocked_domains: tuple[str, ...] = ()
    country: str = "US"
    search_lang: str = "en"
    safe_search: Literal["off", "moderate", "strict"] = "moderate"


async def search(
    provider: WebSearchProvider | None,
    *,
    query: BrowseQuery,
) -> tuple[list[BrowseCandidate], str | None]:
    if provider is None:
        raise RuntimeError("Brave Browse provider is not configured")
    if query.cursor is not None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_CURSOR, "Invalid cursor")
    try:
        result = await provider.search(
            cast(
                WebSearchRequest,
                _BrowseWebSearchRequest(
                    query=query.query,
                    result_type=WebSearchResultType.MIXED,
                    limit=query.limit,
                ),
            )
        )
    except WebSearchError as exc:
        if exc.code is WebSearchErrorCode.RATE_LIMITED:
            raise BrowseProviderFailure(BrowseSectionFailureKind.RateLimited) from exc
        if exc.code in {
            WebSearchErrorCode.TIMEOUT,
            WebSearchErrorCode.PROVIDER_DOWN,
        }:
            raise BrowseProviderFailure(BrowseSectionFailureKind.Unavailable) from exc
        raise RuntimeError(f"Brave Browse provider defect: {exc.code.value}") from exc
    return [_candidate(item) for item in result.results], None


def preview(canonical_url: str) -> BraveArticle:
    try:
        fetched = safe_get(
            canonical_url,
            max_bytes=_MAX_PREVIEW_BYTES,
            timeout_s=15.0,
        )
    except SafeFetchNotFound as exc:
        raise BrowseTargetNotFound from exc
    if fetched.content_type not in {"text/html", "application/xhtml+xml"}:
        raise RuntimeError("Brave Web Article target returned non-HTML content")
    try:
        document = html.document_fromstring(fetched.content)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("Brave Web Article target returned malformed HTML") from exc
    source_href = _canonical_public_url(fetched.final_url)
    title = _first_text(document.xpath("//title/text()"))
    if title is None:
        title = _meta(document, "property", "og:title")
    if title is None:
        raise RuntimeError("Brave Web Article target has no title")
    description = _meta(document, "name", "description") or _meta(
        document,
        "property",
        "og:description",
    )
    author = _meta(document, "name", "author")
    published_at = _instant_or_none(_meta(document, "property", "article:published_time"))
    image_href = _meta(document, "property", "og:image")
    if image_href is not None:
        try:
            image_href = _canonical_public_url(urljoin(source_href, image_href))
        except (InvalidRequestError, ValueError):
            image_href = None
    contributors = []
    if author is not None:
        contributors.append(
            ContributorCreditOut(
                credited_name=author,
                contributor_display_name=author,
                role="author",
            )
        )
    return BraveArticle(
        canonical_url=canonical_url,
        source_href=source_href,
        title=title,
        description=description,
        published_at=published_at,
        image_href=_proxied_image(image_href),
        contributors=contributors,
        site_name=urlsplit(source_href).hostname or "",
    )


def _candidate(citation) -> WebArticleCandidate:
    canonical_url = _canonical_public_url(citation.url)
    if not citation.title.strip():
        raise RuntimeError("Brave Browse result has no title")
    target = seal_target(
        brave_target(
            canonical_url,
            result_ref=citation.result_ref,
        )
    )
    return WebArticleCandidate(
        source=BrowseSource.Brave,
        resolution=PreviewResolution(target=target),
        title=citation.title,
        contributors=[],
        description=absent() if not citation.snippet else present(citation.snippet),
        published_at=(
            absent() if citation.published_at is None else present(_instant(citation.published_at))
        ),
        image=absent(),
        kind_facts=WebArticleFacts(
            site_name=present(citation.source_name or urlsplit(canonical_url).hostname or "")
        ),
    )


def _canonical_public_url(value: str) -> str:
    try:
        validate_requested_url(value)
    except (InvalidRequestError, ValueError) as exc:
        raise RuntimeError("Brave returned an invalid public URL") from exc
    return normalize_url_for_display(value)


def _instant(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeError("Brave returned an invalid publication instant") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeError("Brave returned a timezone-free publication instant")
    return parsed


def _instant_or_none(value: str | None) -> datetime | None:
    return None if value is None else _instant(value)


def _first_text(values: list[object]) -> str | None:
    for value in values:
        normalized = " ".join(str(value).split())
        if normalized:
            return normalized
    return None


def _meta(document, attribute: str, value: str) -> str | None:
    return _first_text(
        document.xpath(
            f"//meta[translate(@{attribute}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', "
            f"'abcdefghijklmnopqrstuvwxyz')='{value}']/@content"
        )
    )


def _proxied_image(value: str | None) -> str | None:
    if value is None:
        return None
    return media_image_url(quote(value, safe=""))
