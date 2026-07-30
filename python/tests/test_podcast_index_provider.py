"""Unit tests for PodcastIndex raw Browse transport and retry behavior.

The retry/backoff/Retry-After loop lives in `nexus.services.net.http_retry`
(`get_json_with_retry`), which `provider._get_json` delegates to. These tests drive
the raw Browse search payload seam and patch the HTTP + sleep owners beneath it.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest

from nexus.config import clear_settings_cache
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

    def fake_get(_self: Any, url: str, **kwargs: Any) -> httpx.Response:
        calls.append(url)
        if not sequence:
            raise AssertionError("httpx.Client.get called more times than expected")
        next_item = sequence.pop(0)
        if isinstance(next_item, Exception):
            raise next_item
        return next_item

    monkeypatch.setattr("httpx.Client.get", fake_get)
    return calls


def _capture_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    delays: list[float] = []

    def fake_sleep(seconds: float) -> None:
        delays.append(float(seconds))

    monkeypatch.setattr("nexus.services.net.http_retry.time.sleep", fake_sleep)
    return delays


def _assert_provider_unavailable(callable_under_test: Callable[[], Any]) -> None:
    with pytest.raises(ApiError) as exc_info:
        callable_under_test()
    assert exc_info.value.code == ApiErrorCode.E_PODCAST_PROVIDER_UNAVAILABLE


def test_browse_search_returns_raw_provider_payload_on_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
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
    }
    calls = _install_sequence_get(
        monkeypatch,
        [
            _json_response(
                status_code=200,
                payload=payload,
            )
        ],
    )

    result = _client().browse_search_payload("systems", 10)

    assert len(calls) == 1
    assert result == payload


def test_browse_search_retries_429_with_retry_after_then_succeeds(
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

    result = _client().browse_search_payload("systems", 5)

    assert result == {"feeds": []}
    assert len(calls) == 2
    assert delays == [0.01]


def test_browse_search_retries_500_then_fails_after_max_attempts(
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

    _assert_provider_unavailable(lambda: _client().browse_search_payload("systems", 3))

    assert len(calls) == PODCAST_PROVIDER_MAX_ATTEMPTS
    assert len(delays) == PODCAST_PROVIDER_MAX_ATTEMPTS - 1


def test_browse_search_retries_timeout_then_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _install_sequence_get(
        monkeypatch,
        [httpx.TimeoutException("timeout")] * PODCAST_PROVIDER_MAX_ATTEMPTS,
    )
    delays = _capture_sleep(monkeypatch)

    _assert_provider_unavailable(lambda: _client().browse_search_payload("systems", 3))

    assert len(calls) == PODCAST_PROVIDER_MAX_ATTEMPTS
    assert len(delays) == PODCAST_PROVIDER_MAX_ATTEMPTS - 1


def test_browse_search_fails_gracefully_on_malformed_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = httpx.Request("GET", "https://podcastindex.test/api/1.0/search/byterm")
    malformed = httpx.Response(status_code=200, request=request, content=b"{not-json")
    _install_sequence_get(monkeypatch, [malformed])

    _assert_provider_unavailable(lambda: _client().browse_search_payload("systems", 3))


def test_browse_search_returns_empty_payload_for_empty_feeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_sequence_get(
        monkeypatch,
        [_json_response(status_code=200, payload={"feeds": []})],
    )

    assert _client().browse_search_payload("systems", 3) == {"feeds": []}


def test_browse_search_fails_on_non_dict_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    # get_json_with_retry rejects a non-object JSON body as a provider error.
    _install_sequence_get(
        monkeypatch,
        [_json_response(status_code=200, payload=["unexpected", "array"])],
    )

    _assert_provider_unavailable(lambda: _client().browse_search_payload("systems", 3))


def test_raw_browse_methods_preserve_real_media_fixture_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture_dir = Path(__file__).parent / "fixtures" / "real_media"
    monkeypatch.setenv("REAL_MEDIA_PROVIDER_FIXTURES", "true")
    monkeypatch.setenv("REAL_MEDIA_FIXTURE_DIR", str(fixture_dir))
    clear_settings_cache()
    try:
        client = _client()
        search = client.browse_search_payload("Houston We Have a Podcast", 5)
        podcast = client.browse_podcast_payload("nasa-hwhap-real-media")
        episodes = client.browse_episode_page_payload(
            "nasa-hwhap-real-media",
            5,
            None,
        )
        episode = client.browse_episode_payload("nasa-hwhap-crew4")
    finally:
        clear_settings_cache()

    assert search["feeds"][0]["id"] == "nasa-hwhap-real-media"
    assert podcast["feed"]["id"] == "nasa-hwhap-real-media"
    assert episodes["items"][0]["id"] == "nasa-hwhap-crew4"
    assert episode["episode"]["id"] == "nasa-hwhap-crew4"
