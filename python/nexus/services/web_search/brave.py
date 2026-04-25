"""Brave Search API provider for public web search."""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

import httpx

from nexus.services.web_search.types import (
    WebSearchError,
    WebSearchErrorCode,
    WebSearchRequest,
    WebSearchResponse,
    WebSearchResultItem,
    WebSearchResultType,
)

BRAVE_PROVIDER = "brave"
BRAVE_DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1"
BRAVE_SEARCH_MAX_ATTEMPTS = 2
BRAVE_MAX_ATTEMPTS = BRAVE_SEARCH_MAX_ATTEMPTS
BRAVE_RETRY_BACKOFF_SECONDS = 0.25


class BraveSearchProvider:
    """Async Brave Search provider with normalized result contracts."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        api_key: str,
        base_url: str = BRAVE_DEFAULT_BASE_URL,
        timeout_seconds: float = 8.0,
    ) -> None:
        self._client = client
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        """Run a Brave web/news search and return normalized results."""

        if not self._api_key:
            raise WebSearchError(
                WebSearchErrorCode.INVALID_KEY,
                "Brave Search API key is not configured",
                provider=BRAVE_PROVIDER,
            )

        url = self._endpoint_for(request)
        params = self._build_params(request)
        headers = {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": self._api_key,
        }

        last_error: WebSearchError | None = None
        for attempt in range(BRAVE_SEARCH_MAX_ATTEMPTS):
            try:
                response = await self._client.get(
                    url,
                    params=params,
                    headers=headers,
                    timeout=httpx.Timeout(self._timeout_seconds, connect=5.0),
                )
                response.raise_for_status()
                data = response.json()
                provider_request_id = (
                    response.headers.get("x-request-id")
                    or response.headers.get("request-id")
                    or data.get("request_id")
                )
                return self._parse_response(data, request, provider_request_id)
            except httpx.TimeoutException as exc:
                last_error = WebSearchError(
                    WebSearchErrorCode.TIMEOUT,
                    "Brave Search request timed out",
                    provider=BRAVE_PROVIDER,
                )
                if attempt + 1 >= BRAVE_SEARCH_MAX_ATTEMPTS:
                    raise last_error from exc
            except httpx.HTTPStatusError as exc:
                error = self._map_http_error(exc.response)
                if (
                    error.code
                    not in {
                        WebSearchErrorCode.RATE_LIMITED,
                        WebSearchErrorCode.PROVIDER_DOWN,
                    }
                    or attempt + 1 >= BRAVE_SEARCH_MAX_ATTEMPTS
                ):
                    raise error from exc
                last_error = error
            except (httpx.NetworkError, httpx.RemoteProtocolError) as exc:
                last_error = WebSearchError(
                    WebSearchErrorCode.PROVIDER_DOWN,
                    "Brave Search network error",
                    provider=BRAVE_PROVIDER,
                )
                if attempt + 1 >= BRAVE_SEARCH_MAX_ATTEMPTS:
                    raise last_error from exc
            except ValueError as exc:
                raise WebSearchError(
                    WebSearchErrorCode.BAD_RESPONSE,
                    "Brave Search returned malformed JSON",
                    provider=BRAVE_PROVIDER,
                ) from exc

            retry_after = None
            if last_error is not None and last_error.status_code == 429:
                retry_after = getattr(last_error, "retry_after", None)
            delay = (
                retry_after
                if isinstance(retry_after, (int, float))
                else BRAVE_RETRY_BACKOFF_SECONDS * (attempt + 1)
            )
            await asyncio.sleep(delay)

        raise last_error or WebSearchError(
            WebSearchErrorCode.PROVIDER_DOWN,
            "Brave Search failed",
            provider=BRAVE_PROVIDER,
        )

    def _endpoint_for(self, request: WebSearchRequest) -> str:
        if request.result_type == WebSearchResultType.NEWS:
            return f"{self._base_url}/news/search"
        return f"{self._base_url}/web/search"

    def _build_params(self, request: WebSearchRequest) -> dict[str, str | int]:
        query = request.query
        if request.allowed_domains:
            query = f"{query} " + " ".join(f"site:{domain}" for domain in request.allowed_domains)
        if request.blocked_domains:
            query = f"{query} " + " ".join(f"-site:{domain}" for domain in request.blocked_domains)

        params: dict[str, str | int] = {
            "q": query,
            "count": request.limit,
            "country": request.country.lower(),
            "search_lang": request.search_lang,
            "safesearch": request.safe_search,
            "spellcheck": 1,
            "extra_snippets": "true",
        }
        if request.freshness_days:
            params["freshness"] = _freshness_window(request.freshness_days)
        if request.result_type == WebSearchResultType.WEB:
            params["result_filter"] = "web"
        return params

    def _map_http_error(self, response: httpx.Response) -> WebSearchError:
        if response.status_code in (401, 403):
            code = WebSearchErrorCode.INVALID_KEY
        elif response.status_code == 429:
            code = WebSearchErrorCode.RATE_LIMITED
        elif 400 <= response.status_code < 500:
            code = WebSearchErrorCode.INVALID_REQUEST
        else:
            code = WebSearchErrorCode.PROVIDER_DOWN
        error = WebSearchError(
            code,
            f"Brave Search returned HTTP {response.status_code}",
            provider=BRAVE_PROVIDER,
            status_code=response.status_code,
        )
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                error.retry_after = float(retry_after)
            except ValueError:
                pass
        return error

    def _parse_response(
        self,
        data: dict[str, Any],
        request: WebSearchRequest,
        provider_request_id: str | None,
    ) -> WebSearchResponse:
        raw_results = _ordered_raw_results(data, request.result_type)

        results: list[WebSearchResultItem] = []
        seen_urls: set[str] = set()
        for raw in raw_results:
            if len(results) >= request.limit:
                break
            item = self._parse_result_item(
                raw,
                len(results) + 1,
                provider_request_id,
                request.result_type,
            )
            if item is None or item.url in seen_urls:
                continue
            seen_urls.add(item.url)
            results.append(item)

        return WebSearchResponse(
            query=request.query,
            results=tuple(results),
            provider=BRAVE_PROVIDER,
            provider_request_id=provider_request_id,
            more_results_available=bool((data.get("query") or {}).get("more_results_available"))
            or len(raw_results) > len(results),
        )

    def _parse_result_item(
        self,
        raw: dict[str, Any],
        rank: int,
        provider_request_id: str | None,
        request_type: WebSearchResultType,
    ) -> WebSearchResultItem | None:
        title = str(raw.get("title") or "").strip()
        url = _normalize_http_url(raw.get("url"))
        if not title or url is None:
            return None

        description = str(raw.get("description") or "").strip()
        extra_snippets = tuple(
            snippet.strip()
            for snippet in raw.get("extra_snippets") or []
            if isinstance(snippet, str) and snippet.strip()
        )
        profile = raw.get("profile") or {}
        source_name = str(profile.get("name") or raw.get("source") or "").strip() or _hostname(url)
        published_at = (
            raw.get("age")
            or raw.get("page_age")
            or raw.get("published")
            or raw.get("published_time")
        )
        ref_type = "news" if request_type == WebSearchResultType.NEWS else "web"
        result_ref = f"brave:{ref_type}:" + hashlib.sha256(url.encode("utf-8")).hexdigest()[:32]

        return WebSearchResultItem(
            result_ref=result_ref,
            title=title[:512],
            url=url,
            display_url=_display_url(url),
            snippet=description[:1000],
            extra_snippets=tuple(snippet[:1000] for snippet in extra_snippets[:5]),
            published_at=_published_at(published_at),
            source_name=source_name[:256] if source_name else None,
            rank=rank,
            provider=BRAVE_PROVIDER,
            provider_request_id=provider_request_id,
        )


def _normalize_http_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    parsed = urlsplit(stripped)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    if parsed.username or parsed.password:
        return None

    scheme = parsed.scheme.lower()
    hostname = (parsed.hostname or "").lower()
    port = parsed.port
    netloc = hostname
    if port and not ((scheme == "https" and port == 443) or (scheme == "http" and port == 80)):
        netloc = f"{hostname}:{port}"
    path = quote(parsed.path or "", safe="/%:@")
    query = urlencode(
        parse_qsl(parsed.query, keep_blank_values=True),
        doseq=True,
        quote_via=quote,
    )
    return urlunsplit((scheme, netloc, path, query, ""))


def _hostname(url: str) -> str:
    return urlsplit(url).hostname or ""


def _display_url(url: str) -> str:
    parsed = urlsplit(url)
    path = parsed.path.rstrip("/")
    if path and path != "/":
        return f"{parsed.netloc}{path}"
    return parsed.netloc


def _freshness_window(days: int) -> str:
    if days <= 1:
        return "pd"
    if days <= 7:
        return "pw"
    if days <= 31:
        return "pm"
    return "py"


def _published_at(value: Any) -> str | None:
    if not value:
        return None
    text = str(value).strip()
    if len(text) >= 10 and text[4:5] == "-" and text[7:8] == "-":
        return text[:10]
    return text[:128]


def _ordered_raw_results(
    data: dict[str, Any],
    result_type: WebSearchResultType,
) -> list[dict[str, Any]]:
    web_results = list((data.get("web") or {}).get("results") or [])
    if result_type == WebSearchResultType.WEB:
        return web_results

    news_root = data.get("news") or {}
    news_results = list(news_root.get("results") or data.get("results") or [])
    if result_type == WebSearchResultType.NEWS:
        return news_results

    ordered: list[dict[str, Any]] = []
    for item in (data.get("mixed") or {}).get("main") or []:
        source_type = item.get("type")
        source_index = item.get("index")
        if not isinstance(source_index, int):
            continue
        if source_type == "web" and 0 <= source_index < len(web_results):
            ordered.append(web_results[source_index])
        elif source_type == "news" and 0 <= source_index < len(news_results):
            ordered.append(news_results[source_index])
    if ordered:
        return ordered
    return [*web_results, *news_results]
