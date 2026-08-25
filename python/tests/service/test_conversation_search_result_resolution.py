"""Priority proof for durable Conversation-domain search-result resolution."""

from __future__ import annotations

from importlib import import_module
from uuid import uuid4

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from nexus.db.models import Conversation, Message
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.search import SearchResultConversationOut, SearchResultMessageOut
from nexus.services import bootstrap
from nexus.services.search.service import get_search_result


def test_conversation_result_resolution_has_one_domain_owner() -> None:
    owner = import_module("nexus.services.search.retrievers.conversations")
    resolver = getattr(owner, "resolve_conversation_search_result", None)

    assert resolver is not None
    assert resolver.__module__ == owner.__name__


def test_conversation_and_message_results_reresolve_under_one_visibility_contract(
    engine: Engine,
) -> None:
    owner_id = uuid4()
    foreign_id = uuid4()
    with Session(engine, expire_on_commit=False) as db:
        bootstrap.ensure_user_and_default_library(
            db,
            owner_id,
            f"conversation-search-owner-{owner_id}@example.invalid",
        )
        bootstrap.ensure_user_and_default_library(
            db,
            foreign_id,
            f"conversation-search-foreign-{foreign_id}@example.invalid",
        )
        conversation = Conversation(
            owner_user_id=owner_id,
            title="Durable conversation result",
            sharing="private",
            next_seq=3,
        )
        db.add(conversation)
        db.flush()
        complete_message = Message(
            conversation_id=conversation.id,
            seq=1,
            role="user",
            content="Durable message result",
            status="complete",
        )
        pending_message = Message(
            conversation_id=conversation.id,
            seq=2,
            role="assistant",
            content="Unpublished pending result",
            status="pending",
            parent_message_id=complete_message.id,
        )
        db.add_all([complete_message, pending_message])
        db.commit()

        conversation_result = get_search_result(
            db,
            owner_id,
            "conversation",
            str(conversation.id),
        )
        message_result = get_search_result(
            db,
            owner_id,
            "message",
            str(complete_message.id),
        )

        assert isinstance(conversation_result, SearchResultConversationOut)
        assert conversation_result.id == conversation.id
        assert conversation_result.title == conversation.title
        assert conversation_result.snippet == conversation.title

        assert isinstance(message_result, SearchResultMessageOut)
        assert message_result.id == complete_message.id
        assert message_result.conversation_id == conversation.id
        assert message_result.seq == complete_message.seq
        assert message_result.snippet == complete_message.content
        assert message_result.locator.model_dump(mode="json", exclude_none=True) == {
            "type": "message_offsets",
            "conversation_id": str(conversation.id),
            "message_id": str(complete_message.id),
            "message_seq": complete_message.seq,
            "start_offset": 0,
            "end_offset": len(complete_message.content),
        }

        hidden_refs = (
            (foreign_id, "conversation", conversation.id),
            (foreign_id, "message", complete_message.id),
            (owner_id, "message", pending_message.id),
        )
        for viewer_id, result_type, result_id in hidden_refs:
            with pytest.raises(NotFoundError) as denied:
                get_search_result(db, viewer_id, result_type, str(result_id))
            assert denied.value.code is ApiErrorCode.E_NOT_FOUND
