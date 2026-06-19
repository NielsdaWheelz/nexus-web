"""Integration tests for the standalone read-only web-search route.

The route reuses the chat tool's provider and projection (``search_web_readonly``)
without persistence; the chat wrapper (``execute_web_search``) keeps persisting.
The external web-search provider is the only mocked boundary (a stub implementing
the ``WebSearchProvider`` protocol), matching the app-state provider the chat path
also receives.
"""

from uuid import UUID

import pytest
from sqlalchemy import text
from web_search_tool.types import (
    WebSearchError,
    WebSearchErrorCode,
    WebSearchRequest,
    WebSearchResponse,
    WebSearchResultItem,
)

from tests.factories import create_test_conversation, create_test_message
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

# The provider stamps a request id on the RESPONSE envelope that intentionally
# DIFFERS from the per-item id below, so telemetry that reconstructs the id from
# citations[0] (instead of the response envelope) is caught. The response-level id
# is the one persisted and returned by search_web_readonly.
_RESPONSE_REQUEST_ID = "stub-response-req"
_ITEM_REQUEST_ID = "stub-item-req"


class _StubWebSearchProvider:
    """External-boundary stub for the public web-search provider."""

    def __init__(self, results: tuple[WebSearchResultItem, ...]) -> None:
        self._results = results
        self.requests: list[WebSearchRequest] = []

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.requests.append(request)
        return WebSearchResponse(
            results=self._results,
            provider="stub",
            provider_request_id=_RESPONSE_REQUEST_ID,
        )


class _FailingWebSearchProvider:
    """External-boundary stub that fails like an unavailable provider."""

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        raise WebSearchError(WebSearchErrorCode.PROVIDER_DOWN, "down", provider="stub")


def _result(rank: int) -> WebSearchResultItem:
    return WebSearchResultItem(
        result_ref=f"stub:web:result-{rank}",
        title=f"Stub Result {rank}",
        url=f"https://example.com/{rank}",
        display_url=f"example.com/{rank}",
        snippet=f"Snippet {rank}",
        extra_snippets=(),
        published_at=None,
        source_name="Example",
        rank=rank,
        provider="stub",
        provider_request_id=_ITEM_REQUEST_ID,
    )


def _count_snapshots(direct_db: DirectSessionManager, user_id: UUID) -> int:
    with direct_db.session() as session:
        return session.execute(
            text("SELECT COUNT(*) FROM resource_external_snapshots WHERE user_id = :user_id"),
            {"user_id": user_id},
        ).scalar_one()


def test_web_search_route_returns_projected_results_and_persists_nothing(
    auth_client, direct_db: DirectSessionManager
):
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    direct_db.register_cleanup("resource_external_snapshots", "user_id", user_id)

    provider = _StubWebSearchProvider((_result(1), _result(2)))
    auth_client.app.state.web_search_provider = provider

    response = auth_client.get("/web/search?q=open%20web%20agents", headers=headers)
    assert response.status_code == 200, (
        f"Expected 200 from /web/search, got {response.status_code}: {response.text}"
    )
    results = response.json()["data"]["results"]
    assert [r["url"] for r in results] == [
        "https://example.com/1",
        "https://example.com/2",
    ], f"Expected both projected web results, got {results}"
    first = results[0]
    assert first["type"] == "web_result"
    assert first["result_ref"] == "stub:web:result-1"
    assert first["title"] == "Stub Result 1"
    assert first["snippet"] == "Snippet 1"

    assert provider.requests, "Provider should have been queried"
    assert provider.requests[0].query == "open web agents", (
        "Route should pass the normalized query to the provider; "
        f"got {provider.requests[0].query!r}"
    )

    assert _count_snapshots(direct_db, user_id) == 0, (
        "Read-only web search must persist zero resource_external_snapshots rows"
    )


def test_web_search_route_query_too_short_is_rejected(auth_client):
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    auth_client.app.state.web_search_provider = _StubWebSearchProvider(())

    response = auth_client.get("/web/search?q=a", headers=headers)
    assert response.status_code == 400, (
        f"Expected 400 for a single-character query, got {response.status_code}: {response.text}"
    )


