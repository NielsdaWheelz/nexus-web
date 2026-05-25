"""Unit tests for official X API thread snapshot safety."""

from types import SimpleNamespace

import httpx
import pytest
import respx

from nexus.errors import ApiError, ApiErrorCode
from nexus.services import x_api

pytestmark = pytest.mark.unit


def _patch_x_api_settings(monkeypatch) -> None:
    monkeypatch.setattr(
        x_api,
        "get_settings",
        lambda: SimpleNamespace(
            x_api_bearer_token="test-x-token",
            x_api_base_url="https://api.x.com/2",
            x_api_timeout_seconds=10.0,
            x_api_author_thread_max_posts=1000,
            x_api_include_user_expansions=False,
        ),
    )


def test_thread_search_params_require_scoped_author():
    with pytest.raises(ApiError) as exc:
        x_api._thread_search_params(
            conversation_id="1234567890",
            username="",
            max_results=10,
            next_token=None,
            include_users=False,
        )

    assert exc.value.code == ApiErrorCode.E_INGEST_FAILED


def test_author_thread_fetch_does_not_search_without_author(monkeypatch):
    _patch_x_api_settings(monkeypatch)

    with respx.mock(assert_all_called=False) as remote:
        remote.get("https://api.x.com/2/tweets/1234567890").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": {
                        "id": "1234567890",
                        "author_id": "10",
                        "text": "Root post.",
                        "conversation_id": "1234567890",
                    }
                },
            )
        )
        search_route = remote.get("https://api.x.com/2/tweets/search/all").mock(
            return_value=httpx.Response(200, json={"data": []})
        )

        with pytest.raises(ApiError) as exc:
            x_api.fetch_author_thread_snapshot("1234567890")

    assert exc.value.code == ApiErrorCode.E_INGEST_FAILED
    assert search_route.call_count == 0


def test_invalid_username_hint_falls_back_to_author_lookup(monkeypatch):
    _patch_x_api_settings(monkeypatch)

    with respx.mock(assert_all_called=True) as remote:
        root_route = remote.get("https://api.x.com/2/tweets/1234567890").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": {
                        "id": "1234567890",
                        "author_id": "10",
                        "text": "Root post.",
                        "conversation_id": "1234567890",
                    },
                    "includes": {
                        "users": [
                            {"id": "10", "name": "Ada Lovelace", "username": "ada"},
                        ]
                    },
                },
            )
        )
        search_route = remote.get("https://api.x.com/2/tweets/search/all").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "1234567890",
                            "author_id": "10",
                            "text": "Root post.",
                            "conversation_id": "1234567890",
                        }
                    ],
                    "meta": {"result_count": 1},
                },
            )
        )

        snapshot = x_api.fetch_author_thread_snapshot(
            "1234567890",
            username_hint="bad-handle",
        )

    root_params = dict(root_route.calls.last.request.url.params)
    search_params = dict(search_route.calls.last.request.url.params)
    assert root_params["user.fields"] == "id,name,username"
    assert search_params["query"] == "conversation_id:1234567890 from:ada"
    assert snapshot.author.username == "ada"
