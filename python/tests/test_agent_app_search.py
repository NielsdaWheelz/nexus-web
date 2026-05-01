"""Agent app-search tool tests."""

import pytest
from sqlalchemy import text

from nexus.services.agent_tools.app_search import execute_app_search
from tests.factories import (
    create_searchable_media_in_library,
    create_test_conversation,
    create_test_library,
    create_test_message,
)
from tests.helpers import create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


def test_execute_app_search_persists_retrieval_metadata(
    direct_db: DirectSessionManager,
) -> None:
    user_id = create_test_user_id()

    with direct_db.session() as session:
        session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        library_id = create_test_library(session, user_id, "Agent Search Test Library")
        conversation_id = create_test_conversation(session, user_id)
        user_message_id = create_test_message(
            session,
            conversation_id,
            seq=1,
            role="user",
            content="App Search Needle",
        )
        assistant_message_id = create_test_message(
            session,
            conversation_id,
            seq=2,
            role="assistant",
            content="",
            status="pending",
        )
        media_id = create_searchable_media_in_library(
            session,
            user_id,
            library_id,
            title="App Search Needle",
        )

        run = execute_app_search(
            session,
            viewer_id=user_id,
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            content="App Search Needle",
            has_user_context=False,
            scope="all",
            history=[],
            scope_metadata={"type": "general"},
        )

        assert run is not None
        assert run.tool_call_id is not None
        assert run.status == "complete"
        assert any(citation.source_id == str(media_id) for citation in run.citations)
        assert run.context_text

        tool_row = session.execute(
            text(
                """
                SELECT query_hash, result_refs, selected_context_refs
                FROM message_tool_calls
                WHERE id = :tool_call_id
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).one()
        assert tool_row[0]
        assert tool_row[0] != "App Search Needle"
        assert any(ref["type"] == "media" for ref in tool_row[1])
        assert {"type": "media", "id": str(media_id)} in tool_row[2]

        retrieval_rows = session.execute(
            text(
                """
                SELECT exact_snippet, retrieval_status, included_in_prompt
                FROM message_retrievals
                WHERE tool_call_id = :tool_call_id
                  AND scope = 'all'
                ORDER BY ordinal ASC
                """
            ),
            {"tool_call_id": run.tool_call_id},
        ).fetchall()
        assert retrieval_rows
        assert any(row[0] for row in retrieval_rows)
        assert any(row[1] == "selected" for row in retrieval_rows)
        assert all(row[2] is False for row in retrieval_rows)

    direct_db.register_cleanup("conversation_media", "conversation_id", conversation_id)
    direct_db.register_cleanup("fragments", "media_id", media_id)
    direct_db.register_cleanup("library_entries", "media_id", media_id)
    direct_db.register_cleanup("media", "id", media_id)
    direct_db.register_cleanup("messages", "conversation_id", conversation_id)
    direct_db.register_cleanup("conversations", "id", conversation_id)
    direct_db.register_cleanup("memberships", "library_id", library_id)
    direct_db.register_cleanup("libraries", "id", library_id)
    direct_db.register_cleanup("users", "id", user_id)
