"""Primary chat context assembly service."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast
from uuid import UUID
from xml.sax.saxutils import escape as xml_escape

from provider_runtime import CanonicalTool, ChatModelContract, GenerateIntent, ReasoningLevel
from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session

from nexus.auth.permissions import can_read_conversation
from nexus.db.models import (
    ChatRun,
    ChatRunTurnContext,
    Conversation,
    Message,
    MessageRetrieval,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.services.chat_prompt import (
    PromptPlan,
    build_generate_intent_from_plan,
    build_prompt_plan,
    render_system_prompt_block,
    validate_prompt_plan_budget,
    validate_prompt_size,
)
from nexus.services.chat_quote import render_quote_block
from nexus.services.chat_reader_selection import (
    decode_reader_selection_snapshot,
    render_historical_reader_selection_prompt_block,
    render_reader_selection_prompt_block,
    render_subject_metadata_block,
)
from nexus.services.llm_profiles import LlmProfile
from nexus.services.prompt_budget import (
    BudgetItem,
    BudgetSelection,
    PromptBlock,
    allocate_budget,
    build_prompt_budget,
    make_prompt_block,
)
from nexus.services.resource_graph.context import (
    admits_resource_for_conversation_read,
    list_context_refs,
)
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    ResourceScheme,
    parse_resource_ref,
)
from nexus.services.resource_graph.resolve import (
    ResolvedResource,
    resolve_ref,
)
from nexus.services.resource_items.capabilities import (
    resource_can_be_chat_subject,
    resource_citation_result_type,
    resource_prompt_render_policy,
)
from nexus.services.retrieval_citation import RetrievalCitation, citation_from_search_result
from nexus.services.search import get_search_result

CACHE_POLICY_5M: Mapping[str, object] = {"type": "ephemeral", "ttl_seconds": 300}


@dataclass(frozen=True)
class HistoryTurn:
    role: Literal["user", "assistant"]
    content: str


@dataclass(frozen=True)
class HistoryUnit:
    key: str
    turns: tuple[HistoryTurn, ...]
    message_ids: tuple[UUID, ...]
    first_seq: int
    last_seq: int


@dataclass(frozen=True)
class AssemblyLedger:
    cacheable_input_tokens_estimate: int
    prompt_block_manifest: Mapping[str, object]
    max_context_tokens: int
    reserved_output_tokens: int
    reserved_reasoning_tokens: int
    input_budget_tokens: int
    estimated_input_tokens: int
    included_message_ids: tuple[UUID, ...]
    included_retrieval_ids: tuple[UUID, ...]
    included_context_refs: tuple[Mapping[str, object], ...]
    dropped_items: tuple[Mapping[str, object], ...]
    budget_breakdown: Mapping[str, object]


@dataclass(frozen=True)
class ContextAssembly:
    generate_intent: GenerateIntent
    prompt_plan: PromptPlan
    history: tuple[HistoryTurn, ...]
    context_blocks: tuple[str, ...]
    context_types: frozenset[str]
    tool_call_events: tuple[Mapping[str, object], ...]
    retrieval_result_events: tuple[Mapping[str, object], ...]
    ledger: AssemblyLedger
    # Citable attached <resources>, in dense ordinal order (n = index + 1). Built at
    # assembly so n is rendered only for resources whose retrieval row can materialize;
    # the synthetic message_retrievals rows are inserted from these in _execute_chat_run.
    attached_citations: tuple[RetrievalCitation, ...] = ()


def assemble_chat_context(
    db: Session,
    *,
    run: ChatRun,
    profile: LlmProfile,
    reasoning: ReasoningLevel,
    contract: ChatModelContract,
    max_output_tokens: int,
    tools: tuple[CanonicalTool, ...],
) -> ContextAssembly:
    """Assemble the provider-neutral chat request for a durable chat run."""

    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    if conversation is None or user_message is None:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    if not can_read_conversation(db, run.owner_user_id, conversation.id):
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    from nexus.services.conversation_branches import load_message_path

    turn_context = db.get(ChatRunTurnContext, run.id)
    path_messages = load_message_path(
        db,
        conversation_id=conversation.id,
        leaf_message_id=user_message.id,
    )
    path_message_ids = [message.id for message in path_messages if message.id != user_message.id]

    history_units = load_recent_history_units(
        db,
        conversation_id=conversation.id,
        before_seq=user_message.seq,
        path_message_ids=path_message_ids,
    )

    context_types: set[str] = set()
    system_block = make_prompt_block(
        block_id="system",
        role="system",
        lane="system",
        text=render_system_prompt_block(),
        cache_policy=CACHE_POLICY_5M,
        privacy_scope="global",
    )
    mandatory_blocks: list[tuple[str, PromptBlock, Mapping[str, object]]] = []

    current_snapshot = (
        decode_reader_selection_snapshot(user_message.reader_selection_snapshot)
        if user_message.reader_selection_snapshot is not None
        else None
    )
    subject_uri: str | None
    if current_snapshot is not None:
        # Selection-backed turn: <subject> is identity/source metadata and
        # <reader_selection> is the sole quote-text block — both rendered from
        # the immutable snapshot, never the live Highlight. The selection
        # Highlight is excluded (via subject_uri) from generic resource
        # rendering so the canonical quote text appears exactly once.
        subject_uri = ResourceRef(
            scheme="highlight", id=current_snapshot.key.highlight_id
        ).uri
        subject_source_ref = {"role": "subject", "resource_uri": subject_uri}
        mandatory_blocks.append(
            (
                "subject",
                make_prompt_block(
                    block_id=f"subject:{subject_uri}",
                    role="system",
                    lane="attached_context",
                    text=render_subject_metadata_block(current_snapshot),
                    source_refs=[subject_source_ref],
                ),
                subject_source_ref,
            )
        )
        mandatory_blocks.append(
            (
                "reader_selection",
                make_prompt_block(
                    block_id="reader_selection",
                    role="system",
                    lane="attached_context",
                    text=render_reader_selection_prompt_block(current_snapshot),
                    source_refs=[
                        {"type": "media", "id": str(current_snapshot.key.media_id)},
                        {"type": "highlight", "id": str(current_snapshot.key.highlight_id)},
                    ],
                ),
                {"hint": "reader_selection"},
            )
        )
    else:
        subject_block, subject_metadata, subject_uri = _build_subject_block(
            db,
            turn_context,
            viewer_id=run.owner_user_id,
            conversation_id=conversation.id,
        )
        if subject_block is not None:
            mandatory_blocks.append(("subject", subject_block, subject_metadata))

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
                ),
                branch_anchor_ref,
            )
        )

    resources_block, resources_metadata, attached_citations, resource_revision_refs = (
        _build_resources_block(
            db,
            conversation_id=conversation.id,
            viewer_id=run.owner_user_id,
            subject_uri=subject_uri,
        )
    )

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

    current_user_block = make_prompt_block(
        block_id=f"current_user:{user_message.id}",
        role="user",
        lane="current_user",
        text=user_message.content,
        source_refs=[{"type": "message", "id": str(user_message.id)}],
    )
    max_context_tokens = contract.context_limit
    budget = build_prompt_budget(
        max_context_tokens=max_context_tokens,
        max_output_tokens=max_output_tokens,
        reasoning=reasoning,
        reasoning_reserve_tokens=contract.pricing.reasoning_reserve_tokens,
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
    if resources_block is not None:
        budget_items.append(
            BudgetItem(
                key="resources",
                lane="attached_context",
                blocks=(resources_block,),
                mandatory=True,
                metadata=resources_metadata,
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

    selection = allocate_budget(budget_items, budget)
    included_keys = selection.included_keys()
    context_blocks = _selected_context_blocks(
        selection,
        mandatory_blocks=mandatory_blocks,
        resources_block=resources_block,
    )
    selected_history_units = [unit for unit in history_units if unit.key in included_keys]
    history = _history_turns_from_units(selected_history_units)
    stable_blocks = (system_block,)
    dynamic_system_blocks = _dynamic_system_blocks(
        mandatory_blocks=mandatory_blocks,
        resources_block=resources_block,
        included_keys=included_keys,
    )
    history_blocks = _history_blocks(selected_history_units, selection)
    prompt_plan = build_prompt_plan(
        stable_blocks=stable_blocks,
        dynamic_system_blocks=dynamic_system_blocks,
        history_blocks=history_blocks,
        current_user_block=current_user_block,
    )
    estimated_input_tokens = validate_prompt_plan_budget(prompt_plan, budget.input_budget_tokens)
    validate_prompt_size(prompt_plan)

    generate_intent = build_generate_intent_from_plan(
        plan=prompt_plan,
        target=profile.target,
        max_output_tokens=max_output_tokens,
        reasoning=reasoning,
        tools=tools,
    )
    included_context_refs: list[Mapping[str, object]] = [
        metadata for key, _text, metadata in mandatory_blocks if key in included_keys
    ]
    # Resources are not a mandatory_block (own BudgetItem); stamp the consumed
    # revision of each included resource (LI artifacts) into the ledger.
    if "resources" in included_keys:
        included_context_refs.extend(resource_revision_refs)
    ledger = _build_ledger(
        selection,
        prompt_plan=prompt_plan,
        estimated_input_tokens=estimated_input_tokens,
        included_history_units=selected_history_units,
        included_context_refs=included_context_refs,
    )
    return ContextAssembly(
        generate_intent=generate_intent,
        prompt_plan=prompt_plan,
        history=tuple(history),
        context_blocks=tuple(context_blocks),
        context_types=frozenset(context_types),
        tool_call_events=tuple(tool_call_events),
        retrieval_result_events=tuple(retrieval_result_events),
        ledger=ledger,
        attached_citations=attached_citations,
    )


def persist_prompt_assembly(db: Session, *, run: ChatRun, assembly: ContextAssembly) -> None:
    ledger = assembly.ledger
    payload = {
        "chat_run_id": run.id,
        "conversation_id": run.conversation_id,
        "assistant_message_id": run.assistant_message_id,
        "cacheable_input_tokens_estimate": ledger.cacheable_input_tokens_estimate,
        "prompt_block_manifest": dict(ledger.prompt_block_manifest),
        "max_context_tokens": ledger.max_context_tokens,
        "reserved_output_tokens": ledger.reserved_output_tokens,
        "reserved_reasoning_tokens": ledger.reserved_reasoning_tokens,
        "input_budget_tokens": ledger.input_budget_tokens,
        "estimated_input_tokens": ledger.estimated_input_tokens,
        "included_message_ids": [str(message_id) for message_id in ledger.included_message_ids],
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
                cacheable_input_tokens_estimate,
                prompt_block_manifest,
                max_context_tokens,
                reserved_output_tokens,
                reserved_reasoning_tokens,
                input_budget_tokens,
                estimated_input_tokens,
                included_message_ids,
                included_retrieval_ids,
                included_context_refs,
                dropped_items,
                budget_breakdown
            )
            VALUES (
                :chat_run_id,
                :conversation_id,
                :assistant_message_id,
                :cacheable_input_tokens_estimate,
                :prompt_block_manifest,
                :max_context_tokens,
                :reserved_output_tokens,
                :reserved_reasoning_tokens,
                :input_budget_tokens,
                :estimated_input_tokens,
                :included_message_ids,
                :included_retrieval_ids,
                :included_context_refs,
                :dropped_items,
                :budget_breakdown
            )
            """
        ).bindparams(
            bindparam("included_message_ids", type_=JSONB),
            bindparam("included_retrieval_ids", type_=JSONB),
            bindparam("included_context_refs", type_=JSONB),
            bindparam("dropped_items", type_=JSONB),
            bindparam("budget_breakdown", type_=JSONB),
            bindparam("prompt_block_manifest", type_=JSONB),
        )
        result = cast(Any, db.execute(insert_statement, payload))
        assert result.rowcount == 1  # justify-service-invariant-check: ledger insert is one row.
        return

    return


