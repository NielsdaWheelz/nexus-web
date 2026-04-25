"""Unit tests for the Brave web search provider."""

from __future__ import annotations

import httpx
import pytest
import respx

from nexus.services.web_search.brave import BRAVE_SEARCH_MAX_ATTEMPTS, BraveSearchProvider
from nexus.services.web_search.types import (
    WebSearchError,
    WebSearchErrorCode,
    WebSearchRequest,
    WebSearchResultType,
)

pytestmark = pytest.mark.unit

BRAVE_WEB_URL = "https://api.search.brave.com/res/v1/web/search"
BRAVE_NEWS_URL = "https://api.search.brave.com/res/v1/news/search"


@pytest.fixture
def httpx_client() -> httpx.AsyncClient:
    return httpx.AsyncClient()


async def _close_client(client: httpx.AsyncClient) -> None:
    await client.aclose()


@pytest.mark.asyncio
@respx.mock
async def test_web_search_sends_brave_params_and_returns_normalized_results(
    httpx_client: httpx.AsyncClient,
) -> None:
    route = respx.get(BRAVE_WEB_URL).respond(
        200,
        headers={"x-request-id": "req-123"},
        json={
            "type": "search",
            "query": {"more_results_available": True},
            "web": {
                "results": [
                    {
                        "title": "Example Result",
                        "url": "HTTPS://Example.COM:443/docs?q=Hello World#section",
                        "description": "Primary snippet",
                        "extra_snippets": ["More context", "", 7],
                        "age": "2026-04-21T10:00:00Z",
                        "profile": {"name": "Example Docs"},
                        "provider_specific": {"must": "not leak"},
                    },
                    {
                        "title": "Unsafe Result",
                        "url": "javascript:alert(1)",
                        "description": "Skipped",
                    },
                ]
            },
        },
    )
    provider = BraveSearchProvider(api_key="test-key", client=httpx_client)

    response = await provider.search(
        WebSearchRequest(
            query="  brave   search  ",
            result_type=WebSearchResultType.WEB,
            limit=3,
            freshness_days=7,
            allowed_domains=("https://Example.com/path",),
            blocked_domains=("Spam.Example",),
        )
    )

    assert route.called
    request = route.calls.last.request
    assert request.headers["X-Subscription-Token"] == "test-key"
    assert request.headers["Accept"] == "application/json"
    assert request.url.params["q"] == "brave search site:example.com -site:spam.example"
    assert request.url.params["freshness"] == "pw"
    assert request.url.params["result_filter"] == "web"
    assert request.url.params["count"] == "3"
    assert request.url.params["extra_snippets"] == "true"

    assert response.provider == "brave"
    assert response.provider_request_id == "req-123"
    assert response.more_results_available is True
    assert len(response.results) == 1
    result = response.results[0]
    assert result.provider == "brave"
    assert result.provider_request_id == "req-123"
    assert result.rank == 1
    assert result.result_ref.startswith("brave:web:")
    assert result.url == "https://example.com/docs?q=Hello%20World"
    assert result.display_url == "example.com/docs"
    assert result.title == "Example Result"
    assert result.snippet == "Primary snippet"
    assert result.extra_snippets == ("More context",)
    assert result.published_at == "2026-04-21"
    assert result.source_name == "Example Docs"
    assert not hasattr(result, "provider_specific")

    await _close_client(httpx_client)


@pytest.mark.asyncio
@respx.mock
async def test_news_search_uses_news_endpoint(httpx_client: httpx.AsyncClient) -> None:
    route = respx.get(BRAVE_NEWS_URL).respond(
        200,
        json={
            "type": "news",
            "query": {"more_results_available": False},
            "results": [
                {
                    "title": "News Result",
                    "url": "https://news.example/story",
                    "description": "News snippet",
                    "source": "Example News",
                    "age": "2 hours ago",
                }
            ],
        },
    )
    provider = BraveSearchProvider(api_key="test-key", client=httpx_client)

    response = await provider.search(
        WebSearchRequest(
            query="market update",
            result_type=WebSearchResultType.NEWS,
            limit=2,
            freshness_days=1,
        )
    )

    request = route.calls.last.request
    assert request.url.params["freshness"] == "pd"
    assert "result_filter" not in request.url.params
    assert len(response.results) == 1
    assert response.results[0].result_ref.startswith("brave:news:")
    assert response.results[0].source_name == "Example News"
    assert response.results[0].published_at == "2 hours ago"

    await _close_client(httpx_client)


