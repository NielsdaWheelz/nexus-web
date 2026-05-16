"""Persistence tests for assistant app-search tool metadata."""

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import get_args
from uuid import uuid4

import pytest
from llm_calling.errors import LLMError, LLMErrorCode
from pydantic import ValidationError
from sqlalchemy import UniqueConstraint, func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from nexus.db.models import (
    AppSearchResultType,
    AssistantMessageCitationAudit,
    AssistantMessageClaim,
    AssistantMessageClaimEvidence,
    AssistantMessageEvidenceSummary,
    AssistantMessageVerifierRun,
    ChatPromptAssembly,
    ChatRun,
    ChatRunEvent,
    ChatRunEventType,
    Message,
    MessageArtifact,
    MessageArtifactPart,
    MessageRetrieval,
    MessageToolCall,
    Model,
    SourceManifest,
)
from nexus.schemas.context_memory import SourceRef
from nexus.schemas.conversation import (
    APP_SEARCH_RESULT_TYPES,
    CHAT_RUN_EVENT_TYPES,
    MESSAGE_TOOL_STATUSES,
    MessageClaimEvidenceOut,
    MessageContextRef,
    MessageDocument,
    MessageOut,
    MessageRetrievalOut,
    MessageToolCallOut,
    chat_run_event_payload_json,
)
from nexus.schemas.notes import OBJECT_TYPE_VALUES
from nexus.schemas.retrieval import retrieval_context_ref_json, retrieval_result_ref_json
from nexus.schemas.search import SearchResultArtifactPartOut
from nexus.services import contexts as contexts_service
from nexus.services.agent_tools.app_search import (
    AppSearchCitation,
    AppSearchRun,
    _citation_from_search_result,
    persist_app_search_run,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.chat_runs import (
    VERIFICATION_FAILURE_CONTENT,
    _finalize_message_evidence,
    _finalize_run,
    _message_document_with_run_components,
    _message_prompt_evidence_rows,
    _parse_claim_extractor_response,
    _parse_claim_verifier_response,
    _reconcile_prompt_retrievals,
    _verified_assistant_content,
    append_run_event,
)
from nexus.services.conversations import load_message_artifacts_for_message_ids, message_to_out
from tests.factories import (
    create_searchable_media,
    create_test_conversation,
    create_test_message,
    create_test_model,
)
from tests.helpers import create_test_user_id

pytestmark = pytest.mark.integration


def test_source_manifest_model_declares_current_snapshot_unique_constraint():
    unique_constraints = {
        constraint.name
        for constraint in SourceManifest.__table__.constraints
        if isinstance(constraint, UniqueConstraint)
    }
    assert "uix_source_manifests_run_tool_call_index" in unique_constraints


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


def _add_prompt_assembly(
    session: Session,
    run: ChatRun,
    assistant_message_id,
    retrieval_ids,
) -> None:
    session.add(
        ChatPromptAssembly(
            chat_run_id=run.id,
            conversation_id=run.conversation_id,
            assistant_message_id=assistant_message_id,
            model_id=run.model_id,
            prompt_version="test",
            prompt_plan_version="test",
            assembler_version="test",
            stable_prefix_hash="hash",
            cacheable_input_tokens_estimate=0,
            prompt_block_manifest={},
            provider_request_hash="hash",
            max_context_tokens=4096,
            reserved_output_tokens=0,
            reserved_reasoning_tokens=0,
            input_budget_tokens=4096,
            estimated_input_tokens=1,
            included_message_ids=[],
            included_memory_item_ids=[],
            included_retrieval_ids=[str(retrieval_id) for retrieval_id in retrieval_ids],
            included_context_refs=[],
            dropped_items=[],
            budget_breakdown={},
        )
    )


def _test_locator(fragment_id: str = "fragment-1") -> dict[str, object]:
    return {
        "type": "web_text_offsets",
        "media_id": "media-1",
        "fragment_id": fragment_id,
        "start_offset": 0,
        "end_offset": 80,
    }


def test_message_retrieval_result_type_enum_matches_response_contract():
    orm_types = {result_type.value for result_type in AppSearchResultType}
    schema_types = set(get_args(APP_SEARCH_RESULT_TYPES))

    assert orm_types == schema_types
    assert "contributor" in orm_types
    assert "episode" in orm_types
    assert "video" in orm_types
    assert "artifact_part" in orm_types
    assert "annotation" not in orm_types


def test_chat_run_event_type_enum_matches_response_contract():
    orm_types = {event_type.value for event_type in ChatRunEventType}
    schema_types = set(get_args(CHAT_RUN_EVENT_TYPES))

    assert orm_types == schema_types
    assert "retrieval_result" in orm_types
    assert "source_manifest_delta" in orm_types
    assert "artifact_delta" in orm_types
    assert "claim" in orm_types
    assert "citation" not in orm_types
    assert "tool_result" not in orm_types


def test_message_tool_status_contract_accepts_streaming_states():
    schema_statuses = set(get_args(MESSAGE_TOOL_STATUSES))

    assert schema_statuses == {"pending", "running", "complete", "error", "cancelled"}


def test_fragment_object_refs_are_part_of_shared_object_type_contract():
    assert "fragment" in OBJECT_TYPE_VALUES


def _message_retrieval_payload(result_type: str = "content_chunk") -> dict:
    retrieval_id = uuid4()
    tool_call_id = uuid4()
    source_id = str(uuid4())
    context_type = "media" if result_type in {"episode", "video"} else result_type
    locator = (
        {
            "type": "web_text_offsets",
            "media_id": str(uuid4()),
            "fragment_id": source_id,
            "start_offset": 1,
            "end_offset": 18,
        }
        if result_type == "content_chunk"
        else None
    )
    payload = {
        "id": retrieval_id,
        "tool_call_id": tool_call_id,
        "ordinal": 0,
        "result_type": result_type,
        "source_id": source_id,
        "media_id": uuid4(),
        "evidence_span_id": None,
        "scope": "all",
        "context_ref": {"type": context_type, "id": source_id},
        "result_ref": {
            "type": result_type,
            "id": source_id,
            "result_type": result_type,
            "source_id": source_id,
            "title": "Source title",
            "source_label": "Source",
            "snippet": "Exact source text",
            "deep_link": f"/media/{source_id}",
            "context_ref": {"type": context_type, "id": source_id},
            "source_version": "content_index:test:v1" if result_type == "content_chunk" else None,
            "locator": locator,
            "media_id": str(uuid4()),
            "media_kind": "web_article",
            "score": 0.8,
            "selected": True,
        },
        "deep_link": f"/media/{source_id}",
        "score": 0.8,
        "selected": True,
        "source_title": "Source title",
        "section_label": "Source",
        "exact_snippet": "Exact source text",
        "snippet_prefix": None,
        "snippet_suffix": None,
        "locator": locator,
        "retrieval_status": "included_in_prompt",
        "included_in_prompt": True,
        "source_version": "content_index:test:v1" if locator is not None else None,
        "created_at": datetime.now(UTC),
    }
    if locator is not None:
        payload["result_ref"].update(
            {
                "source_kind": "web_article",
                "citation_label": "Source",
                "evidence_span_ids": [],
            }
        )
    else:
        payload["result_ref"]["locator"] = None
    return payload


def _web_retrieval_payload() -> dict:
    payload = _message_retrieval_payload("content_chunk")
    result_ref = "web:result:1"
    payload.update(
        {
            "result_type": "web_result",
            "source_id": result_ref,
            "media_id": None,
            "context_ref": {"type": "web_result", "id": result_ref},
            "result_ref": {
                "type": "web_result",
                "id": result_ref,
                "result_type": "web_result",
                "result_ref": result_ref,
                "source_id": result_ref,
                "title": "Web result",
                "url": "https://example.com/story",
                "display_url": "example.com",
                "deep_link": "https://example.com/story",
                "locator": {
                    "type": "external_url",
                    "url": "https://example.com/story",
                    "title": "Web result",
                    "display_url": "example.com",
                },
                "snippet": "Web excerpt",
                "source_name": "Example",
                "rank": 1,
                "provider": "brave",
                "source_version": "web_search:brave:web:result:1",
                "context_ref": {"type": "web_result", "id": result_ref},
                "media_id": None,
                "media_kind": None,
                "score": 1.0,
                "selected": True,
            },
            "deep_link": "https://example.com/story",
            "locator": {
                "type": "external_url",
                "url": "https://example.com/story",
                "title": "Web result",
                "display_url": "example.com",
            },
            "retrieval_status": "web_result",
            "source_version": "web_search:brave:web:result:1",
        }
    )
    return payload


def test_message_retrieval_out_validates_app_and_web_refs():
    assert MessageRetrievalOut.model_validate(_message_retrieval_payload()).result_type == (
        "content_chunk"
    )
    assert MessageRetrievalOut.model_validate(
        _message_retrieval_payload("episode")
    ).result_type == ("episode")
    assert MessageRetrievalOut.model_validate(_message_retrieval_payload("video")).result_type == (
        "video"
    )
    assert MessageRetrievalOut.model_validate(_web_retrieval_payload()).locator is not None


def test_message_retrieval_out_rejects_malformed_refs():
    missing_id = _message_retrieval_payload()
    missing_id["context_ref"] = {"type": "content_chunk"}
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate(missing_id)

    mismatched = _message_retrieval_payload()
    mismatched["result_ref"]["type"] = "highlight"
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate(mismatched)

    bad_web_locator = _web_retrieval_payload()
    bad_web_locator["locator"] = {"type": "external_url", "title": "Missing URL"}
    bad_web_locator["result_ref"]["locator"] = bad_web_locator["locator"]
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate(bad_web_locator)

    outer_mismatch = _message_retrieval_payload()
    outer_mismatch["result_type"] = "highlight"
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate(outer_mismatch)

    web_outer_mismatch = _web_retrieval_payload()
    web_outer_mismatch["result_type"] = "status"
    with pytest.raises(ValidationError):
        MessageRetrievalOut.model_validate(web_outer_mismatch)

    missing_outer_source_version = _web_retrieval_payload()
    missing_outer_source_version["source_version"] = None
    with pytest.raises(ValidationError, match="source_version must match"):
        MessageRetrievalOut.model_validate(missing_outer_source_version)

    missing_outer_locator = _web_retrieval_payload()
    missing_outer_locator["locator"] = None
    with pytest.raises(ValidationError, match="locator must match"):
        MessageRetrievalOut.model_validate(missing_outer_locator)

    drifted_outer_locator = _web_retrieval_payload()
    drifted_outer_locator["locator"] = {
        "type": "external_url",
        "url": "https://example.com/other",
        "title": "Web result",
        "display_url": "example.com",
    }
    with pytest.raises(ValidationError, match="locator must match"):
        MessageRetrievalOut.model_validate(drifted_outer_locator)


def test_message_document_validates_frontend_blocks():
    retrieval_block = _message_retrieval_payload()
    retrieval_block.pop("scope")
    document = MessageDocument.model_validate(
        {
            "type": "message_document",
            "version": 1,
            "blocks": [
                {"type": "text", "format": "markdown", "text": "Here is the answer."},
                {"type": "retrieval_result", **retrieval_block},
            ],
        }
    )

    dumped = document.model_dump(mode="json")
    assert dumped["blocks"][0] == {
        "type": "text",
        "format": "markdown",
        "text": "Here is the answer.",
    }
    assert dumped["blocks"][1]["result_type"] == "content_chunk"
    assert dumped["blocks"][1]["context_ref"]["type"] == "content_chunk"

    source_version_mismatch = _message_retrieval_payload()
    source_version_mismatch.pop("scope")
    source_version_mismatch["source_version"] = "content_index:other:v1"
    with pytest.raises(ValidationError, match="source_version must match"):
        MessageDocument.model_validate(
            {
                "type": "message_document",
                "version": 1,
                "blocks": [{"type": "retrieval_result", **source_version_mismatch}],
            }
        )

    locator_mismatch = _message_retrieval_payload()
    locator_mismatch.pop("scope")
    locator_mismatch["locator"] = {
        **locator_mismatch["locator"],
        "start_offset": 3,
    }
    with pytest.raises(ValidationError, match="locator must match"):
        MessageDocument.model_validate(
            {
                "type": "message_document",
                "version": 1,
                "blocks": [{"type": "retrieval_result", **locator_mismatch}],
            }
        )


def test_message_document_rejects_unknown_blocks():
    with pytest.raises(ValidationError):
        MessageDocument.model_validate(
            {
                "type": "message_document",
                "version": 1,
                "blocks": [{"type": "legacy_citation", "id": "citation-1"}],
            }
        )

    with pytest.raises(ValidationError):
        MessageDocument.model_validate(
            {
                "type": "message_document",
                "version": 2,
                "blocks": [],
            }
        )

    with pytest.raises(ValidationError, match="assistant_message_id"):
        MessageDocument.model_validate(
            {
                "type": "message_document",
                "version": 1,
                "blocks": [
                    {
                        "type": "source_manifest",
                        "tool_name": "app_search",
                        "tool_call_index": 0,
                        "candidate_count": 0,
                        "result_count": 0,
                        "selected_count": 0,
                        "included_in_prompt_count": 0,
                        "excluded_by_budget_count": 0,
                        "excluded_by_scope_count": 0,
                        "stale_count": 0,
                        "unreadable_count": 0,
                        "status": "complete",
                        "metadata": {},
                    }
                ],
            }
        )


def test_message_out_serializes_message_document_contract():
    message = MessageOut.model_validate(
        {
            "id": uuid4(),
            "seq": 1,
            "role": "assistant",
            "status": "complete",
            "created_at": datetime(2026, 1, 1, tzinfo=UTC),
            "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
            "message_document": {
                "type": "message_document",
                "version": 1,
                "blocks": [
                    {
                        "type": "text",
                        "format": "markdown",
                        "text": "Here is the answer.",
                    }
                ],
            },
        }
    )

    assert message.model_dump(mode="json")["message_document"] == {
        "type": "message_document",
        "version": 1,
        "blocks": [
            {
                "type": "text",
                "format": "markdown",
                "text": "Here is the answer.",
            }
        ],
    }

    with pytest.raises(ValidationError):
        MessageOut.model_validate(
            {
                "id": uuid4(),
                "seq": 1,
                "role": "assistant",
                "content": "legacy mirror",
                "status": "complete",
                "created_at": datetime(2026, 1, 1, tzinfo=UTC),
                "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
                "message_document": {
                    "type": "message_document",
                    "version": 1,
                    "blocks": [],
                },
            }
        )


def test_message_out_rejects_malformed_message_document():
    with pytest.raises(ValidationError):
        MessageOut.model_validate(
            {
                "id": uuid4(),
                "seq": 1,
                "role": "assistant",
                "content": "Here is the answer.",
                "status": "complete",
                "created_at": datetime(2026, 1, 1, tzinfo=UTC),
                "updated_at": datetime(2026, 1, 1, tzinfo=UTC),
                "message_document": {
                    "type": "message_document",
                    "version": 1,
                    "blocks": [{"type": "text", "format": "markdown"}],
                },
            }
        )


def test_retrieval_ref_json_rejects_status_and_preserves_web_source_version():
    with pytest.raises(ValidationError):
        retrieval_context_ref_json({"type": "status", "id": "no_results"})
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {
                "type": "status",
                "id": "no_results",
                "status": "no_results",
                "source_version": "app_search_status:v1",
            }
        )
    web_ref = retrieval_result_ref_json(_web_retrieval_payload()["result_ref"])
    assert web_ref["source_version"] == _web_retrieval_payload()["result_ref"]["source_version"]

    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {**_web_retrieval_payload()["result_ref"], "media_id": str(uuid4())}
        )
    with pytest.raises(ValidationError):
        retrieval_context_ref_json({"type": "totally_unknown", "id": "x"})
    with pytest.raises(ValidationError):
        retrieval_result_ref_json({"type": "totally_unknown", "id": "x"})
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {**_web_retrieval_payload()["result_ref"], "source_version": None}
        )
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {
                key: value
                for key, value in _web_retrieval_payload()["result_ref"].items()
                if key != "result_ref"
            }
        )
    with pytest.raises(ValidationError):
        retrieval_result_ref_json(
            {
                **_message_retrieval_payload()["result_ref"],
                "source_version": None,
            }
        )
    with pytest.raises(ValidationError):
        SourceRef.model_validate(
            {
                "type": "message_retrieval",
                "id": "r1",
                "result_ref": {"type": "unknown"},
            }
        )