def _build_subject_block(
    db: Session,
    turn_context: ChatRunTurnContext | None,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
) -> tuple[PromptBlock | None, Mapping[str, object], str | None]:
    if turn_context is None or turn_context.subject_id is None:
        return None, {}, None
    assert turn_context.subject_scheme is not None
    subject = ResourceRef(
        scheme=cast(ResourceScheme, turn_context.subject_scheme),
        id=turn_context.subject_id,
    )
    if not resource_can_be_chat_subject(subject):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Resource cannot be a chat subject")
    if not admits_resource_for_conversation_read(
        db,
        conversation_id=conversation_id,
        target=subject,
    ):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "chat_subject resource_ref must be attached to this conversation",
        )

    resource = resolve_ref(db, viewer_id=viewer_id, ref=subject)
    if resource.missing:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Resource not found")

    metadata: dict[str, object] = {"role": "subject", "resource_uri": resource.uri}
    if turn_context.requested_subject_id is not None:
        assert turn_context.requested_subject_scheme is not None
        requested = ResourceRef(
            scheme=cast(ResourceScheme, turn_context.requested_subject_scheme),
            id=turn_context.requested_subject_id,
        )
        metadata["requested_resource_uri"] = requested.uri
    if turn_context.subject_context_edge_id is not None:
        metadata["context_edge_id"] = str(turn_context.subject_context_edge_id)
    if resource.resolved_revision_ref is not None:
        metadata["revision_uri"] = resource.resolved_revision_ref
    return (
        make_prompt_block(
            block_id=f"subject:{resource.uri}",
            role="system",
            lane="attached_context",
            text=_render_resource(resource, tag="subject"),
            source_refs=[metadata],
        ),
        metadata,
        resource.uri,
    )