def test_web_search_route_over_length_query_is_400_not_500(auth_client):
    """An over-max_length query is rejected at the boundary as 400, never a 500 leak."""
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    provider = _StubWebSearchProvider((_result(1),))
    auth_client.app.state.web_search_provider = provider

    response = auth_client.get(f"/web/search?q={'a' * 500}", headers=headers)
    assert response.status_code == 400, (
        f"Expected 400 for an over-length query, got {response.status_code}: {response.text}"
    )
    assert not provider.requests, "Over-length query must be rejected before the provider call"


def test_web_search_route_too_many_words_query_is_400_not_500(auth_client):
    """A many-word query under the char cap raises WebSearchQueryError → clean 400,
    never the bare ValueError from WebSearchRequest that would surface as 500."""
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    provider = _StubWebSearchProvider((_result(1),))
    auth_client.app.state.web_search_provider = provider

    # 60 single-character words is ~119 chars (well under max_length=400) but exceeds
    # the 50-word cap, so only the shared word-count validation catches it.
    many_words = "+".join(["x"] * 60)  # '+' encodes to a space in the query string
    response = auth_client.get(f"/web/search?q={many_words}", headers=headers)
    assert response.status_code == 400, (
        f"Expected 400 for a too-many-words query, got {response.status_code}: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_INVALID_REQUEST"
    assert not provider.requests, "Too-many-words query must be rejected before the provider call"


def test_web_search_route_provider_error_returns_503(auth_client, direct_db: DirectSessionManager):
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    direct_db.register_cleanup("resource_external_snapshots", "user_id", user_id)
    auth_client.app.state.web_search_provider = _FailingWebSearchProvider()

    response = auth_client.get("/web/search?q=current%20events", headers=headers)
    assert response.status_code == 503, (
        f"Expected 503 when the provider is unavailable, got {response.status_code}: "
        f"{response.text}"
    )
    assert response.json()["error"]["code"] == "E_BROWSE_PROVIDER_UNAVAILABLE"
    assert _count_snapshots(direct_db, user_id) == 0, (
        "A failed read-only web search must still persist nothing"
    )


def test_web_search_route_unconfigured_provider_returns_503(auth_client):
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    auth_client.app.state.web_search_provider = None

    response = auth_client.get("/web/search?q=current%20events", headers=headers)
    assert response.status_code == 503, (
        f"Expected 503 when no provider is configured, got {response.status_code}: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_BROWSE_PROVIDER_UNAVAILABLE"


async def test_chat_execute_web_search_still_persists_snapshots(
    auth_client, direct_db: DirectSessionManager
):
    """The chat wrapper (execute_web_search) still mints persisted snapshots after
    the read-only core was extracted."""
    from nexus.services.agent_tools.web_search import execute_web_search

    user_id = create_test_user_id()
    assert auth_client.get("/me", headers=auth_headers(user_id)).status_code == 200
    with direct_db.session() as session:
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(session, conversation_id, 1, "user", "Ask")
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            2,
            "assistant",
            "Web answer [1].",
            parent_message_id=user_message_id,
        )

    provider = _StubWebSearchProvider((_result(1),))
    with direct_db.session() as session:
        run = await execute_web_search(
            session,
            provider=provider,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            query="open web agents",
            freshness_days=None,
            tool_call_index=0,
        )

    # Teardown is LIFO and retrieval FK cascades were removed (migration 0093), so
    # register parents before children: independent user-keyed rows, then the
    # conversation/messages, then tool-call rows and their ledgers (deleted first).
    direct_db.register_cleanup("resource_external_snapshots", "user_id", user_id)
    direct_db.register_cleanup("resource_edges", "user_id", user_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("message_tool_calls", "id", run.tool_call_id)
    direct_db.register_cleanup("message_retrievals", "tool_call_id", run.tool_call_id)
    direct_db.register_cleanup("message_rerank_ledgers", "tool_call_id", run.tool_call_id)
    direct_db.register_cleanup(
        "message_retrieval_candidate_ledgers", "tool_call_id", run.tool_call_id
    )

    assert run.status == "complete", f"Expected a complete run, got {run.status}"
    assert _count_snapshots(direct_db, user_id) == 1, (
        "execute_web_search must persist a resource_external_snapshots row per result"
    )
    assert run.provider_request_ids == [_RESPONSE_REQUEST_ID], (
        "execute_web_search must persist the RESPONSE-level provider_request_id, not "
        f"the item-level id; got {run.provider_request_ids!r}"
    )


def test_web_search_route_plumbs_freshness_days_to_provider(auth_client):
    """freshness_days on the query string reaches the provider request unchanged."""
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    provider = _StubWebSearchProvider((_result(1),))
    auth_client.app.state.web_search_provider = provider

    response = auth_client.get("/web/search?q=recent%20news&freshness_days=7", headers=headers)
    assert response.status_code == 200, (
        f"Expected 200 with a freshness filter, got {response.status_code}: {response.text}"
    )
    assert provider.requests, "Provider should have been queried"
    assert provider.requests[0].freshness_days == 7, (
        "Route must pass freshness_days through to the provider request; "
        f"got {provider.requests[0].freshness_days!r}"
    )


def test_web_search_route_rejects_non_positive_freshness_days(auth_client):
    """freshness_days=0 violates Query(ge=1) and is rejected at the boundary as 400."""
    user_id = create_test_user_id()
    headers = auth_headers(user_id)
    assert auth_client.get("/me", headers=headers).status_code == 200
    auth_client.app.state.web_search_provider = _StubWebSearchProvider((_result(1),))

    response = auth_client.get("/web/search?q=recent%20news&freshness_days=0", headers=headers)
    assert response.status_code == 400, (
        f"Expected 400 for freshness_days=0, got {response.status_code}: {response.text}"
    )


def test_web_search_route_requires_authentication(auth_client):
    """No bearer token yields 401 E_UNAUTHENTICATED before any provider work."""
    auth_client.app.state.web_search_provider = _StubWebSearchProvider((_result(1),))

    response = auth_client.get("/web/search?q=open%20web%20agents")
    assert response.status_code == 401, (
        f"Expected 401 without auth, got {response.status_code}: {response.text}"
    )
    assert response.json()["error"]["code"] == "E_UNAUTHENTICATED"


async def test_search_web_readonly_returns_response_level_request_id():
    """search_web_readonly preserves the RESPONSE-level provider_request_id, which
    differs from the item-level id, rather than reconstructing it from citations[0]."""
    from nexus.services.agent_tools.web_search import search_web_readonly

    provider = _StubWebSearchProvider((_result(1), _result(2)))
    result = await search_web_readonly(provider, "open web agents", freshness_days=None)

    assert result.provider_request_id == _RESPONSE_REQUEST_ID, (
        "search_web_readonly must return the response-level provider_request_id; "
        f"got {result.provider_request_id!r}"
    )
    assert all(citation.provider_request_id == _ITEM_REQUEST_ID for citation in result.citations), (
        "stub item-level ids should differ from the response-level id so the contract "
        "is actually pinned"
    )


async def test_read_only_projection_matches_chat_tool_projection_field_for_field():
    """The route's projected citation JSON equals the chat tool's per-result
    projection field-for-field — one shared WebSearchCitation.to_json(), no fork."""
    from uuid import uuid4

    from nexus.services.agent_tools.web_search import (
        WebSearchRun,
        search_web_readonly,
    )

    results = (_result(1), _result(2))
    provider = _StubWebSearchProvider(results)

    read_result = await search_web_readonly(provider, "open web agents", freshness_days=None)
    route_projection = [citation.to_json() for citation in read_result.citations]

    # The chat tool emits its per-result projection through WebSearchRun, sharing the
    # same WebSearchCitation.to_json().
    run = WebSearchRun(
        conversation_id=uuid4(),
        user_message_id=uuid4(),
        assistant_message_id=uuid4(),
        query_hash=None,
        result_type="mixed",
        requested_freshness_days=None,
        requested_domains={"allowed": [], "blocked": []},
        citations=read_result.citations,
        selected_citations=[],
        context_text="",
        context_chars=0,
        latency_ms=0,
        status="complete",
    )
    chat_projection = run.retrieval_result_event()["results"]

    assert route_projection == chat_projection, (
        "route and chat-tool web-result projections must be identical field-for-field"
    )
