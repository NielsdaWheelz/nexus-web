"""Priority proof for the public Browse consumer of renamed Web search."""

from __future__ import annotations

from collections.abc import Callable

from fastapi.testclient import TestClient
from llm_tools import (
    WebSearchRequest,
    WebSearchResponse,
    WebSearchResultItem,
    WebSearchResultType,
)

from nexus.schemas.presence import Present
from nexus.services.browse.models import BraveWebArticleTarget, unseal_target


class _RecordingBrowseProvider:
    def __init__(self) -> None:
        self.requests: list[WebSearchRequest] = []

    async def search(
        self, request: WebSearchRequest, *, attempt_started: Callable[[], None] | None = None
    ) -> WebSearchResponse:
        if attempt_started is not None:
            attempt_started()
        self.requests.append(request)
        return WebSearchResponse(
            results=(
                WebSearchResultItem(
                    result_ref="brave-result-opaque-17",
                    title="A normalized provider result",
                    url="https://Example.COM:443/evidence?b=2&a=1#provider-fragment",
                    display_url="example.com/evidence",
                    snippet="The renamed provider retains Browse provenance.",
                    extra_snippets=("One deterministic transcript.",),
                    published_at="2026-08-17T10:20:30Z",
                    source_name="Example Research",
                    rank=1,
                    provider="brave",
                    provider_request_id="brave-item-request-17",
                ),
            ),
            provider="brave",
            provider_request_id="brave-response-request-17",
            retrieved_at="2026-08-17T10:20:31Z",
            attempts=1,
        )


def test_browse_preserves_normalized_provider_results_after_rename(
    authenticated_client: TestClient,
) -> None:
    """The public Browse route keeps normalized results and opaque provenance."""
    provider = _RecordingBrowseProvider()
    authenticated_client.app.state.web_search_provider = provider
    response = authenticated_client.get(
        "/browse",
        params={
            "q": "public evidence",
            "kind": "WebArticle",
            "source": "Brave",
            "limit": "1",
        },
    )

    assert response.status_code == 200
    assert provider.requests == [
        WebSearchRequest(
            query="public evidence",
            result_type=WebSearchResultType.MIXED,
            limit=1,
            freshness_days=None,
            allowed_domains=(),
            blocked_domains=(),
            country="US",
            search_lang="en",
            safe_search="moderate",
            max_attempts=2,
        )
    ]

    page = response.json()["data"]
    assert {
        "query": page["query"],
        "kind": page["kind"],
        "source": page["source"],
        "sort": page["sort"],
        "nextCursor": page["nextCursor"],
    } == {
        "query": "public evidence",
        "kind": "WebArticle",
        "source": "Brave",
        "sort": {"kind": "Absent"},
        "nextCursor": {"kind": "Absent"},
    }
    assert len(page["items"]) == 1
    item = page["items"][0]
    assert {
        "kind": item["kind"],
        "source": item["source"],
        "title": item["title"],
        "description": item["description"],
        "publishedAt": item["publishedAt"],
        "image": item["image"],
        "kindFacts": item["kindFacts"],
    } == {
        "kind": "WebArticle",
        "source": "Brave",
        "title": "A normalized provider result",
        "description": {
            "kind": "Present",
            "value": "The renamed provider retains Browse provenance.",
        },
        "publishedAt": {"kind": "Present", "value": "2026-08-17T10:20:30Z"},
        "image": {"kind": "Absent"},
        "kindFacts": {"siteName": {"kind": "Present", "value": "Example Research"}},
    }
    assert item["resolution"]["kind"] == "Preview"
    target = unseal_target(item["resolution"]["target"])
    assert isinstance(target, BraveWebArticleTarget)
    assert target.canonical_url == "https://example.com/evidence?b=2&a=1"
    assert isinstance(target.search_provenance, Present), (
        "Browse target discarded the provider's opaque search provenance"
    )
    assert target.search_provenance.value.value == "brave-result-opaque-17"