def _build_resources_block(
    db: Session,
    *,
    conversation_id: UUID,
    viewer_id: UUID,
    subject_uri: str | None = None,
) -> tuple[
    PromptBlock | None,
    Mapping[str, object],
    tuple[RetrievalCitation, ...],
    tuple[Mapping[str, object], ...],
]:
    refs = list_context_refs(db, viewer_id=viewer_id, conversation_id=conversation_id)
    if not refs:
        return None, {}, (), ()
    citations: list[RetrievalCitation] = []
    revision_refs: list[Mapping[str, object]] = []
    lines = ["<resources>"]
    source_refs: list[Mapping[str, object]] = []
    for ctx in refs:
        citation = _materialize_attached_citation(db, ctx.resolved, viewer_id=viewer_id)
        compact = ctx.target.uri == subject_uri
        if citation is None:
            lines.append(_render_resource(ctx.resolved, compact=compact))
        else:
            citations.append(citation)
            lines.append(
                _render_resource(
                    ctx.resolved,
                    n=len(citations),
                    compact=compact,
                    citation=citation,
                )
            )
        source_refs.append(
            {"type": "context_ref", "id": str(ctx.edge_id), "resource_uri": ctx.target.uri}
        )
        if ctx.resolved.resolved_revision_ref is not None:
            revision_refs.append(
                {
                    "type": "context_ref_resolved_revision",
                    "id": str(ctx.edge_id),
                    "resource_uri": ctx.target.uri,
                    "revision_uri": ctx.resolved.resolved_revision_ref,
                }
            )
    lines.append("</resources>")
    block = make_prompt_block(
        block_id=f"resources:{conversation_id}",
        role="system",
        lane="attached_context",
        text="\n".join(lines),
        source_refs=source_refs,
        cache_policy=None,
    )
    uris = [ctx.target.uri for ctx in refs]
    return (
        block,
        {"resource_count": len(uris), "resource_uris": uris},
        tuple(citations),
        tuple(revision_refs),
    )


