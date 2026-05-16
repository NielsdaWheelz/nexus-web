"""Agent public web-search tool tests."""

from __future__ import annotations

import pytest
from sqlalchemy import text
from web_search_tool.types import (
    WebSearchProvider,
    WebSearchRequest,
    WebSearchResponse,
    WebSearchResultItem,
)

from nexus.schemas.conversation import WebSearchOptions
from nexus.services.agent_tools.web_search import execute_web_search
from tests.factories import create_test_conversation, create_test_message
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


class FakeWebSearchProvider:
    def __init__(self) -> None:
        self.requests: list[WebSearchRequest] = []

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.requests.append(request)
        return WebSearchResponse(
            provider="fake",
            provider_request_id="fake-request-id",
            results=(
                WebSearchResultItem(
                    result_ref="fake:web:001",
                    title="Example Web Result",
                    url="https://example.com/docs",
                    display_url="example.com/docs",
                    snippet="Example web-search snippet",
                    extra_snippets=("Additional evidence",),
                    published_at="2026-04-24",
                    source_name="Example",
                    rank=1,
                    provider="fake",
                    provider_request_id="fake-request-id",
                ),
            ),
        )


class EmptyWebSearchProvider:
    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        return WebSearchResponse(
            provider="fake",
            provider_request_id="empty-request-id",
            results=(),
        )


@pytest.mark.asyncio
async def test_execute_web_search_persists_tool_and_web_retrievals(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Latest Brave Search API docs",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )

        provider: WebSearchProvider = FakeWebSearchProvider()
        run = await execute_web_search(
            session,
            provider=provider,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            content="What are the latest Brave Search API docs?",
            options=WebSearchOptions(mode="required", freshness_days=7),
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.status == "complete"
        assert run.provider_request_ids == ["fake-request-id"]
        assert run.selected_citations[0].url == "https://example.com/docs"
        assert "<web_search_result" in run.context_text
        assert provider.requests[0].freshness_days == 7

        tool_row = session.execute(
            text(
                """
                SELECT tool_name, tool_call_index, query_hash, result_refs,
                       selected_context_refs, provider_request_ids
                FROM message_tool_calls
                WHERE id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tool_row[0] == "web_search"
        assert tool_row[1] == 1
        assert tool_row[2]
        assert "Brave Search" not in tool_row[2]
        assert tool_row[3][0]["type"] == "web_result"
        assert tool_row[3][0]["id"] == "fake:web:001"
        assert tool_row[3][0]["url"] == "https://example.com/docs"
        assert tool_row[3][0]["locator"]["type"] == "external_url"
        assert tool_row[4][0]["type"] == "web_result"
        assert tool_row[4][0]["id"] == "fake:web:001"
        assert tool_row[5] == ["fake-request-id"]
        event = run.retrieval_result_event()
        assert event["results"][0]["locator"]["type"] == "external_url"

        retrieval_row = session.execute(
            text(
                """
                SELECT result_type, source_id, media_id, deep_link, selected,
                       exact_snippet, locator, retrieval_status, source_version,
                       context_ref, result_ref, included_in_prompt
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert retrieval_row[0] == "web_result"
        assert retrieval_row[1] == "fake:web:001"
        assert retrieval_row[2] is None
        assert retrieval_row[3] == "https://example.com/docs"
        assert retrieval_row[4] is True
        assert retrieval_row[5] == "Example web-search snippet"
        assert retrieval_row[6]["type"] == "external_url"
        assert retrieval_row[7] == "web_result"
        assert retrieval_row[8] == "web_search:fake:fake-request-id"
        assert retrieval_row[9]["type"] == "web_result"
        assert "result_ref" not in retrieval_row[9]
        assert retrieval_row[10]["source_version"] == retrieval_row[8]
        assert retrieval_row[10]["locator"]["type"] == "external_url"
        assert retrieval_row[11] is False

        ledger_row = session.execute(
            text(
                """
                SELECT result_type, source_id, selected, selection_status, source_version
                FROM message_retrieval_candidate_ledgers
                WHERE tool_call_id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert ledger_row[0] == "web_result"
        assert ledger_row[1] == "fake:web:001"
        assert ledger_row[2] is True
        assert ledger_row[3] == "web_result"
        assert ledger_row[4] == "web_search:fake:fake-request-id"

        rerank_row = session.execute(
            text(
                """
                SELECT strategy, input_count, selected_count, budget_chars, selected_chars, status
                FROM message_rerank_ledgers
                WHERE tool_call_id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert rerank_row[0] == "provider_rank_then_context_budget"
        assert rerank_row[1] == 1
        assert rerank_row[2] == 1
        assert rerank_row[3] > 0
        assert rerank_row[4] == run.context_chars
        assert rerank_row[5] == "complete"

    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("users", "id", user_id)


@pytest.mark.asyncio
async def test_execute_web_search_persists_no_results_as_empty_tool_result(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="Latest nonexistent search",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )

        provider: WebSearchProvider = EmptyWebSearchProvider()
        run = await execute_web_search(
            session,
            provider=provider,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            content="Search the web for latest nonexistent search",
            options=WebSearchOptions(
                mode="required",
                freshness_days=7,
                allowed_domains=["example.com"],
                blocked_domains=["blocked.example"],
            ),
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.status == "complete"
        assert run.citations == []
        assert run.empty_status == "no_results"
        assert run.retrieval_result_event()["results"] == []
        assert 'status="no_results"' in run.context_text

        tool_row = session.execute(
            text(
                """
                SELECT result_refs, selected_context_refs
                FROM message_tool_calls
                WHERE id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tool_row[0] == []
        assert tool_row[1] == []
        retrieval_count = session.execute(
            text(
                """
                SELECT
                    (SELECT count(*) FROM message_retrievals WHERE tool_call_id = :tool_call_id),
                    (
                        SELECT count(*)
                        FROM message_retrieval_candidate_ledgers
                        WHERE tool_call_id = :tool_call_id
                    )
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tuple(retrieval_count) == (0, 0)

    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("users", "id", user_id)
