"""Tests for assistant-message trust trail retrieval ledgers."""

from datetime import UTC, datetime
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
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
from nexus.schemas.conversation import (
    ChatRunToolLedgerSnapshotEventPayload,
    MessageRerankLedgerOut,
    MessageRetrievalCandidateLedgerOut,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.message_trust_trails import build_assistant_trust_trail
from nexus.services.search.selection import (
    APP_SEARCH_SELECTION_STRATEGY,
    APP_SEARCH_SELECTION_VERSION,
)
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


def _source_policy() -> dict[str, object]:
    return {
        "version": "source_boundary_policy.v1",
        "decision": "allowed",
        "source_domain": "private_app",
        "mixing_allowed": False,
        "reason": "single_domain_private_app",
        "domains_seen": [],
        "requested_domains": ["private_app"],
    }


def test_candidate_ledger_transport_requires_result_ref_parity() -> None:
    base = {
        "id": uuid4(),
        "tool_call_id": uuid4(),
        "retrieval_id": None,
        "ordinal": 0,
        "result_type": "media",
        "source_id": "media-1",
        "score": 0.9,
        "selected": True,
        "included_in_prompt": True,
        "ledger_included_in_prompt": True,
        "linked_retrieval_included_in_prompt": None,
        "included_in_prompt_source": "candidate_ledger",
        "included_in_prompt_reconciled": True,
        "selection_status": "selected",
        "selection_reason": "selected_within_budget",
        "result_ref": _result_ref(),
        "locator": None,
        "created_at": datetime.now(UTC),
    }
    assert MessageRetrievalCandidateLedgerOut.model_validate(base).source_id == "media-1"

    with pytest.raises(ValidationError):
        MessageRetrievalCandidateLedgerOut.model_validate({**base, "result_type": "page"})
    with pytest.raises(ValidationError):
        MessageRetrievalCandidateLedgerOut.model_validate({**base, "source_id": "media-2"})
    with pytest.raises(ValidationError):
        MessageRetrievalCandidateLedgerOut.model_validate(
            {
                **base,
                "locator": {"type": "external_url", "url": "https://example.com"},
            }
        )


def test_tool_ledger_snapshot_transport_requires_candidate_ref_parity() -> None:
    tool_call_id = uuid4()
    candidate = {
        "id": uuid4(),
        "tool_call_id": tool_call_id,
        "retrieval_id": None,
        "ordinal": 0,
        "result_type": "media",
        "source_id": "media-1",
        "score": 0.9,
        "selected": True,
        "included_in_prompt": True,
        "ledger_included_in_prompt": True,
        "linked_retrieval_included_in_prompt": None,
        "included_in_prompt_source": "candidate_ledger",
        "included_in_prompt_reconciled": True,
        "selection_status": "selected",
        "selection_reason": "selected_within_budget",
        "result_ref": _result_ref(),
        "locator": None,
        "created_at": datetime.now(UTC),
    }
    snapshot = {
        "assistant_message_id": uuid4(),
        "tool_call_id": tool_call_id,
        "tool_name": "app_search",
        "tool_call_index": 0,
        "scope": "all",
        "requested_types": ["media"],
        "source_domain": "private_app",
        "source_policy": _source_policy(),
        "candidate_ledgers": [candidate],
        "rerank_ledgers": [],
    }
    assert ChatRunToolLedgerSnapshotEventPayload.model_validate(snapshot).tool_name == "app_search"

    with pytest.raises(ValidationError):
        ChatRunToolLedgerSnapshotEventPayload.model_validate(
            {
                **snapshot,
                "candidate_ledgers": [{**candidate, "source_id": "media-2"}],
            }
        )


def test_rerank_metadata_transport_is_closed() -> None:
    base = {
        "id": uuid4(),
        "tool_call_id": uuid4(),
        "strategy": "app_search_provider_rerank",
        "input_count": 1,
        "selected_count": 1,
        "budget_chars": 16000,
        "selected_chars": 120,
        "status": "complete",
        "metadata": {
            "selection_strategy": "app_search_provider_rerank",
            "selection_policy_version": "v1",
            "baseline_strategy": "app_search_deterministic_selection",
            "candidate_rerank_trace": [
                {
                    "from": 0,
                    "to": 0,
                    "result_type": "media",
                    "source_id": "media-1",
                    "source": "media:media-1",
                    "section": "section:intro",
                    "provider_score": 0.9,
                    "lexical": 1.0,
                    "phrase": True,
                    "type_bonus": 0.3,
                    "citation_quality": 0.1,
                    "source_penalty": 0.0,
                    "section_penalty": 0.0,
                    "selected": True,
                    "included_in_prompt": True,
                    "selection_status": "selected",
                    "selection_reason": "selected_within_budget",
                }
            ],
        },
        "created_at": datetime.now(UTC),
    }
    assert MessageRerankLedgerOut.model_validate(base).metadata["selection_strategy"] == (
        "app_search_provider_rerank"
    )

    with pytest.raises(ValidationError):
        MessageRerankLedgerOut.model_validate(
            {**base, "metadata": {**base["metadata"], "unknown": True}}
        )
    with pytest.raises(ValidationError):
        MessageRerankLedgerOut.model_validate(
            {
                **base,
                "metadata": {
                    **base["metadata"],
                    "candidate_rerank_trace": [
                        {**base["metadata"]["candidate_rerank_trace"][0], "unknown": True}
                    ],
                },
            }
        )
    for guidance_patch in [
        {"ready_count": 1},
        {"revision_ids": ["revision-1"]},
        {"artifact_kinds": ["document_summary"]},
        {"citation_target": "content_chunk:generated"},
        {"result_ref": {"type": "content_chunk", "id": "generated"}},
        {"generated_text": "generated summary"},
        {"summary": "generated summary"},
        {"evidence": "generated evidence"},
    ]:
        with pytest.raises(ValidationError):
            MessageRerankLedgerOut.model_validate(
                {
                    **base,
                    "metadata": {
                        **base["metadata"],
                        "retrieval_guidance": {
                            "version": "retrieval_guidance_usage.v1",
                            "status": "unused",
                            **guidance_patch,
                        },
                    },
                }
            )
    for trace_patch in [
        {"lexical": "not-a-number"},
        {"lexical": 1.1},
        {"phrase": "not-a-bool"},
        {"provider_score": 1.7},
        {"provider_score": float("nan")},
        {"source_penalty": -0.1},
        {"section_penalty": float("inf")},
        {"type_bonus": float("inf")},
        {"selection_score": float("inf")},
        {"score": -0.1},
        {"citation_quality": -0.1},
    ]:
        with pytest.raises(ValidationError):
            MessageRerankLedgerOut.model_validate(
                {
                    **base,
                    "metadata": {
                        **base["metadata"],
                        "candidate_rerank_trace": [
                            {
                                **base["metadata"]["candidate_rerank_trace"][0],
                                **trace_patch,
                            }
                        ],
                    },
                }
            )
    assert (
        MessageRerankLedgerOut.model_validate(
            {
                **base,
                "metadata": {
                    **base["metadata"],
                    "candidate_rerank_trace": [
                        {
                            **base["metadata"]["candidate_rerank_trace"][0],
                            "type_bonus": -0.05,
                        }
                    ],
                },
            }
        ).metadata["candidate_rerank_trace"][0]["type_bonus"]
        == -0.05
    )
    assert (
        MessageRerankLedgerOut.model_validate(
            {
                **base,
                "metadata": {
                    **base["metadata"],
                    "candidate_rerank_trace": [
                        {
                            **base["metadata"]["candidate_rerank_trace"][0],
                            "selection_score": -0.05,
                        }
                    ],
                },
            }
        ).metadata["candidate_rerank_trace"][0]["selection_score"]
        == -0.05
    )


def _retrieval_plan() -> dict[str, object]:
    return {
        "version": "chat_retrieval_plan.v1",
        "route_intent": "private_app_search",
        "source_domain": "private_app",
        "mixing_policy": "single_domain",
        "query_class": "exact_lookup",
        "allowed_tools": ["app_search", "inspect_resource", "read_resource"],
        "blocked_tools": ["web_search"],
        "candidate_tool_sequence": ["app_search", "inspect_resource", "read_resource"],
        "internal_tool_sequence": [],
        "reason": "default_private_search_or_context",
        "context_ref_count": 0,
        "search_scope_count": 0,
        "search_scope_uris": [],
        "budget_policy": "tool_output_budget_from_prompt_assembly",
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
        retrieval_plan=_retrieval_plan(),
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
        source_domain="private_app",
        source_policy=_source_policy(),
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
            strategy=APP_SEARCH_SELECTION_STRATEGY,
            input_count=1,
            selected_count=1,
            budget_chars=16000,
            selected_chars=200,
            status="complete",
            metadata_={
                "selection_strategy": APP_SEARCH_SELECTION_STRATEGY,
                "selection_policy_version": APP_SEARCH_SELECTION_VERSION,
                "ordering_policy": "hybrid_score_exactness_citation_quality_diversity",
                "diversity_policy": "source_section_penalty",
                "budget_policy": "greedy_context_budget",
                "candidate_limit": 20,
                "selected_limit": 6,
                "context_budget_chars": 16000,
                "query_class": "exact_lookup",
                "scope": "all",
                "inclusion_surface": "tool_output",
                "selection_reason_counts": {"selected_within_budget": 1},
                "candidate_rerank_trace": [
                    {
                        "from": 0,
                        "to": 0,
                        "result_type": "media",
                        "source_id": "media-1",
                        "score": 0.9,
                        "reason": "kept_order",
                        "selected": True,
                        "included_in_prompt": True,
                        "selection_status": "selected",
                        "selection_reason": "selected_within_budget",
                    }
                ],
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
        source_domain="private_app",
        source_policy=_source_policy(),
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
            strategy=APP_SEARCH_SELECTION_STRATEGY,
            input_count=1,
            selected_count=1,
            budget_chars=4000,
            selected_chars=15,
            status="complete",
            metadata_={
                "selection_strategy": APP_SEARCH_SELECTION_STRATEGY,
                "selection_policy_version": APP_SEARCH_SELECTION_VERSION,
                "ordering_policy": "hybrid_score_exactness_citation_quality_diversity",
                "diversity_policy": "source_section_penalty",
                "budget_policy": "greedy_context_budget",
                "candidate_limit": 20,
                "selected_limit": 6,
                "context_budget_chars": 16000,
                "query_class": "exact_lookup",
                "scope": "all",
                "inclusion_surface": "tool_output",
                "selection_reason_counts": {"selected": 1},
                "candidate_rerank_trace": [
                    {
                        "from": 0,
                        "to": 0,
                        "result_type": "media",
                        "source_id": "media-1",
                        "score": 0.9,
                        "reason": "kept_order",
                        "selected": True,
                        "included_in_prompt": True,
                        "selection_status": "included_in_prompt",
                        "selection_reason": "selected",
                    }
                ],
            },
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
    assert trail.tool_calls[0].rerank_ledgers[0].strategy == APP_SEARCH_SELECTION_STRATEGY
    assert (
        trail.tool_calls[0]
        .rerank_ledgers[0]
        .metadata["candidate_rerank_trace"][0]["selection_reason"]
        == "selected"
    )


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
    assert (
        trail.context_refs_added[0].activation.href
        == f"/media/{trail.context_refs_added[0].resource_ref.split(':', 1)[1]}"
    )
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
        retrieval_plan=_retrieval_plan(),
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
        source_domain="private_app",
        source_policy=_source_policy(),
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