def _materialize_attached_citation(
    db: Session, resource: ResolvedResource, *, viewer_id: UUID
) -> RetrievalCitation | None:
    """The validated citation for a citable attached resource, or None.

    Citable = a body/quote prompt-render resource AND a durable retrieval row
    materializes via `get_search_result`. Long body resources can still cite:
    `_render_resource` falls back to the retrieval snippet so attached evidence
    does not silently become a label-only container.
    """
    if resource.missing:
        return None
    parsed = parse_resource_ref(resource.uri)
    if isinstance(parsed, ResourceRefParseFailure):
        return None
    if (
        resource.quote is None
        and resource.inline_body is None
        and resource_prompt_render_policy(parsed) not in ("inline_body", "quote")
    ):
        return None
    result_type = resource_citation_result_type(parsed)
    if result_type is None:
        return None
    try:
        result = get_search_result(db, viewer_id, result_type, str(parsed.id))
        citation = citation_from_search_result(result, filters={})
    except (NotFoundError, ValueError):
        # justify-ignore-error: no active content index / no resolvable anchor →
        # the resource stays in the prompt but is not citable (no synthetic row).
        return None
    citation.selected = True
    return citation


def _render_resource(
    resource: ResolvedResource,
    n: int | None = None,
    *,
    tag: Literal["resource", "subject"] = "resource",
    compact: bool = False,
    citation: RetrievalCitation | None = None,
) -> str:
    uri_attr = xml_escape(resource.uri, {'"': "&quot;"})
    if resource.missing:
        return f'<{tag} uri="{uri_attr}" missing="true">resource unavailable</{tag}>'
    label_attr = xml_escape(resource.label, {'"': "&quot;"})
    summary_attr = xml_escape(resource.summary, {'"': "&quot;"})
    fetch_attr = xml_escape(resource.fetch_hint, {'"': "&quot;"})
    parsed = parse_resource_ref(resource.uri)
    if not isinstance(parsed, ResourceRefParseFailure):
        compact = compact or resource_prompt_render_policy(parsed) in (
            "label",
            "none",
        )
    n_attr = f' n="{n}"' if n is not None and not compact else ""
    open_tag = (
        f'<{tag} uri="{uri_attr}"{n_attr} label="{label_attr}" '
        f'summary="{summary_attr}" fetch_hint="{fetch_attr}">'
    )
    if not compact and resource.quote is not None:
        quote = resource.quote
        inner = render_quote_block(
            "quote",
            exact=quote.exact,
            prefix=quote.prefix,
            suffix=quote.suffix,
            source_label=quote.source_label,
            note=quote.note,
        )
        return f"{open_tag}\n{inner}\n</{tag}>"
    if compact:
        return f"{open_tag}</{tag}>"
    if resource.inline_body is None:
        if citation is not None and citation.snippet:
            return f"{open_tag}\n<excerpt>{xml_escape(citation.snippet)}</excerpt>\n</{tag}>"
        return f"{open_tag}</{tag}>"
    body = xml_escape(resource.inline_body)
    return f"{open_tag}\n<body>{body}</body>\n</{tag}>"