def test_artifact_part_app_search_ref_emits_strict_source_version():
    artifact_id = uuid4()
    part_id = uuid4()
    message_id = uuid4()
    conversation_id = uuid4()
    locator = {
        "type": "artifact_part_ref",
        "artifact_id": str(artifact_id),
        "artifact_part_id": str(part_id),
        "message_id": str(message_id),
        "conversation_id": str(conversation_id),
        "part_key": "row-1",
    }
    result = SearchResultArtifactPartOut(
        type="artifact_part",
        id=part_id,
        score=0.9,
        snippet="Artifact needle row evidence",
        artifact_id=artifact_id,
        message_id=message_id,
        conversation_id=conversation_id,
        artifact_kind="table",
        artifact_title="Research Table",
        part_key="row-1",
        part_type="table_row",
        evidence_span_ids=[],
        source_version=f"artifact_part:{part_id}:v1",
        locator=locator,
        title="Research Table",
        source_label="artifact part",
        media_id=None,
        media_kind=None,
        deep_link=f"/conversations/{conversation_id}?artifact={artifact_id}&artifactPart={part_id}",
        context_ref={"type": "artifact_part", "id": part_id},
    )

    citation = _citation_from_search_result(result, filters={})

    assert citation.locator == locator
    assert citation.source_version == f"artifact_part:{part_id}:v1"
    assert citation.result_ref_json()["source_version"] == f"artifact_part:{part_id}:v1"


def test_message_claim_evidence_out_validates_retrieval_refs():
    retrieval = _web_retrieval_payload()
    evidence = {
        "id": uuid4(),
        "claim_id": uuid4(),
        "ordinal": 0,
        "evidence_role": "supports",
        "source_ref": {
            "type": "web_result",
            "id": retrieval["source_id"],
            "source_version": retrieval["source_version"],
        },
        "retrieval_id": retrieval["id"],
        "evidence_span_id": None,
        "context_ref": retrieval["context_ref"],
        "result_ref": retrieval["result_ref"],
        "exact_snippet": "Web excerpt",
        "snippet_prefix": None,
        "snippet_suffix": None,
        "locator": retrieval["locator"],
        "deep_link": retrieval["deep_link"],
        "score": 1.0,
        "retrieval_status": "web_result",
        "selected": True,
        "included_in_prompt": True,
        "source_version": retrieval["source_version"],
        "created_at": datetime.now(UTC),
    }

    assert MessageClaimEvidenceOut.model_validate(evidence).retrieval_status == "web_result"


def test_message_document_rejects_incomplete_citable_claim_evidence():
    retrieval = _web_retrieval_payload()
    evidence = {
        "type": "claim_evidence",
        "id": uuid4(),
        "claim_id": uuid4(),
        "ordinal": 0,
        "evidence_role": "supports",
        "source_ref": {
            "type": "web_result",
            "id": retrieval["source_id"],
            "source_version": retrieval["source_version"],
        },
        "retrieval_id": retrieval["id"],
        "evidence_span_id": None,
        "context_ref": retrieval["context_ref"],
        "result_ref": retrieval["result_ref"],
        "exact_snippet": "Web excerpt",
        "snippet_prefix": None,
        "snippet_suffix": None,
        "locator": retrieval["locator"],
        "deep_link": retrieval["deep_link"],
        "score": 1.0,
        "retrieval_status": "web_result",
        "selected": True,
        "included_in_prompt": True,
        "source_version": retrieval["source_version"],
        "created_at": datetime.now(UTC),
    }

    assert MessageDocument.model_validate(
        {"type": "message_document", "version": 1, "blocks": [evidence]}
    )

    for key, message in (
        ("locator", "supporting claim evidence requires a locator"),
        ("source_version", "supporting claim evidence requires a source_version"),
        ("exact_snippet", "supporting claim evidence requires an exact_snippet"),
    ):
        incomplete = {**evidence, key: None}
        with pytest.raises(ValidationError, match=message):
            MessageDocument.model_validate(
                {"type": "message_document", "version": 1, "blocks": [incomplete]}
            )


def test_message_tool_call_out_rejects_loose_result_and_context_refs():
    base = {
        "id": uuid4(),
        "conversation_id": uuid4(),
        "user_message_id": uuid4(),
        "assistant_message_id": uuid4(),
        "tool_name": "app_search",
        "tool_call_index": 0,
        "scope": "all",
        "semantic": True,
        "status": "complete",
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }
    with pytest.raises(ValidationError):
        MessageToolCallOut.model_validate(
            {
                **base,
                "result_refs": [{"kind": "web", "route": "/legacy"}],
                "selected_context_refs": [],
            }
        )
    with pytest.raises(ValidationError):
        MessageToolCallOut.model_validate(
            {
                **base,
                "result_refs": [],
                "selected_context_refs": [{"kind": "message", "id": "legacy"}],
            }
        )


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


