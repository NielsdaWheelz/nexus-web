"""Unit tests for official X API thread snapshot safety."""

from types import SimpleNamespace

import httpx
import pytest
import respx

from nexus.services import x_client
from nexus.services.x_types import XProviderError, XProviderErrorCode

pytestmark = pytest.mark.unit


def _patch_x_api_settings(monkeypatch) -> None:
    monkeypatch.setattr(
        x_client,
        "get_settings",
        lambda: SimpleNamespace(
            x_api_bearer_token="test-x-token",
            x_api_base_url="https://api.x.com/2",
            x_api_timeout_seconds=10.0,
            x_api_author_thread_max_posts=1000,
        ),
    )


def test_thread_search_params_require_scoped_author():
    with pytest.raises(XProviderError) as exc:
        x_client._thread_search_params(
            conversation_id="1234567890",
            username="",
            max_results=10,
            next_token=None,
        )

    assert exc.value.code == XProviderErrorCode.UNAVAILABLE


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
        search_route = remote.get("https://api.x.com/2/tweets/search/all")

        with pytest.raises(XProviderError) as exc:
            x_client.fetch_author_thread_snapshot("1234567890")

    assert exc.value.code == XProviderErrorCode.UNAVAILABLE
    assert search_route.call_count == 0


def test_author_thread_fetch_requires_bearer_token(monkeypatch):
    monkeypatch.setattr(
        x_client,
        "get_settings",
        lambda: SimpleNamespace(
            x_api_bearer_token="",
            x_api_base_url="https://api.x.com/2",
            x_api_timeout_seconds=10.0,
            x_api_author_thread_max_posts=1000,
        ),
    )

    with pytest.raises(XProviderError) as exc:
        x_client.fetch_author_thread_snapshot("1234567890")

    assert exc.value.code == XProviderErrorCode.AUTH_REJECTED
    assert exc.value.operation == "lookup_post"


def test_author_thread_fetch_uses_provider_author_not_url_hint(monkeypatch):
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

        snapshot = x_client.fetch_author_thread_snapshot("1234567890")

    root_params = dict(root_route.calls.last.request.url.params)
    search_params = dict(search_route.calls.last.request.url.params)
    assert root_params["user.fields"] == "id,name,username"
    assert search_params["query"] == "conversation_id:1234567890 from:ada"
    assert snapshot.author.username == "ada"
    assert snapshot.conversation_id == "1234567890"
    assert snapshot.canonical_anchor_post_id == "1234567890"


def test_author_thread_fetch_paginates_and_fetches_missing_quotes(monkeypatch):
    _patch_x_api_settings(monkeypatch)

    with respx.mock(assert_all_called=True) as remote:
        remote.get("https://api.x.com/2/tweets/1234567890").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": {
                        "id": "1234567890",
                        "author_id": "10",
                        "text": "Root post.",
                        "conversation_id": "1234567890",
                        "referenced_tweets": [{"type": "quoted", "id": "4444444444"}],
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
            side_effect=[
                httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "id": "1234567890",
                                "author_id": "10",
                                "text": "Root post.",
                                "created_at": "2026-04-15T12:00:00.000Z",
                                "conversation_id": "1234567890",
                            }
                        ],
                        "meta": {"next_token": "page-2"},
                    },
                ),
                httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "id": "1234567891",
                                "author_id": "10",
                                "text": "Second same-author post.",
                                "created_at": "2026-04-15T12:01:00.000Z",
                                "conversation_id": "1234567890",
                                "referenced_tweets": [{"type": "replied_to", "id": "1234567890"}],
                            }
                        ],
                        "meta": {"result_count": 1},
                    },
                ),
            ]
        )
        quote_route = remote.get("https://api.x.com/2/tweets").mock(
            return_value=httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "4444444444",
                            "author_id": "20",
                            "text": "Quoted post.",
                            "conversation_id": "4444444444",
                        }
                    ],
                    "includes": {
                        "users": [
                            {"id": "20", "name": "Grace Hopper", "username": "grace"},
                        ]
                    },
                },
            )
        )

        snapshot = x_client.fetch_author_thread_snapshot("1234567890")

    assert search_route.call_count == 2
    assert dict(search_route.calls[1].request.url.params)["next_token"] == "page-2"
    assert dict(quote_route.calls.last.request.url.params)["ids"] == "4444444444"
    assert [post.id for post in snapshot.posts] == ["1234567890", "1234567891"]
    assert set(snapshot.quoted_posts) == {"4444444444"}


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (
            402,
            {"title": "CreditsDepleted", "detail": "account has no credits"},
            XProviderErrorCode.CREDITS_DEPLETED,
        ),
        (401, {"title": "Unauthorized"}, XProviderErrorCode.AUTH_REJECTED),
        (403, {"title": "Forbidden"}, XProviderErrorCode.AUTH_REJECTED),
        (429, {"title": "Too Many Requests"}, XProviderErrorCode.RATE_LIMITED),
        (404, {"title": "Not Found"}, XProviderErrorCode.POST_UNAVAILABLE),
        (500, {"title": "Server Error"}, XProviderErrorCode.UNAVAILABLE),
    ],
)
def test_provider_http_errors_are_classified(monkeypatch, status, body, expected):
    _patch_x_api_settings(monkeypatch)

    with respx.mock(assert_all_called=False) as remote:
        remote.get("https://api.x.com/2/tweets/1234567890").mock(
            return_value=httpx.Response(status, json=body)
        )

        with pytest.raises(XProviderError) as exc:
            x_client.fetch_author_thread_snapshot("1234567890")

    assert exc.value.code == expected
    assert exc.value.provider_status_code == status


def test_provider_retry_after_is_preserved(monkeypatch):
    _patch_x_api_settings(monkeypatch)
    monkeypatch.setattr(x_client, "_RETRY_BACKOFF_SECONDS", ())

    with respx.mock(assert_all_called=False) as remote:
        remote.get("https://api.x.com/2/tweets/1234567890").mock(
            return_value=httpx.Response(
                429,
                json={"title": "Too Many Requests"},
                headers={"Retry-After": "7"},
            )
        )

        with pytest.raises(XProviderError) as exc:
            x_client.fetch_author_thread_snapshot("1234567890")

    assert exc.value.code == XProviderErrorCode.RATE_LIMITED
    assert exc.value.retry_after_seconds == 7


def test_provider_invalid_json_is_unavailable(monkeypatch):
    _patch_x_api_settings(monkeypatch)

    with respx.mock(assert_all_called=False) as remote:
        remote.get("https://api.x.com/2/tweets/1234567890").mock(
            return_value=httpx.Response(200, content=b"not-json")
        )

        with pytest.raises(XProviderError) as exc:
            x_client.fetch_author_thread_snapshot("1234567890")

    assert exc.value.code == XProviderErrorCode.UNAVAILABLE
    assert exc.value.operation == "lookup_post"
