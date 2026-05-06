"""Primary chat context assembly service."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from llm_calling.types import LLMRequest, Turn
from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import (
    ChatRun,
    Contributor,
    Conversation,
    Message,
    MessageContextItem,
    MessageRetrieval,
    Model,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import ContextItem, MessageContextRef, ReaderSelectionContext
from nexus.services.chat_prompt import (
    SYSTEM_PROMPT_VERSION,
    PromptPlan,
    build_llm_request_from_plan,
    build_prompt_plan,
    render_system_prompt_block,
    validate_prompt_plan_budget,
    validate_prompt_size,
)
from nexus.services.context_lookup import (
    ContextLookupError,
    ContextLookupResult,
    hydrate_context_ref,
    hydrate_source_ref,
)
from nexus.services.context_rendering import (
    PROMPT_VERSION,
    render_context_blocks,
    render_conversation_scope_block,
)
from nexus.services.conversation_memory import (
    ConversationMemoryItem,
    ConversationStateSnapshot,
    collect_memory_source_refs,
    load_active_memory_items,
    load_active_state_snapshot,
)
from nexus.services.conversations import conversation_scope_metadata
from nexus.services.library_intelligence import load_current_library_artifact_context
from nexus.services.prompt_budget import (
    BudgetItem,
    BudgetLane,
    BudgetSelection,
    PromptBlock,
    allocate_budget,
    build_prompt_budget,
    make_prompt_block,
)
from nexus.services.retrieval_planner import RetrievalPlan, build_retrieval_plan

ASSEMBLER_VERSION = "chat-context-memory-v1"
CACHE_POLICY_5M: Mapping[str, object] = {"type": "ephemeral", "ttl_seconds": 300}


@dataclass(frozen=True)
class HistoryUnit:
    key: str
    turns: tuple[Turn, ...]
    message_ids: tuple[UUID, ...]
    first_seq: int
    last_seq: int


@dataclass(frozen=True)
class AssemblyLedger:
    prompt_version: str
    prompt_plan_version: str
    assembler_version: str
    stable_prefix_hash: str
    cacheable_input_tokens_estimate: int
    prompt_block_manifest: Mapping[str, object]
    provider_request_hash: str
    max_context_tokens: int
    reserved_output_tokens: int
    reserved_reasoning_tokens: int
    input_budget_tokens: int
    estimated_input_tokens: int
    included_message_ids: tuple[UUID, ...]
    included_memory_item_ids: tuple[UUID, ...]
    included_retrieval_ids: tuple[UUID, ...]
    included_context_refs: tuple[Mapping[str, object], ...]
    dropped_items: tuple[Mapping[str, object], ...]
    budget_breakdown: Mapping[str, object]
    snapshot_id: UUID | None = None


@dataclass(frozen=True)
class ContextAssembly:
    llm_request: LLMRequest
    prompt_plan: PromptPlan
    history: tuple[Turn, ...]
    context_blocks: tuple[str, ...]
    context_types: frozenset[str]
    scope_metadata: Mapping[str, object]
    retrieval_plan: RetrievalPlan
    lookup_results: tuple[ContextLookupResult, ...]
    tool_call_events: tuple[Mapping[str, object], ...]
    tool_result_events: tuple[Mapping[str, object], ...]
    citation_events: tuple[Mapping[str, object], ...]
    ledger: AssemblyLedger


def assemble_chat_context(
    db: Session,
    *,
    run: ChatRun,
    model: Model,
    environment: str,
    key_mode_used: str,
    provider_account_boundary: str,
    max_output_tokens: int,
) -> ContextAssembly:
    """Assemble the provider-neutral chat request for a durable chat run."""

    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    if conversation is None or user_message is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if not can_read_conversation(db, run.owner_user_id, conversation.id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    scope_metadata = conversation_scope_metadata(db, conversation)
    attached_context_refs = load_message_context_refs(db, run.user_message_id)
    snapshot = load_active_state_snapshot(
        db,
        conversation_id=conversation.id,
        prompt_version=PROMPT_VERSION,
    )
    after_seq = snapshot.covered_through_seq if snapshot is not None else None
    memory_items = load_active_memory_items(
        db,
        conversation_id=conversation.id,
        after_seq=after_seq,
        prompt_version=PROMPT_VERSION,
    )
    memory_source_refs = collect_memory_source_refs(memory_items=memory_items, snapshot=snapshot)

    history_units = load_recent_history_units(
        db,
        conversation_id=conversation.id,
        before_seq=user_message.seq,
        after_seq=after_seq,
    )
    planner_history = _history_turns_from_units(history_units[-4:])
    attached_context_ref_payloads = message_context_ref_payloads(db, attached_context_refs)
    retrieval_plan = build_retrieval_plan(
        user_content=user_message.content,
        history=planner_history,
        scope_metadata=scope_metadata,
        attached_context_refs=attached_context_ref_payloads,
        memory_source_refs=memory_source_refs,
        web_search_options=run.web_search,
    )

    lookup_results: list[ContextLookupResult] = []
    context_types = {_context_type_name(ref) for ref in attached_context_refs}
    system_block = make_prompt_block(
        block_id=f"system:{SYSTEM_PROMPT_VERSION}",
        role="system",
        lane="system",
        text=render_system_prompt_block(),
        source_version=SYSTEM_PROMPT_VERSION,
        cache_policy=CACHE_POLICY_5M,
        required_provider_capability="prompt_cache",
    )
    scope_block = render_conversation_scope_block(scope_metadata)
    mandatory_blocks: list[tuple[str, PromptBlock, Mapping[str, object]]] = []
    if scope_block:
        scope_text = scope_block + "\n" + _render_scope_policy_block(scope_metadata)
        mandatory_blocks.append(
            (
                "scope",
                make_prompt_block(
                    block_id=f"scope:{scope_metadata.get('type')}",
                    role="system",
                    lane="scope",
                    text=scope_text,
                    source_refs=[_scope_source_ref(scope_metadata)],
                    source_version=_scope_source_version(scope_metadata),
                    cache_policy=CACHE_POLICY_5M,
                    required_provider_capability="prompt_cache",
                ),
                {"scope_type": scope_metadata.get("type")},
            )
        )
    artifact_block: PromptBlock | None = None
    artifact_metadata: Mapping[str, object] | None = None
    if scope_metadata.get("type") == "library" and scope_metadata.get("library_id") is not None:
        artifact_context = load_current_library_artifact_context(
            db,
            run.owner_user_id,
            UUID(str(scope_metadata["library_id"])),
        )
        if artifact_context is not None:
            artifact_metadata = {
                "type": "library_intelligence_version",
                "id": str(artifact_context.version_id),
                "library_id": str(artifact_context.library_id),
                "source_set_version_id": str(artifact_context.source_set_version_id),
            }
            artifact_block = make_prompt_block(
                block_id=f"library_intelligence:{artifact_context.version_id}",
                role="system",
                lane="artifact_context",
                text=artifact_context.text,
                source_refs=[artifact_metadata],
                source_version=(
                    f"{artifact_context.prompt_version}:"
                    f"{artifact_context.schema_version}:"
                    f"{artifact_context.source_set_hash}"
                ),
                cache_policy=CACHE_POLICY_5M,
                privacy_scope="library",
                required_provider_capability="prompt_cache",
            )

    for ref, context_ref in zip(
        attached_context_refs,
        attached_context_ref_payloads,
        strict=True,
    ):
        if ref.kind == "reader_selection":
            rendered_context, _ = render_context_blocks(db, [ref])
            mandatory_blocks.append(
                (
                    _context_block_key(ref),
                    make_prompt_block(
                        block_id=_context_block_key(ref),
                        role="system",
                        lane="attached_context",
                        text=rendered_context,
                        source_refs=[context_ref],
                        source_version=_context_source_version(ref),
                    ),
                    context_ref,
                )
            )
            continue

        result = hydrate_context_ref(db, viewer_id=run.owner_user_id, context_ref=context_ref)
        lookup_results.append(result)
        if not result.resolved:
            raise ContextLookupError(result)
        mandatory_blocks.append(
            (
                _context_block_key(ref),
                make_prompt_block(
                    block_id=_context_block_key(ref),
                    role="system",
                    lane="attached_context",
                    text=result.evidence_text,
                    source_refs=[context_ref],
                    source_version=_context_source_version(ref),
                ),
                context_ref,
            )
        )

    raw_retrieval_blocks, retrieval_lookup_results = _load_selected_retrieval_blocks(
        db,
        viewer_id=run.owner_user_id,
        assistant_message_id=run.assistant_message_id,
    )
    retrieval_blocks = [
        (
            retrieval_id,
            make_prompt_block(
                block_id=f"{_retrieval_lane(metadata)}:{retrieval_id}",
                role="system",
                lane=_retrieval_lane(metadata),
                text=text_block,
                source_refs=[
                    {
                        "type": "message_retrieval",
                        "id": str(retrieval_id),
                        "retrieval_id": str(retrieval_id),
                    }
                ],
                source_version=f"message_retrieval:{retrieval_id}",
            ),
            metadata,
        )
        for retrieval_id, text_block, metadata in raw_retrieval_blocks
    ]
    lookup_results.extend(retrieval_lookup_results)
    tool_call_events, tool_result_events, citation_events = _load_tool_events(
        db,
        assistant_message_id=run.assistant_message_id,
    )
    for event in tool_call_events:
        tool_name = event.get("tool_name")
        if tool_name == "app_search":
            context_types.add("app_search")
        elif tool_name == "web_search":
            context_types.add("web_search")

    snapshot_block = (
        make_prompt_block(
            block_id=f"snapshot:{snapshot.id}",
            role="system",
            lane="state_snapshot",
            text=_render_snapshot_block(snapshot),
            source_refs=[{"type": "conversation_state_snapshot", "id": str(snapshot.id)}],
            source_version=f"{PROMPT_VERSION}:snapshot:{snapshot.id}",
            cache_policy=CACHE_POLICY_5M,
            required_provider_capability="prompt_cache",
        )
        if snapshot is not None
        else None
    )
    memory_block = (
        make_prompt_block(
            block_id="memory:active",
            role="system",
            lane="memory",
            text=_render_memory_block(memory_items),
            source_refs=[
                {"type": "conversation_memory_item", "id": str(item.id)} for item in memory_items
            ],
            source_version=PROMPT_VERSION,
            cache_policy=CACHE_POLICY_5M,
            required_provider_capability="prompt_cache",
        )
        if memory_items
        else None
    )
    pointer_block = (
        make_prompt_block(
            block_id="pointer_refs",
            role="system",
            lane="pointer_refs",
            text=_render_pointer_refs_block(memory_source_refs),
            source_refs=[_safe_source_ref(ref) for ref in memory_source_refs],
            source_version=PROMPT_VERSION,
        )
        if memory_source_refs
        else None
    )
    current_user_block = make_prompt_block(
        block_id=f"current_user:{user_message.id}",
        role="user",
        lane="current_user",
        text=user_message.content,
        source_refs=[{"type": "message", "id": str(user_message.id)}],
        source_version=f"message:{user_message.id}",
    )
    budget = build_prompt_budget(
        max_context_tokens=model.max_context_tokens,
        max_output_tokens=max_output_tokens,
        provider=model.provider,
        reasoning=run.reasoning,
    )
    budget_items: list[BudgetItem] = [
        BudgetItem(
            key=system_block.id,
            lane="system",
            blocks=(system_block,),
            mandatory=True,
        ),
        BudgetItem(
            key=current_user_block.id,
            lane="current_user",
            blocks=(current_user_block,),
            mandatory=True,
        ),
    ]
    for key, block, metadata in mandatory_blocks:
        lane = "scope" if key == "scope" else "attached_context"
        budget_items.append(
            BudgetItem(key=key, lane=lane, blocks=(block,), mandatory=True, metadata=metadata)
        )
    if artifact_block is not None and artifact_metadata is not None:
        budget_items.append(
            BudgetItem(
                key=artifact_block.id,
                lane="artifact_context",
                blocks=(artifact_block,),
                mandatory=False,
                priority=90,
                metadata=artifact_metadata,
            )
        )
    for index, (retrieval_id, block, metadata) in enumerate(retrieval_blocks):
        budget_items.append(
            BudgetItem(
                key=f"retrieved_evidence:{retrieval_id}",
                lane=block.lane,
                blocks=(block,),
                mandatory=False,
                priority=100 - index,
                metadata=metadata,
            )
        )
    if snapshot is not None and snapshot_block is not None:
        budget_items.append(
            BudgetItem(
                key=f"snapshot:{snapshot.id}",
                lane="state_snapshot",
                blocks=(snapshot_block,),
                mandatory=False,
                metadata={"snapshot_id": str(snapshot.id)},
            )
        )
    if memory_block is not None:
        budget_items.append(
            BudgetItem(
                key="memory:active",
                lane="memory",
                blocks=(memory_block,),
                mandatory=False,
                metadata={"memory_item_ids": [str(item.id) for item in memory_items]},
            )
        )
    history_count = len(history_units)
    for index, unit in enumerate(reversed(history_units)):
        unit_blocks = tuple(
            make_prompt_block(
                block_id=f"history:{message_id}",
                role=turn.role,
                lane="recent_history",
                text=turn.content,
                source_refs=[{"type": "message", "id": str(message_id)}],
                source_version=f"message:{message_id}",
            )
            for turn, message_id in zip(unit.turns, unit.message_ids, strict=True)
        )
        budget_items.append(
            BudgetItem(
                key=unit.key,
                lane="recent_history",
                blocks=unit_blocks,
                mandatory=False,
                priority=history_count - index,
                metadata={
                    "message_ids": [str(message_id) for message_id in unit.message_ids],
                    "first_seq": unit.first_seq,
                    "last_seq": unit.last_seq,
                },
            )
        )
    if pointer_block is not None:
        budget_items.append(
            BudgetItem(
                key="pointer_refs",
                lane="pointer_refs",
                blocks=(pointer_block,),
                mandatory=False,
                metadata={"source_ref_count": len(memory_source_refs)},
            )
        )

    selection = allocate_budget(budget_items, budget)
    included_keys = selection.included_keys()
    if artifact_block is not None and artifact_block.id in included_keys:
        context_types.add("library_intelligence")
    context_blocks = _selected_context_blocks(
        selection,
        mandatory_blocks=mandatory_blocks,
        artifact_block=artifact_block,
        retrieval_blocks=retrieval_blocks,
        snapshot_block=snapshot_block,
        memory_block=memory_block,
        pointer_block=pointer_block,
    )
    selected_history_units = [unit for unit in history_units if unit.key in included_keys]
    included_retrieval_ids = tuple(
        retrieval_id
        for retrieval_id, _text_block, _metadata in retrieval_blocks
        if f"retrieved_evidence:{retrieval_id}" in included_keys
    )
    included_memory_items = memory_items if "memory:active" in included_keys else []
    history = _history_turns_from_units(selected_history_units)
    stable_blocks = _stable_blocks(
        system_block=system_block,
        mandatory_blocks=mandatory_blocks,
        artifact_block=artifact_block,
        snapshot_block=snapshot_block,
        memory_block=memory_block,
        included_keys=included_keys,
    )
    dynamic_system_blocks = _dynamic_system_blocks(
        mandatory_blocks=mandatory_blocks,
        retrieval_blocks=retrieval_blocks,
        pointer_block=pointer_block,
        included_keys=included_keys,
    )
    history_blocks = _history_blocks(selected_history_units, selection)
    prompt_plan = build_prompt_plan(
        stable_blocks=stable_blocks,
        dynamic_system_blocks=dynamic_system_blocks,
        history_blocks=history_blocks,
        current_user_block=current_user_block,
        cache_identity=_cache_identity(
            run=run,
            model=model,
            environment=environment,
            key_mode_used=key_mode_used,
            provider_account_boundary=provider_account_boundary,
            scope_metadata=scope_metadata,
        ),
        model_name=model.model_name,
        max_tokens=max_output_tokens,
        reasoning_effort=run.reasoning,
    )
    estimated_input_tokens = validate_prompt_plan_budget(prompt_plan, budget.input_budget_tokens)
    validate_prompt_size(prompt_plan)

    llm_request = build_llm_request_from_plan(
        plan=prompt_plan,
        provider=model.provider,
        model_name=model.model_name,
        max_tokens=max_output_tokens,
        reasoning_effort=run.reasoning,
    )
    ledger = _build_ledger(
        selection,
        prompt_plan=prompt_plan,
        estimated_input_tokens=estimated_input_tokens,
        model=model,
        snapshot=snapshot,
        memory_items=included_memory_items,
        included_history_units=selected_history_units,
        included_retrieval_ids=included_retrieval_ids,
        included_context_refs=[
            metadata for key, _text, metadata in mandatory_blocks if key in included_keys
        ]
        + (
            [artifact_metadata]
            if artifact_metadata is not None
            and artifact_block is not None
            and artifact_block.id in included_keys
            else []
        ),
    )
    return ContextAssembly(
        llm_request=llm_request,
        prompt_plan=prompt_plan,
        history=tuple(history),
        context_blocks=tuple(context_blocks),
        context_types=frozenset(context_types),
        scope_metadata=scope_metadata,
        retrieval_plan=retrieval_plan,
        lookup_results=tuple(lookup_results),
        tool_call_events=tuple(tool_call_events),
        tool_result_events=tuple(tool_result_events),
        citation_events=tuple(citation_events),
        ledger=ledger,
    )


def persist_prompt_assembly(db: Session, *, run: ChatRun, assembly: ContextAssembly) -> None:
    ledger = assembly.ledger
    payload = {
        "chat_run_id": run.id,
        "conversation_id": run.conversation_id,
        "assistant_message_id": run.assistant_message_id,
        "model_id": run.model_id,
        "prompt_version": ledger.prompt_version,
        "prompt_plan_version": ledger.prompt_plan_version,
        "assembler_version": ledger.assembler_version,
        "stable_prefix_hash": ledger.stable_prefix_hash,
        "cacheable_input_tokens_estimate": ledger.cacheable_input_tokens_estimate,
        "prompt_block_manifest": dict(ledger.prompt_block_manifest),
        "provider_request_hash": ledger.provider_request_hash,
        "snapshot_id": ledger.snapshot_id,
        "max_context_tokens": ledger.max_context_tokens,
        "reserved_output_tokens": ledger.reserved_output_tokens,
        "reserved_reasoning_tokens": ledger.reserved_reasoning_tokens,
        "input_budget_tokens": ledger.input_budget_tokens,
        "estimated_input_tokens": ledger.estimated_input_tokens,
        "included_message_ids": [str(message_id) for message_id in ledger.included_message_ids],
        "included_memory_item_ids": [
            str(memory_item_id) for memory_item_id in ledger.included_memory_item_ids
        ],
        "included_retrieval_ids": [
            str(retrieval_id) for retrieval_id in ledger.included_retrieval_ids
        ],
        "included_context_refs": [
            dict(context_ref) for context_ref in ledger.included_context_refs
        ],
        "dropped_items": [dict(item) for item in ledger.dropped_items],
        "budget_breakdown": dict(ledger.budget_breakdown),
    }
    existing = db.execute(
        text(
            """
            SELECT id
            FROM chat_prompt_assemblies
            WHERE chat_run_id = :chat_run_id
            FOR UPDATE
            """
        ),
        {"chat_run_id": run.id},
    ).first()

    if existing is None:
        insert_statement = text(
            """
            INSERT INTO chat_prompt_assemblies (
                chat_run_id,
                conversation_id,
                assistant_message_id,
                model_id,
                prompt_version,
                prompt_plan_version,
                assembler_version,
                stable_prefix_hash,
                cacheable_input_tokens_estimate,
                prompt_block_manifest,
                provider_request_hash,
                snapshot_id,
                max_context_tokens,
                reserved_output_tokens,
                reserved_reasoning_tokens,
                input_budget_tokens,
                estimated_input_tokens,
                included_message_ids,
                included_memory_item_ids,
                included_retrieval_ids,
                included_context_refs,
                dropped_items,
                budget_breakdown
            )
            VALUES (
                :chat_run_id,
                :conversation_id,
                :assistant_message_id,
                :model_id,
                :prompt_version,
                :prompt_plan_version,
                :assembler_version,
                :stable_prefix_hash,
                :cacheable_input_tokens_estimate,
                :prompt_block_manifest,
                :provider_request_hash,
                :snapshot_id,
                :max_context_tokens,
                :reserved_output_tokens,
                :reserved_reasoning_tokens,
                :input_budget_tokens,
                :estimated_input_tokens,
                :included_message_ids,
                :included_memory_item_ids,
                :included_retrieval_ids,
                :included_context_refs,
                :dropped_items,
                :budget_breakdown
            )
            """
        ).bindparams(
            bindparam("included_message_ids", type_=JSONB),
            bindparam("included_memory_item_ids", type_=JSONB),
            bindparam("included_retrieval_ids", type_=JSONB),
            bindparam("included_context_refs", type_=JSONB),
            bindparam("dropped_items", type_=JSONB),
            bindparam("budget_breakdown", type_=JSONB),
            bindparam("prompt_block_manifest", type_=JSONB),
        )
        result = cast(Any, db.execute(insert_statement, payload))
        assert result.rowcount == 1  # justify-service-invariant-check: ledger insert is one row.
        return

    update_statement = text(
        """
        UPDATE chat_prompt_assemblies
        SET conversation_id = :conversation_id,
            assistant_message_id = :assistant_message_id,
            model_id = :model_id,
            prompt_version = :prompt_version,
            prompt_plan_version = :prompt_plan_version,
            assembler_version = :assembler_version,
            stable_prefix_hash = :stable_prefix_hash,
            cacheable_input_tokens_estimate = :cacheable_input_tokens_estimate,
            prompt_block_manifest = :prompt_block_manifest,
            provider_request_hash = :provider_request_hash,
            snapshot_id = :snapshot_id,
            max_context_tokens = :max_context_tokens,
            reserved_output_tokens = :reserved_output_tokens,
            reserved_reasoning_tokens = :reserved_reasoning_tokens,
            input_budget_tokens = :input_budget_tokens,
            estimated_input_tokens = :estimated_input_tokens,
            included_message_ids = :included_message_ids,
            included_memory_item_ids = :included_memory_item_ids,
            included_retrieval_ids = :included_retrieval_ids,
            included_context_refs = :included_context_refs,
            dropped_items = :dropped_items,
            budget_breakdown = :budget_breakdown
        WHERE id = :assembly_id
        """
    ).bindparams(
        bindparam("included_message_ids", type_=JSONB),
        bindparam("included_memory_item_ids", type_=JSONB),
        bindparam("included_retrieval_ids", type_=JSONB),
        bindparam("included_context_refs", type_=JSONB),
        bindparam("dropped_items", type_=JSONB),
        bindparam("budget_breakdown", type_=JSONB),
        bindparam("prompt_block_manifest", type_=JSONB),
    )
    result = cast(Any, db.execute(update_statement, {**payload, "assembly_id": existing[0]}))
    assert result.rowcount == 1  # justify-service-invariant-check: selected ledger row vanished.


def message_context_ref_payloads(
    db: Session,
    refs: Sequence[ContextItem],
) -> list[dict[str, object]]:
    return [_context_ref_payload(db, ref) for ref in refs]


def _context_type_name(ref: ContextItem) -> str:
    if ref.kind == "reader_selection":
        return "reader_selection"
    return ref.type


def _context_block_key(ref: ContextItem) -> str:
    if ref.kind == "reader_selection":
        return f"attached_context:reader_selection:{ref.client_context_id}"
    return f"attached_context:{ref.type}:{ref.id}"


def _context_source_version(ref: ContextItem) -> str:
    if ref.kind == "reader_selection":
        return f"reader_selection:{ref.client_context_id}"
    return f"{ref.type}:{ref.id}"


def _context_ref_payload(db: Session, ref: ContextItem) -> dict[str, object]:
    if ref.kind == "reader_selection":
        return ref.model_dump(mode="json")

    if ref.type == "contributor":
        contributor_handle = db.scalar(
            select(Contributor.handle).where(
                Contributor.id == ref.id,
                Contributor.status.in_(("unverified", "verified")),
            )
        )
        if contributor_handle is not None:
            return {
                "type": "contributor",
                "id": contributor_handle,
                "contributor_handle": contributor_handle,
            }

    payload: dict[str, object] = {"type": ref.type, "id": str(ref.id)}
    if ref.type == "content_chunk" and ref.evidence_span_ids:
        payload["evidence_span_ids"] = [str(span_id) for span_id in ref.evidence_span_ids]
    return payload


def _context_snapshot_evidence_span_ids(snapshot: Mapping[str, Any] | None) -> list[UUID]:
    if not isinstance(snapshot, Mapping):
        return []
    raw_values = snapshot.get("evidence_span_ids")
    if raw_values is None:
        raw_values = snapshot.get("evidenceSpanIds")
    if raw_values is None:
        raw_values = snapshot.get("evidence_span_id")
    if raw_values is None:
        raw_values = snapshot.get("evidenceSpanId")
    if isinstance(raw_values, str):
        values = [raw_values]
    elif isinstance(raw_values, Sequence) and not isinstance(raw_values, (str, bytes)):
        values = list(raw_values)
    else:
        values = []

    evidence_span_ids: list[UUID] = []
    seen: set[UUID] = set()
    for value in values:
        try:
            evidence_span_id = UUID(str(value))
        except (TypeError, ValueError):
            continue
        if evidence_span_id in seen:
            continue
        seen.add(evidence_span_id)
        evidence_span_ids.append(evidence_span_id)
    return evidence_span_ids


def load_message_context_refs(db: Session, user_message_id: UUID) -> list[ContextItem]:
    rows = (
        db.execute(
            select(MessageContextItem)
            .where(MessageContextItem.message_id == user_message_id)
            .order_by(MessageContextItem.ordinal.asc())
        )
        .scalars()
        .all()
    )
    refs: list[ContextItem] = []
    for row in rows:
        if row.context_kind == "reader_selection":
            snapshot = (
                row.context_snapshot_json if isinstance(row.context_snapshot_json, Mapping) else {}
            )
            refs.append(
                ReaderSelectionContext(
                    kind="reader_selection",
                    client_context_id=_context_snapshot_uuid(
                        snapshot.get("client_context_id") or snapshot.get("clientContextId"),
                        fallback=row.id,
                    ),
                    media_id=row.source_media_id,
                    media_kind=_context_snapshot_string(
                        snapshot.get("media_kind") or snapshot.get("mediaKind"),
                        fallback="media",
                    ),
                    media_title=_context_snapshot_string(
                        snapshot.get("media_title") or snapshot.get("mediaTitle"),
                        fallback="Selected source",
                    ),
                    exact=_context_snapshot_string(snapshot.get("exact"), fallback=""),
                    prefix=_context_snapshot_optional_string(snapshot.get("prefix")),
                    suffix=_context_snapshot_optional_string(snapshot.get("suffix")),
                    locator=(
                        row.locator_json
                        if isinstance(row.locator_json, dict) and row.locator_json
                        else dict(snapshot.get("locator"))
                        if isinstance(snapshot.get("locator"), Mapping)
                        else {"type": "unknown"}
                    ),
                )
            )
            continue

        refs.append(
            MessageContextRef(
                kind="object_ref",
                type=row.object_type,
                id=row.object_id,
                evidence_span_ids=_context_snapshot_evidence_span_ids(row.context_snapshot_json),
            )
        )
    return refs


def _context_snapshot_uuid(value: object, *, fallback: UUID) -> UUID:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return fallback


def _context_snapshot_string(value: object, *, fallback: str) -> str:
    if isinstance(value, str) and value:
        return value
    return fallback


def _context_snapshot_optional_string(value: object) -> str | None:
    return value if isinstance(value, str) else None


def load_recent_history_units(
    db: Session,
    *,
    conversation_id: UUID,
    before_seq: int,
    after_seq: int | None = None,
) -> list[HistoryUnit]:
    """Load completed recent history as pair-aware units in chronological order."""

    filters = [
        "conversation_id = :conversation_id",
        "status = 'complete'",
        "role IN ('user', 'assistant')",
        "seq < :before_seq",
    ]
    params: dict[str, object] = {"conversation_id": conversation_id, "before_seq": before_seq}
    if after_seq is not None:
        filters.append("seq > :after_seq")
        params["after_seq"] = after_seq

    rows = db.execute(
        text(
            f"""
            SELECT id, seq, role, content
            FROM messages
            WHERE {" AND ".join(filters)}
            ORDER BY seq ASC
            """
        ),
        params,
    ).fetchall()

    units: list[HistoryUnit] = []
    index = 0
    while index < len(rows):
        row = rows[index]
        if row[2] == "user" and index + 1 < len(rows) and rows[index + 1][2] == "assistant":
            next_row = rows[index + 1]
            units.append(
                HistoryUnit(
                    key=f"history_pair:{row[1]}:{next_row[1]}",
                    turns=(
                        Turn(role="user", content=row[3]),
                        Turn(role="assistant", content=next_row[3]),
                    ),
                    message_ids=(row[0], next_row[0]),
                    first_seq=row[1],
                    last_seq=next_row[1],
                )
            )
            index += 2
            continue
        units.append(
            HistoryUnit(
                key=f"history_single:{row[1]}",
                turns=(Turn(role=row[2], content=row[3]),),
                message_ids=(row[0],),
                first_seq=row[1],
                last_seq=row[1],
            )
        )
        index += 1
    return units


def _load_selected_retrieval_blocks(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
) -> tuple[list[tuple[UUID, str, Mapping[str, object]]], list[ContextLookupResult]]:
    rows = db.execute(
        text(
            """
            SELECT mr.id
            FROM message_retrievals mr
            JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            WHERE mtc.assistant_message_id = :assistant_message_id
              AND mr.selected = true
            ORDER BY mtc.tool_call_index ASC, mr.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).fetchall()
    blocks: list[tuple[UUID, str, Mapping[str, object]]] = []
    lookup_results: list[ContextLookupResult] = []
    for row in rows:
        retrieval_id = row[0]
        result = hydrate_source_ref(
            db,
            viewer_id=viewer_id,
            source_ref={"type": "message_retrieval", "retrieval_id": str(retrieval_id)},
        )
        lookup_results.append(result)
        if not result.resolved:
            continue
        blocks.append(
            (
                retrieval_id,
                result.evidence_text,
                {
                    "retrieval_id": str(retrieval_id),
                    "context_ref": dict(result.context_ref or {}),
                },
            )
        )
    return blocks, lookup_results