@pytest.mark.asyncio
@respx.mock
async def test_mixed_search_respects_brave_mixed_order(httpx_client: httpx.AsyncClient) -> None:
    respx.get(BRAVE_WEB_URL).respond(
        200,
        json={
            "web": {
                "results": [
                    {
                        "title": "Web One",
                        "url": "https://example.com/one",
                        "description": "Web one",
                    },
                    {
                        "title": "Web Two",
                        "url": "https://example.com/two",
                        "description": "Web two",
                    },
                ]
            },
            "news": {
                "results": [
                    {
                        "title": "News One",
                        "url": "https://news.example/one",
                        "description": "News one",
                    }
                ]
            },
            "mixed": {
                "main": [
                    {"type": "news", "index": 0},
                    {"type": "web", "index": 1},
                    {"type": "web", "index": 0},
                ]
            },
        },
    )
    provider = BraveSearchProvider(api_key="test-key", client=httpx_client)

    response = await provider.search(
        WebSearchRequest(query="mixed order", result_type=WebSearchResultType.MIXED, limit=3)
    )

    assert [result.title for result in response.results] == ["News One", "Web Two", "Web One"]
    assert [result.rank for result in response.results] == [1, 2, 3]

    await _close_client(httpx_client)


@pytest.mark.asyncio
@respx.mock
async def test_retries_retryable_status_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    httpx_client: httpx.AsyncClient,
) -> None:
    delays: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        delays.append(seconds)

    monkeypatch.setattr("nexus.services.web_search.brave.asyncio.sleep", fake_sleep)
    route = respx.get(BRAVE_WEB_URL).mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "0.01"}),
            httpx.Response(200, json={"web": {"results": []}}),
        ]
    )
    provider = BraveSearchProvider(api_key="test-key", client=httpx_client)

    response = await provider.search(WebSearchRequest(query="retry me"))

    assert response.results == ()
    assert route.call_count == 2
    assert delays == [0.01]

    await _close_client(httpx_client)


@pytest.mark.asyncio
@respx.mock
async def test_timeout_after_bounded_retries_maps_to_web_search_error(
    monkeypatch: pytest.MonkeyPatch,
    httpx_client: httpx.AsyncClient,
) -> None:
    delays: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        delays.append(seconds)

    monkeypatch.setattr("nexus.services.web_search.brave.asyncio.sleep", fake_sleep)
    route = respx.get(BRAVE_WEB_URL).mock(side_effect=httpx.ReadTimeout("timed out"))
    provider = BraveSearchProvider(api_key="test-key", client=httpx_client)

    with pytest.raises(WebSearchError) as exc_info:
        await provider.search(WebSearchRequest(query="timeout please"))

    assert exc_info.value.code == WebSearchErrorCode.TIMEOUT
    assert route.call_count == BRAVE_SEARCH_MAX_ATTEMPTS
    assert len(delays) == BRAVE_SEARCH_MAX_ATTEMPTS - 1

    await _close_client(httpx_client)


@pytest.mark.asyncio
@respx.mock
async def test_unauthorized_maps_to_invalid_key_without_retry(
    httpx_client: httpx.AsyncClient,
) -> None:
    route = respx.get(BRAVE_WEB_URL).respond(403, json={"error": {"message": "forbidden"}})
    provider = BraveSearchProvider(api_key="test-key", client=httpx_client)

    with pytest.raises(WebSearchError) as exc_info:
        await provider.search(WebSearchRequest(query="auth failure"))

    assert exc_info.value.code == WebSearchErrorCode.INVALID_KEY
    assert exc_info.value.status_code == 403
    assert route.call_count == 1

    await _close_client(httpx_client)


def test_request_validates_query_limit_and_domains() -> None:
    with pytest.raises(ValueError, match="too short"):
        WebSearchRequest(query="x")
    with pytest.raises(ValueError, match="between"):
        WebSearchRequest(query="valid", limit=11)
    with pytest.raises(ValueError, match="registrable"):
        WebSearchRequest(query="valid", allowed_domains=("localhost",))
