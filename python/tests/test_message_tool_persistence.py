"""Persistence tests for assistant app-search tool metadata."""

from typing import get_args
from uuid import uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import (
    AppSearchResultType,
    AssistantMessageClaim,
    AssistantMessageClaimEvidence,
    AssistantMessageEvidenceSummary,
    MessageRetrieval,
    MessageToolCall,
)
from nexus.schemas.conversation import APP_SEARCH_RESULT_TYPES
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


def test_message_retrieval_result_type_enum_matches_response_contract():
    orm_types = {result_type.value for result_type in AppSearchResultType}
    schema_types = set(get_args(APP_SEARCH_RESULT_TYPES))

    assert orm_types == schema_types
    assert "contributor" in orm_types
    assert "annotation" not in orm_types


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
        requested_types=["media", "content_chunk"],
        semantic=True,
        result_refs=[{"type": "content_chunk", "id": source_id}],
        selected_context_refs=[{"type": "content_chunk", "id": source_id}],
        provider_request_ids=["req_123"],
        latency_ms=42,
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=source_id,
                context_ref={"type": "content_chunk", "id": source_id},
                result_ref={"type": "content_chunk", "id": source_id, "rank": 0},
                deep_link=f"/media/{source_id}?t=12",
                score=0.91,
                selected=True,
                exact_snippet="A retrieved transcript excerpt.",
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
            )
        ],
    )

    db_session.add(tool_call)
    db_session.commit()

    persisted = db_session.get(MessageToolCall, tool_call.id)
    assert persisted is not None
    assert persisted.tool_name == "app_search"
    assert persisted.query_hash == "sha256:memory"
    assert persisted.requested_types == ["media", "content_chunk"]
    assert persisted.selected_context_refs == [{"type": "content_chunk", "id": source_id}]
    assert len(persisted.retrievals) == 1
    assert persisted.retrievals[0].result_type == "content_chunk"
    assert persisted.retrievals[0].context_ref == {"type": "content_chunk", "id": source_id}
    assert persisted.retrievals[0].selected is True
    assert persisted.retrievals[0].exact_snippet == "A retrieved transcript excerpt."
    assert persisted.retrievals[0].retrieval_status == "included_in_prompt"
    assert persisted.retrievals[0].included_in_prompt is True


def test_assistant_claim_evidence_round_trip(db_session: Session):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    source_id = str(uuid4())
    retrieval = MessageRetrieval(
        ordinal=0,
        result_type="message",
        source_id=source_id,
        context_ref={"type": "message", "id": source_id},
        result_ref={"type": "message", "id": source_id, "title": "Source message"},
        deep_link=f"/conversations/{conversation_id}",
        score=1.0,
        selected=True,
        exact_snippet="The exact persisted source excerpt.",
        retrieval_status="included_in_prompt",
        included_in_prompt=True,
    )
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[retrieval],
    )
    db_session.add(tool_call)
    db_session.flush()

    claim = AssistantMessageClaim(
        message_id=assistant_message_id,
        ordinal=0,
        claim_text="The assistant made a sourced claim.",
        answer_start_offset=0,
        answer_end_offset=37,
        claim_kind="answer",
        support_status="supported",
        verifier_status="verified",
    )
    db_session.add(
        AssistantMessageEvidenceSummary(
            message_id=assistant_message_id,
            scope_type="general",
            scope_ref=None,
            retrieval_status="included_in_prompt",
            support_status="supported",
            verifier_status="verified",
            claim_count=1,
            supported_claim_count=1,
            unsupported_claim_count=0,
            not_enough_evidence_count=0,
        )
    )
    db_session.add(claim)
    db_session.flush()
    db_session.add(
        AssistantMessageClaimEvidence(
            claim_id=claim.id,
            ordinal=0,
            evidence_role="supports",
            source_ref={
                "type": "message_retrieval",
                "id": str(retrieval.id),
                "retrieval_id": str(retrieval.id),
            },
            retrieval_id=retrieval.id,
            context_ref={"type": "message", "id": source_id},
            result_ref={"type": "message", "id": source_id, "title": "Source message"},
            exact_snippet="The exact persisted source excerpt.",
            deep_link=f"/conversations/{conversation_id}",
            score=1.0,
            retrieval_status="included_in_prompt",
            selected=True,
            included_in_prompt=True,
        )
    )
    db_session.commit()

    persisted = db_session.get(AssistantMessageClaim, claim.id)
    assert persisted is not None
    assert persisted.support_status == "supported"
    assert len(persisted.evidence) == 1
    assert persisted.evidence[0].exact_snippet == "The exact persisted source excerpt."
    assert persisted.evidence[0].source_ref["retrieval_id"] == str(retrieval.id)


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
    tool_call_id = tool_call.id

    db_session.execute(text("DELETE FROM messages WHERE id = :id"), {"id": assistant_message_id})
    db_session.commit()

    assert db_session.get(MessageToolCall, tool_call_id) is None
    assert (
        db_session.scalar(
            select(func.count(MessageRetrieval.id)).where(
                MessageRetrieval.tool_call_id == tool_call_id
            )
        )
        == 0
    )
