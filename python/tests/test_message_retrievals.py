"""Tests for assistant-message trust trail retrieval ledgers."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatPromptAssembly,
    ChatRun,
    ChatRunEvent,
    MessageRerankLedger,
    MessageRetrieval,
    MessageRetrievalCandidateLedger,
    MessageToolCall,
    ResourceEdge,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.message_trust_trails import build_assistant_trust_trail
from tests.factories import (
    add_library_member,
    create_test_conversation,
    create_test_library,
    create_test_media_in_library,
    create_test_message,
    create_test_model,
    get_user_default_library,
    share_conversation_to_library,
)
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


def _owned_assistant_message(db_session: Session, viewer_id: UUID) -> tuple[UUID, UUID, UUID]:
    conversation_id = create_test_conversation(db_session, viewer_id)
    user_message_id = create_test_message(
        db_session, conversation_id, seq=1, role="user", content="hi"
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="complete",
    )
    return conversation_id, user_message_id, assistant_message_id


def _result_ref(media_id: UUID | None = None) -> dict[str, object]:
    media_id = media_id or uuid4()
    media_id_str = str(media_id)
    return {
        "type": "media",
        "id": media_id_str,
        "result_type": "media",
        "source_id": "media-1",
        "title": "Trust source",
        "source_label": None,
        "snippet": "Quoted evidence",
        "deep_link": f"/reader/{media_id_str}",
        "citation_target": f"media:{media_id_str}",
        "context_ref": {"type": "media", "id": media_id_str},
        "locator": None,
        "media_id": media_id_str,
        "media_kind": "book",
        "score": 0.9,
        "selected": True,
    }


def _seed_cited_run(
    db_session: Session,
    *,
    owner_id: UUID,
    conversation_id: UUID,
    user_message_id: UUID,
    assistant_message_id: UUID,
) -> tuple[UUID, UUID, UUID, UUID]:
    now = datetime.now(UTC)
    model_id = create_test_model(db_session)
    library_id = get_user_default_library(db_session, owner_id)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session,
        owner_id,
        library_id,
        title="Trust source",
    )
    run = ChatRun(
        owner_user_id=owner_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=f"trust-{uuid4()}",
        payload_hash="hash",
        status="complete",
        model_id=model_id,
        reasoning="medium",
        key_mode="auto",
        started_at=now,
        completed_at=now,
    )
    db_session.add(run)
    db_session.flush()
    tool = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=1,
        scope="all",
        requested_types=["media"],
        result_refs=[],
        selected_context_refs=[],
        provider_request_ids=[],
        status="complete",
    )
    db_session.add(tool)
    db_session.flush()
    result_ref = _result_ref(media_id)
    retrieval = MessageRetrieval(
        tool_call_id=tool.id,
        ordinal=0,
        result_type="media",
        source_id="media-1",
        media_id=media_id,
        scope="all",
        context_ref={"type": "media", "id": str(media_id)},
        result_ref=result_ref,
        deep_link=f"/reader/{media_id}",
        score=0.9,
        selected=True,
        source_title="Trust source",
        exact_snippet="Quoted evidence",
        retrieval_status="selected",
        included_in_prompt=True,
    )
    db_session.add(retrieval)
    db_session.flush()
    edge = ResourceEdge(
        user_id=owner_id,
        kind="context",
        origin="citation",
        source_scheme="message",
        source_id=assistant_message_id,
        target_scheme="media",
        target_id=media_id,
        ordinal=1,
        snapshot={
            "title": "Trust source",
            "excerpt": "Quoted evidence",
            "result_type": "media",
            "deep_link": f"/reader/{media_id}",
        },
    )
    db_session.add(edge)
    db_session.flush()
    retrieval.cited_edge_id = edge.id
    db_session.add(
        MessageRetrievalCandidateLedger(
            tool_call_id=tool.id,
            retrieval_id=retrieval.id,
            ordinal=0,
            result_type="media",
            source_id="media-1",
            score=0.9,
            selected=True,
            included_in_prompt=True,
            selection_status="selected",
            selection_reason="selected_within_budget",
            result_ref=result_ref,
            locator=None,
        )
    )
    db_session.add(
        MessageRerankLedger(
            tool_call_id=tool.id,
            strategy="app_search_context_budget",
            input_count=1,
            selected_count=1,
            budget_chars=16000,
            selected_chars=200,
            status="complete",
            metadata_={
                "selected_limit": 6,
                "scope": "all",
                "inclusion_surface": "tool_output",
            },
        )
    )
    db_session.add(
        ChatPromptAssembly(
            chat_run_id=run.id,
            conversation_id=conversation_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
            cacheable_input_tokens_estimate=20,
            prompt_block_manifest={"blocks": 1},
            max_context_tokens=1000,
            reserved_output_tokens=100,
            reserved_reasoning_tokens=50,
            input_budget_tokens=850,
            estimated_input_tokens=200,
            included_message_ids=[str(user_message_id)],
            included_retrieval_ids=[str(retrieval.id)],
            included_context_refs=[{"uri": f"media:{media_id}"}],
            dropped_items=[],
            budget_breakdown={"retrievals": 1},
        )
    )
    db_session.add(
        ChatRunEvent(
            run_id=run.id,
            seq=1,
            event_type="done",
            payload={"status": "complete", "usage": None, "error_code": None, "final_chars": 12},
        )
    )
    db_session.add(
        ChatRunEvent(
            run_id=run.id,
            seq=2,
            event_type="context_ref_added",
            payload={
                "id": str(uuid4()),
                "conversation_id": str(conversation_id),
                "resource_ref": f"media:{media_id}",
                "activation": {
                    "resource_ref": f"media:{media_id}",
                    "kind": "route",
                    "href": f"/media/{media_id}",
                    "unresolved_reason": None,
                },
                "label": "Trust source",
                "summary": "Cited media",
                "missing": False,
                "created_at": now.isoformat(),
                "citation_edge_id": str(edge.id),
            },
        )
    )
    db_session.commit()
    return run.id, tool.id, retrieval.id, edge.id


def test_owned_message_without_ledgers_returns_empty_trail(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    _, _, assistant_message_id = _owned_assistant_message(db_session, bootstrapped_user)

    trail = build_assistant_trust_trail(
        db_session,
        viewer_id=bootstrapped_user,
        assistant_message_id=assistant_message_id,
    )

    assert trail.assistant_message_id == assistant_message_id
    assert trail.tool_calls == []
    assert trail.citations == []


def test_candidate_and_rerank_ledgers_are_nested_under_tool_call(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    conversation_id, user_message_id, assistant_message_id = _owned_assistant_message(
        db_session,
        bootstrapped_user,
    )
    tool = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        requested_types=["media"],
        result_refs=[_result_ref()],
        selected_context_refs=[],
        provider_request_ids=[],
        status="complete",
    )
    db_session.add(tool)
    db_session.flush()
    db_session.add(
        MessageRetrievalCandidateLedger(
            tool_call_id=tool.id,
            ordinal=0,
            result_type="media",
            source_id="media-1",
            score=0.9,
            selected=True,
            included_in_prompt=True,
            selection_status="included_in_prompt",
            selection_reason="selected",
            result_ref=_result_ref(),
            locator=None,
        )
    )
    db_session.add(
        MessageRerankLedger(
            tool_call_id=tool.id,
            strategy="score",
            input_count=1,
            selected_count=1,
            budget_chars=4000,
            selected_chars=15,
            status="complete",
            metadata_={"reason": "top_result"},
        )
    )
    db_session.commit()

    trail = build_assistant_trust_trail(
        db_session,
        viewer_id=bootstrapped_user,
        assistant_message_id=assistant_message_id,
    )

    assert len(trail.tool_calls) == 1
    assert trail.tool_calls[0].tool_name == "app_search"
    assert len(trail.tool_calls[0].candidate_ledgers) == 1
    assert trail.tool_calls[0].candidate_ledgers[0].included_in_prompt is True
    assert len(trail.tool_calls[0].rerank_ledgers) == 1
    assert trail.tool_calls[0].rerank_ledgers[0].metadata == {"reason": "top_result"}


def test_trust_trail_links_run_prompt_retrieval_citation_and_reference(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    conversation_id, user_message_id, assistant_message_id = _owned_assistant_message(
        db_session,
        bootstrapped_user,
    )
    run_id, tool_id, retrieval_id, edge_id = _seed_cited_run(
        db_session,
        owner_id=bootstrapped_user,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
    )

    trail = build_assistant_trust_trail(
        db_session,
        viewer_id=bootstrapped_user,
        assistant_message_id=assistant_message_id,
    )

    assert trail.chat_run_id == run_id
    assert trail.run is not None
    assert trail.run.reasoning_mode == "medium"
    assert trail.run.status == "complete"
    assert trail.prompt is not None
    assert trail.prompt.included_retrieval_ids == [str(retrieval_id)]
    assert len(trail.tool_calls) == 1
    tool = trail.tool_calls[0]
    assert tool.id == tool_id
    assert len(tool.retrievals) == 1
    retrieval = tool.retrievals[0]
    assert retrieval.id == retrieval_id
    assert retrieval.cited_edge_id == edge_id
    assert retrieval.citation_number == 1
    assert retrieval.included_in_prompt is True
    assert retrieval.included_in_prompt_source == "tool_output"
    assert len(tool.candidate_ledgers) == 1
    assert tool.candidate_ledgers[0].included_in_prompt_source == "tool_output"
    assert tool.candidate_ledgers[0].selection_reason == "selected_within_budget"
    assert len(trail.citations) == 1
    assert trail.citations[0].citation_edge_id == edge_id
    assert trail.citations[0].retrieval_id == retrieval_id
    assert len(trail.context_refs_added) == 1
    assert trail.context_refs_added[0].citation_edge_id == edge_id
    assert trail.integrity_notices == []


def test_shared_reader_reads_owner_owned_citation_edges(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    reader_id = create_test_user_id()
    ensure_user_and_default_library(db_session, reader_id)
    conversation_id, user_message_id, assistant_message_id = _owned_assistant_message(
        db_session,
        bootstrapped_user,
    )
    library_id = create_test_library(db_session, bootstrapped_user, name="Shared trust")
    add_library_member(db_session, library_id, reader_id)
    share_conversation_to_library(db_session, conversation_id, library_id)
    _, _, retrieval_id, edge_id = _seed_cited_run(
        db_session,
        owner_id=bootstrapped_user,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
    )

    trail = build_assistant_trust_trail(
        db_session,
        viewer_id=reader_id,
        assistant_message_id=assistant_message_id,
    )

    assert trail.citations[0].citation_edge_id == edge_id
    assert trail.citations[0].retrieval_id == retrieval_id
    assert trail.tool_calls[0].retrievals[0].cited_edge_id == edge_id


def test_integrity_notices_are_deterministic(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    conversation_id, user_message_id, assistant_message_id = _owned_assistant_message(
        db_session,
        bootstrapped_user,
    )
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=bootstrapped_user,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=f"trust-{uuid4()}",
        payload_hash="hash",
        status="complete",
        model_id=model_id,
        reasoning="default",
        key_mode="auto",
    )
    db_session.add(run)
    db_session.flush()
    tool = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=1,
        scope="all",
        requested_types=["media"],
        result_refs=[],
        selected_context_refs=[],
        provider_request_ids=[],
        status="complete",
    )
    db_session.add(tool)
    db_session.flush()
    library_id = get_user_default_library(db_session, bootstrapped_user)
    assert library_id is not None
    media_id = create_test_media_in_library(
        db_session,
        bootstrapped_user,
        library_id,
        title="Broken trust source",
    )
    result_ref = _result_ref(media_id)
    retrieval = MessageRetrieval(
        tool_call_id=tool.id,
        ordinal=0,
        result_type="media",
        source_id="media-1",
        media_id=media_id,
        scope="all",
        context_ref={"type": "media", "id": str(media_id)},
        result_ref=result_ref,
        selected=True,
        retrieval_status="selected",
        included_in_prompt=False,
    )
    db_session.add(retrieval)
    db_session.flush()
    db_session.add(
        MessageRetrievalCandidateLedger(
            tool_call_id=tool.id,
            retrieval_id=retrieval.id,
            ordinal=0,
            result_type="media",
            source_id="media-1",
            score=0.9,
            selected=True,
            included_in_prompt=True,
            selection_status="included_in_prompt",
            selection_reason="selected",
            result_ref=result_ref,
            locator=None,
        )
    )
    missing_prompt_retrieval_id = uuid4()
    db_session.add(
        ChatPromptAssembly(
            chat_run_id=run.id,
            conversation_id=conversation_id,
            assistant_message_id=assistant_message_id,
            model_id=model_id,
            cacheable_input_tokens_estimate=20,
            prompt_block_manifest={},
            max_context_tokens=1000,
            reserved_output_tokens=100,
            reserved_reasoning_tokens=50,
            input_budget_tokens=850,
            estimated_input_tokens=200,
            included_message_ids=[],
            included_retrieval_ids=[str(missing_prompt_retrieval_id)],
            included_context_refs=[],
            dropped_items=[],
            budget_breakdown={},
        )
    )
    db_session.add(
        ChatRunEvent(
            run_id=run.id,
            seq=1,
            event_type="context_ref_added",
            payload={
                "id": str(uuid4()),
                "conversation_id": str(conversation_id),
                "resource_ref": f"media:{media_id}",
                "activation": {
                    "resource_ref": f"media:{media_id}",
                    "kind": "route",
                    "href": f"/media/{media_id}",
                    "unresolved_reason": None,
                },
                "label": "Broken reference",
                "summary": "",
                "missing": False,
                "created_at": datetime.now(UTC).isoformat(),
                "citation_edge_id": str(uuid4()),
            },
        )
    )
    db_session.commit()

    trail = build_assistant_trust_trail(
        db_session,
        viewer_id=bootstrapped_user,
        assistant_message_id=assistant_message_id,
    )

    assert [notice.code.split(":")[0] for notice in trail.integrity_notices] == [
        "selected_retrieval_missing_citation",
        "candidate_inclusion_mismatch",
        "prompt_retrieval_missing",
        "context_ref_missing_citation",
    ]


def test_unknown_message_raises_message_not_found(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    with pytest.raises(NotFoundError) as exc_info:
        build_assistant_trust_trail(
            db_session,
            viewer_id=bootstrapped_user,
            assistant_message_id=uuid4(),
        )
    assert exc_info.value.code == ApiErrorCode.E_MESSAGE_NOT_FOUND


def test_non_owner_is_masked_as_message_not_found(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    _, _, assistant_message_id = _owned_assistant_message(db_session, bootstrapped_user)

    with pytest.raises(NotFoundError) as exc_info:
        build_assistant_trust_trail(
            db_session,
            viewer_id=create_test_user_id(),
            assistant_message_id=assistant_message_id,
        )
    assert exc_info.value.code == ApiErrorCode.E_MESSAGE_NOT_FOUND
