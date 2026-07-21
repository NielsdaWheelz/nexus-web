"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming via ``llm_execution.
execute_generation_stream`` (the sole generation boundary); the stream route
only tails persisted events.
"""

from __future__ import annotations

import asyncio
import dataclasses
import time
from collections.abc import AsyncGenerator, Mapping
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID, uuid4

from provider_runtime import (
    CATALOG,
    Absent,
    AssistantMessage,
    Cancelled,
    CancelSignal,
    CanonicalTool,
    ChatModelContract,
    ContinuationArtifact,
    ContinuationDelta,
    Failed,
    Incomplete,
    Presence,
    Present,
    PromptMessage,
    ReasoningLevel,
    RuntimeStreamEvent,
    StreamStart,
    Succeeded,
    TerminalEvent,
    TextDelta,
    ToolCall,
    ToolCallDelta,
    ToolCallDone,
    ToolCallStart,
    ToolResultMessage,
    UsageEvent,
    failure_code,
    failure_origin,
    parse_canonical_schema,
)
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker
from web_search_tool.types import WebSearchProvider

from nexus.config import Settings
from nexus.db.models import (
    ChatRun,
    ChatRunTurnContext,
    Conversation,
    Message,
)
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
    exception_error_detail,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.conversation import (
    CHAT_RUN_STATUS_FILTER,
    BranchAnchorRequest,
    ChatRunResponse,
    ChatSubjectRequest,
    ReaderSelectionRequest,
)
from nexus.services.agent_tools.app_search import (
    APP_SEARCH_TOOL_DEFINITION,
    APP_SEARCH_TOOL_NAME,
    execute_app_search,
)
from nexus.services.agent_tools.inspect_resource import (
    INSPECT_RESOURCE_TOOL_DEFINITION,
    INSPECT_RESOURCE_TOOL_NAME,
    execute_inspect_resource,
)
from nexus.services.agent_tools.read_resource import (
    READ_RESOURCE_TOOL_DEFINITION,
    READ_RESOURCE_TOOL_NAME,
    execute_read_resource,
)
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_DEFINITION,
    WEB_SEARCH_TOOL_NAME,
    execute_web_search,
)
from nexus.services.agent_tools.writes import (
    WRITE_TOOL_NAMES,
    assistant_write_tool_definitions,
    execute_write_tool,
)
from nexus.services.chat_run_access import get_run_for_owner
from nexus.services.chat_run_citations import (
    clear_message_citations,
    emit_citation_index,
    persist_attached_citations,
    persist_read_evidence_citation,
    record_tool_citations,
)
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    ChatRunEventEmitter,
    has_provider_output_without_terminal,
    is_cancel_requested,
    mark_running,
)
from nexus.services.chat_run_finalize import (
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
    finalize_cancelled,
    finalize_defect,
    finalize_interrupted,
    finalize_run,
)
from nexus.services.chat_run_idempotency import (
    compute_payload_hash,
    get_run_by_idempotency_key,
    lock_idempotency_key,
    normalize_idempotency_key,
    raise_if_payload_mismatch,
)
from nexus.services.chat_run_message_prep import prepare_messages
from nexus.services.chat_run_prompt_tracking import reconcile_prompt_retrievals
from nexus.services.chat_run_response import build_chat_run_response
from nexus.services.chat_run_tools import (
    app_search_tool_output,
    bind_provider_tool_call_events,
    persist_tool_call_error,
    persist_tool_call_start,
    persist_tool_call_trace,
    tool_start_event,
    tool_trace_event,
    web_search_tool_output,
)
from nexus.services.chat_run_usage import usage_provider_json
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.context_assembler import (
    assemble_chat_context,
    persist_prompt_assembly,
)
from nexus.services.llm_execution import (
    ExecutionRuntime,
    GenerationRequest,
    execute_generation_stream,
)
from nexus.services.llm_ledger import LlmCallOwner
from nexus.services.llm_profiles import LlmProfile
from nexus.services.llm_profiles import profile as lookup_profile
from nexus.services.llm_profiles import reasoning_level as lookup_reasoning_level
from nexus.services.prompt_budget import ContextBudgetError
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.resource_graph.context import (
    add_context_ref_without_commit,
)
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_items.chat_subjects import resolve_chat_subject

logger = get_logger(__name__)


REASONING_OUTPUT_TOKENS = 25000
DEFAULT_OUTPUT_TOKENS = 4096
MAX_TOOL_ITERATIONS = 8
CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048
CHAT_CANCEL_POLL_INTERVAL_SECONDS = 0.25


def _chat_tool_specs() -> tuple[CanonicalTool, ...]:
    """The read-only tools plus the assistant write tools when enabled (AC-6),
    compiled to the runtime's canonical JSON-Schema subset exactly once here —
    the sole LLM-boundary schema compile site for chat."""
    definitions: list[tuple[str, str, Mapping[str, Any]]] = [
        (
            APP_SEARCH_TOOL_NAME,
            APP_SEARCH_TOOL_DEFINITION["description"],
            APP_SEARCH_TOOL_DEFINITION["parameters"],
        ),
        (
            WEB_SEARCH_TOOL_NAME,
            WEB_SEARCH_TOOL_DEFINITION["description"],
            WEB_SEARCH_TOOL_DEFINITION["parameters"],
        ),
        (
            READ_RESOURCE_TOOL_NAME,
            READ_RESOURCE_TOOL_DEFINITION["description"],
            READ_RESOURCE_TOOL_DEFINITION["parameters"],
        ),
        (
            INSPECT_RESOURCE_TOOL_NAME,
            INSPECT_RESOURCE_TOOL_DEFINITION["description"],
            INSPECT_RESOURCE_TOOL_DEFINITION["parameters"],
        ),
    ]
    definitions.extend(
        (definition["name"], definition["description"], definition["parameters"])
        for definition in assistant_write_tool_definitions()
    )
    return tuple(
        CanonicalTool(
            name=name,
            description=description,
            parameters=parse_canonical_schema(parameters),
        )
        for name, description, parameters in definitions
    )


def _app_search_scopes_from_tool_args(args: Mapping[str, Any]) -> tuple[list[str], str | None]:
    if "scope" in args:
        return (
            [],
            "app_search uses scopes=[...] for URI scopes; the singular scope field is invalid",
        )

    raw_scopes = args.get("scopes")
    if raw_scopes is None:
        return [], None
    if not isinstance(raw_scopes, list):
        return [], "app_search scopes must be an array of URI strings"

    scopes: list[str] = []
    for scope in raw_scopes:
        if not isinstance(scope, str):
            return [], "app_search scopes must be an array of URI strings"
        normalized_scope = scope.strip()
        if not normalized_scope:
            return [], "app_search scopes must be non-empty URI strings"
        scopes.append(normalized_scope)
    return scopes, None


def _app_search_string_array_from_tool_args(
    args: Mapping[str, Any], key: str
) -> tuple[list[str] | None, str | None]:
    raw = args.get(key)
    if raw is None:
        return None, None
    if not isinstance(raw, list):
        return None, f"app_search {key} must be an array of strings"
    values: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            return None, f"app_search {key} must be an array of strings"
        value = item.strip()
        if value:
            values.append(value)
    return (values or None), None


def _max_output_tokens_for_reasoning(contract: ChatModelContract, reasoning: ReasoningLevel) -> int:
    if reasoning != "none" and contract.pricing.reasoning_reserve_tokens > 0:
        return min(REASONING_OUTPUT_TOKENS, contract.output_limit)
    return min(DEFAULT_OUTPUT_TOKENS, contract.output_limit)


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    chat_subject: ChatSubjectRequest | None,
    reader_selection: ReaderSelectionRequest | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    profile_id: str,
    reasoning_option_id: str,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    requested_subject_ref = _parse_chat_subject(chat_subject)
    resolved_subject = (
        resolve_chat_subject(db, viewer_id=viewer_id, requested_ref=requested_subject_ref)
        if requested_subject_ref is not None
        else None
    )
    subject_ref = resolved_subject.subject_ref if resolved_subject is not None else None

    payload_hash = compute_payload_hash(
        content,
        profile_id,
        reasoning_option_id,
        conversation_id,
        parent_message_id,
        branch_anchor,
        requested_subject_ref,
        subject_ref,
        reader_selection,
    )

    existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
    if existing is not None:
        raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
        return build_chat_run_response(db, viewer_id, existing)

    # Validates profile/reasoning via llm_profiles, entitlement/rate-limit
    # preflight (fast-fail at POST) — the returned facts are re-resolved from
    # the persisted snapshot at execution time, not threaded through here.
    validate_pre_phase(
        db,
        viewer_id,
        conversation_id,
        parent_message_id,
        branch_anchor,
        subject_ref,
        reader_selection,
        content,
        profile_id,
        reasoning_option_id,
    )

    try:
        lock_idempotency_key(db, viewer_id, normalized_key)
        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        subject_context_edge_id: UUID | None = None
        if resolved_subject is not None:
            for ref in resolved_subject.context_refs:
                context_ref = add_context_ref_without_commit(
                    db,
                    viewer_id=viewer_id,
                    conversation_id=conversation_id,
                    target=ref,
                    origin="user" if ref == resolved_subject.subject_ref else "system",
                )
                if ref == resolved_subject.subject_ref:
                    subject_context_edge_id = context_ref.edge_id
        if reader_selection is not None and (
            resolved_subject is None or resolved_subject.subject_ref.scheme != "highlight"
        ):
            add_context_ref_without_commit(
                db,
                viewer_id=viewer_id,
                conversation_id=conversation_id,
                target=ResourceRef(scheme="highlight", id=reader_selection.highlight_id),
                origin="user",
            )

        prepared = prepare_messages(
            db,
            viewer_id,
            conversation_id,
            parent_message_id,
            branch_anchor,
            content,
        )
        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=prepared.conversation.id,
            user_message_id=prepared.user_message.id,
            assistant_message_id=prepared.assistant_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            profile_id=profile_id,
            reasoning_option_id=reasoning_option_id,
        )
        db.add(run)
        db.flush()
        if subject_ref is not None or reader_selection is not None:
            db.add(
                ChatRunTurnContext(
                    chat_run_id=run.id,
                    requested_subject_scheme=(
                        requested_subject_ref.scheme if requested_subject_ref else None
                    ),
                    requested_subject_id=requested_subject_ref.id
                    if requested_subject_ref
                    else None,
                    subject_scheme=subject_ref.scheme if subject_ref else None,
                    subject_id=subject_ref.id if subject_ref else None,
                    subject_context_edge_id=subject_context_edge_id,
                    reader_selection_media_id=(
                        reader_selection.media_id if reader_selection is not None else None
                    ),
                    reader_selection_highlight_id=(
                        reader_selection.highlight_id if reader_selection is not None else None
                    ),
                )
            )
        ChatRunEventEmitter(db, run).meta(
            {
                "run_id": str(run.id),
                "conversation_id": str(prepared.conversation.id),
                "user_message_id": str(prepared.user_message.id),
                "assistant_message_id": str(prepared.assistant_message.id),
                "profile_id": profile_id,
                "reasoning_option_id": reasoning_option_id,
                "chat_subject": (
                    {
                        "requested_resource_ref": resolved_subject.requested_ref.uri,
                        "resource_ref": resolved_subject.subject_ref.uri,
                        "context_edge_id": (
                            str(subject_context_edge_id)
                            if subject_context_edge_id is not None
                            else None
                        ),
                        "companions": [ref.uri for ref in resolved_subject.companion_refs],
                    }
                    if resolved_subject is not None
                    else None
                ),
            }
        )
        enqueue_job(
            db,
            kind="chat_run",
            payload={"run_id": str(run.id)},
            priority=50,
            max_attempts=3,
            dedupe_key=f"chat_run:{run.id}",
        )
        db.commit()
    except Exception:
        db.rollback()
        raise

    return build_chat_run_response(db, viewer_id, run)


def _parse_chat_subject(chat_subject: ChatSubjectRequest | None) -> ResourceRef | None:
    if chat_subject is None:
        return None
    parsed = parse_resource_ref(chat_subject.resource_ref)
    if isinstance(parsed, ResourceRefParseFailure):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "chat_subject.resource_ref is invalid")
    return parsed


def get_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    run = get_run_for_owner(db, viewer_id, run_id)
    return build_chat_run_response(db, viewer_id, run)


def list_chat_runs_for_conversation(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID,
    status: CHAT_RUN_STATUS_FILTER,
) -> list[ChatRunResponse]:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    # "active" means non-terminal; every other value is an exact status match. The
    # filter vocabulary is validated once at the boundary by CHAT_RUN_STATUS_FILTER.
    if status == "active":
        filters = [ChatRun.status.notin_(TERMINAL_RUN_STATUSES)]
    else:
        filters = [ChatRun.status == status]

    runs = (
        db.execute(
            select(ChatRun)
            .where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.conversation_id == conversation_id,
                *filters,
            )
            .order_by(ChatRun.created_at.asc(), ChatRun.id.asc())
        )
        .scalars()
        .all()
    )
    return [build_chat_run_response(db, viewer_id, run) for run in runs]


def cancel_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    run = get_run_for_owner(db, viewer_id, run_id)
    if run.status not in TERMINAL_RUN_STATUSES and run.cancel_requested_at is None:
        run.cancel_requested_at = datetime.now(UTC)
        run.updated_at = datetime.now(UTC)
        db.commit()
        logger.info(
            "chat_run.cancel_requested",
            **safe_kv(chat_run_id=str(run.id), status=run.status),
        )
    return build_chat_run_response(db, viewer_id, run)


def assert_chat_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    get_run_for_owner(db, viewer_id, run_id)


async def _watch_chat_run_cancel(
    db: Session, *, run_id: UUID, cancel_signal: asyncio.Event
) -> None:
    # justify-polling: cancel_requested_at is an UPDATE on the run row, while the
    # existing SSE push channel only notifies appended event rows. This watcher is
    # scoped to one active provider stream and exits as soon as the stream ends.
    while not cancel_signal.is_set():
        if is_cancel_requested(db, run_id):
            cancel_signal.set()
            return
        await asyncio.sleep(CHAT_CANCEL_POLL_INTERVAL_SECONDS)


def _latest_generation_support_id(db: Session, run_id: UUID) -> str | None:
    """`llm_ledger._support_id`'s derivation (``generation_id.hex[:12]``),
    re-derived from the run's most recent llm_calls row — the terminal fold
    only receives the runtime's own ``RuntimeStreamEvent`` envelopes, which
    carry no generation id, so the ledger identity is read back here."""
    generation_id = db.execute(
        text(
            "SELECT id FROM llm_calls WHERE owner_kind = 'chat_run' AND owner_id = :run_id "
            "ORDER BY call_seq DESC LIMIT 1"
        ),
        {"run_id": run_id},
    ).scalar_one_or_none()
    return generation_id.hex[:12] if generation_id is not None else None


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    settings: Settings,
    web_search_provider: WebSearchProvider | None = None,
) -> dict[str, str]:
    flow_id = str(run_id)
    set_flow_id(flow_id)
    try:
        return await _execute_chat_run(
            db,
            run_id=run_id,
            session_factory=session_factory,
            runtime=runtime,
            settings=settings,
            web_search_provider=web_search_provider,
        )
    except Exception as exc:  # justify-ignore-error: chat-run worker boundary; finalize as a generic defect and report.
        logger.exception("chat_run.unhandled_error", run_id=str(run_id), error=str(exc))
        try:
            finalize_defect(db, run_id=run_id, error_detail=exception_error_detail(exc))
            return {"status": "error", "error_code": "defect"}
        except Exception:
            db.rollback()
            raise
    finally:
        set_flow_id(None)


async def _execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    session_factory: sessionmaker[Session],
    runtime: ExecutionRuntime,
    settings: Settings,
    web_search_provider: WebSearchProvider | None = None,
) -> dict[str, str]:
    run = db.get(ChatRun, run_id)
    if run is None:
        return {"status": "skipped", "reason": "run_not_found"}
    if run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}

    if has_provider_output_without_terminal(db, run.id):
        finalize_interrupted(db, run, session_factory=session_factory)
        return {"status": "error", "error_code": "stream_interrupted"}

    profile: LlmProfile | None = (
        lookup_profile(run.profile_id) if run.profile_id is not None else None
    )
    if profile is None:
        finalize_defect(db, run_id=run.id, error_detail="run profile_id is missing or unknown")
        return {"status": "error", "error_code": "defect"}
    reasoning = (
        lookup_reasoning_level(profile, run.reasoning_option_id)
        if run.reasoning_option_id is not None
        else None
    )
    if reasoning is None:
        finalize_defect(
            db, run_id=run.id, error_detail="run reasoning_option_id is missing or unsupported"
        )
        return {"status": "error", "error_code": "defect"}

    contract = CATALOG.chat_contract(profile.target)
    max_output_tokens = _max_output_tokens_for_reasoning(contract, reasoning)

    mark_running(db, run.id)
    run = db.get(ChatRun, run.id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}
    if run.cancel_requested_at is not None:
        finalize_cancelled(db, run)
        return {"status": "cancelled"}

    emitter = ChatRunEventEmitter(db, run)
    rate_limiter = get_rate_limiter()
    rate_limiter.acquire_inflight_slot(run.owner_user_id)
    # Bound unconditionally before any call that can raise (incl. ApiError
    # from execute_generation_stream) so the exception handler below can
    # always read them.
    full_content = ""
    last_provider_event_seq: int | None = None
    stream_started_at = time.monotonic()
    first_provider_event_ms: int | None = None
    first_visible_text_ms: int | None = None
    provider_event_count = 0
    durable_flush_count = 0
    stream_observed_logged = False

    def log_stream_observed(*, status: str, error_code: str | None, terminal_cause: str) -> None:
        nonlocal stream_observed_logged
        if stream_observed_logged:
            return
        stream_observed_logged = True
        cancel_requested_at = db.execute(
            select(ChatRun.cancel_requested_at).where(ChatRun.id == run.id)
        ).scalar_one_or_none()
        cancel_latency_ms = (
            max(0, int((datetime.now(UTC) - cancel_requested_at).total_seconds() * 1000))
            if cancel_requested_at is not None
            else None
        )
        logger.info(
            "chat_run.stream.finished",
            **safe_kv(
                chat_run_id=str(run.id),
                status=status,
                error_code=error_code,
                terminal_cause=terminal_cause,
                first_provider_event_ms=first_provider_event_ms,
                first_visible_text_ms=first_visible_text_ms,
                provider_event_count=provider_event_count,
                durable_flush_count=durable_flush_count,
                cancel_latency_ms=cancel_latency_ms,
            ),
        )

    try:
        conversation = db.get(Conversation, run.conversation_id)
        user_message = db.get(Message, run.user_message_id)
        if conversation is None or user_message is None:
            finalize_run(
                db,
                run_id=run.id,
                assistant_content="",
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=None,
                support_id=uuid4().hex[:12],
                error_detail="Conversation not found.",
            )
            return {"status": "error", "error_code": "defect"}

        if is_cancel_requested(db, run.id):
            finalize_cancelled(db, run)
            return {"status": "cancelled"}

        tools = _chat_tool_specs()
        try:
            assembly = assemble_chat_context(
                db,
                run=run,
                profile=profile,
                reasoning=reasoning,
                contract=contract,
                max_output_tokens=max_output_tokens,
                tools=tools,
            )
            persist_prompt_assembly(db, run=run, assembly=assembly)
            reconcile_prompt_retrievals(db, run=run, assembly=assembly)
            persist_attached_citations(db, run, assembly.attached_citations)
            db.commit()
        except ContextBudgetError as exc:
            logger.warning(
                "chat_run.context_budget_exceeded",
                run_id=str(run.id),
                lane=exc.lane,
                item_key=exc.item_key,
                requested_tokens=exc.requested_tokens,
                remaining_tokens=exc.remaining_tokens,
            )
            # Owner-side assembly rejected the intent before any generation
            # attempt began (the intent is eager) — ledgerless expected
            # failure, origin=intent, no llm_calls row.
            finalize_run(
                db,
                run_id=run.id,
                assistant_content="",
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code="context_too_large",
                error_origin="intent",
                support_id=uuid4().hex[:12],
                error_detail=exception_error_detail(exc),
            )
            return {"status": "error", "error_code": "context_too_large"}

        call_owner = LlmCallOwner(kind="chat_run", id=run.id, user_id=run.owner_user_id)
        base_intent = assembly.generate_intent
        messages: list[PromptMessage] = list(base_intent.messages)
        final_usage: Presence[object] = Absent()
        citation_n_next = len(assembly.attached_citations) + 1
        tool_call_index_next = 0
        locally_truncated = False

        def flush_text_buffer(
            text_buffer: str,
            text_seq_start: int | None,
            text_seq_end: int,
            last_text_flush: float,
        ) -> tuple[str, int | None, float]:
            nonlocal durable_flush_count
            if not text_buffer:
                return text_buffer, text_seq_start, last_text_flush
            emitter.assistant_text_delta(
                text=text_buffer,
                provider_event_seq_start=text_seq_start or text_seq_end,
                provider_event_seq_end=text_seq_end,
            )
            durable_flush_count += 1
            return "", None, time.monotonic()

        for _iteration in range(MAX_TOOL_ITERATIONS):
            iter_text = ""
            pending_tool_calls: list[ToolCall] = []
            continuation: Presence[ContinuationArtifact] = Absent()
            provider_tool_indices: dict[str, int] = {}
            tool_names_by_call_id: dict[str, str] = {}
            text_buffer = ""
            text_seq_start: int | None = None
            text_seq_end = 0
            last_text_flush = time.monotonic()
            activity_started = False

            iter_intent = dataclasses.replace(base_intent, messages=tuple(messages))
            req = GenerationRequest(
                owner=call_owner,
                operation="chat",
                profile=profile,
                reasoning=reasoning,
                intent=iter_intent,
            )
            cancel_signal = asyncio.Event()
            cancel_watcher = asyncio.create_task(
                _watch_chat_run_cancel(db, run_id=run.id, cancel_signal=cancel_signal)
            )
            stream = execute_generation_stream(
                req,
                session_factory=session_factory,
                runtime=runtime,
                settings=settings,
                cancel=cast(CancelSignal, cancel_signal),
            )
            terminal_outcome: object | None = None
            try:
                async for event in stream:
                    provider_event_count += 1
                    if first_provider_event_ms is None:
                        first_provider_event_ms = int((time.monotonic() - stream_started_at) * 1000)
                    last_provider_event_seq = event.seq
                    inner = event.event
                    if isinstance(inner, StreamStart):
                        if not activity_started:
                            activity_started = True
                            emitter.assistant_activity(
                                phase="thinking",
                                provider_event_seq_start=event.seq,
                                provider_event_seq_end=event.seq,
                            )
                        continue
                    if isinstance(inner, TextDelta):
                        delta = inner.text
                        if not locally_truncated:
                            if len(full_content) + len(delta) > MAX_ASSISTANT_CONTENT_LENGTH:
                                remaining = MAX_ASSISTANT_CONTENT_LENGTH - len(full_content)
                                delta = delta[: max(remaining, 0)] + TRUNCATION_NOTICE
                            if delta:
                                if first_visible_text_ms is None:
                                    first_visible_text_ms = int(
                                        (time.monotonic() - stream_started_at) * 1000
                                    )
                                full_content += delta
                                iter_text += delta
                                text_buffer += delta
                                text_seq_start = text_seq_start or event.seq
                                text_seq_end = event.seq
                                if (
                                    len(text_buffer) >= CHAT_TEXT_FLUSH_MAX_CHARS
                                    or len(text_buffer.encode("utf-8")) >= CHAT_TEXT_FLUSH_MAX_BYTES
                                    or (time.monotonic() - last_text_flush) * 1000
                                    >= CHAT_TEXT_FLUSH_INTERVAL_MS
                                ):
                                    text_buffer, text_seq_start, last_text_flush = (
                                        flush_text_buffer(
                                            text_buffer,
                                            text_seq_start,
                                            text_seq_end,
                                            last_text_flush,
                                        )
                                    )
                            if len(full_content) >= MAX_ASSISTANT_CONTENT_LENGTH:
                                locally_truncated = True
                                text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                    text_buffer, text_seq_start, text_seq_end, last_text_flush
                                )
                                cancel_signal.set()
                        continue
                    if isinstance(inner, ToolCallStart):
                        text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                            text_buffer, text_seq_start, text_seq_end, last_text_flush
                        )
                        tool_names_by_call_id[inner.call_id] = inner.name
                        if inner.call_id not in provider_tool_indices:
                            provider_tool_indices[inner.call_id] = (
                                tool_call_index_next + len(provider_tool_indices) + 1
                            )
                        index = provider_tool_indices[inner.call_id]
                        emitter.tool_call_start(
                            tool_name=inner.name,
                            tool_call_index=index,
                            provider_tool_call_id=inner.call_id,
                            provider_event_seq_start=event.seq,
                            provider_event_seq_end=event.seq,
                        )
                        continue
                    if isinstance(inner, ToolCallDelta):
                        text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                            text_buffer, text_seq_start, text_seq_end, last_text_flush
                        )
                        if inner.call_id not in provider_tool_indices:
                            provider_tool_indices[inner.call_id] = (
                                tool_call_index_next + len(provider_tool_indices) + 1
                            )
                        index = provider_tool_indices[inner.call_id]
                        emitter.tool_call_delta(
                            tool_name=tool_names_by_call_id[inner.call_id],
                            tool_call_index=index,
                            provider_tool_call_id=inner.call_id,
                            input_delta=inner.arguments_delta,
                            input_preview=None,
                            provider_event_seq_start=event.seq,
                            provider_event_seq_end=event.seq,
                        )
                        continue
                    if isinstance(inner, ToolCallDone):
                        text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                            text_buffer, text_seq_start, text_seq_end, last_text_flush
                        )
                        tc = inner.tool_call
                        tool_names_by_call_id[tc.id] = tc.name
                        if tc.id not in provider_tool_indices:
                            provider_tool_indices[tc.id] = (
                                tool_call_index_next + len(provider_tool_indices) + 1
                            )
                        index = provider_tool_indices[tc.id]
                        pending_tool_calls.append(tc)
                        emitter.tool_call_done(
                            tool_name=tc.name,
                            tool_call_index=index,
                            provider_tool_call_id=tc.id,
                            input=dict(tc.arguments),
                            provider_event_seq_start=event.seq,
                            provider_event_seq_end=event.seq,
                        )
                        continue
                    if isinstance(inner, ContinuationDelta):
                        # AT MOST ONE per stream; REPLACES the slot; never
                        # mapped to chat events, persisted, or logged.
                        continuation = Present(inner.artifact)
                        continue
                    if isinstance(inner, UsageEvent):
                        # Progressive telemetry only; the ledger source is the
                        # terminal's meta.usage, folded below.
                        continue
                    if isinstance(inner, TerminalEvent):
                        text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                            text_buffer, text_seq_start, text_seq_end, last_text_flush
                        )
                        terminal_outcome = inner.outcome
                        break
            finally:
                cancel_watcher.cancel()
                with suppress(asyncio.CancelledError):
                    await cancel_watcher
                await cast(AsyncGenerator[RuntimeStreamEvent, None], stream).aclose()

            if terminal_outcome is None:
                # justify-defect: execute_generation_stream's contract guarantees
                # exactly one terminal before the generator ends; a generator
                # that ended without one is a broken runtime invariant.
                raise AssertionError("execute_generation_stream ended without a terminal event")

            if isinstance(terminal_outcome, Cancelled):
                usage = usage_provider_json(terminal_outcome.meta.usage)
                if locally_truncated:
                    finalize_run(
                        db,
                        run_id=run.id,
                        assistant_content=full_content,
                        assistant_status="error",
                        run_status="error",
                        done_status="error",
                        error_code="incomplete",
                        error_origin="provider_response",
                        support_id=_latest_generation_support_id(db, run.id),
                        usage=usage,
                        last_provider_event_seq=last_provider_event_seq,
                    )
                    log_stream_observed(
                        status="error", error_code="incomplete", terminal_cause="local_truncation"
                    )
                    return {"status": "error", "error_code": "incomplete"}
                finalize_cancelled(
                    db,
                    run,
                    assistant_content=full_content,
                    usage=usage,
                    last_provider_event_seq=last_provider_event_seq,
                )
                log_stream_observed(status="cancelled", error_code=None, terminal_cause="cancelled")
                return {"status": "cancelled"}

            if isinstance(terminal_outcome, Incomplete):
                usage = usage_provider_json(terminal_outcome.meta.usage)
                support_id = _latest_generation_support_id(db, run.id)
                if terminal_outcome.status == "refused":
                    # Refusal fold: finalize assistant_content="" — the live
                    # tail clears text; refused runs are excluded from
                    # continuation assembly.
                    finalize_run(
                        db,
                        run_id=run.id,
                        assistant_content="",
                        assistant_status="error",
                        run_status="error",
                        done_status="error",
                        error_code="refused",
                        error_origin="provider_stream",
                        support_id=support_id,
                        usage=usage,
                        last_provider_event_seq=last_provider_event_seq,
                    )
                    log_stream_observed(
                        status="error", error_code="refused", terminal_cause="refused"
                    )
                    return {"status": "error", "error_code": "refused"}
                finalize_run(
                    db,
                    run_id=run.id,
                    assistant_content=full_content,
                    assistant_status="error",
                    run_status="error",
                    done_status="error",
                    error_code="incomplete",
                    error_origin="provider_response",
                    support_id=support_id,
                    usage=usage,
                    last_provider_event_seq=last_provider_event_seq,
                )
                log_stream_observed(
                    status="error", error_code="incomplete", terminal_cause="incomplete"
                )
                return {"status": "error", "error_code": "incomplete"}

            if isinstance(terminal_outcome, Failed):
                origin = failure_origin(terminal_outcome.failure)
                code = failure_code(terminal_outcome.failure)
                finalize_run(
                    db,
                    run_id=run.id,
                    assistant_content=full_content,
                    assistant_status="error",
                    run_status="error",
                    done_status="error",
                    error_code=code,
                    error_origin=origin,
                    support_id=_latest_generation_support_id(db, run.id),
                    usage=usage_provider_json(terminal_outcome.meta.usage),
                    last_provider_event_seq=last_provider_event_seq,
                )
                log_stream_observed(status="error", error_code=code, terminal_cause="failed")
                return {"status": "error", "error_code": code}

            assert isinstance(terminal_outcome, Succeeded)
            final_usage = terminal_outcome.meta.usage
            if not pending_tool_calls:
                break

            messages.append(
                AssistantMessage(
                    text=iter_text, tool_calls=tuple(pending_tool_calls), continuation=continuation
                )
            )
            tool_results: list[ToolResultMessage] = []
            for tc in pending_tool_calls:
                tool_call_index_next += 1
                if tc.name == APP_SEARCH_TOOL_NAME:
                    args = tc.arguments
                    scopes, forced_error = _app_search_scopes_from_tool_args(args)
                    kinds, filter_error = _app_search_string_array_from_tool_args(args, "kinds")
                    forced_error = forced_error or filter_error
                    formats, filter_error = _app_search_string_array_from_tool_args(args, "formats")
                    forced_error = forced_error or filter_error
                    authors, filter_error = _app_search_string_array_from_tool_args(args, "authors")
                    forced_error = forced_error or filter_error
                    roles, filter_error = _app_search_string_array_from_tool_args(args, "roles")
                    forced_error = forced_error or filter_error
                    app_tool_call_id = persist_tool_call_start(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=APP_SEARCH_TOOL_NAME,
                        scope="all",
                        requested_types=[],
                    )
                    bind_provider_tool_call_events(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_call_id=app_tool_call_id,
                    )
                    emitter.tool_result(
                        tool_start_event(
                            run=run,
                            tool_call_id=app_tool_call_id,
                            tool_call_index=tool_call_index_next,
                            tool_name=APP_SEARCH_TOOL_NAME,
                            scope="all",
                            types=[],
                            filters={},
                        )
                    )
                    db.commit()
                    run_result = execute_app_search(
                        db,
                        viewer_id=run.owner_user_id,
                        conversation_id=run.conversation_id,
                        user_message_id=run.user_message_id,
                        assistant_message_id=run.assistant_message_id,
                        scopes=scopes,
                        query=str(args.get("query") or ""),
                        kinds=kinds,
                        formats=formats,
                        authors=authors,
                        roles=roles,
                        tool_call_index=tool_call_index_next,
                        forced_error=forced_error,
                    )
                    assert run_result.tool_call_id is not None
                    start_n = citation_n_next
                    citation_n_next = record_tool_citations(
                        db,
                        run=run,
                        tool_call_id=run_result.tool_call_id,
                        start_ordinal=citation_n_next,
                    )
                    emitter.tool_result(
                        {
                            **run_result.tool_call_event(),
                            **run_result.retrieval_result_event(),
                            "status": run_result.status,
                            "error_code": run_result.error_code,
                        }
                    )
                    db.commit()
                    tool_results.append(
                        ToolResultMessage(
                            call_id=tc.id,
                            output=app_search_tool_output(run_result, start_n),
                            is_error=run_result.status == "error",
                        )
                    )
                elif tc.name == WEB_SEARCH_TOOL_NAME:
                    args = tc.arguments
                    fresh_arg = args.get("freshness_days")
                    freshness_days = fresh_arg if isinstance(fresh_arg, int) else None
                    web_filters: dict[str, object] = {
                        "freshness_days": freshness_days,
                        "allowed_domains": [],
                        "blocked_domains": [],
                    }
                    web_tool_call_id = persist_tool_call_start(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=WEB_SEARCH_TOOL_NAME,
                        scope="public_web",
                        requested_types=["mixed"],
                    )
                    bind_provider_tool_call_events(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_call_id=web_tool_call_id,
                    )
                    emitter.tool_result(
                        tool_start_event(
                            run=run,
                            tool_call_id=web_tool_call_id,
                            tool_call_index=tool_call_index_next,
                            tool_name=WEB_SEARCH_TOOL_NAME,
                            scope="public_web",
                            types=["mixed"],
                            filters=web_filters,
                        )
                    )
                    db.commit()
                    if web_search_provider is None:
                        error_code = "web_search_not_configured"
                        persist_tool_call_error(
                            db, tool_call_id=web_tool_call_id, error_code=error_code
                        )
                        emitter.tool_result(
                            {
                                **tool_start_event(
                                    run=run,
                                    tool_call_id=web_tool_call_id,
                                    tool_call_index=tool_call_index_next,
                                    tool_name=WEB_SEARCH_TOOL_NAME,
                                    scope="public_web",
                                    types=["mixed"],
                                    filters=web_filters,
                                ),
                                "status": "error",
                                "error_code": error_code,
                            }
                        )
                        db.commit()
                        tool_results.append(
                            ToolResultMessage(
                                call_id=tc.id,
                                output='{"error":"web_search is not configured"}',
                                is_error=True,
                            )
                        )
                        continue
                    run_result = await execute_web_search(
                        db,
                        provider=web_search_provider,
                        conversation_id=run.conversation_id,
                        user_message_id=run.user_message_id,
                        assistant_message_id=run.assistant_message_id,
                        query=str(args.get("query") or ""),
                        freshness_days=freshness_days,
                        tool_call_index=tool_call_index_next,
                    )
                    assert run_result.tool_call_id is not None
                    start_n = citation_n_next
                    citation_n_next = record_tool_citations(
                        db,
                        run=run,
                        tool_call_id=run_result.tool_call_id,
                        start_ordinal=citation_n_next,
                    )
                    emitter.tool_result(
                        {
                            **run_result.tool_call_event(),
                            **run_result.retrieval_result_event(),
                            "status": run_result.status,
                            "error_code": run_result.error_code,
                        }
                    )
                    db.commit()
                    tool_results.append(
                        ToolResultMessage(
                            call_id=tc.id,
                            output=web_search_tool_output(run_result, start_n),
                            is_error=run_result.status == "error",
                        )
                    )
                elif tc.name == READ_RESOURCE_TOOL_NAME:
                    args = tc.arguments
                    uri = str(args.get("uri") or "")
                    read_tool_call_id = persist_tool_call_start(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=READ_RESOURCE_TOOL_NAME,
                        scope="conversation_context",
                        requested_types=[],
                    )
                    bind_provider_tool_call_events(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_call_id=read_tool_call_id,
                    )
                    emitter.tool_result(
                        tool_start_event(
                            run=run,
                            tool_call_id=read_tool_call_id,
                            tool_call_index=tool_call_index_next,
                            tool_name=READ_RESOURCE_TOOL_NAME,
                            scope="conversation_context",
                            types=[],
                            filters={"uri": uri},
                        )
                    )
                    db.commit()
                    read_result = execute_read_resource(
                        db,
                        viewer_id=run.owner_user_id,
                        conversation_id=run.conversation_id,
                        uri=uri,
                    )
                    read_tool_call_id = persist_tool_call_trace(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=READ_RESOURCE_TOOL_NAME,
                        result=read_result,
                    )
                    read_n = persist_read_evidence_citation(
                        db,
                        run=run,
                        tool_call_id=read_tool_call_id,
                        result=read_result,
                        start_ordinal=citation_n_next,
                    )
                    if read_n is not None:
                        citation_n_next += 1
                    emitter.tool_result(
                        tool_trace_event(
                            run=run,
                            tool_call_id=read_tool_call_id,
                            tool_call_index=tool_call_index_next,
                            tool_name=READ_RESOURCE_TOOL_NAME,
                            result=read_result,
                        )
                    )
                    db.commit()
                    tool_results.append(
                        ToolResultMessage(
                            call_id=tc.id,
                            output=read_result.tool_output(n=read_n),
                            is_error=read_result.is_error,
                        )
                    )
                elif tc.name == INSPECT_RESOURCE_TOOL_NAME:
                    args = tc.arguments
                    uri = str(args.get("uri") or "")
                    inspect_tool_call_id = persist_tool_call_start(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=INSPECT_RESOURCE_TOOL_NAME,
                        scope="conversation_context",
                        requested_types=[],
                    )
                    bind_provider_tool_call_events(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_call_id=inspect_tool_call_id,
                    )
                    emitter.tool_result(
                        tool_start_event(
                            run=run,
                            tool_call_id=inspect_tool_call_id,
                            tool_call_index=tool_call_index_next,
                            tool_name=INSPECT_RESOURCE_TOOL_NAME,
                            scope="conversation_context",
                            types=[],
                            filters={"uri": uri},
                        )
                    )
                    db.commit()
                    inspect_result = execute_inspect_resource(
                        db,
                        viewer_id=run.owner_user_id,
                        conversation_id=run.conversation_id,
                        uri=uri,
                    )
                    inspect_tool_call_id = persist_tool_call_trace(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=INSPECT_RESOURCE_TOOL_NAME,
                        result=inspect_result,
                    )
                    emitter.tool_result(
                        tool_trace_event(
                            run=run,
                            tool_call_id=inspect_tool_call_id,
                            tool_call_index=tool_call_index_next,
                            tool_name=INSPECT_RESOURCE_TOOL_NAME,
                            result=inspect_result,
                        )
                    )
                    db.commit()
                    tool_results.append(
                        ToolResultMessage(
                            call_id=tc.id,
                            output=inspect_result.tool_output(),
                            is_error=inspect_result.is_error,
                        )
                    )
                elif tc.name in WRITE_TOOL_NAMES:
                    write_args: dict[str, Any] = dict(tc.arguments)
                    write_tool_call_id = persist_tool_call_start(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=tc.name,
                        scope="assistant_write",
                        requested_types=[],
                    )
                    bind_provider_tool_call_events(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_call_id=write_tool_call_id,
                    )
                    emitter.tool_result(
                        tool_start_event(
                            run=run,
                            tool_call_id=write_tool_call_id,
                            tool_call_index=tool_call_index_next,
                            tool_name=tc.name,
                            scope="assistant_write",
                            types=[],
                            filters={},
                        )
                    )
                    db.commit()
                    write_outcome = execute_write_tool(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=tc.name,
                        args=write_args,
                    )
                    emitter.tool_result(
                        {
                            **tool_start_event(
                                run=run,
                                tool_call_id=write_outcome.tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=tc.name,
                                scope="assistant_write",
                                types=[],
                                filters={},
                            ),
                            "status": write_outcome.status,
                            "error_code": write_outcome.error_code,
                        }
                    )
                    db.commit()
                    tool_results.append(
                        ToolResultMessage(
                            call_id=tc.id,
                            output=write_outcome.tool_output_json,
                            is_error=write_outcome.is_error,
                        )
                    )
                else:
                    error_code = "unknown_tool"
                    tool_call_id = persist_tool_call_start(
                        db,
                        run=run,
                        tool_call_index=tool_call_index_next,
                        tool_name=tc.name,
                        scope="provider_tool",
                        requested_types=[],
                    )
                    bind_provider_tool_call_events(
                        db, run=run, tool_call_index=tool_call_index_next, tool_call_id=tool_call_id
                    )
                    emitter.tool_result(
                        tool_start_event(
                            run=run,
                            tool_call_id=tool_call_id,
                            tool_call_index=tool_call_index_next,
                            tool_name=tc.name,
                            scope="provider_tool",
                            types=[],
                            filters={},
                        )
                    )
                    persist_tool_call_error(db, tool_call_id=tool_call_id, error_code=error_code)
                    emitter.tool_result(
                        {
                            **tool_start_event(
                                run=run,
                                tool_call_id=tool_call_id,
                                tool_call_index=tool_call_index_next,
                                tool_name=tc.name,
                                scope="provider_tool",
                                types=[],
                                filters={},
                            ),
                            "status": "error",
                            "error_code": error_code,
                        }
                    )
                    db.commit()
                    tool_results.append(
                        ToolResultMessage(
                            call_id=tc.id,
                            output=f'{{"error":"unknown tool: {tc.name}"}}',
                            is_error=True,
                        )
                    )
            messages.extend(tool_results)
            db.commit()
        else:
            logger.warning(
                "chat_run.max_tool_iterations_exceeded",
                run_id=str(run.id),
                iterations=MAX_TOOL_ITERATIONS,
            )

        try:
            emit_citation_index(db, run, full_content, emitter=emitter)
        except InvalidRequestError as exc:
            clear_message_citations(db, run)
            finalize_run(
                db,
                run_id=run.id,
                assistant_content=full_content,
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=None,
                support_id=uuid4().hex[:12],
                error_detail=f"assistant citation markers invalid: {exc.message}",
                usage=usage_provider_json(final_usage),
                last_provider_event_seq=last_provider_event_seq,
            )
            log_stream_observed(status="error", error_code=None, terminal_cause="bad_citations")
            return {"status": "error", "error_code": "defect"}

        finalize_run(
            db,
            run_id=run.id,
            assistant_content=full_content,
            assistant_status="complete",
            run_status="complete",
            done_status="complete",
            error_code=None,
            usage=usage_provider_json(final_usage),
            last_provider_event_seq=last_provider_event_seq,
            cancelled=False,
        )
        log_stream_observed(status="complete", error_code=None, terminal_cause="complete")
        return {"status": "complete"}
    except ApiError as exc:
        # execute_generation_stream raises ApiError only for two cases that
        # have no representable ExpectedModelFailure leaf: entitlement denial
        # (no llm_calls row at all — a generic defect) or budget denial
        # (llm_execution already terminalized {origin=budget,
        # code=budget_exceeded} on the just-written row before re-raising —
        # re-derive those facts here rather than re-deciding them).
        latest_code = db.execute(
            text(
                "SELECT error_code FROM llm_calls WHERE owner_kind = 'chat_run' "
                "AND owner_id = :run_id ORDER BY call_seq DESC LIMIT 1"
            ),
            {"run_id": run.id},
        ).scalar_one_or_none()
        if latest_code == "budget_exceeded":
            finalize_run(
                db,
                run_id=run.id,
                assistant_content=full_content,
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code="budget_exceeded",
                error_origin="budget",
                support_id=_latest_generation_support_id(db, run.id),
                last_provider_event_seq=last_provider_event_seq,
            )
            log_stream_observed(
                status="error", error_code="budget_exceeded", terminal_cause="budget_exceeded"
            )
            return {"status": "error", "error_code": "budget_exceeded"}
        finalize_defect(db, run_id=run.id, error_detail=exception_error_detail(exc))
        log_stream_observed(status="error", error_code=None, terminal_cause="defect")
        return {"status": "error", "error_code": "defect"}
    finally:
        rate_limiter.release_inflight_slot(run.owner_user_id)
