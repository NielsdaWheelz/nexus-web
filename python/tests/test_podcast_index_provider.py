"""Unit tests for PodcastIndex provider retry and parsing behavior."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from nexus.errors import ApiError, ApiErrorCode
from nexus.services.podcasts.provider import (
    PODCAST_PROVIDER_MAX_ATTEMPTS,
    PodcastIndexClient,
)

pytestmark = pytest.mark.unit


def _client() -> PodcastIndexClient:
    return PodcastIndexClient(
        api_key="test-key",
        api_secret="test-secret",
        base_url="https://podcastindex.test/api/1.0",
    )


def _json_response(
    *,
    status_code: int,
    payload: Any,
    headers: dict[str, str] | None = None,
) -> httpx.Response:
    request = httpx.Request("GET", "https://podcastindex.test/api/1.0/search/byterm")
    return httpx.Response(
        status_code=status_code,
        request=request,
        headers=headers,
        content=json.dumps(payload).encode("utf-8"),
    )


def _install_sequence_get(
    monkeypatch: pytest.MonkeyPatch,
    responses: list[httpx.Response | Exception],
) -> list[str]:
    calls: list[str] = []
    sequence = list(responses)

    def fake_get(url: str, **kwargs: Any) -> httpx.Response:
        calls.append(url)
        if not sequence:
            raise AssertionError("httpx.get called more times than expected")
        next_item = sequence.pop(0)
        if isinstance(next_item, Exception):
            raise next_item
        return next_item

    monkeypatch.setattr("nexus.services.podcasts.provider.httpx.get", fake_get)
    return calls


def _capture_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    delays: list[float] = []

    def fake_sleep(seconds: float) -> None:
        delays.append(float(seconds))

    monkeypatch.setattr("nexus.services.podcasts.provider.time.sleep", fake_sleep)
    return delays


def _assert_provider_unavailable(callable_under_test: Callable[[], Any]) -> None:
    with pytest.raises(ApiError) as exc_info:
        callable_under_test()
    assert exc_info.value.code == ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE


def test_search_podcasts_returns_parsed_rows_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _install_sequence_get(
        monkeypatch,
        [
            _json_response(
                status_code=200,
                payload={
                    "feeds": [
                        {
                            "id": 123,
                            "url": "https://feeds.example.com/systems.xml",
                            "title": "Systems Podcast",
                            "author": "Systems Team",
                            "link": "https://example.com/systems",
                            "image": "https://example.com/systems.png",
                            "description": "Deep systems analysis",
                        }
                    ]
                },
            )
        ],
    )

    results = _client().search_podcasts("systems", 10)

    assert len(calls) == 1
    assert results == [
        {
            "provider_podcast_id": "123",
            "title": "Systems Podcast",
            "author": "Systems Team",
            "feed_url": "https://feeds.example.com/systems.xml",
            "website_url": "https://example.com/systems",
            "image_url": "https://example.com/systems.png",
            "description": "Deep systems analysis",
        }
    ]


def test_search_podcasts_retries_429_with_retry_after_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_sequence_get(
        monkeypatch,
        [
            _json_response(
                status_code=429,
                payload={"status": "rate_limited"},
                headers={"Retry-After": "0.01"},
            ),
            _json_response(status_code=200, payload={"feeds": []}),
        ],
    )
    delays = _capture_sleep(monkeypatch)

    results = _client().search_podcasts("systems", 5)

    assert results == []
    assert len(calls) == 2
    assert delays == [0.01]


def test_search_podcasts_retries_500_then_fails_after_max_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_sequence_get(
        monkeypatch,
        [
            _json_response(status_code=500, payload={"status": "error"})
            for _ in range(PODCAST_PROVIDER_MAX_ATTEMPTS)
        ],
    )
    delays = _capture_sleep(monkeypatch)

    _assert_provider_unavailable(lambda: _client().search_podcasts("systems", 3))

    assert len(calls) == PODCAST_PROVIDER_MAX_ATTEMPTS
    assert len(delays) == PODCAST_PROVIDER_MAX_ATTEMPTS - 1


def test_search_podcasts_retries_timeout_then_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _install_sequence_get(
        monkeypatch,
        [httpx.TimeoutException("timeout")] * PODCAST_PROVIDER_MAX_ATTEMPTS,
    )
    delays = _capture_sleep(monkeypatch)

    _assert_provider_unavailable(lambda: _client().search_podcasts("systems", 3))

    assert len(calls) == PODCAST_PROVIDER_MAX_ATTEMPTS
    assert len(delays) == PODCAST_PROVIDER_MAX_ATTEMPTS - 1


def test_search_podcasts_fails_gracefully_on_malformed_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = httpx.Request("GET", "https://podcastindex.test/api/1.0/search/byterm")
    malformed = httpx.Response(status_code=200, request=request, content=b"{not-json")
    _install_sequence_get(monkeypatch, [malformed])

    _assert_provider_unavailable(lambda: _client().search_podcasts("systems", 3))


def test_search_podcasts_returns_empty_list_for_empty_feeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_sequence_get(
        monkeypatch,
        [_json_response(status_code=200, payload={"feeds": []})],
    )

    assert _client().search_podcasts("systems", 3) == []
