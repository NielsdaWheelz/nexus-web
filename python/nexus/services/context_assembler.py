"""Primary chat context assembly service."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, cast
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from llm_calling.types import LLMRequest, ReasoningEffort, Turn
from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import ChatRun, Conversation, Message, MessageContext, MessageRetrieval, Model
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.schemas.conversation import MessageContextRef
from nexus.services.chat_prompt import render_prompt
from nexus.services.context_lookup import (
    ContextLookupError,
    ContextLookupResult,
    hydrate_context_ref,
    hydrate_source_ref,
)
from nexus.services.context_rendering import PROMPT_VERSION, render_conversation_scope_block
from nexus.services.conversation_memory import (
    ConversationMemoryItem,
    ConversationStateSnapshot,
    collect_memory_source_refs,
    load_active_memory_items,
    load_active_state_snapshot,
)
from nexus.services.conversations import conversation_scope_metadata
from nexus.services.prompt_budget import (
    BudgetItem,
    BudgetSelection,
    allocate_budget,
    build_prompt_budget,
    validate_turn_budget,
)
from nexus.services.retrieval_planner import RetrievalPlan, build_retrieval_plan

ASSEMBLER_VERSION = "chat-context-memory-v1"


@dataclass(frozen=True)
class HistoryUnit:
    key: str
    turns: tuple[Turn, ...]
    message_ids: tuple[UUID, ...]
    first_seq: int
    last_seq: int

    def budget_text(self) -> str:
        return "\n".join(f"{turn.role}: {turn.content}" for turn in self.turns)


@dataclass(frozen=True)
class AssemblyLedger:
    prompt_version: str
    assembler_version: str
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
    retrieval_plan = build_retrieval_plan(
        user_content=user_message.content,
        history=planner_history,
        scope_metadata=scope_metadata,
        attached_context_refs=[
            {"type": ref.type, "id": str(ref.id)} for ref in attached_context_refs
        ],
        memory_source_refs=memory_source_refs,
        web_search_options=run.web_search,
    )

    lookup_results: list[ContextLookupResult] = []
    context_types = {ref.type for ref in attached_context_refs}
    scope_block = render_conversation_scope_block(scope_metadata)
    mandatory_blocks: list[tuple[str, str, Mapping[str, object]]] = []
    if scope_block:
        mandatory_blocks.append(("scope", scope_block, {"scope_type": scope_metadata.get("type")}))

    for ref in attached_context_refs:
        context_ref = {"type": ref.type, "id": str(ref.id)}
        result = hydrate_context_ref(db, viewer_id=run.owner_user_id, context_ref=context_ref)
        lookup_results.append(result)
        if not result.resolved:
            raise ContextLookupError(result)
        mandatory_blocks.append(
            (f"attached_context:{ref.type}:{ref.id}", result.evidence_text, context_ref)
        )

    retrieval_blocks, retrieval_lookup_results = _load_selected_retrieval_blocks(
        db,
        viewer_id=run.owner_user_id,
        assistant_message_id=run.assistant_message_id,
    )
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

    snapshot_block = _render_snapshot_block(snapshot) if snapshot is not None else None
    memory_block = _render_memory_block(memory_items) if memory_items else None
    pointer_block = _render_pointer_refs_block(memory_source_refs) if memory_source_refs else None

    base_system = render_prompt(
        user_content="",
        history=[],
        context_blocks=[],
        context_types=context_types,
        scope_metadata=scope_metadata,
    )[0].content
    budget = build_prompt_budget(
        max_context_tokens=model.max_context_tokens,
        max_output_tokens=max_output_tokens,
        provider=model.provider,
        reasoning=run.reasoning,
    )
    budget_items: list[BudgetItem] = [
        BudgetItem(
            key="system",
            lane="system",
            text=base_system,
            mandatory=True,
        ),
        BudgetItem(
            key="current_user",
            lane="current_user",
            text=user_message.content,
            mandatory=True,
        ),
    ]
    for key, text_block, metadata in mandatory_blocks:
        lane = "scope" if key == "scope" else "attached_context"
        budget_items.append(
            BudgetItem(key=key, lane=lane, text=text_block, mandatory=True, metadata=metadata)
        )
    for index, (retrieval_id, text_block, metadata) in enumerate(retrieval_blocks):
        budget_items.append(
            BudgetItem(
                key=f"retrieved_evidence:{retrieval_id}",
                lane="retrieved_evidence",
                text=text_block,
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
                text=snapshot_block,
                mandatory=False,
                metadata={"snapshot_id": str(snapshot.id)},
            )
        )
    if memory_block is not None:
        budget_items.append(
            BudgetItem(
                key="memory:active",
                lane="memory",
                text=memory_block,
                mandatory=False,
                metadata={"memory_item_ids": [str(item.id) for item in memory_items]},
            )
        )
    history_count = len(history_units)
    for index, unit in enumerate(reversed(history_units)):
        budget_items.append(
            BudgetItem(
                key=unit.key,
                lane="recent_history",
                text=unit.budget_text(),
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
                text=pointer_block,
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
    turns = render_prompt(
        user_content=user_message.content,
        history=history,
        context_blocks=context_blocks,
        context_types=context_types,
        scope_metadata=scope_metadata,
    )
    estimated_input_tokens = validate_turn_budget(turns, budget)

    llm_request = LLMRequest(
        model_name=model.model_name,
        messages=turns,
        max_tokens=max_output_tokens,
        temperature=0.7,
        reasoning_effort=cast(ReasoningEffort, run.reasoning),
    )
    ledger = _build_ledger(
        selection,
        estimated_input_tokens=estimated_input_tokens,
        model=model,
        snapshot=snapshot,
        memory_items=included_memory_items,
        included_history_units=selected_history_units,
        included_retrieval_ids=included_retrieval_ids,
        included_context_refs=[metadata for _key, _text, metadata in mandatory_blocks],
    )
    return ContextAssembly(
        llm_request=llm_request,
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
        "assembler_version": ledger.assembler_version,
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
                assembler_version,
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
                :assembler_version,
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
            assembler_version = :assembler_version,
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
    )
    result = cast(Any, db.execute(update_statement, {**payload, "assembly_id": existing[0]}))
    assert result.rowcount == 1  # justify-service-invariant-check: selected ledger row vanished.


def load_message_context_refs(db: Session, user_message_id: UUID) -> list[MessageContextRef]:
    rows = (
        db.execute(
            select(MessageContext)
            .where(MessageContext.message_id == user_message_id)
            .order_by(MessageContext.ordinal.asc())
        )
        .scalars()
        .all()
    )
    refs: list[MessageContextRef] = []
    for row in rows:
        if row.target_type == "media" and row.media_id is not None:
            refs.append(MessageContextRef(type="media", id=row.media_id))
        elif row.target_type == "highlight" and row.highlight_id is not None:
            refs.append(MessageContextRef(type="highlight", id=row.highlight_id))
        elif row.target_type == "annotation" and row.annotation_id is not None:
            refs.append(MessageContextRef(type="annotation", id=row.annotation_id))
    return refs


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
    mandatory_blocks: Sequence[tuple[str, str, Mapping[str, object]]],
    retrieval_blocks: Sequence[tuple[UUID, str, Mapping[str, object]]],
    snapshot_block: str | None,
    memory_block: str | None,
    pointer_block: str | None,
) -> list[str]:
    included_keys = selection.included_keys()
    blocks: list[str] = []
    for key, text_block, _metadata in mandatory_blocks:
        if key in included_keys:
            blocks.append(text_block)
    for retrieval_id, text_block, _metadata in retrieval_blocks:
        if f"retrieved_evidence:{retrieval_id}" in included_keys:
            blocks.append(text_block)
    if snapshot_block is not None and any(
        item.key.startswith("snapshot:") for item in selection.included
    ):
        blocks.append(snapshot_block)
    if memory_block is not None and "memory:active" in included_keys:
        blocks.append(memory_block)
    if pointer_block is not None and "pointer_refs" in included_keys:
        blocks.append(pointer_block)
    return blocks


def _history_turns_from_units(units: Sequence[HistoryUnit]) -> list[Turn]:
    turns: list[Turn] = []
    for unit in sorted(units, key=lambda candidate: candidate.first_seq):
        turns.extend(unit.turns)
    return turns


def _render_snapshot_block(snapshot: ConversationStateSnapshot | None) -> str | None:
    if snapshot is None:
        return None
    lines = [
        f'<conversation_state_snapshot covered_through_seq="{snapshot.covered_through_seq}">',
        f"<state>{xml_escape(snapshot.state_text)}</state>",
        "</conversation_state_snapshot>",
    ]
    return "\n".join(lines)


def _render_memory_block(memory_items: Sequence[ConversationMemoryItem]) -> str | None:
    if not memory_items:
        return None
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


def _render_pointer_refs_block(source_refs: Sequence[Mapping[str, object]]) -> str | None:
    if not source_refs:
        return None
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
        assembler_version=ASSEMBLER_VERSION,
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
