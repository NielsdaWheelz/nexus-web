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
        assert tool_row[3][0]["url"] == "https://example.com/docs"
        assert tool_row[4] == [{"type": "web_result", "id": "fake:web:001"}]
        assert tool_row[5] == ["fake-request-id"]

        retrieval_row = session.execute(
            text(
                """
                SELECT result_type, source_id, media_id, deep_link, selected,
                       exact_snippet, locator, retrieval_status
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
        assert retrieval_row[6]["type"] == "web_url"
        assert retrieval_row[7] == "web_result"

    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("users", "id", user_id)
