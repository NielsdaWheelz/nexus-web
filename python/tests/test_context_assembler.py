"""Integration tests for chat context assembly service."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, MessageRetrieval, MessageToolCall, Model
from nexus.services.context_assembler import assemble_chat_context
from tests.factories import create_test_conversation, create_test_message, create_test_model

pytestmark = pytest.mark.integration


def _create_run(
    db_session: Session,
    *,
    user_id: UUID,
    model_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
) -> ChatRun:
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="test-payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    db_session.commit()
    return run


def test_assemble_chat_context_selects_recent_history_as_pairs(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 1300
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    for pair_index in range(10):
        seq = pair_index * 2 + 1
        create_test_message(
            db_session,
            conversation_id=conversation_id,
            seq=seq,
            role="user",
            content=f"older user {pair_index} " + ("alpha " * 80),
        )
        create_test_message(
            db_session,
            conversation_id=conversation_id,
            seq=seq + 1,
            role="assistant",
            content=f"older assistant {pair_index} " + ("beta " * 80),
        )
    current_user_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=21,
        role="user",
        content="What did we decide most recently?",
    )
    assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=22,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
    )
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=current_user_id,
        assistant_message_id=assistant_id,
    )

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        max_output_tokens=128,
    )

    assert assembly.llm_request.messages[-1].content == "What did we decide most recently?"
    assert 0 < len(assembly.history) < 20
    assert len(assembly.history) % 2 == 0
    assert assembly.history[0].role == "user"
    assert assembly.history[-1].role == "assistant"
    assert "older assistant 9" in assembly.history[-1].content


def test_assemble_chat_context_returns_tool_and_citation_events_from_persisted_retrievals(
    db_session: Session,
    bootstrapped_user: UUID,
):
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    model.max_context_tokens = 5000
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=1,
        role="user",
        content="Search the web for current docs.",
    )
    assistant_id = create_test_message(
        db_session,
        conversation_id=conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
    )
    run = _create_run(
        db_session,
        user_id=bootstrapped_user,
        model_id=model_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_id,
    )
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_id,
        tool_name="web_search",
        tool_call_index=1,
        query_hash="hash",
        scope="public_web",
        requested_types=["mixed"],
        semantic=False,
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="web_result",
                source_id="web_1",
                context_ref={"type": "web_result", "id": "web_1"},
                result_ref={
                    "result_ref": "web_1",
                    "title": "Docs",
                    "url": "https://example.com/docs",
                    "display_url": "example.com/docs",
                    "snippet": "Docs snippet",
                    "provider": "test",
                },
                deep_link="https://example.com/docs",
                score=1.0,
                selected=True,
            )
        ],
    )
    db_session.add(tool_call)
    db_session.commit()

    assembly = assemble_chat_context(
        db_session,
        run=run,
        model=model,
        max_output_tokens=128,
    )

    assert "web_search" in assembly.context_types
    assert assembly.tool_call_events[0]["tool_name"] == "web_search"
    assert assembly.tool_result_events[0]["selected_count"] == 1
    assert assembly.citation_events[0]["url"] == "https://example.com/docs"
    assert any("Docs snippet" in block for block in assembly.context_blocks)
    assert len(assembly.ledger.included_retrieval_ids) == 1
