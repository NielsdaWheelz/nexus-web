"""Primary chat context assembly service."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from llm_calling.types import LLMRequest, Turn
from pydantic import ValidationError
from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import (
    ChatRun,
    Contributor,
    Conversation,
    ConversationPinnedSource,
    Library,
    Media,
    Message,
    MessageContextItem,
    MessageRetrieval,
    Model,
)
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import (
    MESSAGE_CONTEXT_TYPES,
    ContextItem,
    MessageContextRef,
    ReaderContextHint,
)
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
    safe_retrieval_locator_json,
)
from nexus.services.contexts import reader_selection_context_from_row
from nexus.services.conversation_branches import load_message_path
from nexus.services.conversation_memory import (
    ConversationMemoryItem,
    ConversationStateSnapshot,
    collect_memory_source_refs,
    load_active_memory_items,
)
from nexus.services.message_context_snapshots import (
    trusted_content_chunk_context_snapshot_fields,
    trusted_context_snapshot,
    trusted_object_ref_context_snapshot_payload,
)
from nexus.services.prompt_budget import (
    BudgetItem,
    BudgetLane,
    BudgetSelection,
    PromptBlock,
    allocate_budget,
    build_prompt_budget,
    make_prompt_block,
)

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
    lookup_results: tuple[ContextLookupResult, ...]
    tool_call_events: tuple[Mapping[str, object], ...]
    retrieval_result_events: tuple[Mapping[str, object], ...]
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
    reader_context: ReaderContextHint | None = None,
) -> ContextAssembly:
    """Assemble the provider-neutral chat request for a durable chat run."""

    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    if conversation is None or user_message is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if not can_read_conversation(db, run.owner_user_id, conversation.id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    attached_context_refs = load_message_context_refs(db, run.user_message_id)
    path_messages = load_message_path(
        db,
        conversation_id=conversation.id,
        leaf_message_id=user_message.id,
    )
    path_message_ids = [message.id for message in path_messages if message.id != user_message.id]
    snapshot = None
    after_seq = None
    memory_items = load_active_memory_items(
        db,
        conversation_id=conversation.id,
        after_seq=after_seq,
        prompt_version=PROMPT_VERSION,
        allowed_message_ids=set(path_message_ids),
    )
    memory_source_refs = collect_memory_source_refs(memory_items=memory_items, snapshot=snapshot)

    history_units = load_recent_history_units(
        db,
        conversation_id=conversation.id,
        before_seq=user_message.seq,
        after_seq=after_seq,
        path_message_ids=path_message_ids,
    )
    attached_context_ref_payloads = message_context_ref_payloads(db, attached_context_refs)

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
    mandatory_blocks: list[tuple[str, PromptBlock, Mapping[str, object]]] = []

    reader_context_block = _build_reader_context_block(db, reader_context)
    if reader_context_block is not None:
        mandatory_blocks.append(
            (
                "reader_context_hint",
                reader_context_block,
                {"hint": "reader_context"},
            )
        )

    pinned_sources = list(conversation.pinned_sources)
    if pinned_sources:
        mandatory_blocks.append(
            (
                "pinned_sources",
                make_prompt_block(
                    block_id=f"pinned_sources:{conversation.id}",
                    role="system",
                    lane="attached_context",
                    text=_render_pinned_sources_block(pinned_sources),
                    source_version=f"pinned_sources:{conversation.id}:{len(pinned_sources)}",
                ),
                {"type": "pinned_sources", "id": str(conversation.id)},
            )
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
                        source_version=_context_source_version(ref, context_ref),
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
                    source_version=_context_source_version(ref, context_ref),
                ),
                context_ref,
            )
        )

    if user_message.branch_anchor_kind == "assistant_selection":
        branch_anchor_ref = {
            "type": "assistant_selection_branch_anchor",
            "message_id": str(user_message.branch_anchor.get("message_id") or ""),
            "user_message_id": str(user_message.id),
            "parent_message_id": str(user_message.parent_message_id),
        }
        mandatory_blocks.append(
            (
                "branch_anchor",
                make_prompt_block(
                    block_id=f"branch_anchor:{user_message.id}",
                    role="system",
                    lane="attached_context",
                    text=_render_branch_anchor_block(user_message.branch_anchor),
                    source_refs=[branch_anchor_ref],
                    source_version=f"message_branch_anchor:{user_message.id}",
                ),
                branch_anchor_ref,
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
    tool_call_events, retrieval_result_events = _load_tool_events(
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
        budget_items.append(
            BudgetItem(
                key=key, lane="attached_context", blocks=(block,), mandatory=True, metadata=metadata
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
                role=cast(Literal["system", "user", "assistant"], turn.role),
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
    context_blocks = _selected_context_blocks(
        selection,
        mandatory_blocks=mandatory_blocks,
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
        ],
    )
    return ContextAssembly(
        llm_request=llm_request,
        prompt_plan=prompt_plan,
        history=tuple(history),
        context_blocks=tuple(context_blocks),
        context_types=frozenset(context_types),
        lookup_results=tuple(lookup_results),
        tool_call_events=tuple(tool_call_events),
        retrieval_result_events=tuple(retrieval_result_events),
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
            SELECT id, provider_request_hash
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

    if existing[1] == payload["provider_request_hash"]:
        return
    raise ValueError("prompt assembly already persisted with different provider request hash")


def message_context_ref_payloads(
    db: Session,
    refs: Sequence[ContextItem],
) -> list[dict[str, object]]:
    return [_context_ref_payload(db, ref) for ref in refs]


def _build_reader_context_block(
    db: Session,
    reader_context: ReaderContextHint | None,
) -> PromptBlock | None:
    """Render the reader-context hint (the doc/library the viewer is reading).

    Per spec §4.12 and §5.7 this is a model hint, not a retrieval filter. The
    hint flows in as a request-level parameter; titles are resolved here and
    discarded after the prompt block is rendered.
    """
    if reader_context is None:
        return None
    media_id = reader_context.media_id
    library_id = reader_context.library_id
    if media_id is None and library_id is None:
        return None

    media_title: str | None = None
    library_name: str | None = None
    if media_id is not None:
        media_title = db.scalar(select(Media.title).where(Media.id == media_id))
    if library_id is not None:
        library_name = db.scalar(select(Library.name).where(Library.id == library_id))

    fragments: list[str] = []
    source_refs: list[Mapping[str, object]] = []
    source_version_parts: list[str] = []
    if media_title:
        fragments.append(f'media "{xml_escape(media_title)}"')
        source_refs.append({"type": "media", "id": str(media_id)})
        source_version_parts.append(f"media:{media_id}")
    if library_name:
        fragments.append(f'library "{xml_escape(library_name)}"')
        source_refs.append({"type": "library", "id": str(library_id)})
        source_version_parts.append(f"library:{library_id}")
    if not fragments:
        return None

    body = "The user is currently viewing " + " in ".join(fragments) + "."
    text_block = "<reader_context_hint>\n" + body + "\n</reader_context_hint>"
    return make_prompt_block(
        block_id="reader_context_hint",
        role="system",
        lane="attached_context",
        text=text_block,
        source_refs=source_refs,
        source_version="reader_context_hint:" + "|".join(source_version_parts),
    )


def _context_type_name(ref: ContextItem) -> str:
    if ref.kind == "reader_selection":
        return "reader_selection"
    return ref.type


def _context_block_key(ref: ContextItem) -> str:
    if ref.kind == "reader_selection":
        return f"attached_context:reader_selection:{ref.client_context_id}"
    return f"attached_context:{ref.type}:{ref.id}"


def _context_source_version(
    ref: ContextItem,
    payload: Mapping[str, object] | None = None,
) -> str:
    if payload is not None:
        source_version = payload.get("source_version")
        if isinstance(source_version, str) and source_version:
            return source_version
    if ref.kind == "reader_selection":
        return ref.source_version
    return f"{ref.type}:{ref.id}"


def _context_ref_payload(db: Session, ref: ContextItem) -> dict[str, object]:
    if ref.kind == "reader_selection":
        locator = safe_retrieval_locator_json(ref.locator)
        payload = ref.model_dump(mode="json", exclude_none=True)
        payload["type"] = "reader_selection"
        payload["id"] = str(ref.client_context_id)
        payload["source_media_id"] = str(ref.media_id)
        payload["locator"] = locator
        payload["source_version"] = ref.source_version
        payload["exact_snippet"] = ref.exact
        if ref.prefix is not None:
            payload["snippet_prefix"] = ref.prefix
        if ref.suffix is not None:
            payload["snippet_suffix"] = ref.suffix
        return payload

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
    if ref.source_version is not None:
        payload["source_version"] = ref.source_version
    if ref.locator is not None:
        payload["locator"] = ref.locator.model_dump(mode="json")
    return payload


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
            try:
                refs.append(reader_selection_context_from_row(row))
            except (KeyError, TypeError, ValueError, ValidationError) as exc:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Message context not found") from exc
            continue

        if row.object_type is None or row.object_id is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Message context not found")
        try:
            snapshot = trusted_context_snapshot(row.context_snapshot_json)
            object_payload = trusted_object_ref_context_snapshot_payload(
                object_type=row.object_type,
                object_id=row.object_id,
                payload=snapshot,
            )
            payload: dict[str, object] = {
                "kind": "object_ref",
                "type": cast(MESSAGE_CONTEXT_TYPES, row.object_type),
                "id": row.object_id,
                "evidence_span_ids": object_payload["evidence_span_ids"],
            }
            if row.object_type == "content_chunk":
                payload.update(
                    trusted_content_chunk_context_snapshot_fields(
                        object_type=row.object_type,
                        object_id=row.object_id,
                        payload=snapshot,
                    )
                )
            else:
                source_version = object_payload["source_version"]
                if source_version is not None:
                    payload["source_version"] = source_version
                locator = object_payload["locator"]
                if locator is not None:
                    payload["locator"] = locator
            refs.append(MessageContextRef.model_validate(payload))
        except (ValueError, ValidationError) as exc:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Message context not found") from exc
    return refs


def _render_pinned_sources_block(pinned: Sequence[ConversationPinnedSource]) -> str:
    lines = ["<pinned_sources>"]
    for pin in pinned:
        attrs = f'n="{pin.ordinal}" kind="{pin.kind}" title="{xml_escape(pin.title)}"'
        if pin.target_id is not None:
            attrs += f' target_id="{pin.target_id}"'
        if pin.kind == "reader_selection":
            lines.append(f"<pinned_source {attrs}>")
            if pin.exact:
                lines.append(f"<exact>{xml_escape(pin.exact)}</exact>")
            lines.append("</pinned_source>")
        else:
            lines.append(f"<pinned_source {attrs} />")
    lines.append("</pinned_sources>")
    return "\n".join(lines)


def _render_branch_anchor_block(anchor: Mapping[str, object]) -> str:
    exact = anchor.get("exact")
    prefix = anchor.get("prefix")
    suffix = anchor.get("suffix")
    offset_status = anchor.get("offset_status")
    lines = [
        "The user branched from this selected part of the previous assistant answer.",
        "<assistant_selection>",
    ]
    if offset_status in {"mapped", "unmapped"}:
        lines.append(f"<offset_status>{offset_status}</offset_status>")
    if isinstance(prefix, str) and prefix:
        lines.append(f"<prefix>{xml_escape(prefix)}</prefix>")
    lines.append(f"<exact>{xml_escape(exact if isinstance(exact, str) else '')}</exact>")
    if isinstance(suffix, str) and suffix:
        lines.append(f"<suffix>{xml_escape(suffix)}</suffix>")
    lines.append("</assistant_selection>")
    return "\n".join(lines)


def load_recent_history_units(
    db: Session,
    *,
    conversation_id: UUID,
    before_seq: int,
    after_seq: int | None = None,
    path_message_ids: Sequence[UUID] | None = None,
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
    if path_message_ids is not None:
        if not path_message_ids:
            return []
        filters.append("id = ANY(:path_message_ids)")
        params["path_message_ids"] = list(path_message_ids)

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
) -> tuple[list[Mapping[str, object]], list[Mapping[str, object]]]:
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
    for row in rows:
        retrievals = _tool_retrieval_refs(db, row[0])
        selected = [retrieval for retrieval in retrievals if bool(retrieval.get("selected"))]
        call_events.append(
            {
                "tool_call_id": str(row[0]),
                "assistant_message_id": str(row[1]),
                "tool_name": row[2],
                "tool_call_index": row[3],
                "status": row[7],
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
    return call_events, result_events


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
    snapshot_block: PromptBlock | None,
    memory_block: PromptBlock | None,
    included_keys: set[str],
) -> tuple[PromptBlock, ...]:
    blocks = [system_block]
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
        if key in included_keys:
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
) -> Mapping[str, object]:
    return {
        "environment": environment,
        "owner_user_id": str(run.owner_user_id),
        "conversation_id": str(run.conversation_id),
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