def _load_tool_events(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> tuple[list[Mapping[str, object]], list[Mapping[str, object]], list[Mapping[str, object]]]:
    rows = db.execute(
        text(
            """
            SELECT id, assistant_message_id, tool_name, tool_call_index, scope,
                   requested_types, semantic, status, error_code, latency_ms
            FROM message_tool_calls
            WHERE assistant_message_id = :assistant_message_id
            ORDER BY tool_call_index ASC
            """
        ),
        {"assistant_message_id": assistant_message_id},
    ).fetchall()
    call_events: list[Mapping[str, object]] = []
    result_events: list[Mapping[str, object]] = []
    citation_events: list[Mapping[str, object]] = []
    for row in rows:
        retrievals = _tool_retrieval_refs(db, row[0])
        selected = [retrieval for retrieval in retrievals if bool(retrieval.get("selected"))]
        call_events.append(
            {
                "tool_call_id": str(row[0]),
                "assistant_message_id": str(row[1]),
                "tool_name": row[2],
                "tool_call_index": row[3],
                "status": "started",
                "scope": row[4],
                "types": row[5] or [],
                "semantic": bool(row[6]),
            }
        )
        result_events.append(
            {
                "tool_call_id": str(row[0]),
                "assistant_message_id": str(row[1]),
                "tool_name": row[2],
                "tool_call_index": row[3],
                "status": row[7],
                "error_code": row[8],
                "result_count": len(retrievals),
                "selected_count": len(selected),
                "latency_ms": row[9],
                "citations": [retrieval["result_ref"] for retrieval in selected],
            }
        )
        if row[2] == "web_search":
            for retrieval in selected:
                result_ref = retrieval["result_ref"]
                if isinstance(result_ref, Mapping):
                    citation_events.append(
                        {
                            "assistant_message_id": str(row[1]),
                            "tool_name": row[2],
                            "tool_call_index": row[3],
                            "title": result_ref.get("title"),
                            "url": result_ref.get("url"),
                            "display_url": result_ref.get("display_url"),
                            "source_name": result_ref.get("source_name"),
                            "snippet": result_ref.get("snippet"),
                            "provider": result_ref.get("provider"),
                        }
                    )
    return call_events, result_events, citation_events


def _tool_retrieval_refs(db: Session, tool_call_id: UUID) -> list[Mapping[str, object]]:
    rows = (
        db.execute(
            select(MessageRetrieval)
            .where(MessageRetrieval.tool_call_id == tool_call_id)
            .order_by(MessageRetrieval.ordinal.asc())
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": str(row.id),
            "result_type": row.result_type,
            "source_id": row.source_id,
            "context_ref": row.context_ref,
            "result_ref": row.result_ref,
            "selected": row.selected,
        }
        for row in rows
    ]


def _selected_context_blocks(
    selection: BudgetSelection,
    *,
    mandatory_blocks: Sequence[tuple[str, PromptBlock, Mapping[str, object]]],
    artifact_block: PromptBlock | None,
    retrieval_blocks: Sequence[tuple[UUID, PromptBlock, Mapping[str, object]]],
    snapshot_block: PromptBlock | None,
    memory_block: PromptBlock | None,
    pointer_block: PromptBlock | None,
) -> list[str]:
    included_keys = selection.included_keys()
    blocks: list[str] = []
    for key, block, _metadata in mandatory_blocks:
        if key in included_keys and block.lane == "attached_context":
            blocks.append(block.text)
    if artifact_block is not None and artifact_block.id in included_keys:
        blocks.append(artifact_block.text)
    for retrieval_id, block, _metadata in retrieval_blocks:
        if f"retrieved_evidence:{retrieval_id}" in included_keys:
            blocks.append(block.text)
    if memory_block is not None and "memory:active" in included_keys:
        blocks.append(memory_block.text)
    if pointer_block is not None and "pointer_refs" in included_keys:
        blocks.append(pointer_block.text)
    return blocks


def _stable_blocks(
    *,
    system_block: PromptBlock,
    mandatory_blocks: Sequence[tuple[str, PromptBlock, Mapping[str, object]]],
    artifact_block: PromptBlock | None,
    snapshot_block: PromptBlock | None,
    memory_block: PromptBlock | None,
    included_keys: set[str],
) -> tuple[PromptBlock, ...]:
    blocks = [system_block]
    for key, block, _metadata in mandatory_blocks:
        if key == "scope" and key in included_keys:
            blocks.append(block)
    if artifact_block is not None and artifact_block.id in included_keys:
        blocks.append(artifact_block)
    if snapshot_block is not None and any(key.startswith("snapshot:") for key in included_keys):
        blocks.append(snapshot_block)
    if memory_block is not None and "memory:active" in included_keys:
        blocks.append(memory_block)
    return tuple(blocks)


def _dynamic_system_blocks(
    *,
    mandatory_blocks: Sequence[tuple[str, PromptBlock, Mapping[str, object]]],
    retrieval_blocks: Sequence[tuple[UUID, PromptBlock, Mapping[str, object]]],
    pointer_block: PromptBlock | None,
    included_keys: set[str],
) -> tuple[PromptBlock, ...]:
    blocks: list[PromptBlock] = []
    for key, block, _metadata in mandatory_blocks:
        if key != "scope" and key in included_keys:
            blocks.append(block)
    for retrieval_id, block, _metadata in retrieval_blocks:
        if f"retrieved_evidence:{retrieval_id}" in included_keys:
            blocks.append(block)
    if pointer_block is not None and "pointer_refs" in included_keys:
        blocks.append(pointer_block)
    return tuple(blocks)


def _history_blocks(
    selected_history_units: Sequence[HistoryUnit],
    selection: BudgetSelection,
) -> tuple[PromptBlock, ...]:
    selected = {item.key: item for item in selection.included}
    blocks: list[PromptBlock] = []
    for unit in selected_history_units:
        item = selected.get(unit.key)
        if item is not None:
            blocks.extend(item.blocks)
    return tuple(blocks)


def _history_turns_from_units(units: Sequence[HistoryUnit]) -> list[Turn]:
    turns: list[Turn] = []
    for unit in sorted(units, key=lambda candidate: candidate.first_seq):
        turns.extend(unit.turns)
    return turns


def _retrieval_lane(metadata: Mapping[str, object]) -> BudgetLane:
    context_ref = metadata.get("context_ref")
    if isinstance(context_ref, Mapping) and context_ref.get("type") == "web_result":
        return "web_evidence"
    return "retrieved_evidence"


def _render_scope_policy_block(scope_metadata: Mapping[str, object]) -> str:
    scope_type = scope_metadata.get("type")
    if scope_type == "media":
        return (
            "<scope_policy>Search and source-grounded claims must stay within this saved "
            "document unless web evidence is present.</scope_policy>"
        )
    if scope_type == "library":
        return (
            "<scope_policy>Search and source-grounded claims must stay within this saved "
            "library unless web evidence is present.</scope_policy>"
        )
    return "<scope_policy>Use the supplied evidence blocks when relevant.</scope_policy>"


def _scope_source_ref(scope_metadata: Mapping[str, object]) -> Mapping[str, object]:
    scope_type = str(scope_metadata.get("type") or "general")
    if scope_type == "media":
        return {
            "type": "conversation_scope",
            "scope_type": scope_type,
            "id": scope_metadata.get("media_id"),
        }
    if scope_type == "library":
        return {
            "type": "conversation_scope",
            "scope_type": scope_type,
            "id": scope_metadata.get("library_id"),
        }
    return {"type": "conversation_scope", "scope_type": scope_type}


def _scope_source_version(scope_metadata: Mapping[str, object]) -> str:
    scope_type = str(scope_metadata.get("type") or "general")
    if scope_type == "media":
        return f"media:{scope_metadata.get('media_id')}"
    if scope_type == "library":
        return f"library:{scope_metadata.get('library_id')}"
    return "general"


def _safe_source_ref(source_ref: Mapping[str, object]) -> Mapping[str, object]:
    ref_type = source_ref.get("type")
    ref_id = source_ref.get("id") or source_ref.get("message_id") or source_ref.get("retrieval_id")
    safe: dict[str, object] = {}
    if isinstance(ref_type, str):
        safe["type"] = ref_type
    if isinstance(ref_id, str):
        safe["id"] = ref_id
    context_ref = source_ref.get("context_ref")
    if isinstance(context_ref, Mapping):
        nested_type = context_ref.get("type")
        nested_id = context_ref.get("id")
        safe["context_ref"] = {
            "type": nested_type,
            "id": nested_id,
        }
    return safe


def _cache_identity(
    *,
    run: ChatRun,
    model: Model,
    environment: str,
    key_mode_used: str,
    provider_account_boundary: str,
    scope_metadata: Mapping[str, object],
) -> Mapping[str, object]:
    return {
        "environment": environment,
        "owner_user_id": str(run.owner_user_id),
        "conversation_id": str(run.conversation_id),
        "scope": _scope_source_ref(scope_metadata),
        "provider": model.provider,
        "model_name": model.model_name,
        "key_mode_requested": run.key_mode,
        "key_mode_used": key_mode_used,
        "provider_account_boundary": provider_account_boundary,
        "prompt_version": PROMPT_VERSION,
        "system_prompt_version": SYSTEM_PROMPT_VERSION,
    }


def _render_snapshot_block(snapshot: ConversationStateSnapshot) -> str:
    lines = [
        f'<conversation_state_snapshot covered_through_seq="{snapshot.covered_through_seq}">',
        f"<state>{xml_escape(snapshot.state_text)}</state>",
        "</conversation_state_snapshot>",
    ]
    return "\n".join(lines)


def _render_memory_block(memory_items: Sequence[ConversationMemoryItem]) -> str:
    lines = ["<conversation_memory>"]
    for item in memory_items:
        lines.append(
            f'<memory_item id="{item.id}" kind="{xml_escape(item.kind)}" '
            f'source_required="{str(item.source_required).lower()}">'
        )
        lines.append(f"<body>{xml_escape(item.body)}</body>")
        lines.append("</memory_item>")
    lines.append("</conversation_memory>")
    return "\n".join(lines)


def _render_pointer_refs_block(source_refs: Sequence[Mapping[str, object]]) -> str:
    lines = ['<source_refs pointers_only="true">']
    for source_ref in source_refs:
        lines.append(
            f"<source_ref>{xml_escape(json.dumps(source_ref, sort_keys=True))}</source_ref>"
        )
    lines.append("</source_refs>")
    return "\n".join(lines)


def _build_ledger(
    selection: BudgetSelection,
    *,
    prompt_plan: PromptPlan,
    estimated_input_tokens: int,
    model: Model,
    snapshot: ConversationStateSnapshot | None,
    memory_items: Sequence[ConversationMemoryItem],
    included_history_units: Sequence[HistoryUnit],
    included_retrieval_ids: Sequence[UUID],
    included_context_refs: Sequence[Mapping[str, object]],
) -> AssemblyLedger:
    return AssemblyLedger(
        prompt_version=PROMPT_VERSION,
        prompt_plan_version=prompt_plan.version,
        assembler_version=ASSEMBLER_VERSION,
        stable_prefix_hash=prompt_plan.stable_prefix_hash,
        cacheable_input_tokens_estimate=prompt_plan.cacheable_input_tokens_estimate,
        prompt_block_manifest=prompt_plan.manifest(),
        provider_request_hash=prompt_plan.provider_request_hash,
        max_context_tokens=model.max_context_tokens,
        reserved_output_tokens=selection.budget.reserved_output_tokens,
        reserved_reasoning_tokens=selection.budget.reserved_reasoning_tokens,
        input_budget_tokens=selection.budget.input_budget_tokens,
        estimated_input_tokens=estimated_input_tokens,
        included_message_ids=tuple(
            message_id for unit in included_history_units for message_id in unit.message_ids
        ),
        included_memory_item_ids=tuple(item.id for item in memory_items),
        included_retrieval_ids=tuple(included_retrieval_ids),
        included_context_refs=tuple(included_context_refs),
        dropped_items=tuple(item.to_json() for item in selection.dropped),
        budget_breakdown=selection.breakdown,
        snapshot_id=snapshot.id if snapshot is not None else None,
    )
