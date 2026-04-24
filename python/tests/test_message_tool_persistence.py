"""Persistence tests for assistant app-search tool metadata."""

from uuid import uuid4

import pytest
from sqlalchemy import func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import MessageRetrieval, MessageToolCall
from tests.factories import create_test_conversation, create_test_message
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


def _create_message_pair(session: Session) -> tuple:
    user_id = create_test_user_id()
    session.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
    conversation_id = create_test_conversation(session, user_id)
    user_message_id = create_test_message(
        session,
        conversation_id,
        seq=1,
        role="user",
        content="Find the episode about memory",
    )
    assistant_message_id = create_test_message(
        session,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
    )
    return conversation_id, user_message_id, assistant_message_id


def test_message_tool_call_and_retrieval_round_trip(db_session: Session):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    source_id = str(uuid4())

    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        query_hash="sha256:memory",
        scope="all",
        requested_types=["media", "transcript_chunk"],
        semantic=True,
        result_refs=[{"type": "transcript_chunk", "id": source_id}],
        selected_context_refs=[{"type": "transcript_chunk", "id": source_id}],
        provider_request_ids=["req_123"],
        latency_ms=42,
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="transcript_chunk",
                source_id=source_id,
                context_ref={"type": "transcript_chunk", "id": source_id},
                result_ref={"type": "transcript_chunk", "id": source_id, "rank": 0},
                deep_link=f"/media/{source_id}?t=12",
                score=0.91,
                selected=True,
            )
        ],
    )

    db_session.add(tool_call)
    db_session.commit()

    persisted = db_session.get(MessageToolCall, tool_call.id)
    assert persisted is not None
    assert persisted.tool_name == "app_search"
    assert persisted.query_hash == "sha256:memory"
    assert persisted.requested_types == ["media", "transcript_chunk"]
    assert persisted.selected_context_refs == [{"type": "transcript_chunk", "id": source_id}]
    assert len(persisted.retrievals) == 1
    assert persisted.retrievals[0].result_type == "transcript_chunk"
    assert persisted.retrievals[0].context_ref == {"type": "transcript_chunk", "id": source_id}
    assert persisted.retrievals[0].selected is True


def test_message_tool_call_constraints_and_cascade(db_session: Session):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)

    db_session.add(
        MessageToolCall(
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            tool_name="app_search",
            tool_call_index=0,
            scope="all",
            latency_ms=-1,
            status="complete",
        )
    )

    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()

    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        latency_ms=1,
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="message",
                source_id=str(user_message_id),
                context_ref={"type": "message", "id": str(user_message_id)},
                result_ref={"type": "message", "id": str(user_message_id)},
                selected=True,
            )
        ],
    )
    db_session.add(tool_call)
    db_session.commit()

    db_session.execute(text("DELETE FROM messages WHERE id = :id"), {"id": assistant_message_id})
    db_session.commit()

    assert db_session.scalar(func.count(MessageToolCall.id)) == 0
    assert db_session.scalar(func.count(MessageRetrieval.id)) == 0