def test_message_prompt_evidence_rows_include_attached_content_chunk_context(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    ensure_user_and_default_library(db_session, user_id)
    model_id = create_test_model(db_session)
    media_id = create_searchable_media(db_session, user_id, title="Attached Evidence Source")
    row = (
        db_session.execute(
            text(
                """
                SELECT
                    cc.id AS chunk_id,
                    cc.primary_evidence_span_id AS evidence_span_id,
                    ss.source_version AS source_version
                FROM content_chunks cc
                JOIN evidence_spans es ON es.id = cc.primary_evidence_span_id
                JOIN source_snapshots ss ON ss.id = es.source_snapshot_id
                WHERE cc.media_id = :media_id
                ORDER BY cc.chunk_idx ASC
                LIMIT 1
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .one()
    )
    contexts_service.insert_context(
        db=db_session,
        message_id=user_message_id,
        ordinal=0,
        context=MessageContextRef(
            kind="object_ref",
            type="content_chunk",
            id=row["chunk_id"],
            evidence_span_ids=[row["evidence_span_id"]],
        ),
    )
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    db_session.commit()
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None

    _prompt_rows, evidence_rows = _message_prompt_evidence_rows(
        db_session,
        run,
        assistant_message,
        reconcile_inclusion=False,
    )

    assert len(evidence_rows) == 1
    evidence = evidence_rows[0]
    assert evidence["retrieval_status"] == "attached_context"
    assert evidence["context_ref"] == {
        "type": "content_chunk",
        "id": str(row["chunk_id"]),
        "evidence_span_ids": [str(row["evidence_span_id"])],
    }
    assert evidence["source_version"] == row["source_version"]
    assert evidence["locator"]["type"] == "web_text_offsets"
    assert "canonical text" in evidence["exact_snippet"]


def test_persist_app_search_run_appends_audit_ledgers_for_existing_tool_call(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    source_id = str(uuid4())
    media_id = str(uuid4())
    fragment_id = str(uuid4())
    locator = {
        "type": "web_text_offsets",
        "media_id": media_id,
        "fragment_id": fragment_id,
        "start_offset": 0,
        "end_offset": 20,
        "media_kind": "web_article",
        "text_quote_selector": {"exact": "Durable source text"},
    }
    citation = AppSearchCitation(
        result_type="content_chunk",
        source_id=source_id,
        title="Durable Source",
        source_label="Durable Source",
        snippet="Durable source text",
        deep_link=f"/media/{media_id}",
        citation_label="Source",
        locator=locator,
        context_ref={"type": "content_chunk", "id": source_id},
        evidence_span_id=None,
        source_version="content_index:test:v1",
        media_id=None,
        media_kind="web_article",
        score=0.8,
        result_ref={"source_kind": "web_article", "evidence_span_ids": []},
        selected=True,
    )
    run = AppSearchRun(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        query_hash="query-hash",
        scope="all",
        requested_types=["content_chunk"],
        semantic=True,
        citations=[citation],
        selected_citations=[citation],
        context_text="Durable source text",
        context_chars=len("Durable source text"),
        latency_ms=12,
        status="complete",
    )

    persist_app_search_run(db_session, run)
    persist_app_search_run(db_session, run)

    counts = db_session.execute(
        text(
            """
            SELECT
                (SELECT count(*) FROM message_retrievals WHERE tool_call_id = :tool_call_id),
                (
                    SELECT count(*)
                    FROM message_retrieval_candidate_ledgers
                    WHERE tool_call_id = :tool_call_id
                ),
                (SELECT count(*) FROM message_rerank_ledgers WHERE tool_call_id = :tool_call_id)
            """
        ),
        {"tool_call_id": run.tool_call_id},
    ).one()
    retrieval_row = (
        db_session.execute(
            text(
                """
            SELECT id, locator, source_version, result_ref
            FROM message_retrievals
            WHERE tool_call_id = :tool_call_id
            """
            ),
            {"tool_call_id": run.tool_call_id},
        )
        .mappings()
        .one()
    )
    ledger_retrieval_ids = (
        db_session.execute(
            text(
                """
            SELECT retrieval_id
            FROM message_retrieval_candidate_ledgers
            WHERE tool_call_id = :tool_call_id
            ORDER BY created_at ASC, id ASC
            """
            ),
            {"tool_call_id": run.tool_call_id},
        )
        .scalars()
        .all()
    )

    assert tuple(counts) == (1, 2, 2)
    assert retrieval_row["locator"] == locator
    assert retrieval_row["source_version"] == "content_index:test:v1"
    assert retrieval_row["result_ref"]["source_version"] == "content_index:test:v1"
    assert ledger_retrieval_ids == [retrieval_row["id"], retrieval_row["id"]]


def test_assistant_claim_evidence_round_trip(db_session: Session):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    source_id = str(uuid4())
    locator = {
        "type": "message_offsets",
        "conversation_id": str(conversation_id),
        "message_id": source_id,
        "start_offset": 0,
        "end_offset": 36,
    }
    retrieval = MessageRetrieval(
        ordinal=0,
        result_type="message",
        source_id=source_id,
        context_ref={"type": "message", "id": source_id},
        result_ref={
            "type": "message",
            "id": source_id,
            "result_type": "message",
            "source_id": source_id,
            "title": "Source message",
            "source_label": "Conversation",
            "snippet": "The exact persisted source excerpt.",
            "deep_link": f"/conversations/{conversation_id}",
            "context_ref": {"type": "message", "id": source_id},
            "source_version": "message:test:v1",
            "locator": locator,
        },
        deep_link=f"/conversations/{conversation_id}",
        score=1.0,
        selected=True,
        exact_snippet="The exact persisted source excerpt.",
        locator=locator,
        retrieval_status="included_in_prompt",
        included_in_prompt=True,
        source_version="message:test:v1",
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
        verifier_status="llm_verified",
    )
    db_session.add(
        AssistantMessageEvidenceSummary(
            message_id=assistant_message_id,
            scope_type="general",
            scope_ref=None,
            retrieval_status="included_in_prompt",
            support_status="supported",
            verifier_status="llm_verified",
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
            result_ref=retrieval.result_ref,
            exact_snippet="The exact persisted source excerpt.",
            deep_link=f"/conversations/{conversation_id}",
            locator=locator,
            score=1.0,
            retrieval_status="included_in_prompt",
            selected=True,
            included_in_prompt=True,
            source_version="message:test:v1",
        )
    )
    db_session.commit()

    persisted = db_session.get(AssistantMessageClaim, claim.id)
    assert persisted is not None
    assert persisted.support_status == "supported"
    assert len(persisted.evidence) == 1
    assert persisted.evidence[0].exact_snippet == "The exact persisted source excerpt."
    assert persisted.evidence[0].source_ref["retrieval_id"] == str(retrieval.id)


def test_message_document_persists_source_manifest_and_cited_artifact_parts(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    db_session.flush()
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        requested_types=["highlight"],
        result_refs=[],
        selected_context_refs=[],
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="highlight",
                source_id="highlight-1",
                media_id=None,
                context_ref={"type": "highlight", "id": "highlight-1"},
                result_ref={
                    "type": "highlight",
                    "id": "highlight-1",
                    "result_type": "highlight",
                    "source_id": "highlight-1",
                    "color": "yellow",
                    "exact": "A saved quote.",
                    "title": "Saved quote",
                    "source_label": "Reader source",
                    "snippet": "A saved quote.",
                    "deep_link": "/media/media-1?highlight=highlight-1",
                    "context_ref": {"type": "highlight", "id": "highlight-1"},
                    "source_version": "highlight:v1",
                    "locator": _test_locator("highlight-1"),
                },
                deep_link="/media/media-1?highlight=highlight-1",
                score=0.92,
                selected=True,
                source_title="Saved quote",
                section_label="Reader source",
                exact_snippet="A saved quote.",
                locator=_test_locator("highlight-1"),
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version="highlight:v1",
            )
        ],
    )
    db_session.add_all(
        [
            tool_call,
            ChatRunEvent(
                run_id=run.id,
                seq=1,
                event_type="source_manifest_delta",
                payload={
                    "assistant_message_id": str(assistant_message_id),
                    "tool_call_id": str(tool_call.id),
                    "tool_name": "app_search",
                    "tool_call_index": 0,
                    "query_hash": None,
                    "scope": "all",
                    "filters": {},
                    "requested_types": ["fragment", "highlight"],
                    "candidate_count": 5,
                    "result_count": 3,
                    "selected_count": 2,
                    "included_in_prompt_count": 1,
                    "excluded_by_budget_count": 0,
                    "excluded_by_scope_count": 0,
                    "stale_count": 0,
                    "unreadable_count": 0,
                    "index_versions": [],
                    "metadata": {},
                    "latency_ms": 24,
                    "status": "complete",
                },
            ),
            ChatRunEvent(
                run_id=run.id,
                seq=2,
                event_type="artifact_delta",
                payload={
                    "artifact_id": "artifact-1",
                    "artifact_kind": "timeline",
                    "title": "Timeline",
                    "status": "complete",
                    "parts": [
                        {
                            "id": "part-1",
                            "source_version": "artifact_part:part-1:v1",
                            "locator": {
                                "type": "artifact_part_ref",
                                "artifact_id": "artifact-1",
                                "artifact_part_id": "part-1",
                                "message_id": str(assistant_message_id),
                                "conversation_id": str(conversation_id),
                                "part_key": "part-1",
                            },
                            "metadata": {"support_state": "not_source_grounded"},
                        },
                        {
                            "part_key": "part-2",
                            "source_version": "artifact_part:part-2:v1",
                            "locator": {
                                "type": "artifact_part_ref",
                                "artifact_id": "artifact-1",
                                "artifact_part_id": "part-2",
                                "message_id": str(assistant_message_id),
                                "conversation_id": str(conversation_id),
                                "part_key": "part-2",
                            },
                            "source_ref": {
                                "type": "message_retrieval",
                                "id": "retrieval-1",
                            },
                        },
                    ],
                },
            ),
            ChatRunEvent(
                run_id=run.id,
                seq=3,
                event_type="source_manifest_delta",
                payload={
                    "assistant_message_id": str(assistant_message_id),
                    "tool_call_id": str(tool_call.id),
                    "tool_name": "app_search",
                    "tool_call_index": 0,
                    "query_hash": None,
                    "scope": "all",
                    "filters": {},
                    "requested_types": ["fragment", "highlight"],
                    "candidate_count": 5,
                    "result_count": 3,
                    "selected_count": 2,
                    "included_in_prompt_count": 1,
                    "excluded_by_budget_count": 1,
                    "excluded_by_scope_count": 0,
                    "stale_count": 0,
                    "unreadable_count": 0,
                    "index_versions": [],
                    "metadata": {},
                    "latency_ms": 24,
                    "status": "complete",
                },
            ),
        ]
    )
    db_session.commit()
    db_session.add(
        SourceManifest(
            conversation_id=conversation_id,
            assistant_message_id=assistant_message_id,
            chat_run_id=run.id,
            tool_name="app_search",
            tool_call_index=0,
            scope="all",
            requested_types=["fragment", "highlight"],
            candidate_count=5,
            result_count=3,
            selected_count=2,
            included_in_prompt_count=1,
            excluded_by_budget_count=1,
            metadata_json={"empty_status": "partial"},
            latency_ms=24,
            status="complete",
        )
    )
    db_session.commit()
    retrieval_id = db_session.execute(
        select(MessageRetrieval.id).where(
            MessageRetrieval.tool_call_id == tool_call.id,
            MessageRetrieval.result_type == "highlight",
        )
    ).scalar_one()
    db_session.add(
        AssistantMessageEvidenceSummary(
            message_id=assistant_message_id,
            scope_type="general",
            scope_ref=None,
            retrieval_status="included_in_prompt",
            support_status="supported",
            verifier_status="llm_verified",
            claim_count=1,
            supported_claim_count=1,
            unsupported_claim_count=0,
            not_enough_evidence_count=0,
        )
    )
    claim = AssistantMessageClaim(
        message_id=assistant_message_id,
        ordinal=0,
        claim_text="Here is the answer.",
        answer_start_offset=0,
        answer_end_offset=len("Here is the answer."),
        claim_kind="answer",
        support_status="supported",
        verifier_status="llm_verified",
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
                "id": str(retrieval_id),
                "retrieval_id": str(retrieval_id),
            },
            retrieval_id=retrieval_id,
            context_ref={"type": "highlight", "id": "highlight-1"},
            result_ref={
                "type": "highlight",
                "id": "highlight-1",
                "result_type": "highlight",
                "source_id": "highlight-1",
                "color": "yellow",
                "exact": "A saved quote.",
                "title": "Saved quote",
                "source_label": "Reader source",
                "snippet": "A saved quote.",
                "deep_link": "/media/media-1?highlight=highlight-1",
                "context_ref": {"type": "highlight", "id": "highlight-1"},
                "source_version": "highlight:v1",
                "locator": _test_locator("highlight-1"),
            },
            exact_snippet="A saved quote.",
            locator=_test_locator("highlight-1"),
            retrieval_status="included_in_prompt",
            selected=True,
            included_in_prompt=True,
            source_version="highlight:v1",
        )
    )
    db_session.commit()

    document = _message_document_with_run_components(
        db_session,
        run_id=run.id,
        role="assistant",
        content="Here is the answer.",
    )
    MessageDocument.model_validate(document)

    assert document["blocks"][0] == {
        "type": "text",
        "format": "markdown",
        "text": "Here is the answer.",
    }
    assert document["blocks"][1]["type"] == "verification_summary"
    assert document["blocks"][1]["support_status"] == "supported"
    assert document["blocks"][1]["supported_claim_count"] == 1
    assert document["blocks"][2]["type"] == "claim"
    assert document["blocks"][2]["claim_text"] == "Here is the answer."
    assert document["blocks"][2]["support_status"] == "supported"
    assert document["blocks"][2]["evidence_ids"]
    assert document["blocks"][3]["type"] == "claim_evidence"
    assert document["blocks"][3]["claim_id"] == str(claim.id)
    assert document["blocks"][3]["source_version"] == "highlight:v1"
    assert document["blocks"][4]["type"] == "retrieval_result"
    assert document["blocks"][4]["result_type"] == "highlight"
    assert document["blocks"][4]["source_version"] == "highlight:v1"
    assert document["blocks"][4]["included_in_prompt"] is True
    assert document["blocks"][5]["type"] == "source_manifest"
    assert document["blocks"][5]["requested_types"] == ["fragment", "highlight"]
    assert document["blocks"][5]["selected_count"] == 2
    assert document["blocks"][5]["included_in_prompt_count"] == 1
    assert document["blocks"][5]["excluded_by_budget_count"] == 1
    assert document["blocks"][5]["metadata"] == {"empty_status": "partial"}
    assert document["blocks"][6]["type"] == "artifact_preview"
    assert document["blocks"][6]["parts"][0]["id"] == "part-1"
    assert document["blocks"][6]["parts"][0]["metadata"] == {"support_state": "not_source_grounded"}
    assert document["blocks"][6]["parts"][1]["part_key"] == "part-2"
    assert document["blocks"][6]["parts"][1]["source_ref"] == {
        "type": "message_retrieval",
        "id": "retrieval-1",
    }


def test_message_artifact_rows_enrich_preview_blocks(db_session: Session):
    conversation_id, _user_message_id, assistant_message_id = _create_message_pair(db_session)
    artifact = MessageArtifact(
        conversation_id=conversation_id,
        message_id=assistant_message_id,
        artifact_key="artifact-1",
        artifact_kind="timeline",
        title="Timeline",
        status="complete",
        preview_text="Durable preview",
    )
    db_session.add(artifact)
    db_session.flush()
    part_id = uuid4()
    part = MessageArtifactPart(
        id=part_id,
        artifact_id=artifact.id,
        ordinal=0,
        part_key="part-1",
        part_type="event",
        part_text="Cited event",
        source_version=f"artifact_part:{part_id}:v1",
        locator={
            "type": "artifact_part_ref",
            "artifact_id": str(artifact.id),
            "artifact_part_id": str(part_id),
            "message_id": str(assistant_message_id),
            "conversation_id": str(conversation_id),
            "part_key": "part-1",
        },
        source_ref={"type": "message_retrieval", "id": "retrieval-1"},
        source_refs=[{"type": "message_retrieval", "id": "retrieval-2"}],
        evidence_span_ids=[str(uuid4())],
    )
    db_session.add(part)
    message = db_session.get(Message, assistant_message_id)
    message.message_document = {
        "type": "message_document",
        "version": 1,
        "blocks": [
            {
                "type": "artifact_preview",
                "artifact_id": "artifact-1",
                "artifact_kind": "timeline",
                "parts": [],
            }
        ],
    }
    db_session.commit()

    artifacts = load_message_artifacts_for_message_ids(db_session, [assistant_message_id])
    message_out = message_to_out(message, artifacts=artifacts[assistant_message_id])

    block = message_out.message_document.model_dump(mode="json")["blocks"][0]
    assert block["artifact_id"] == str(artifact.id)
    assert block["durable_artifact_id"] == str(artifact.id)
    assert block["delta"] == "Durable preview"
    assert block["parts"][0]["id"] == str(part.id)
    assert block["parts"][0]["source_ref"]["type"] == "message_retrieval"
    assert block["parts"][0]["source_ref"]["id"] == "retrieval-1"
    assert block["parts"][0]["source_refs"][0]["type"] == "message_retrieval"
    assert block["parts"][0]["source_refs"][0]["id"] == "retrieval-2"


def test_finalize_run_persists_artifact_delta_rows(db_session: Session):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
        next_event_seq=2,
    )
    db_session.add(run)
    db_session.flush()
    db_session.add(
        ChatRunEvent(
            run_id=run.id,
            seq=1,
            event_type="artifact_delta",
            payload={
                "artifact_id": "artifact-1",
                "artifact_kind": "timeline",
                "title": "Timeline",
                "status": "streaming",
                "delta": "Durable preview",
                "parts": [
                    {
                        "part_key": "part-1",
                        "part_type": "event",
                        "text": "Cited event",
                        "source_version": f"message:{user_message_id}:v1",
                        "locator": {
                            "type": "message_offsets",
                            "conversation_id": str(conversation_id),
                            "message_id": str(user_message_id),
                            "start_offset": 0,
                            "end_offset": 12,
                            "message_seq": 1,
                        },
                        "source_ref": {"type": "message", "id": str(user_message_id)},
                        "source_refs": [{"type": "message", "id": str(user_message_id)}],
                    }
                ],
            },
        )
    )
    db_session.commit()

    _finalize_run(
        db_session,
        run_id=run.id,
        assistant_content="Done.",
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
        model=None,
        resolved_key=None,
        key_mode="auto",
        latency_ms=12,
        usage=None,
        provider_request_id=None,
        viewer_id=user_id,
    )

    artifact_row = (
        db_session.execute(
            text(
                """
            SELECT artifact_key, artifact_kind, status, preview_text, metadata
            FROM message_artifacts
            WHERE message_id = :message_id
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .one()
    )
    part_row = (
        db_session.execute(
            text(
                """
            SELECT ordinal, part_key, part_type, text, source_ref, source_refs
            FROM message_artifact_parts
            WHERE artifact_id = (
                SELECT id FROM message_artifacts WHERE message_id = :message_id
            )
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .one()
    )

    assert artifact_row["artifact_key"] == "artifact-1"
    assert artifact_row["artifact_kind"] == "timeline"
    assert artifact_row["status"] == "complete"
    assert artifact_row["preview_text"] == "Durable preview"
    assert artifact_row["metadata"]["source"] == "chat_run_artifact_delta"
    assert artifact_row["metadata"]["run_event_seqs"] == [1]
    assert part_row["ordinal"] == 0
    assert part_row["part_key"] == "part-1"
    assert part_row["part_type"] == "event"
    assert part_row["text"] == "Cited event"
    assert part_row["source_ref"] == {"type": "message", "id": str(user_message_id)}
    assert part_row["source_refs"] == [{"type": "message", "id": str(user_message_id)}]


def test_reconcile_prompt_retrievals_preserves_empty_manifest_metadata(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "auto"},
    )
    db_session.add(run)
    db_session.flush()
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="web_search",
        tool_call_index=1,
        query_hash="sha256:web",
        scope="public_web",
        requested_types=["web_result"],
        status="complete",
        latency_ms=17,
    )
    db_session.add(tool_call)
    db_session.flush()
    db_session.add(
        ChatRunEvent(
            run_id=run.id,
            seq=1,
            event_type="source_manifest_delta",
            payload={
                "assistant_message_id": str(assistant_message_id),
                "tool_call_id": str(tool_call.id),
                "tool_name": "web_search",
                "tool_call_index": 1,
                "query_hash": "sha256:web",
                "scope": "public_web",
                "filters": {"allowed_domains": ["example.com"]},
                "requested_types": ["web_result"],
                "candidate_count": 0,
                "result_count": 0,
                "selected_count": 0,
                "included_in_prompt_count": 0,
                "excluded_by_budget_count": 0,
                "excluded_by_scope_count": 0,
                "stale_count": 0,
                "unreadable_count": 0,
                "web_search_mode": "auto",
                "index_versions": ["web:index:v1"],
                "metadata": {"provider": "test"},
                "latency_ms": 17,
                "status": "complete",
            },
        )
    )
    run.next_event_seq = 2
    db_session.commit()

    _reconcile_prompt_retrievals(
        db_session,
        run=run,
        assembly=SimpleNamespace(
            ledger=SimpleNamespace(included_retrieval_ids=(), dropped_items=())
        ),
    )
    db_session.commit()

    manifest = db_session.execute(
        select(ChatRunEvent.payload)
        .where(
            ChatRunEvent.run_id == run.id,
            ChatRunEvent.event_type == "source_manifest_delta",
        )
        .order_by(ChatRunEvent.seq.desc())
        .limit(1)
    ).scalar_one()

    assert manifest["filters"] == {"allowed_domains": ["example.com"]}
    assert manifest["web_search_mode"] == "auto"
    assert manifest["index_versions"] == ["web:index:v1"]
    assert manifest["metadata"] == {"provider": "test"}
    assert manifest["candidate_count"] == 0
    assert manifest["result_count"] == 0
    assert manifest["selected_count"] == 0

    durable_manifest = db_session.scalar(
        select(SourceManifest).where(SourceManifest.chat_run_id == run.id)
    )
    assert durable_manifest is not None
    assert durable_manifest.tool_call_id == tool_call.id
    assert durable_manifest.filters == {"allowed_domains": ["example.com"]}
    assert durable_manifest.web_search_mode == "auto"
    assert durable_manifest.index_versions == ["web:index:v1"]
    assert durable_manifest.metadata_json == {"provider": "test"}
    assert durable_manifest.candidate_count == 0
    assert durable_manifest.result_count == 0
    assert durable_manifest.selected_count == 0


def test_reconcile_prompt_retrievals_updates_current_source_manifest_snapshot(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "auto"},
    )
    db_session.add(run)
    db_session.flush()
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="web_search",
        tool_call_index=0,
        query_hash="sha256:web",
        scope="public_web",
        requested_types=["web_result"],
        status="complete",
        latency_ms=21,
    )
    db_session.add(tool_call)
    db_session.flush()
    retrievals: dict[str, MessageRetrieval] = {}
    for ordinal, source_id in enumerate(("web-included", "web-dropped", "web-scope")):
        url = f"https://example.com/{source_id}"
        source_version = f"web_search:test:{source_id}"
        retrieval = MessageRetrieval(
            tool_call_id=tool_call.id,
            ordinal=ordinal,
            result_type="web_result",
            source_id=source_id,
            context_ref={"type": "web_result", "id": source_id},
            result_ref={
                "type": "web_result",
                "id": source_id,
                "result_type": "web_result",
                "result_ref": source_id,
                "source_id": source_id,
                "title": source_id,
                "url": url,
                "deep_link": url,
                "snippet": f"{source_id} excerpt.",
                "source_version": source_version,
                "locator": {"type": "external_url", "url": url, "title": source_id},
                "context_ref": {"type": "web_result", "id": source_id},
                "media_id": None,
                "media_kind": None,
                "score": 1.0,
                "selected": source_id != "web-scope",
            },
            locator={"type": "external_url", "url": url, "title": source_id},
            deep_link=url,
            selected=source_id != "web-scope",
            retrieval_status="excluded_by_scope" if source_id == "web-scope" else "selected",
            source_version=source_version,
        )
        retrievals[source_id] = retrieval
        db_session.add(retrieval)
    db_session.flush()

    append_run_event(
        db_session,
        run,
        "source_manifest_delta",
        {
            "assistant_message_id": str(assistant_message_id),
            "tool_call_id": str(tool_call.id),
            "tool_name": "web_search",
            "tool_call_index": 0,
            "query_hash": "sha256:web",
            "scope": "public_web",
            "filters": {"allowed_domains": ["example.com"]},
            "requested_types": ["web_result"],
            "candidate_count": 3,
            "result_count": 3,
            "selected_count": 2,
            "included_in_prompt_count": 0,
            "excluded_by_budget_count": 0,
            "excluded_by_scope_count": 0,
            "stale_count": 0,
            "unreadable_count": 0,
            "web_search_mode": "auto",
            "index_versions": ["web:index:v1"],
            "metadata": {"provider": "test", "empty_status": "partial"},
            "latency_ms": 21,
            "status": "complete",
        },
    )
    db_session.flush()
    initial_manifest_id = db_session.scalar(
        select(SourceManifest.id).where(SourceManifest.chat_run_id == run.id)
    )
    assert initial_manifest_id is not None

    _reconcile_prompt_retrievals(
        db_session,
        run=run,
        assembly=SimpleNamespace(
            ledger=SimpleNamespace(
                included_retrieval_ids=(retrievals["web-included"].id,),
                dropped_items=(
                    {
                        "lane": "web_evidence",
                        "key": f"web_evidence:{retrievals['web-dropped'].id}",
                    },
                ),
            )
        ),
    )
    db_session.commit()

    assert (
        db_session.scalar(
            select(func.count())
            .select_from(ChatRunEvent)
            .where(
                ChatRunEvent.run_id == run.id,
                ChatRunEvent.event_type == "source_manifest_delta",
            )
        )
        == 2
    )
    assert (
        db_session.scalar(
            select(func.count())
            .select_from(SourceManifest)
            .where(SourceManifest.chat_run_id == run.id)
        )
        == 1
    )
    durable_manifest = db_session.scalar(
        select(SourceManifest).where(SourceManifest.chat_run_id == run.id)
    )
    assert durable_manifest is not None
    assert durable_manifest.id == initial_manifest_id
    assert durable_manifest.candidate_count == 3
    assert durable_manifest.selected_count == 2
    assert durable_manifest.included_in_prompt_count == 1
    assert durable_manifest.excluded_by_budget_count == 1
    assert durable_manifest.excluded_by_scope_count == 1
    assert durable_manifest.filters == {"allowed_domains": ["example.com"]}
    assert durable_manifest.web_search_mode == "auto"
    assert durable_manifest.index_versions == ["web:index:v1"]
    assert durable_manifest.metadata_json == {"provider": "test", "empty_status": "partial"}

    document = _message_document_with_run_components(
        db_session,
        run_id=run.id,
        role="assistant",
        content="Done.",
    )
    MessageDocument.model_validate(document)
    manifest_block = next(
        block for block in document["blocks"] if block["type"] == "source_manifest"
    )
    assert manifest_block["included_in_prompt_count"] == 1
    assert manifest_block["excluded_by_budget_count"] == 1
    assert manifest_block["excluded_by_scope_count"] == 1
    assert manifest_block["metadata"] == {"provider": "test", "empty_status": "partial"}


def test_reconcile_prompt_retrievals_marks_dropped_web_evidence_by_budget(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "auto"},
    )
    db_session.add(run)
    db_session.flush()
    retrieval = MessageRetrieval(
        ordinal=0,
        result_type="web_result",
        source_id="web-1",
        context_ref={"type": "web_result", "id": "web-1"},
        result_ref={
            "type": "web_result",
            "id": "web-1",
            "title": "Web result",
            "url": "https://example.com",
            "snippet": "A web excerpt.",
        },
        deep_link="https://example.com",
        selected=True,
        retrieval_status="selected",
        source_version="web_search:test:web-1",
    )
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="web_search",
        tool_call_index=0,
        query_hash="sha256:web",
        scope="public_web",
        requested_types=["web_result"],
        status="complete",
        retrievals=[retrieval],
    )
    db_session.add(tool_call)
    db_session.flush()
    retrieval_id = retrieval.id
    db_session.commit()

    _reconcile_prompt_retrievals(
        db_session,
        run=run,
        assembly=SimpleNamespace(
            ledger=SimpleNamespace(
                included_retrieval_ids=(),
                dropped_items=(
                    {
                        "lane": "web_evidence",
                        "key": f"web_evidence:{retrieval_id}",
                    },
                ),
            )
        ),
    )
    db_session.commit()

    persisted = db_session.get(MessageRetrieval, retrieval_id)
    assert persisted is not None
    assert persisted.retrieval_status == "excluded_by_budget"

    manifest = db_session.execute(
        select(ChatRunEvent.payload)
        .where(
            ChatRunEvent.run_id == run.id,
            ChatRunEvent.event_type == "source_manifest_delta",
        )
        .order_by(ChatRunEvent.seq.desc())
        .limit(1)
    ).scalar_one()
    assert manifest["candidate_count"] == 1
    assert manifest["selected_count"] == 1
    assert manifest["included_in_prompt_count"] == 0
    assert manifest["excluded_by_budget_count"] == 1


def test_claim_verifier_response_preserves_status_reason_and_confidence():
    claims = _parse_claim_verifier_response(
        (
            '{"claims": ['
            '{"ordinal": 0, "answer_start_offset": 0, "answer_end_offset": 12, '
            '"support_status": "supported", '
            '"evidence_ordinals": [0], "confidence": 0.98},'
            '{"ordinal": 1, "answer_start_offset": 13, "answer_end_offset": 25, '
            '"support_status": "partially_supported", '
            '"evidence_ordinals": [1], "unsupported_reason": "date not in evidence", '
            '"confidence": 0.42}'
            "]}"
        ),
        claim_count=2,
        evidence_count=2,
    )

    assert claims == [
        {
            "ordinal": 0,
            "answer_start_offset": 0,
            "answer_end_offset": 12,
            "support_status": "supported",
            "evidence_ordinals": [0],
            "supporting_evidence_ordinals": [0],
            "contradicting_evidence_ordinals": [],
            "context_evidence_ordinals": [],
            "confidence": 0.98,
        },
        {
            "ordinal": 1,
            "answer_start_offset": 13,
            "answer_end_offset": 25,
            "support_status": "partially_supported",
            "evidence_ordinals": [1],
            "supporting_evidence_ordinals": [1],
            "contradicting_evidence_ordinals": [],
            "context_evidence_ordinals": [],
            "unsupported_reason": "date not in evidence",
            "confidence": 0.42,
        },
    ]


def test_claim_verifier_response_accepts_not_source_grounded_without_evidence():
    claims = _parse_claim_verifier_response(
        (
            '{"claims": ['
            '{"ordinal": 0, "answer_start_offset": 0, "answer_end_offset": 12, '
            '"support_status": "not_source_grounded", '
            '"evidence_ordinals": [], "unsupported_reason": "no source request"}'
            "]}"
        ),
        claim_count=1,
        evidence_count=0,
    )

    assert claims == [
        {
            "ordinal": 0,
            "answer_start_offset": 0,
            "answer_end_offset": 12,
            "support_status": "not_source_grounded",
            "evidence_ordinals": [],
            "supporting_evidence_ordinals": [],
            "contradicting_evidence_ordinals": [],
            "context_evidence_ordinals": [],
            "unsupported_reason": "no source request",
        }
    ]


def test_chat_run_event_payloads_are_strict():
    now = datetime.now(UTC).isoformat()
    run_id = str(uuid4())
    conversation_id = str(uuid4())
    assistant_message_id = str(uuid4())
    tool_call_id = str(uuid4())

    assert (
        chat_run_event_payload_json(
            "meta",
            {
                "run_id": run_id,
                "conversation_id": conversation_id,
                "user_message_id": str(uuid4()),
                "assistant_message_id": assistant_message_id,
                "model_id": str(uuid4()),
                "provider": "openai",
            },
        )["run_id"]
        == run_id
    )
    assert (
        chat_run_event_payload_json(
            "source_manifest_delta",
            {
                "assistant_message_id": assistant_message_id,
                "tool_call_id": tool_call_id,
                "tool_name": "app_search",
                "tool_call_index": 0,
                "query_hash": "sha256:test",
                "scope": "all",
                "filters": {},
                "requested_types": ["content_chunk"],
                "candidate_count": 1,
                "result_count": 1,
                "selected_count": 1,
                "included_in_prompt_count": 1,
                "excluded_by_budget_count": 0,
                "excluded_by_scope_count": 0,
                "stale_count": 0,
                "unreadable_count": 0,
                "index_versions": [],
                "metadata": {},
                "latency_ms": 7,
                "status": "complete",
            },
        )["tool_call_id"]
        == tool_call_id
    )
    retrieval_citation = {
        "type": "content_chunk",
        "id": "chunk-1",
        "result_type": "content_chunk",
        "source_id": "chunk-1",
        "source_kind": "web_article",
        "title": "Source title",
        "source_label": "Source",
        "snippet": "Exact source text",
        "deep_link": "/media/media-1",
        "citation_label": "Source",
        "context_ref": {"type": "content_chunk", "id": "chunk-1"},
        "evidence_span_ids": [],
        "source_version": "content_index:test:v1",
        "locator": _test_locator(),
        "media_id": "media-1",
        "media_kind": "web_article",
        "score": 0.8,
        "selected": True,
    }
    retrieval_event = chat_run_event_payload_json(
        "retrieval_result",
        {
            "assistant_message_id": assistant_message_id,
            "tool_call_id": tool_call_id,
            "tool_name": "app_search",
            "tool_call_index": 0,
            "status": "complete",
            "error_code": None,
            "result_count": 1,
            "selected_count": 1,
            "latency_ms": 7,
            "filters": {},
            "results": [retrieval_citation],
        },
    )
    assert retrieval_event["results"][0]["source_kind"] == "web_article"
    with pytest.raises(ValueError, match="unknown chat-run event type"):
        chat_run_event_payload_json("citation", {"type": "web_result"})
    with pytest.raises(ValidationError):
        chat_run_event_payload_json(
            "retrieval_result",
            {
                "assistant_message_id": assistant_message_id,
                "tool_call_id": tool_call_id,
                "tool_name": "app_search",
                "tool_call_index": 0,
                "status": "complete",
                "result_count": 1,
                "selected_count": 1,
                "filters": {},
                "results": [{**retrieval_citation, "filters": {"legacy": True}}],
            },
        )
    assert (
        chat_run_event_payload_json(
            "artifact_delta",
            {
                "artifact_id": "artifact-1",
                "artifact_kind": "timeline",
                "status": "streaming",
                "parts": [
                    {
                        "part_key": "claim-1",
                        "text": "The source-backed generated claim.",
                        "source_version": f"message:{assistant_message_id}:v1",
                        "locator": {
                            "type": "message_offsets",
                            "conversation_id": str(conversation_id),
                            "message_id": str(assistant_message_id),
                            "start_offset": 0,
                            "end_offset": 12,
                            "message_seq": 2,
                        },
                        "source_ref": {"type": "message", "id": str(uuid4())},
                    }
                ],
            },
        )["parts"][0]["part_key"]
        == "claim-1"
    )
    with pytest.raises(ValidationError):
        chat_run_event_payload_json(
            "artifact_delta",
            {
                "artifact_id": "artifact-1",
                "artifact_kind": "timeline",
                "status": "streaming",
                "parts": [{"part_key": "claim-1", "text": "Unbacked generated claim."}],
            },
        )
    with pytest.raises(ValidationError):
        chat_run_event_payload_json(
            "tool_call",
            {
                "assistant_message_id": assistant_message_id,
                "tool_name": "app_search",
                "tool_call_index": 0,
                "status": "running",
                "scope": "all",
                "types": ["content_chunk"],
                "semantic": True,
            },
        )

    claim_payload = chat_run_event_payload_json(
        "claim",
        {
            "id": str(uuid4()),
            "message_id": str(uuid4()),
            "ordinal": 0,
            "claim_text": "The report mentions water vapor.",
            "answer_start_offset": 0,
            "answer_end_offset": 32,
            "claim_kind": "answer",
            "support_status": "supported",
            "unsupported_reason": None,
            "confidence": 0.9,
            "verifier_status": "llm_verified",
            "verifier_run_id": str(uuid4()),
            "created_at": now,
        },
    )
    assert claim_payload["support_status"] == "supported"

    with pytest.raises(ValidationError):
        chat_run_event_payload_json(
            "claim",
            {
                "id": str(uuid4()),
                "message_id": assistant_message_id,
                "ordinal": 0,
                "claim_text": "The report mentions water vapor.",
                "answer_start_offset": 0,
                "answer_end_offset": 32,
                "claim_kind": "answer",
                "support_status": "not_enough_evidence",
                "verifier_status": "llm_verified",
                "verifier_run_id": str(uuid4()),
                "created_at": now,
            },
        )
    with pytest.raises(ValidationError):
        chat_run_event_payload_json(
            "claim_evidence",
            {
                "id": str(uuid4()),
                "claim_id": str(uuid4()),
                "ordinal": 0,
                "evidence_role": "supports",
                "source_ref": {"type": "message_retrieval", "id": str(uuid4())},
                "retrieval_id": None,
                "evidence_span_id": None,
                "context_ref": None,
                "result_ref": None,
                "exact_snippet": "supporting text",
                "snippet_prefix": None,
                "snippet_suffix": None,
                "locator": None,
                "deep_link": None,
                "score": None,
                "retrieval_status": "included_in_prompt",
                "selected": True,
                "included_in_prompt": True,
                "source_version": "source:v1",
                "created_at": now,
            },
        )


def test_claim_verifier_response_requires_contradiction_roles():
    with pytest.raises(ValueError, match="contradicted item missing support or conflict evidence"):
        _parse_claim_verifier_response(
            (
                '{"claims": ['
                '{"ordinal": 0, "answer_start_offset": 0, "answer_end_offset": 12, '
                '"support_status": "contradicted", "evidence_ordinals": [0]}'
                "]}"
            ),
            claim_count=1,
            evidence_count=1,
        )

    claims = _parse_claim_verifier_response(
        (
            '{"claims": ['
            '{"ordinal": 0, "answer_start_offset": 0, "answer_end_offset": 12, '
            '"support_status": "contradicted", '
            '"supporting_evidence_ordinals": [0], '
            '"contradicting_evidence_ordinals": [1]}'
            "]}"
        ),
        claim_count=1,
        evidence_count=2,
    )

    assert claims[0]["evidence_ordinals"] == [0, 1]
    assert claims[0]["supporting_evidence_ordinals"] == [0]
    assert claims[0]["contradicting_evidence_ordinals"] == [1]


def test_claim_extractor_response_requires_exact_offsets():
    answer = (
        "The observatory detected water vapor, and the archive includes methane; "
        "the appendix cites ammonia."
    )

    claims = _parse_claim_extractor_response(
        json.dumps(
            {
                "claims": [
                    {
                        "text": "The observatory detected water vapor",
                        "answer_start_offset": 0,
                        "answer_end_offset": len("The observatory detected water vapor"),
                    },
                    {
                        "text": "the archive includes methane",
                        "answer_start_offset": answer.index("the archive includes methane"),
                        "answer_end_offset": answer.index("the archive includes methane")
                        + len("the archive includes methane"),
                    },
                    {
                        "text": "the appendix cites ammonia.",
                        "answer_start_offset": answer.index("the appendix cites ammonia."),
                        "answer_end_offset": len(answer),
                    },
                ]
            }
        ),
        assistant_content=answer,
    )

    assert [claim.text for claim in claims] == [
        "The observatory detected water vapor",
        "the archive includes methane",
        "the appendix cites ammonia.",
    ]

    with pytest.raises(ValueError, match="offsets do not match"):
        _parse_claim_extractor_response(
            json.dumps(
                {
                    "claims": [
                        {
                            "text": "The observatory detected water vapor",
                            "answer_start_offset": 4,
                            "answer_end_offset": 4 + len("The observatory detected water vapor"),
                        }
                    ]
                }
            ),
            assistant_content=answer,
        )


@pytest.mark.asyncio
async def test_verified_assistant_content_extracts_general_answer_claims_as_not_source_grounded(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    db_session.commit()

    first = "The observatory detected water vapor in the target atmosphere."
    second = "The archive includes methane on page five."
    answer = f"{first} {second}"
    calls = 0

    async def generate(_provider, request, _api_key, *, timeout_s):
        nonlocal calls
        calls += 1
        assert "Extract every atomic factual claim" in request.messages[0].content
        return SimpleNamespace(
            text=json.dumps(
                {
                    "claims": [
                        {
                            "text": first,
                            "answer_start_offset": 0,
                            "answer_end_offset": len(first),
                        },
                        {
                            "text": second,
                            "answer_start_offset": len(first) + 1,
                            "answer_end_offset": len(first) + 1 + len(second),
                        },
                    ]
                }
            )
        )

    verified_content, verifier_hint = await _verified_assistant_content(
        db_session,
        run=run,
        model=model,
        resolved_key=SimpleNamespace(api_key="test"),
        llm_router=SimpleNamespace(generate=generate),
        assistant_content=answer,
    )

    assert calls == 1
    assert verified_content == answer
    assert verifier_hint is not None
    assert verifier_hint["verifier_status"] == "llm_verified"
    assert verifier_hint["metadata"]["source_backed"] is False
    assert verifier_hint["metadata"]["rewrote_answer"] is False
    assert [item["support_status"] for item in verifier_hint["metadata"]["claim_statuses"]] == [
        "not_source_grounded",
        "not_source_grounded",
    ]

    _finalize_run(
        db_session,
        run_id=run.id,
        assistant_content=verified_content,
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
        model=None,
        resolved_key=None,
        key_mode="auto",
        latency_ms=12,
        usage=None,
        provider_request_id=None,
        viewer_id=user_id,
        verifier_hint=verifier_hint,
    )

    message = db_session.get(Message, assistant_message_id)
    assert message is not None
    assert message.content == answer
    assert message.message_document["blocks"][0]["text"] == answer

    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    verifier_run = db_session.get(AssistantMessageVerifierRun, summary.verifier_run_id)
    claims = (
        db_session.execute(
            select(AssistantMessageClaim)
            .where(AssistantMessageClaim.message_id == assistant_message_id)
            .order_by(AssistantMessageClaim.ordinal.asc())
        )
        .scalars()
        .all()
    )
    evidence_count = db_session.execute(
        select(func.count(AssistantMessageClaimEvidence.id))
        .join(AssistantMessageClaim)
        .where(AssistantMessageClaim.message_id == assistant_message_id)
    ).scalar_one()
    event_types = (
        db_session.execute(
            select(ChatRunEvent.event_type)
            .where(ChatRunEvent.run_id == run.id)
            .order_by(ChatRunEvent.seq)
        )
        .scalars()
        .all()
    )

    assert summary.support_status == "not_source_grounded"
    assert summary.verifier_status == "llm_verified"
    assert summary.claim_count == 2
    assert summary.supported_claim_count == 0
    assert summary.unsupported_claim_count == 2
    assert summary.not_enough_evidence_count == 0
    assert verifier_run is not None
    assert verifier_run.metadata_["support_status_counts"]["not_source_grounded"] == 2
    assert [claim.claim_text for claim in claims] == [first, second]
    assert [claim.answer_start_offset for claim in claims] == [0, len(first) + 1]
    assert [claim.support_status for claim in claims] == [
        "not_source_grounded",
        "not_source_grounded",
    ]
    assert [claim.verifier_status for claim in claims] == ["llm_verified", "llm_verified"]
    assert evidence_count == 0
    assert event_types.count("claim") == 2
    assert "claim_evidence" not in event_types


@pytest.mark.asyncio
async def test_verified_assistant_content_removes_unsupported_claim_before_finalize(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=str(uuid4()),
                context_ref={"type": "content_chunk", "id": str(uuid4())},
                result_ref={
                    "type": "content_chunk",
                    "id": str(uuid4()),
                    "result_type": "content_chunk",
                    "source_id": "content-chunk-1",
                    "source_kind": "web_article",
                    "title": "Launch report",
                    "source_label": "Report",
                    "citation_label": "Report",
                    "snippet": (
                        "The launch report states that the observatory detected water vapor "
                        "in the target atmosphere during the second observation window."
                    ),
                    "deep_link": "/media/media-1?fragment=fragment-1",
                    "context_ref": {"type": "content_chunk", "id": "content-chunk-1"},
                    "evidence_span_ids": [],
                    "source_version": "content_chunk:test:v1",
                    "locator": _test_locator(),
                },
                selected=True,
                exact_snippet=(
                    "The launch report states that the observatory detected water vapor "
                    "in the target atmosphere during the second observation window."
                ),
                locator=_test_locator(),
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version="content_chunk:test:v1",
            ),
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(db_session, run, assistant_message_id, [tool_call.retrievals[0].id])
    db_session.commit()

    supported = "The observatory detected water vapor in the target atmosphere."
    unsupported = "The archive includes methane on page five."

    async def generate(_provider, request, _api_key, *, timeout_s):
        if "Extract every atomic factual claim" in request.messages[0].content:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "claims": [
                            {
                                "text": supported,
                                "answer_start_offset": 0,
                                "answer_end_offset": len(supported),
                            },
                            {
                                "text": unsupported,
                                "answer_start_offset": len(supported) + 1,
                                "answer_end_offset": len(supported) + 1 + len(unsupported),
                            },
                        ]
                    }
                )
            )
        return SimpleNamespace(
            text=json.dumps(
                {
                    "claims": [
                        {
                            "ordinal": 0,
                            "answer_start_offset": 0,
                            "answer_end_offset": len(supported),
                            "support_status": "supported",
                            "evidence_ordinals": [0],
                            "confidence": 0.98,
                        },
                        {
                            "ordinal": 1,
                            "answer_start_offset": len(supported) + 1,
                            "answer_end_offset": len(supported) + 1 + len(unsupported),
                            "support_status": "not_enough_evidence",
                            "evidence_ordinals": [],
                            "unsupported_reason": "not in selected evidence",
                            "confidence": 0.2,
                        },
                    ]
                }
            )
        )

    verified_content, verifier_hint = await _verified_assistant_content(
        db_session,
        run=run,
        model=model,
        resolved_key=SimpleNamespace(api_key="test"),
        llm_router=SimpleNamespace(generate=generate),
        assistant_content=f"{supported} {unsupported}",
    )
    assert supported in verified_content
    assert unsupported not in verified_content
    assert verifier_hint is not None
    assert verifier_hint["metadata"]["rewrote_answer"] is True
    assert verifier_hint["metadata"]["removed_claim_count"] == 1

    _finalize_run(
        db_session,
        run_id=run.id,
        assistant_content=verified_content,
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
        model=None,
        resolved_key=None,
        key_mode="auto",
        latency_ms=12,
        usage=None,
        provider_request_id=None,
        viewer_id=user_id,
        verifier_hint=verifier_hint,
    )

    message = db_session.get(Message, assistant_message_id)
    assert message is not None
    assert supported in message.content
    assert unsupported not in message.content
    assert supported in message.message_document["blocks"][0]["text"]
    assert unsupported not in message.message_document["blocks"][0]["text"]

    verifier_run = db_session.execute(
        select(AssistantMessageVerifierRun).where(
            AssistantMessageVerifierRun.message_id == assistant_message_id
        )
    ).scalar_one()
    event_types = (
        db_session.execute(
            select(ChatRunEvent.event_type)
            .where(ChatRunEvent.run_id == run.id)
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    claims = (
        db_session.execute(
            select(AssistantMessageClaim)
            .where(AssistantMessageClaim.message_id == assistant_message_id)
            .order_by(AssistantMessageClaim.ordinal.asc())
        )
        .scalars()
        .all()
    )
    claim_texts = [claim.claim_text for claim in claims]
    assert verifier_run.metadata_["rewrote_answer"] is True
    assert verifier_run.metadata_["removed_claim_count"] == 1
    assert verifier_run.metadata_["unsupported_claim_count"] == 1
    assert verifier_run.metadata_["final_unsupported_claim_count"] == 1
    assert verifier_run.metadata_["removed_claim_statuses"][0]["support_status"] == (
        "not_enough_evidence"
    )
    assert claim_texts == [supported, unsupported]
    assert [
        (claim.support_status, claim.claim_kind, claim.answer_start_offset, claim.answer_end_offset)
        for claim in claims
    ] == [
        ("supported", "answer", 0, len(supported)),
        ("not_enough_evidence", "insufficient_evidence", None, None),
    ]
    assert "claim" in event_types
    assert "claim_evidence" in event_types


@pytest.mark.asyncio
async def test_verified_assistant_content_persists_all_contradicted_claims(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    source_version = "content_chunk:contradiction:v1"
    support_locator = _test_locator("support")
    conflict_locator = _test_locator("conflict")
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=str(uuid4()),
                context_ref={"type": "content_chunk", "id": "support"},
                result_ref={
                    "type": "content_chunk",
                    "id": "support",
                    "result_type": "content_chunk",
                    "source_id": "support",
                    "source_kind": "web_article",
                    "title": "Archive",
                    "source_label": "Archive",
                    "citation_label": "Archive",
                    "snippet": "The archive says methane is present in the sampled atmosphere.",
                    "deep_link": "/media/media-1?fragment=support",
                    "context_ref": {"type": "content_chunk", "id": "support"},
                    "evidence_span_ids": [],
                    "source_version": source_version,
                    "locator": support_locator,
                },
                selected=True,
                exact_snippet="The archive says methane is present in the sampled atmosphere.",
                locator=support_locator,
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version=source_version,
            ),
            MessageRetrieval(
                ordinal=1,
                result_type="content_chunk",
                source_id=str(uuid4()),
                context_ref={"type": "content_chunk", "id": "conflict"},
                result_ref={
                    "type": "content_chunk",
                    "id": "conflict",
                    "result_type": "content_chunk",
                    "source_id": "conflict",
                    "source_kind": "web_article",
                    "title": "Archive",
                    "source_label": "Archive",
                    "citation_label": "Archive",
                    "snippet": "The archive says methane is absent from the sampled atmosphere.",
                    "deep_link": "/media/media-1?fragment=conflict",
                    "context_ref": {"type": "content_chunk", "id": "conflict"},
                    "evidence_span_ids": [],
                    "source_version": source_version,
                    "locator": conflict_locator,
                },
                selected=True,
                exact_snippet="The archive says methane is absent from the sampled atmosphere.",
                locator=conflict_locator,
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version=source_version,
            ),
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(
        db_session,
        run,
        assistant_message_id,
        [retrieval.id for retrieval in tool_call.retrievals],
    )
    db_session.commit()

    contradicted = "The archive says methane is present."

    async def generate(_provider, request, _api_key, *, timeout_s):
        if "Extract every atomic factual claim" in request.messages[0].content:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "claims": [
                            {
                                "text": contradicted,
                                "answer_start_offset": 0,
                                "answer_end_offset": len(contradicted),
                            }
                        ]
                    }
                )
            )
        return SimpleNamespace(
            text=json.dumps(
                {
                    "claims": [
                        {
                            "ordinal": 0,
                            "answer_start_offset": 0,
                            "answer_end_offset": len(contradicted),
                            "support_status": "contradicted",
                            "evidence_ordinals": [0, 1],
                            "supporting_evidence_ordinals": [0],
                            "contradicting_evidence_ordinals": [1],
                            "confidence": 0.91,
                        }
                    ]
                }
            )
        )

    verified_content, verifier_hint = await _verified_assistant_content(
        db_session,
        run=run,
        model=model,
        resolved_key=SimpleNamespace(api_key="test"),
        llm_router=SimpleNamespace(generate=generate),
        assistant_content=contradicted,
    )
    assert verified_content == VERIFICATION_FAILURE_CONTENT
    assert verifier_hint is not None
    assert verifier_hint["metadata"]["claim_statuses"][0]["support_status"] == "contradicted"
    assert verifier_hint["metadata"]["claim_statuses"][0]["answer_start_offset"] is None
    assert verifier_hint["metadata"]["final_unsupported_claim_count"] == 1

    _finalize_run(
        db_session,
        run_id=run.id,
        assistant_content=verified_content,
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
        model=None,
        resolved_key=None,
        key_mode="auto",
        latency_ms=12,
        usage=None,
        provider_request_id=None,
        viewer_id=user_id,
        verifier_hint=verifier_hint,
    )

    message = db_session.get(Message, assistant_message_id)
    assert message is not None
    assert message.content == VERIFICATION_FAILURE_CONTENT
    claim = db_session.execute(
        select(AssistantMessageClaim).where(
            AssistantMessageClaim.message_id == assistant_message_id
        )
    ).scalar_one()
    evidence_roles = (
        db_session.execute(
            select(AssistantMessageClaimEvidence.evidence_role)
            .join(AssistantMessageClaim)
            .where(AssistantMessageClaim.message_id == assistant_message_id)
            .order_by(AssistantMessageClaimEvidence.ordinal.asc())
        )
        .scalars()
        .all()
    )
    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    assert claim.claim_text == contradicted
    assert claim.support_status == "contradicted"
    assert claim.claim_kind == "insufficient_evidence"
    assert claim.answer_start_offset is None
    assert claim.answer_end_offset is None
    assert evidence_roles == ["supports", "contradicts"]
    assert summary.support_status == "contradicted"
    assert summary.unsupported_claim_count == 1
    assert summary.not_enough_evidence_count == 0


@pytest.mark.asyncio
async def test_verified_assistant_content_drops_unextracted_factual_text(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=str(uuid4()),
                context_ref={"type": "content_chunk", "id": str(uuid4())},
                result_ref={
                    "type": "content_chunk",
                    "id": str(uuid4()),
                    "result_type": "content_chunk",
                    "source_id": "content-chunk-1",
                    "source_kind": "web_article",
                    "title": "Launch report",
                    "source_label": "Report",
                    "citation_label": "Report",
                    "snippet": (
                        "The launch report states that the observatory detected water vapor "
                        "in the target atmosphere during the second observation window."
                    ),
                    "deep_link": "/media/media-1?fragment=fragment-1",
                    "context_ref": {"type": "content_chunk", "id": "content-chunk-1"},
                    "evidence_span_ids": [],
                    "source_version": "content_chunk:test:v1",
                    "locator": _test_locator(),
                },
                selected=True,
                exact_snippet=(
                    "The launch report states that the observatory detected water vapor "
                    "in the target atmosphere during the second observation window."
                ),
                locator=_test_locator(),
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version="content_chunk:test:v1",
            )
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(db_session, run, assistant_message_id, [tool_call.retrievals[0].id])
    db_session.commit()

    supported = "The observatory detected water vapor in the target atmosphere."
    omitted = "The archive includes methane on page five."

    async def generate(_provider, request, _api_key, *, timeout_s):
        if "Extract every atomic factual claim" in request.messages[0].content:
            return SimpleNamespace(
                text=json.dumps(
                    {
                        "claims": [
                            {
                                "text": supported,
                                "answer_start_offset": 0,
                                "answer_end_offset": len(supported),
                            }
                        ]
                    }
                )
            )
        return SimpleNamespace(
            text=json.dumps(
                {
                    "claims": [
                        {
                            "ordinal": 0,
                            "answer_start_offset": 0,
                            "answer_end_offset": len(supported),
                            "support_status": "supported",
                            "evidence_ordinals": [0],
                            "confidence": 0.98,
                        }
                    ]
                }
            )
        )

    verified_content, verifier_hint = await _verified_assistant_content(
        db_session,
        run=run,
        model=model,
        resolved_key=SimpleNamespace(api_key="test"),
        llm_router=SimpleNamespace(generate=generate),
        assistant_content=f"{supported} {omitted}",
    )

    assert verified_content == supported
    assert omitted not in verified_content
    assert verifier_hint is not None
    assert verifier_hint["metadata"]["rewrote_answer"] is True
    assert verifier_hint["metadata"]["removed_claim_count"] == 0


@pytest.mark.asyncio
async def test_verified_assistant_content_fails_closed_when_verifier_generate_fails(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    model = db_session.get(Model, model_id)
    assert model is not None
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    source_id = str(uuid4())
    locator = _test_locator("generate-fail")
    source_version = "content_chunk:generate-fail:v1"
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=source_id,
                context_ref={"type": "content_chunk", "id": source_id},
                result_ref={
                    "type": "content_chunk",
                    "id": source_id,
                    "result_type": "content_chunk",
                    "source_id": source_id,
                    "source_kind": "web_article",
                    "title": "Launch report",
                    "source_label": "Report",
                    "citation_label": "Report",
                    "snippet": (
                        "The launch report states that the observatory detected water vapor "
                        "in the target atmosphere during the second observation window."
                    ),
                    "deep_link": "/media/media-1?fragment=generate-fail",
                    "context_ref": {"type": "content_chunk", "id": source_id},
                    "evidence_span_ids": [],
                    "source_version": source_version,
                    "locator": locator,
                },
                selected=True,
                exact_snippet=(
                    "The launch report states that the observatory detected water vapor "
                    "in the target atmosphere during the second observation window."
                ),
                locator=locator,
                source_version=source_version,
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
            )
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(db_session, run, assistant_message_id, [tool_call.retrievals[0].id])
    db_session.commit()

    async def generate(*_args, **_kwargs):
        raise LLMError(LLMErrorCode.PROVIDER_DOWN, "verifier unavailable")

    verified_content, verifier_hint = await _verified_assistant_content(
        db_session,
        run=run,
        model=model,
        resolved_key=SimpleNamespace(api_key="test"),
        llm_router=SimpleNamespace(generate=generate),
        assistant_content="The observatory detected water vapor in the target atmosphere.",
    )
    assert verified_content == (
        "I could not verify enough of the drafted answer against the available evidence."
    )
    assert verifier_hint is not None
    assert verifier_hint["verifier_status"] == "parse_failed"
    assert all(
        item["support_status"] == "not_enough_evidence"
        for item in verifier_hint["metadata"]["claim_statuses"]
    )

    _finalize_run(
        db_session,
        run_id=run.id,
        assistant_content=verified_content,
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
        model=None,
        resolved_key=None,
        key_mode="auto",
        latency_ms=12,
        usage=None,
        provider_request_id=None,
        viewer_id=user_id,
        verifier_hint=verifier_hint,
    )

    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    verifier_run = db_session.get(AssistantMessageVerifierRun, summary.verifier_run_id)
    claims = (
        db_session.execute(
            text(
                """
            SELECT support_status, verifier_status
            FROM assistant_message_claims
            WHERE message_id = :message_id
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .all()
    )
    assert summary.support_status == "not_enough_evidence"
    assert summary.supported_claim_count == 0
    assert summary.not_enough_evidence_count == 1
    assert verifier_run is not None
    assert verifier_run.verifier_status == "parse_failed"
    assert [dict(row) for row in claims] == [
        {"support_status": "not_enough_evidence", "verifier_status": "failed"}
    ]
    assert not any(
        item.get("support_status") == "supported"
        for item in verifier_run.metadata_["claim_statuses"]
    )


def test_finalize_message_evidence_persists_unsupported_claim_without_evidence(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    assistant_message.content = (
        "The observatory detected water vapor in the target atmosphere. "
        "The archive includes methane on page five."
    )
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=str(uuid4()),
                context_ref={"type": "content_chunk", "id": str(uuid4())},
                result_ref={"type": "content_chunk", "id": str(uuid4())},
                selected=True,
                exact_snippet=(
                    "The launch report states that the observatory detected water vapor "
                    "in the target atmosphere during the second observation window."
                ),
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
            )
        ],
    )
    db_session.add(tool_call)
    db_session.flush()

    _finalize_message_evidence(db_session, run, assistant_message)
    rows = (
        db_session.execute(
            text(
                """
                SELECT ac.ordinal,
                       ac.claim_text,
                       ac.support_status,
                       ac.claim_kind,
                       count(ace.id) AS evidence_count
                FROM assistant_message_claims ac
                LEFT JOIN assistant_message_claim_evidence ace ON ace.claim_id = ac.id
                WHERE ac.message_id = :message_id
                GROUP BY ac.id
                ORDER BY ac.ordinal ASC
                """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .all()
    )
    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()

    assert [(row["support_status"], row["evidence_count"]) for row in rows] == [
        ("not_enough_evidence", 0),
    ], rows
    assert rows[0]["claim_text"] == assistant_message.content
    assert rows[0]["claim_kind"] == "insufficient_evidence"
    assert summary.support_status == "not_enough_evidence"
    assert summary.verifier_status == "failed"
    assert summary.verifier_run_id is not None
    assert summary.supported_claim_count == 0
    assert summary.not_enough_evidence_count == 1
    verifier_run = db_session.get(AssistantMessageVerifierRun, summary.verifier_run_id)
    assert verifier_run is not None
    assert verifier_run.verifier_name == "source_evidence_gate"
    assert verifier_run.verifier_status == "failed"
    audit = db_session.execute(
        select(AssistantMessageCitationAudit).where(
            AssistantMessageCitationAudit.message_id == assistant_message_id
        )
    ).scalar_one()
    assert audit.chat_run_id == run.id
    assert audit.verifier_run_id == summary.verifier_run_id
    assert audit.supported_claim_count == 0
    assert audit.supported_claims_with_valid_offsets_count == 0
    assert audit.supported_claims_with_citation_count == 0
    assert audit.supported_claims_have_valid_offsets is True
    assert audit.supported_claims_have_citation_placement is True
    assert audit.claim_evidence_has_required_locators is True
    assert audit.claim_evidence_has_source_versions is True
    assert audit.missing_locator_count == 0
    assert audit.missing_source_version_count == 0

    _finalize_message_evidence(db_session, run, assistant_message)
    audit_ids = (
        db_session.execute(
            select(AssistantMessageCitationAudit.id)
            .where(AssistantMessageCitationAudit.message_id == assistant_message_id)
            .order_by(
                AssistantMessageCitationAudit.created_at.asc(),
                AssistantMessageCitationAudit.id.asc(),
            )
        )
        .scalars()
        .all()
    )
    assert len(audit_ids) == 2


def test_finalize_message_evidence_parse_failed_does_not_fall_back_to_lexical_support(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    claim_text = "The observatory detected water vapor in the target atmosphere."
    assistant_message.content = claim_text
    source_id = str(uuid4())
    locator = _test_locator("parse-failed")
    source_version = "content_chunk:parse-failed:v1"
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=source_id,
                context_ref={"type": "content_chunk", "id": source_id},
                result_ref={
                    "type": "content_chunk",
                    "id": source_id,
                    "result_type": "content_chunk",
                    "source_id": source_id,
                    "source_kind": "web_article",
                    "title": "Launch report",
                    "source_label": "Report",
                    "citation_label": "Report",
                    "snippet": (
                        "The launch report states that the observatory detected water vapor "
                        "in the target atmosphere during the second observation window."
                    ),
                    "deep_link": "/media/media-1?fragment=parse-failed",
                    "context_ref": {"type": "content_chunk", "id": source_id},
                    "evidence_span_ids": [],
                    "source_version": source_version,
                    "locator": locator,
                },
                selected=True,
                exact_snippet=(
                    "The launch report states that the observatory detected water vapor "
                    "in the target atmosphere during the second observation window."
                ),
                locator=locator,
                source_version=source_version,
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
            )
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(db_session, run, assistant_message_id, [tool_call.retrievals[0].id])
    db_session.flush()

    _finalize_message_evidence(
        db_session,
        run,
        assistant_message,
        {
            "verifier_name": "llm_claim_classifier",
            "verifier_version": "v1",
            "verifier_status": "parse_failed",
            "metadata": {
                "claim_statuses": [
                    {
                        "ordinal": 0,
                        "text": claim_text,
                        "answer_start_offset": 0,
                        "answer_end_offset": len(claim_text),
                        "support_status": "supported",
                        "verifier_status": "llm_verified",
                        "evidence_ordinals": [0],
                    }
                ]
            },
        },
    )

    claim = (
        db_session.execute(
            text(
                """
            SELECT support_status, claim_kind, verifier_status
            FROM assistant_message_claims
            WHERE message_id = :message_id
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .one()
    )
    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    assert claim["support_status"] == "not_enough_evidence"
    assert claim["claim_kind"] == "insufficient_evidence"
    assert claim["verifier_status"] == "failed"
    assert summary.support_status == "not_enough_evidence"
    assert summary.verifier_status == "parse_failed"
    assert summary.supported_claim_count == 0


def test_finalize_message_evidence_rejects_prompt_retrieval_locator_drift(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    claim_text = "The observatory detected water vapor in the target atmosphere."
    assistant_message.content = claim_text
    source_id = str(uuid4())
    source_version = "content_index:test:v1"
    locator = {
        "type": "web_text_offsets",
        "media_id": str(uuid4()),
        "fragment_id": source_id,
        "start_offset": 0,
        "end_offset": len(claim_text),
    }
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=source_id,
                context_ref={"type": "content_chunk", "id": source_id},
                result_ref={
                    "type": "content_chunk",
                    "id": source_id,
                    "result_type": "content_chunk",
                    "source_id": source_id,
                    "source_kind": "web_article",
                    "title": "Launch report",
                    "source_label": "Report",
                    "citation_label": "Report",
                    "snippet": claim_text,
                    "deep_link": "/media/source?fragment=launch",
                    "context_ref": {"type": "content_chunk", "id": source_id},
                    "evidence_span_ids": [],
                    "source_version": source_version,
                    "locator": locator,
                },
                selected=True,
                exact_snippet=claim_text,
                locator={
                    "type": "external_url",
                    "url": "https://example.com/drift",
                },
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version=source_version,
            )
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(db_session, run, assistant_message_id, [tool_call.retrievals[0].id])
    db_session.flush()

    _finalize_message_evidence(
        db_session,
        run,
        assistant_message,
        {
            "verifier_name": "llm_claim_classifier",
            "verifier_version": "v1",
            "verifier_status": "llm_verified",
            "metadata": {
                "claim_statuses": [
                    {
                        "ordinal": 0,
                        "text": claim_text,
                        "answer_start_offset": 0,
                        "answer_end_offset": len(claim_text),
                        "support_status": "supported",
                        "verifier_status": "llm_verified",
                        "evidence_ordinals": [0],
                    }
                ]
            },
        },
    )

    claim = (
        db_session.execute(
            text(
                """
            SELECT support_status, claim_kind, verifier_status
            FROM assistant_message_claims
            WHERE message_id = :message_id
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .one()
    )
    evidence_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM assistant_message_claim_evidence ace
            JOIN assistant_message_claims ac ON ac.id = ace.claim_id
            WHERE ac.message_id = :message_id
            """
        ),
        {"message_id": assistant_message_id},
    ).scalar_one()
    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()

    assert claim["support_status"] == "not_enough_evidence"
    assert claim["claim_kind"] == "insufficient_evidence"
    assert claim["verifier_status"] == "failed"
    assert evidence_count == 0
    assert summary.support_status == "not_enough_evidence"
    assert summary.verifier_status == "failed"


def test_finalize_message_evidence_downgrades_claims_missing_evidence(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    supported_text = "The observatory detected water vapor in the target atmosphere."
    contradicted_text = "The archive says methane is present."
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    assistant_message.content = f"{supported_text} {contradicted_text}"
    source_id = str(uuid4())
    locator = _test_locator("missing-evidence")
    source_version = "content_chunk:missing-evidence:v1"
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=source_id,
                context_ref={"type": "content_chunk", "id": source_id},
                result_ref={
                    "type": "content_chunk",
                    "id": source_id,
                    "result_type": "content_chunk",
                    "source_id": source_id,
                    "source_kind": "web_article",
                    "title": "Archive report",
                    "source_label": "Report",
                    "citation_label": "Report",
                    "snippet": "The archive says methane is absent from the sampled atmosphere.",
                    "deep_link": "/media/media-1?fragment=missing-evidence",
                    "context_ref": {"type": "content_chunk", "id": source_id},
                    "evidence_span_ids": [],
                    "source_version": source_version,
                    "locator": locator,
                },
                selected=True,
                exact_snippet="The archive says methane is absent from the sampled atmosphere.",
                locator=locator,
                source_version=source_version,
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
            )
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(db_session, run, assistant_message_id, [tool_call.retrievals[0].id])

    _finalize_message_evidence(
        db_session,
        run,
        assistant_message,
        {
            "verifier_name": "llm_claim_classifier",
            "verifier_version": "v1",
            "verifier_status": "llm_verified",
            "metadata": {
                "claim_statuses": [
                    {
                        "ordinal": 0,
                        "text": supported_text,
                        "answer_start_offset": 0,
                        "answer_end_offset": len(supported_text),
                        "support_status": "supported",
                        "evidence_ordinals": [],
                    },
                    {
                        "ordinal": 1,
                        "text": contradicted_text,
                        "answer_start_offset": len(supported_text) + 1,
                        "answer_end_offset": len(supported_text) + 1 + len(contradicted_text),
                        "support_status": "contradicted",
                        "evidence_ordinals": [],
                    },
                ]
            },
        },
    )

    claims = (
        db_session.execute(
            text(
                """
            SELECT support_status, claim_kind
            FROM assistant_message_claims
            WHERE message_id = :message_id
            ORDER BY ordinal ASC
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .all()
    )
    evidence_count = db_session.execute(
        text(
            """
            SELECT count(*)
            FROM assistant_message_claim_evidence ace
            JOIN assistant_message_claims ac ON ac.id = ace.claim_id
            WHERE ac.message_id = :message_id
            """
        ),
        {"message_id": assistant_message_id},
    ).scalar_one()
    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    assert [(row["support_status"], row["claim_kind"]) for row in claims] == [
        ("not_enough_evidence", "insufficient_evidence"),
        ("not_enough_evidence", "insufficient_evidence"),
    ]
    assert evidence_count == 0
    assert summary.support_status == "not_enough_evidence"
    assert summary.supported_claim_count == 0
    assert summary.not_enough_evidence_count == 2


def test_finalize_message_evidence_fails_closed_for_source_backed_empty_results(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    assistant_message.content = "The observatory detected water vapor in the target atmosphere."
    db_session.add(
        MessageToolCall(
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            tool_name="app_search",
            tool_call_index=0,
            scope="all",
            status="complete",
        )
    )
    db_session.flush()

    _finalize_message_evidence(db_session, run, assistant_message)

    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    claim = (
        db_session.execute(
            text(
                """
            SELECT support_status, claim_kind
            FROM assistant_message_claims
            WHERE message_id = :message_id
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .one()
    )
    assert summary.support_status == "not_enough_evidence"
    assert summary.claim_count == 1
    assert claim["support_status"] == "not_enough_evidence"
    assert claim["claim_kind"] == "insufficient_evidence"


def test_finalize_message_evidence_persists_not_source_grounded_claim(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    assistant_message.content = "The answer was not requested against saved sources."

    claim_events, claim_evidence_events = _finalize_message_evidence(
        db_session,
        run,
        assistant_message,
    )

    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    claim = (
        db_session.execute(
            text(
                """
            SELECT support_status, claim_kind
            FROM assistant_message_claims
            WHERE message_id = :message_id
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .one()
    )
    assert summary.support_status == "not_source_grounded"
    assert summary.claim_count == 1
    assert summary.unsupported_claim_count == 1
    assert claim["support_status"] == "not_source_grounded"
    assert claim["claim_kind"] == "insufficient_evidence"
    assert claim_events[0]["support_status"] == "not_source_grounded"
    assert claim_evidence_events == []


def test_finalize_message_evidence_fails_closed_when_source_answer_has_no_claim_candidates(
    db_session: Session,
):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    assistant_message.content = "Can I help with anything else?"
    db_session.add(
        MessageToolCall(
            conversation_id=conversation_id,
            user_message_id=user_message_id,
            assistant_message_id=assistant_message_id,
            tool_name="app_search",
            tool_call_index=0,
            scope="all",
            status="complete",
            retrievals=[
                MessageRetrieval(
                    ordinal=0,
                    result_type="content_chunk",
                    source_id=str(uuid4()),
                    context_ref={"type": "content_chunk", "id": str(uuid4())},
                    result_ref={"type": "content_chunk", "id": str(uuid4())},
                    selected=True,
                    exact_snippet=(
                        "The launch report states that the observatory detected water vapor "
                        "in the target atmosphere during the second observation window."
                    ),
                    retrieval_status="included_in_prompt",
                    included_in_prompt=True,
                )
            ],
        )
    )
    db_session.flush()

    _finalize_message_evidence(db_session, run, assistant_message)

    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    claim = (
        db_session.execute(
            text(
                """
            SELECT claim_text, support_status, claim_kind
            FROM assistant_message_claims
            WHERE message_id = :message_id
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .one()
    )
    assert summary.support_status == "not_enough_evidence"
    assert summary.supported_claim_count == 0
    assert summary.not_enough_evidence_count == 1
    assert claim["claim_text"] == "Can I help with anything else?"
    assert claim["support_status"] == "not_enough_evidence"
    assert claim["claim_kind"] == "insufficient_evidence"


def test_finalize_message_evidence_preserves_llm_unsupported_statuses(db_session: Session):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    contradicted_text = "The archive says methane is present."
    out_of_scope_text = "The private lab note confirms ammonia."
    assistant_message.content = f"{contradicted_text} {out_of_scope_text}"
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=str(uuid4()),
                context_ref={"type": "content_chunk", "id": str(uuid4())},
                result_ref={
                    "type": "content_chunk",
                    "id": str(uuid4()),
                    "result_type": "content_chunk",
                    "source_id": "content-chunk-support",
                    "source_kind": "web_article",
                    "title": "Archive",
                    "source_label": "Archive",
                    "citation_label": "Archive",
                    "snippet": "The archive says methane is present in the sampled atmosphere.",
                    "deep_link": "/media/media-1?fragment=support",
                    "context_ref": {
                        "type": "content_chunk",
                        "id": "content-chunk-support",
                    },
                    "evidence_span_ids": [],
                    "source_version": "content_chunk:test:v1",
                    "locator": _test_locator("support"),
                },
                selected=True,
                exact_snippet="The archive says methane is present in the sampled atmosphere.",
                locator=_test_locator("support"),
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version="content_chunk:test:v1",
            ),
            MessageRetrieval(
                ordinal=1,
                result_type="content_chunk",
                source_id=str(uuid4()),
                context_ref={"type": "content_chunk", "id": str(uuid4())},
                result_ref={
                    "type": "content_chunk",
                    "id": str(uuid4()),
                    "result_type": "content_chunk",
                    "source_id": "content-chunk-contradiction",
                    "source_kind": "web_article",
                    "title": "Archive",
                    "source_label": "Archive",
                    "citation_label": "Archive",
                    "snippet": "The archive says methane is absent from the sampled atmosphere.",
                    "deep_link": "/media/media-1?fragment=contradiction",
                    "context_ref": {
                        "type": "content_chunk",
                        "id": "content-chunk-contradiction",
                    },
                    "evidence_span_ids": [],
                    "source_version": "content_chunk:test:v1",
                    "locator": _test_locator("contradiction"),
                },
                selected=True,
                exact_snippet="The archive says methane is absent from the sampled atmosphere.",
                locator=_test_locator("contradiction"),
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version="content_chunk:test:v1",
            ),
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(
        db_session,
        run,
        assistant_message_id,
        [retrieval.id for retrieval in tool_call.retrievals],
    )

    _finalize_message_evidence(
        db_session,
        run,
        assistant_message,
        {
            "verifier_name": "llm_claim_classifier",
            "verifier_version": "v1",
            "verifier_status": "llm_verified",
            "metadata": {
                "claim_statuses": [
                    {
                        "ordinal": 0,
                        "text": contradicted_text,
                        "answer_start_offset": 0,
                        "answer_end_offset": len(contradicted_text),
                        "support_status": "contradicted",
                        "evidence_ordinals": [0, 1],
                        "supporting_evidence_ordinals": [0],
                        "contradicting_evidence_ordinals": [1],
                        "confidence": 0.94,
                    },
                    {
                        "ordinal": 1,
                        "text": out_of_scope_text,
                        "answer_start_offset": len(contradicted_text) + 1,
                        "answer_end_offset": len(contradicted_text) + 1 + len(out_of_scope_text),
                        "support_status": "out_of_scope",
                        "evidence_ordinals": [],
                        "unsupported_reason": "outside selected scope",
                    },
                ]
            },
        },
    )

    claims = (
        db_session.execute(
            text(
                """
            SELECT claim_text,
                   support_status,
                   claim_kind,
                   verifier_status,
                   unsupported_reason,
                   confidence
            FROM assistant_message_claims
            WHERE message_id = :message_id
            ORDER BY ordinal ASC
            """
            ),
            {"message_id": assistant_message_id},
        )
        .mappings()
        .all()
    )
    evidence_roles = (
        db_session.execute(
            text(
                """
            SELECT ace.evidence_role
            FROM assistant_message_claim_evidence ace
            JOIN assistant_message_claims ac ON ac.id = ace.claim_id
            WHERE ac.message_id = :message_id
            ORDER BY ac.ordinal ASC, ace.ordinal ASC
            """
            ),
            {"message_id": assistant_message_id},
        )
        .scalars()
        .all()
    )
    summary = db_session.execute(
        select(AssistantMessageEvidenceSummary).where(
            AssistantMessageEvidenceSummary.message_id == assistant_message_id
        )
    ).scalar_one()
    verifier_run = db_session.get(AssistantMessageVerifierRun, summary.verifier_run_id)
    audit = db_session.execute(
        select(AssistantMessageCitationAudit).where(
            AssistantMessageCitationAudit.message_id == assistant_message_id
        )
    ).scalar_one()

    assert [(row["support_status"], row["verifier_status"]) for row in claims] == [
        ("contradicted", "llm_verified"),
        ("out_of_scope", "llm_verified"),
    ]
    assert claims[0]["claim_kind"] == "insufficient_evidence"
    assert claims[1]["claim_kind"] == "insufficient_evidence"
    assert claims[0]["confidence"] == 0.94
    assert claims[1]["unsupported_reason"] == "outside selected scope"
    assert evidence_roles == ["supports", "contradicts"]
    assert summary.support_status == "contradicted"
    assert summary.verifier_status == "llm_verified"
    assert summary.supported_claim_count == 0
    assert summary.unsupported_claim_count == 2
    assert summary.not_enough_evidence_count == 0
    assert verifier_run is not None
    assert verifier_run.verifier_status == "llm_verified"
    assert verifier_run.metadata_["support_status_counts"] == {
        "supported": 0,
        "partially_supported": 0,
        "contradicted": 1,
        "not_enough_evidence": 0,
        "out_of_scope": 1,
        "not_source_grounded": 0,
    }
    assert verifier_run.metadata_["claim_statuses"][1]["unsupported_reason"] == (
        "outside selected scope"
    )
    assert audit.details["contradiction_pairs"][0]["claim_ordinal"] == 0
    assert audit.details["contradiction_pairs"][0]["claim_id"]
    assert audit.details["contradiction_pairs"][0]["evidence_id"]


def test_citation_audit_counts_partially_supported_claims(db_session: Session):
    conversation_id, user_message_id, assistant_message_id = _create_message_pair(db_session)
    user_id = db_session.execute(
        text("SELECT owner_user_id FROM conversations WHERE id = :id"),
        {"id": conversation_id},
    ).scalar_one()
    model_id = create_test_model(db_session)
    run = ChatRun(
        owner_user_id=user_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=str(uuid4()),
        payload_hash="payload",
        status="running",
        model_id=model_id,
        reasoning="none",
        key_mode="auto",
        web_search={"mode": "off"},
    )
    db_session.add(run)
    assistant_message = db_session.get(Message, assistant_message_id)
    assert assistant_message is not None
    claim_text = "The observatory detected water vapor in the target atmosphere."
    assistant_message.content = claim_text
    tool_call = MessageToolCall(
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        tool_name="app_search",
        tool_call_index=0,
        scope="all",
        status="complete",
        retrievals=[
            MessageRetrieval(
                ordinal=0,
                result_type="content_chunk",
                source_id=str(uuid4()),
                context_ref={"type": "content_chunk", "id": str(uuid4())},
                result_ref={
                    "type": "content_chunk",
                    "id": str(uuid4()),
                    "result_type": "content_chunk",
                    "source_id": "content-chunk-partial",
                    "source_kind": "web_article",
                    "title": "Launch report",
                    "source_label": "Report",
                    "citation_label": "Report",
                    "snippet": "The observatory detected water vapor.",
                    "deep_link": "/media/media-1?fragment=partial",
                    "context_ref": {"type": "content_chunk", "id": "content-chunk-partial"},
                    "evidence_span_ids": [],
                    "source_version": "content_chunk:test:v1",
                    "locator": _test_locator("partial"),
                },
                selected=True,
                exact_snippet="The observatory detected water vapor.",
                locator=_test_locator("partial"),
                retrieval_status="included_in_prompt",
                included_in_prompt=True,
                source_version="content_chunk:test:v1",
            )
        ],
    )
    db_session.add(tool_call)
    db_session.flush()
    _add_prompt_assembly(db_session, run, assistant_message_id, [tool_call.retrievals[0].id])

    _finalize_message_evidence(
        db_session,
        run,
        assistant_message,
        {
            "verifier_name": "llm_claim_classifier",
            "verifier_version": "v1",
            "verifier_status": "llm_verified",
            "metadata": {
                "claim_statuses": [
                    {
                        "ordinal": 0,
                        "text": claim_text,
                        "answer_start_offset": 0,
                        "answer_end_offset": len(claim_text),
                        "support_status": "partially_supported",
                        "evidence_ordinals": [0],
                        "supporting_evidence_ordinals": [0],
                        "unsupported_reason": "target atmosphere is not named in evidence",
                        "confidence": 0.61,
                    }
                ]
            },
        },
    )

    audit = db_session.execute(
        select(AssistantMessageCitationAudit).where(
            AssistantMessageCitationAudit.message_id == assistant_message_id
        )
    ).scalar_one()
    claim_id = db_session.execute(
        select(AssistantMessageClaim.id).where(
            AssistantMessageClaim.message_id == assistant_message_id
        )
    ).scalar_one()

    assert audit.supported_claim_count == 1
    assert audit.supported_claims_with_valid_offsets_count == 1
    assert audit.supported_claims_with_citation_count == 1
    assert audit.supported_claims_have_valid_offsets is True
    assert audit.supported_claims_have_citation_placement is True
    assert str(claim_id) in audit.details["partially_supported_claim_ids"]


def test_message_tool_call_constraints_and_restricts_raw_message_delete(db_session: Session):
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

    with pytest.raises(IntegrityError):
        db_session.execute(
            text("DELETE FROM messages WHERE id = :id"), {"id": assistant_message_id}
        )
        db_session.commit()
    db_session.rollback()

    assert db_session.get(MessageToolCall, tool_call_id) is not None
    assert (
        db_session.scalar(
            select(func.count(MessageRetrieval.id)).where(
                MessageRetrieval.tool_call_id == tool_call_id
            )
        )
        == 1
    )
