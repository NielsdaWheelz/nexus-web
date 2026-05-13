"""Focused tests for chat context memory model and schema contracts."""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic import ValidationError

from nexus.db.models import (
    ChatPromptAssembly,
    ConversationMemoryItem,
    ConversationMemoryItemSource,
    ConversationStateSnapshot,
)
from nexus.schemas.context_memory import (
    ChatPromptAssemblyOut,
    ConversationMemoryItemOut,
    SourceRef,
    SourceRefLocation,
)

pytestmark = pytest.mark.unit


def _constraint_names(model: type) -> set[str]:
    return {constraint.name for constraint in model.__table__.constraints if constraint.name}


def test_memory_models_expose_finite_constraints() -> None:
    assert {
        fk.column.table.name: fk.ondelete
        for fk in ConversationMemoryItem.__table__.foreign_keys
        if fk.parent.name in {"conversation_id", "created_by_message_id", "supersedes_id"}
    } == {
        "conversations": "CASCADE",
        "messages": "SET NULL",
        "conversation_memory_items": "SET NULL",
    }
    assert {
        "ck_conversation_memory_items_kind",
        "ck_conversation_memory_items_status",
        "ck_conversation_memory_items_invalid_reason",
        "ck_conversation_memory_items_confidence",
        "ck_conversation_memory_items_valid_seq",
        "ck_conversation_memory_items_source_claim_requires_source",
    } <= _constraint_names(ConversationMemoryItem)
    assert {
        "idx_conversation_memory_items_active",
    } <= {index.name for index in ConversationMemoryItem.__table__.indexes}

    assert {
        "ck_conversation_memory_item_sources_source_ref_type",
        "ck_conversation_memory_item_sources_source_ref_id",
        "ck_conversation_memory_item_sources_evidence_role",
        "uix_conversation_memory_item_sources_item_ordinal",
    } <= _constraint_names(ConversationMemoryItemSource)
    assert next(iter(ConversationMemoryItemSource.__table__.foreign_keys)).ondelete == "CASCADE"

    assert {
        "ck_conversation_state_snapshots_status",
        "ck_conversation_state_snapshots_invalid_reason",
        "ck_conversation_state_snapshots_source_refs_array",
    } <= _constraint_names(ConversationStateSnapshot)
    assert next(iter(ConversationStateSnapshot.__table__.foreign_keys)).ondelete == "CASCADE"

    assert {
        "ck_chat_prompt_assemblies_token_budget",
        "ck_chat_prompt_assemblies_message_ids_array",
        "uix_chat_prompt_assemblies_chat_run",
    } <= _constraint_names(ChatPromptAssembly)
    assert {
        fk.parent.name: fk.ondelete
        for fk in ChatPromptAssembly.__table__.foreign_keys
        if fk.parent.name
        in {
            "chat_run_id",
            "conversation_id",
            "assistant_message_id",
            "snapshot_id",
        }
    } == {
        "chat_run_id": "CASCADE",
        "conversation_id": "CASCADE",
        "assistant_message_id": "CASCADE",
        "snapshot_id": "SET NULL",
    }

    active_snapshot_indexes = [
        index
        for index in ConversationStateSnapshot.__table__.indexes
        if index.name == "uix_conversation_state_snapshots_active"
    ]
    assert len(active_snapshot_indexes) == 1
    assert active_snapshot_indexes[0].unique is True


def test_source_ref_rejects_unknown_type() -> None:
    with pytest.raises(ValidationError):
        SourceRef(type="media", id="source-1")


def test_source_ref_location_rejects_inverted_offsets() -> None:
    with pytest.raises(ValidationError):
        SourceRefLocation(start_offset=10, end_offset=9)


def test_memory_item_schema_rejects_invalid_reason_on_active_item() -> None:
    now = datetime.now(UTC)

    with pytest.raises(ValidationError):
        ConversationMemoryItemOut(
            id=uuid4(),
            conversation_id=uuid4(),
            kind="goal",
            status="active",
            body="Keep the implementation narrowly scoped.",
            source_required=False,
            confidence=0.9,
            prompt_version="ContextMemory.V1",
            memory_version=1,
            invalid_reason="validation_failed",
            created_at=now,
            updated_at=now,
        )


def test_prompt_assembly_schema_rejects_overspent_budget() -> None:
    with pytest.raises(ValidationError):
        ChatPromptAssemblyOut(
            id=uuid4(),
            chat_run_id=uuid4(),
            conversation_id=uuid4(),
            assistant_message_id=uuid4(),
            model_id=uuid4(),
            prompt_version="ContextMemory.V1",
            prompt_plan_version="prompt-plan-v1",
            assembler_version="ContextAssembler.V1",
            stable_prefix_hash="hash",
            cacheable_input_tokens_estimate=10,
            prompt_block_manifest={"blocks": []},
            provider_request_hash="request-hash",
            max_context_tokens=100,
            reserved_output_tokens=40,
            reserved_reasoning_tokens=20,
            input_budget_tokens=50,
            estimated_input_tokens=45,
            created_at=datetime.now(UTC),
        )
