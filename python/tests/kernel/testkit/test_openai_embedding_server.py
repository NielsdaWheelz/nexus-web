"""The controller-owned TLS peer serves Brave web search only to the controller's token."""

from __future__ import annotations

import asyncio
import ssl
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import httpx
import pytest
from llm_tools.web.brave import BraveSearchProvider
from llm_tools.web.contracts import WebSearchError, WebSearchErrorCode, WebSearchRequest

from nexus_test_control.services import (
    TEST_BRAVE_SEARCH_API_KEY,
    _write_embedding_peer_certificate,
)
from tests.testkit.openai_embedding_server import _OpenAIProviderServer

_SEARCH_PATH = "/res/v1/web/search"
_QUERY = "Houston We Have a Podcast"
_EXPECTED_URLS = [
    "https://www.nasa.gov/podcasts/houston-we-have-a-podcast/",
    "https://www.nasa.gov/johnson/",
    "https://www.nasa.gov/mission/nasas-spacex-crew-4/",
]


@contextmanager
def _running_peer(tmp_path: Path) -> Iterator[tuple[str, ssl.SSLContext]]:
    certificate = tmp_path / "ca.pem"
    key = tmp_path / "server-key.pem"
    audit = tmp_path / "requests.jsonl"
    audit.touch()
    _write_embedding_peer_certificate(certificate, key)
    server = _OpenAIProviderServer(0, certificate, key, audit)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        host, port = server.server_address
        yield f"https://{host!s}:{int(port)}", ssl.create_default_context(cafile=str(certificate))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        assert not thread.is_alive(), "embedding peer did not stop"


def test_brave_web_search_answers_only_the_controller_token_with_fixed_results(
    tmp_path: Path,
) -> None:
    with (
        _running_peer(tmp_path) as (origin, verify),
        httpx.Client(base_url=origin, verify=verify) as client,
    ):
        anonymous = client.get(_SEARCH_PATH, params={"q": _QUERY})
        assert anonymous.status_code == 401, anonymous.text
        assert anonymous.json() == {"error": {"code": "invalid_subscription_token"}}

        foreign = client.get(
            _SEARCH_PATH,
            params={"q": _QUERY},
            headers={"X-Subscription-Token": "not-the-controller-key"},
        )
        assert foreign.status_code == 401, foreign.text

        unqueried = client.get(
            _SEARCH_PATH,
            headers={"X-Subscription-Token": TEST_BRAVE_SEARCH_API_KEY},
        )
        assert unqueried.status_code == 422, unqueried.text
        assert unqueried.json() == {"error": {"code": "invalid_search_query"}}

        accepted = client.get(
            _SEARCH_PATH,
            params={"q": _QUERY, "count": 6, "result_filter": "web"},
            headers={
                "Accept": "application/json",
                "X-Subscription-Token": TEST_BRAVE_SEARCH_API_KEY,
            },
        )
        assert accepted.status_code == 200, accepted.text
        assert accepted.headers["content-type"] == "application/json"
        assert accepted.headers["x-request-id"] == "req_nexus_brave_fixture"
        payload = accepted.json()
        assert payload["query"] == {"original": _QUERY}
        results = payload["web"]["results"]
        assert [result["url"] for result in results] == _EXPECTED_URLS
        assert all(result["title"] and result["description"] for result in results), results


def test_pinned_brave_provider_reads_the_peer_as_one_ranked_search(tmp_path: Path) -> None:
    async def search(origin: str, verify: ssl.SSLContext, api_key: str):  # noqa: ANN202
        async with httpx.AsyncClient(verify=verify) as client:
            provider = BraveSearchProvider(client, api_key=api_key, base_url=f"{origin}/res/v1")
            return await provider.search(WebSearchRequest(query=_QUERY, limit=6, max_attempts=1))

    with _running_peer(tmp_path) as (origin, verify):
        response = asyncio.run(search(origin, verify, TEST_BRAVE_SEARCH_API_KEY))
        assert response.provider == "brave"
        assert response.provider_request_id == "req_nexus_brave_fixture"
        assert [(item.rank, item.url) for item in response.results] == list(
            enumerate(_EXPECTED_URLS, start=1)
        )
        assert all(item.title and item.snippet for item in response.results), response.results

        with pytest.raises(WebSearchError) as rejected:
            asyncio.run(search(origin, verify, "not-the-controller-key"))
        assert rejected.value.code is WebSearchErrorCode.INVALID_KEY
        assert rejected.value.status_code == 401