def _render_branch_anchor_block(anchor: Mapping[str, object]) -> str:
    prefix = anchor.get("prefix")
    suffix = anchor.get("suffix")
    exact = anchor.get("exact")
    offset_status = anchor.get("offset_status")
    return "The user branched from this selected part of the previous assistant answer.\n" + (
        render_quote_block(
            "assistant_selection",
            exact=exact if isinstance(exact, str) else "",
            prefix=prefix if isinstance(prefix, str) else None,
            suffix=suffix if isinstance(suffix, str) else None,
            offset_status=offset_status if isinstance(offset_status, str) else None,
        )
    )


def load_recent_history_units(
    db: Session,
    *,
    conversation_id: UUID,
    before_seq: int,
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
    if path_message_ids is not None:
        if not path_message_ids:
            return []
        filters.append("id = ANY(:path_message_ids)")
        params["path_message_ids"] = list(path_message_ids)

    rows = db.execute(
        text(
            f"""
            SELECT id, seq, role, content, reader_selection_snapshot
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
                        HistoryTurn(role="user", content=_history_user_content(row)),
                        HistoryTurn(role="assistant", content=next_row[3]),
                    ),
                    message_ids=(row[0], next_row[0]),
                    first_seq=row[1],
                    last_seq=next_row[1],
                )
            )
            index += 2
            continue
        content = (
            _history_user_content(row)
            if row[2] == "user"
            else row[3]
        )
        units.append(
            HistoryUnit(
                key=f"history_single:{row[1]}",
                turns=(
                    HistoryTurn(role=cast(Literal["user", "assistant"], row[2]), content=content),
                ),
                message_ids=(row[0],),
                first_seq=row[1],
                last_seq=row[1],
            )
        )
        index += 1
    return units


def _history_user_content(row: Any) -> str:
    """A historical user turn, prefixed with its bounded
    `<historical_reader_selection>` block when the message carries a quote
    snapshot. The block applies only to the immediately following user text, and
    the whole unit stays one indivisible history turn for the budget."""
    snapshot_raw = row[4]
    if snapshot_raw is None:
        return row[3]
    snapshot = decode_reader_selection_snapshot(snapshot_raw)
    return f"{render_historical_reader_selection_prompt_block(snapshot)}\n\n{row[3]}"


def _load_tool_events(
    db: Session,
    *,
    assistant_message_id: UUID,
) -> tuple[list[Mapping[str, object]], list[Mapping[str, object]]]:
    rows = db.execute(
        text(
            """
            SELECT id, assistant_message_id, tool_name, tool_call_index, scope,
                   requested_types, status, error_code, latency_ms
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
                "status": row[6],
                "scope": row[4],
                "types": row[5] or [],
            }
        )
        result_events.append(
            {
                "tool_call_id": str(row[0]),
                "assistant_message_id": str(row[1]),
                "tool_name": row[2],
                "tool_call_index": row[3],
                "status": row[6],
                "error_code": row[7],
                "result_count": len(retrievals),
                "selected_count": len(selected),
                "latency_ms": row[8],
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
    resources_block: PromptBlock | None,
) -> list[str]:
    included_keys = selection.included_keys()
    blocks: list[str] = []
    for key, block, _metadata in mandatory_blocks:
        if key in included_keys and block.lane == "attached_context":
            blocks.append(block.text)
    if resources_block is not None and "resources" in included_keys:
        blocks.append(resources_block.text)
    return blocks


def _dynamic_system_blocks(
    *,
    mandatory_blocks: Sequence[tuple[str, PromptBlock, Mapping[str, object]]],
    resources_block: PromptBlock | None,
    included_keys: set[str],
) -> tuple[PromptBlock, ...]:
    blocks: list[PromptBlock] = []
    for key, block, _metadata in mandatory_blocks:
        if key in included_keys:
            blocks.append(block)
    if resources_block is not None and "resources" in included_keys:
        blocks.append(resources_block)
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


def _history_turns_from_units(units: Sequence[HistoryUnit]) -> list[HistoryTurn]:
    turns: list[HistoryTurn] = []
    for unit in sorted(units, key=lambda candidate: candidate.first_seq):
        turns.extend(unit.turns)
    return turns


def _build_ledger(
    selection: BudgetSelection,
    *,
    prompt_plan: PromptPlan,
    estimated_input_tokens: int,
    included_history_units: Sequence[HistoryUnit],
    included_context_refs: Sequence[Mapping[str, object]],
) -> AssemblyLedger:
    return AssemblyLedger(
        cacheable_input_tokens_estimate=prompt_plan.cacheable_input_tokens_estimate,
        prompt_block_manifest=prompt_plan.manifest(),
        max_context_tokens=selection.budget.max_context_tokens,
        reserved_output_tokens=selection.budget.reserved_output_tokens,
        reserved_reasoning_tokens=selection.budget.reserved_reasoning_tokens,
        input_budget_tokens=selection.budget.input_budget_tokens,
        estimated_input_tokens=estimated_input_tokens,
        included_message_ids=tuple(
            message_id for unit in included_history_units for message_id in unit.message_ids
        ),
        included_retrieval_ids=(),
        included_context_refs=tuple(included_context_refs),
        dropped_items=tuple(item.to_json() for item in selection.dropped),
        budget_breakdown=selection.breakdown,
    )
