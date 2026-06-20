"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming; the stream route only tails persisted
events.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
from collections.abc import AsyncIterator, Mapping
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any, Protocol, cast
from uuid import UUID

from provider_runtime import ModelRuntime
from provider_runtime.errors import ModelCallError, ModelCallErrorCode
from provider_runtime.types import (
    ModelCall,
    ModelMessage,
    ModelStreamEvent,
    ProviderApiKey,
    ProviderArtifact,
    TokenUsage,
    ToolResult,
    ToolSpec,
)
from sqlalchemy import select
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.db.models import (
    ChatRun,
    ChatRunTurnContext,
    Conversation,
    Message,
    Model,
)
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
    api_error_code_for_model_call,
    exception_error_detail,
)
from nexus.jobs.queue import enqueue_job
from nexus.llm_catalog import model_max_context_tokens, model_reasoning_reserve_tokens
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
from nexus.services.api_key_resolver import (
    get_model_by_id,
    resolve_api_key,
)
from nexus.services.chat_run_access import (
    get_run_for_owner,
    load_retryable_failed_assistant_message,
    load_source_run_for_retry,
)
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
    ERROR_CODE_TO_MESSAGE,
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
    finalize_cancelled,
    finalize_error,
    finalize_interrupted,
    finalize_run,
)
from nexus.services.chat_run_idempotency import (
    compute_payload_hash,
    compute_retry_payload_hash,
    get_run_by_idempotency_key,
    lock_idempotency_key,
    normalize_idempotency_key,
    raise_if_payload_mismatch,
)
from nexus.services.chat_run_message_blocks import (
    message_document,
)
from nexus.services.chat_run_message_prep import prepare_messages
from nexus.services.chat_run_prompt_tracking import (
    reconcile_prompt_retrievals,
)
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
from nexus.services.chat_run_usage import usage_provider_json, usage_tokens
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.context_assembler import (
    assemble_chat_context,
    persist_prompt_assembly,
)
from nexus.services.conversation_branches import (
    ensure_branch_metadata,
    persist_active_leaf,
)
from nexus.services.llm_ledger import LlmCallOwner, observed_generate_stream
from nexus.services.prompt_budget import ContextBudgetError, estimate_tokens
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
from nexus.services.seq import assign_next_message_seq

logger = get_logger(__name__)


REASONING_OUTPUT_TOKENS = 25000
DEFAULT_OUTPUT_TOKENS = 4096
LLM_TIMEOUT_SECONDS = 45.0
MAX_TOOL_ITERATIONS = 8
CHAT_TEXT_FLUSH_INTERVAL_MS = 33
CHAT_TEXT_FLUSH_MAX_CHARS = 512
CHAT_TEXT_FLUSH_MAX_BYTES = 2048
CHAT_CANCEL_POLL_INTERVAL_SECONDS = 0.25

_CHAT_TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec(
        name=APP_SEARCH_TOOL_NAME,
        description=APP_SEARCH_TOOL_DEFINITION["description"],
        parameters=APP_SEARCH_TOOL_DEFINITION["parameters"],
    ),
    ToolSpec(
        name=WEB_SEARCH_TOOL_NAME,
        description=WEB_SEARCH_TOOL_DEFINITION["description"],
        parameters=WEB_SEARCH_TOOL_DEFINITION["parameters"],
    ),
    ToolSpec(
        name=READ_RESOURCE_TOOL_NAME,
        description=READ_RESOURCE_TOOL_DEFINITION["description"],
        parameters=READ_RESOURCE_TOOL_DEFINITION["parameters"],
    ),
    ToolSpec(
        name=INSPECT_RESOURCE_TOOL_NAME,
        description=INSPECT_RESOURCE_TOOL_DEFINITION["description"],
        parameters=INSPECT_RESOURCE_TOOL_DEFINITION["parameters"],
    ),
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
    return values, None


class ChatRunModelRuntime(Protocol):
    def stream(
        self,
        call: ModelCall,
        *,
        key: ProviderApiKey,
        timeout_s: float,
        cancel: asyncio.Event | None = None,
    ) -> AsyncIterator[ModelStreamEvent]: ...


def _max_output_tokens_for_reasoning(model: Model, reasoning: str) -> int:
    max_context_tokens = model_max_context_tokens(model.provider, model.model_name)
    reasoning_reserve = model_reasoning_reserve_tokens(
        model.provider,
        model.model_name,
        reasoning,
    )
    if reasoning_reserve > 0:
        return min(REASONING_OUTPUT_TOKENS, max_context_tokens)
    return min(DEFAULT_OUTPUT_TOKENS, max_context_tokens)


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
    model_id: UUID,
    reasoning: str,
    key_mode: str,
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
        model_id,
        reasoning,
        key_mode,
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

    model = get_model_by_id(db, model_id)
    if model is None:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found")

    try:
        resolved = resolve_api_key(db, viewer_id, model.provider, key_mode)
        use_platform_key = resolved.mode == "platform"
    except ApiError as exc:
        if exc.code != ApiErrorCode.E_MODEL_NOT_AVAILABLE:
            raise
        use_platform_key = False
    except ModelCallError:
        # justify-ignore-error: BYOK probe may fail when the user has no key
        # yet; treat as "no platform key in use" and continue pre-validation.
        use_platform_key = False

    validate_pre_phase(
        db,
        viewer_id,
        conversation_id,
        parent_message_id,
        branch_anchor,
        subject_ref,
        reader_selection,
        content,
        model_id,
        reasoning,
        key_mode,
        use_platform_key,
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
            model_id,
        )
        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=prepared.conversation.id,
            user_message_id=prepared.user_message.id,
            assistant_message_id=prepared.assistant_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            model_id=model_id,
            reasoning=reasoning,
            key_mode=key_mode,
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
                "model_id": str(model.id),
                "provider": model.provider,
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


def retry_failed_assistant_response(
    db: Session,
    *,
    viewer_id: UUID,
    assistant_message_id: UUID,
    idempotency_key: str | None,
) -> ChatRunResponse:
    normalized_key = normalize_idempotency_key(idempotency_key)
    try:
        lock_idempotency_key(db, viewer_id, normalized_key)
        assistant_message = load_retryable_failed_assistant_message(
            db,
            viewer_id=viewer_id,
            assistant_message_id=assistant_message_id,
        )
        source_run = load_source_run_for_retry(
            db,
            viewer_id=viewer_id,
            assistant_message=assistant_message,
        )
        source_user_message = db.get(Message, source_run.user_message_id)
        if source_user_message is None or source_user_message.role != "user":
            raise ApiError(ApiErrorCode.E_RETRY_INVALID_STATE, "Retry source prompt not found")
        payload_hash = compute_retry_payload_hash(
            failed_assistant_message_id=assistant_message_id,
            source_run=source_run,
            source_user_message=source_user_message,
        )

        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        model = db.get(Model, source_run.model_id)
        if model is None:
            raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found")

        user_message = Message(
            conversation_id=source_run.conversation_id,
            seq=assign_next_message_seq(db, source_run.conversation_id),
            role="user",
            content=source_user_message.content,
            message_document=message_document("user", source_user_message.content),
            status="complete",
            parent_message_id=source_user_message.parent_message_id,
            branch_root_message_id=source_user_message.branch_root_message_id,
            branch_anchor_kind=source_user_message.branch_anchor_kind,
            branch_anchor=dict(source_user_message.branch_anchor or {}),
        )
        db.add(user_message)
        db.flush()
        if user_message.parent_message_id is not None:
            ensure_branch_metadata(
                db,
                conversation_id=source_run.conversation_id,
                branch_user_message_id=user_message.id,
            )

        assistant_retry_message = Message(
            conversation_id=source_run.conversation_id,
            seq=assign_next_message_seq(db, source_run.conversation_id),
            role="assistant",
            content="",
            message_document=message_document("assistant", ""),
            status="pending",
            model_id=source_run.model_id,
            parent_message_id=user_message.id,
            branch_root_message_id=user_message.branch_root_message_id,
            branch_anchor_kind="none",
            branch_anchor={},
        )
        db.add(assistant_retry_message)
        db.flush()
        persist_active_leaf(
            db,
            viewer_id=viewer_id,
            conversation_id=source_run.conversation_id,
            active_leaf_message_id=assistant_retry_message.id,
        )

        run = ChatRun(
            owner_user_id=viewer_id,
            conversation_id=source_run.conversation_id,
            user_message_id=user_message.id,
            assistant_message_id=assistant_retry_message.id,
            idempotency_key=normalized_key,
            payload_hash=payload_hash,
            status="queued",
            model_id=source_run.model_id,
            reasoning=source_run.reasoning,
            key_mode=source_run.key_mode,
        )
        db.add(run)
        db.flush()
        source_turn_context = db.get(ChatRunTurnContext, source_run.id)
        if source_turn_context is not None:
            db.add(
                ChatRunTurnContext(
                    chat_run_id=run.id,
                    requested_subject_scheme=source_turn_context.requested_subject_scheme,
                    requested_subject_id=source_turn_context.requested_subject_id,
                    subject_scheme=source_turn_context.subject_scheme,
                    subject_id=source_turn_context.subject_id,
                    subject_context_edge_id=source_turn_context.subject_context_edge_id,
                    reader_selection_media_id=source_turn_context.reader_selection_media_id,
                    reader_selection_highlight_id=source_turn_context.reader_selection_highlight_id,
                )
            )
        ChatRunEventEmitter(db, run).meta(
            {
                "run_id": str(run.id),
                "conversation_id": str(source_run.conversation_id),
                "user_message_id": str(user_message.id),
                "assistant_message_id": str(assistant_retry_message.id),
                "model_id": str(model.id),
                "provider": model.provider,
                "chat_subject": None,
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


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: ChatRunModelRuntime,
    web_search_provider: WebSearchProvider | None = None,
) -> dict[str, str]:
    flow_id = str(run_id)
    set_flow_id(flow_id)
    try:
        return await _execute_chat_run(
            db,
            run_id=run_id,
            llm_router=llm_router,
            web_search_provider=web_search_provider,
        )
    except ApiError as exc:
        logger.warning(
            "chat_run.api_error",
            run_id=str(run_id),
            error_code=exc.code.value,
            error=str(exc),
        )
        try:
            finalize_error(
                db,
                run_id=run_id,
                error_code=exc.code.value,
                error_detail=exception_error_detail(exc),
                assistant_content=ERROR_CODE_TO_MESSAGE.get(exc.code.value, exc.message),
            )
            return {"status": "error", "error_code": exc.code.value}
        except Exception:
            db.rollback()
            raise
    except Exception as exc:  # justify-ignore-error: chat-run boundary; finalize the run as failed and report E_INTERNAL
        logger.exception("chat_run.unhandled_error", run_id=str(run_id), error=str(exc))
        try:
            finalize_error(
                db,
                run_id=run_id,
                error_code=ApiErrorCode.E_INTERNAL.value,
                error_detail=exception_error_detail(exc),
            )
            return {"status": "error", "error_code": ApiErrorCode.E_INTERNAL.value}
        except Exception:
            db.rollback()
            raise
    finally:
        set_flow_id(None)


async def _execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: ChatRunModelRuntime,
    web_search_provider: WebSearchProvider | None = None,
) -> dict[str, str]:
    run = db.get(ChatRun, run_id)
    if run is None:
        return {"status": "skipped", "reason": "run_not_found"}
    if run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}

    if has_provider_output_without_terminal(db, run.id):
        finalize_interrupted(db, run)
        return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

    model = db.get(Model, run.model_id)
    if model is None:
        finalize_error(
            db,
            run_id=run.id,
            error_code=ApiErrorCode.E_MODEL_NOT_AVAILABLE.value,
        )
        return {"status": "error", "error_code": ApiErrorCode.E_MODEL_NOT_AVAILABLE.value}

    mark_running(db, run.id)
    run = db.get(ChatRun, run.id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}
    if run.cancel_requested_at is not None:
        finalize_cancelled(db, run, None)
        return {"status": "cancelled"}

    emitter = ChatRunEventEmitter(db, run)

    try:
        resolved_key = resolve_api_key(db, run.owner_user_id, model.provider, run.key_mode)
    except ApiError as exc:
        finalize_error(
            db,
            run_id=run.id,
            error_code=exc.code.value,
            error_detail=exception_error_detail(exc),
            assistant_content=ERROR_CODE_TO_MESSAGE.get(exc.code.value, exc.message),
        )
        return {"status": "error", "error_code": exc.code.value}
    except ModelCallError as exc:
        error_code = api_error_code_for_model_call(exc.error_code).value
        finalize_error(
            db,
            run_id=run.id,
            error_code=error_code,
            error_detail=exception_error_detail(exc),
            assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INVALID_KEY"],
        )
        return {"status": "error", "error_code": error_code}

    rate_limiter = get_rate_limiter()
    rate_limiter.acquire_inflight_slot(run.owner_user_id)
    budget_reserved = False
    max_output_tokens = _max_output_tokens_for_reasoning(model, run.reasoning)
    try:
        conversation = db.get(Conversation, run.conversation_id)
        user_message = db.get(Message, run.user_message_id)
        if conversation is None or user_message is None:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_CONVERSATION_NOT_FOUND.value,
                resolved_key=resolved_key,
                assistant_content="Conversation not found.",
            )
            return {"status": "error", "error_code": ApiErrorCode.E_CONVERSATION_NOT_FOUND.value}

        if is_cancel_requested(db, run.id):
            finalize_cancelled(db, run, resolved_key)
            return {"status": "cancelled"}

        try:
            assembly = assemble_chat_context(
                db,
                run=run,
                model=model,
                max_output_tokens=max_output_tokens,
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
            error_code = exc.api_error_code.value
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                error_detail=exception_error_detail(exc),
                resolved_key=resolved_key,
            )
            return {"status": "error", "error_code": error_code}

        llm_request = dataclasses.replace(assembly.llm_request, tools=_CHAT_TOOL_SPECS)
        if resolved_key.mode == "platform":
            est_tokens = (
                estimate_tokens("\n".join(turn.content for turn in llm_request.messages))
                + llm_request.max_output_tokens
            )
            rate_limiter.reserve_token_budget(
                run.owner_user_id, run.assistant_message_id, est_tokens
            )
            budget_reserved = True
        turns: list[ModelMessage] = list(llm_request.messages)
        full_content = ""
        usage: TokenUsage | None = None
        provider_request_id: str | None = None
        provider_request_ids: list[str] = []
        last_provider_event_seq: int | None = None
        actual_budget_tokens = 0
        incomplete_reason: str | None = None
        terminal_seen = False
        locally_truncated = False
        citation_n_next = len(assembly.attached_citations) + 1
        tool_call_index_next = 0
        stream_error_code: str | None = None
        stream_error_detail: str | None = None
        call_owner = LlmCallOwner(kind="chat_run", id=run.id)
        stream_started_at = time.monotonic()
        first_provider_event_ms: int | None = None
        first_visible_text_ms: int | None = None
        provider_event_count = 0
        durable_flush_count = 0
        stream_observed_logged = False

        def log_stream_observed(
            *, status: str, error_code: str | None, terminal_cause: str
        ) -> None:
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
                    provider_request_id=provider_request_id,
                    provider_request_ids=provider_request_ids,
                ),
            )

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

        try:
            for _iteration in range(MAX_TOOL_ITERATIONS):
                pending_tool_calls: list[Any] = []
                provider_artifacts: list[ProviderArtifact] = []
                iter_text = ""
                iter_terminal = False
                iter_request = dataclasses.replace(llm_request, messages=turns)
                cancel_signal = asyncio.Event()
                cancel_watcher = asyncio.create_task(
                    _watch_chat_run_cancel(db, run_id=run.id, cancel_signal=cancel_signal)
                )
                stream = observed_generate_stream(
                    db,
                    owner=call_owner,
                    # The ledger is typed against the nominal router; chat's seam
                    # stays the structural ChatRunModelRuntime (test fakes), same
                    # cast precedent as llm_task's fixture swap.
                    llm=cast(ModelRuntime, llm_router),
                    provider=model.provider,
                    request=iter_request,
                    api_key=resolved_key.api_key,
                    timeout_s=int(LLM_TIMEOUT_SECONDS),
                    llm_operation="chat_send",
                    key_mode_requested=run.key_mode,
                    key_mode_used=resolved_key.mode,
                    cancel=cancel_signal,
                )
                try:
                    text_buffer = ""
                    text_seq_start: int | None = None
                    text_seq_end = 0
                    last_text_flush = time.monotonic()
                    provider_tool_indices: dict[str, int] = {}

                    async for event in stream:
                        provider_event_count += 1
                        if first_provider_event_ms is None:
                            first_provider_event_ms = int(
                                (time.monotonic() - stream_started_at) * 1000
                            )
                        last_provider_event_seq = event.sequence
                        if event.type == "text_delta":
                            delta = event.text
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
                                text_seq_start = text_seq_start or event.sequence
                                text_seq_end = event.sequence
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
                                stream.record_abandoned(
                                    error_class=ApiErrorCode.E_LLM_INTERRUPTED.value,
                                    error_detail=(
                                        "stream abandoned after local assistant content limit"
                                    ),
                                )
                                text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                    text_buffer,
                                    text_seq_start,
                                    text_seq_end,
                                    last_text_flush,
                                )
                                break
                            if is_cancel_requested(db, run.id):
                                stream.record_abandoned(
                                    error_class=ApiErrorCode.E_CANCELLED.value,
                                    error_detail="chat run cancelled during provider stream",
                                )
                                await stream.aclose()
                                text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                    text_buffer,
                                    text_seq_start,
                                    text_seq_end,
                                    last_text_flush,
                                )
                                finalize_cancelled(
                                    db,
                                    run,
                                    resolved_key,
                                    last_provider_event_seq=last_provider_event_seq,
                                )
                                log_stream_observed(
                                    status="cancelled",
                                    error_code=ApiErrorCode.E_CANCELLED.value,
                                    terminal_cause="cancelled",
                                )
                                return {"status": "cancelled"}
                            continue
                        if event.type in {"stream_start", "activity"}:
                            text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                text_buffer,
                                text_seq_start,
                                text_seq_end,
                                last_text_flush,
                            )
                            phase = event.activity or "thinking"
                            emitter.assistant_activity(
                                phase=phase,
                                provider_event_seq_start=event.sequence,
                                provider_event_seq_end=event.sequence,
                            )
                            continue
                        if event.type in {"tool_call_start", "tool_call_delta", "tool_call_done"}:
                            text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                text_buffer,
                                text_seq_start,
                                text_seq_end,
                                last_text_flush,
                            )
                            provider_tool_call_id = event.tool_call_id or (
                                event.tool_call.id if event.tool_call is not None else ""
                            )
                            if not provider_tool_call_id:
                                continue
                            if provider_tool_call_id not in provider_tool_indices:
                                provider_tool_indices[provider_tool_call_id] = (
                                    tool_call_index_next + len(provider_tool_indices) + 1
                                )
                            index = provider_tool_indices[provider_tool_call_id]
                            if event.type == "tool_call_start":
                                emitter.tool_call_start(
                                    tool_name=event.tool_name or "",
                                    tool_call_index=index,
                                    provider_tool_call_id=provider_tool_call_id,
                                    provider_event_seq_start=event.sequence,
                                    provider_event_seq_end=event.sequence,
                                )
                            elif event.type == "tool_call_delta":
                                input_preview = (
                                    json.dumps(
                                        event.tool_arguments_partial,
                                        sort_keys=True,
                                        default=str,
                                    )[:512]
                                    if event.tool_arguments_partial is not None
                                    else None
                                )
                                emitter.tool_call_delta(
                                    tool_name=event.tool_name or "",
                                    tool_call_index=index,
                                    provider_tool_call_id=provider_tool_call_id,
                                    input_delta=event.tool_arguments_delta,
                                    input_preview=input_preview,
                                    provider_event_seq_start=event.sequence,
                                    provider_event_seq_end=event.sequence,
                                )
                            elif event.tool_call is not None:
                                pending_tool_calls.append(event.tool_call)
                                emitter.tool_call_done(
                                    tool_name=event.tool_call.name,
                                    tool_call_index=index,
                                    provider_tool_call_id=provider_tool_call_id,
                                    input=event.tool_call.arguments,
                                    provider_event_seq_start=event.sequence,
                                    provider_event_seq_end=event.sequence,
                                )
                            if is_cancel_requested(db, run.id):
                                stream.record_abandoned(
                                    error_class=ApiErrorCode.E_CANCELLED.value,
                                    error_detail="chat run cancelled during provider stream",
                                )
                                await stream.aclose()
                                text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                    text_buffer,
                                    text_seq_start,
                                    text_seq_end,
                                    last_text_flush,
                                )
                                finalize_cancelled(
                                    db,
                                    run,
                                    resolved_key,
                                    last_provider_event_seq=last_provider_event_seq,
                                )
                                log_stream_observed(
                                    status="cancelled",
                                    error_code=ApiErrorCode.E_CANCELLED.value,
                                    terminal_cause="cancelled",
                                )
                                return {"status": "cancelled"}
                            continue
                        if event.type == "provider_artifact":
                            text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                text_buffer,
                                text_seq_start,
                                text_seq_end,
                                last_text_flush,
                            )
                            if event.provider_artifact is not None:
                                provider_artifacts.append(event.provider_artifact)
                            continue
                        if event.type == "usage_delta":
                            usage = event.usage
                            continue
                        if event.type == "cancelled":
                            text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                text_buffer,
                                text_seq_start,
                                text_seq_end,
                                last_text_flush,
                            )
                            provider_request_id = event.provider_request_id
                            if provider_request_id is not None:
                                provider_request_ids.append(provider_request_id)
                            finalize_cancelled(
                                db,
                                run,
                                resolved_key,
                                usage=usage_provider_json(event.usage),
                                last_provider_event_seq=last_provider_event_seq,
                            )
                            log_stream_observed(
                                status="cancelled",
                                error_code=ApiErrorCode.E_CANCELLED.value,
                                terminal_cause="cancelled",
                            )
                            return {"status": "cancelled"}
                        if event.type == "failed":
                            text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                text_buffer,
                                text_seq_start,
                                text_seq_end,
                                last_text_flush,
                            )
                            terminal_seen = True
                            iter_terminal = True
                            usage = event.usage
                            provider_request_id = event.provider_request_id
                            if provider_request_id is not None:
                                provider_request_ids.append(provider_request_id)
                            try:
                                stream_error_code = api_error_code_for_model_call(
                                    ModelCallErrorCode(event.error_code)
                                ).value
                            except ValueError:
                                stream_error_code = ApiErrorCode.E_LLM_PROVIDER_DOWN.value
                            stream_error_detail = event.error_detail
                            break
                        if event.type in {"completed", "incomplete"}:
                            text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                text_buffer,
                                text_seq_start,
                                text_seq_end,
                                last_text_flush,
                            )
                            iter_terminal = True
                            terminal_seen = True
                            usage = event.usage
                            provider_request_id = event.provider_request_id
                            if provider_request_id is not None:
                                provider_request_ids.append(provider_request_id)
                            terminal_tokens = usage_tokens(event.usage)["total_tokens"]
                            if terminal_tokens is not None:
                                actual_budget_tokens += terminal_tokens
                            if event.type == "incomplete":
                                incomplete_reason = "unknown"
                                if event.incomplete_details is not None:
                                    reason = event.incomplete_details.get("reason")
                                    incomplete_reason = (
                                        reason if isinstance(reason, str) else "unknown"
                                    )
                            break
                        if is_cancel_requested(db, run.id):
                            stream.record_abandoned(
                                error_class=ApiErrorCode.E_CANCELLED.value,
                                error_detail="chat run cancelled during provider stream",
                            )
                            await stream.aclose()
                            text_buffer, text_seq_start, last_text_flush = flush_text_buffer(
                                text_buffer,
                                text_seq_start,
                                text_seq_end,
                                last_text_flush,
                            )
                            finalize_cancelled(
                                db,
                                run,
                                resolved_key,
                                last_provider_event_seq=last_provider_event_seq,
                            )
                            log_stream_observed(
                                status="cancelled",
                                error_code=ApiErrorCode.E_CANCELLED.value,
                                terminal_cause="cancelled",
                            )
                            return {"status": "cancelled"}
                finally:
                    cancel_watcher.cancel()
                    with suppress(asyncio.CancelledError):
                        await cancel_watcher
                    await stream.aclose()
                if locally_truncated or not pending_tool_calls:
                    break
                if not iter_terminal:
                    break
                turns.append(
                    ModelMessage(
                        role="assistant",
                        content=iter_text,
                        tool_calls=tuple(pending_tool_calls),
                        provider_artifacts=tuple(provider_artifacts),
                    )
                )
                tool_results: list[ToolResult] = []
                for tc in pending_tool_calls:
                    tool_call_index_next += 1
                    if tc.name == APP_SEARCH_TOOL_NAME:
                        raw_args = tc.arguments or {}
                        args: Mapping[str, Any]
                        if isinstance(raw_args, Mapping):
                            args = raw_args
                            scopes, forced_error = _app_search_scopes_from_tool_args(args)
                            kinds, filter_error = _app_search_string_array_from_tool_args(
                                args, "kinds"
                            )
                            forced_error = forced_error or filter_error
                            formats, filter_error = _app_search_string_array_from_tool_args(
                                args, "formats"
                            )
                            forced_error = forced_error or filter_error
                            authors, filter_error = _app_search_string_array_from_tool_args(
                                args, "authors"
                            )
                            forced_error = forced_error or filter_error
                            roles, filter_error = _app_search_string_array_from_tool_args(
                                args, "roles"
                            )
                            forced_error = forced_error or filter_error
                        else:
                            args = {}
                            scopes = []
                            kinds = None
                            formats = None
                            authors = None
                            roles = None
                            forced_error = "app_search arguments must be an object"
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
                            ToolResult(
                                call_id=tc.id,
                                output=app_search_tool_output(run_result, start_n),
                                is_error=run_result.status == "error",
                            )
                        )
                    elif tc.name == WEB_SEARCH_TOOL_NAME:
                        args = tc.arguments or {}
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
                                db,
                                tool_call_id=web_tool_call_id,
                                error_code=error_code,
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
                                ToolResult(
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
                            ToolResult(
                                call_id=tc.id,
                                output=web_search_tool_output(run_result, start_n),
                                is_error=run_result.status == "error",
                            )
                        )
                    elif tc.name == READ_RESOURCE_TOOL_NAME:
                        args = tc.arguments or {}
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
                            ToolResult(
                                call_id=tc.id,
                                output=read_result.tool_output(n=read_n),
                                is_error=read_result.is_error,
                            )
                        )
                    elif tc.name == INSPECT_RESOURCE_TOOL_NAME:
                        args = tc.arguments or {}
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
                            ToolResult(
                                call_id=tc.id,
                                output=inspect_result.tool_output(),
                                is_error=inspect_result.is_error,
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
                            db,
                            run=run,
                            tool_call_index=tool_call_index_next,
                            tool_call_id=tool_call_id,
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
                        persist_tool_call_error(
                            db,
                            tool_call_id=tool_call_id,
                            error_code=error_code,
                        )
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
                            ToolResult(
                                call_id=tc.id,
                                output=f'{{"error":"unknown tool: {tc.name}"}}',
                                is_error=True,
                            )
                        )
                db.commit()
                turns.append(ModelMessage(role="tool", tool_results=tuple(tool_results)))
            else:
                logger.warning(
                    "chat_run.max_tool_iterations_exceeded",
                    run_id=str(run.id),
                    iterations=MAX_TOOL_ITERATIONS,
                )
        except ModelCallError as llm_error:
            error_code = api_error_code_for_model_call(llm_error.error_code).value
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                error_detail=exception_error_detail(
                    llm_error, provider_request_id=provider_request_id
                ),
                resolved_key=resolved_key,
            )
            log_stream_observed(
                status="error",
                error_code=error_code,
                terminal_cause="provider_exception",
            )
            return {"status": "error", "error_code": error_code}

        if stream_error_code is not None:
            finalize_error(
                db,
                run_id=run.id,
                error_code=stream_error_code,
                error_detail=stream_error_detail,
                assistant_content=full_content or None,
                resolved_key=resolved_key,
                usage=usage_provider_json(usage),
                last_provider_event_seq=last_provider_event_seq,
            )
            log_stream_observed(
                status="error",
                error_code=stream_error_code,
                terminal_cause="failed",
            )
            return {"status": "error", "error_code": stream_error_code}

        if not terminal_seen and not locally_truncated:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                resolved_key=resolved_key,
            )
            log_stream_observed(
                status="error",
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                terminal_cause="abandoned",
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

        if locally_truncated:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                error_detail="stream abandoned after local assistant content limit",
                assistant_content=full_content,
                resolved_key=resolved_key,
                last_provider_event_seq=last_provider_event_seq,
            )
            log_stream_observed(
                status="error",
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                terminal_cause="local_truncation",
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

        if incomplete_reason is not None:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INCOMPLETE.value,
                error_detail=f"provider stopped early: {incomplete_reason}",
                assistant_content=full_content or None,
                resolved_key=resolved_key,
                usage=usage_provider_json(usage),
                last_provider_event_seq=last_provider_event_seq,
            )
            log_stream_observed(
                status="error",
                error_code=ApiErrorCode.E_LLM_INCOMPLETE.value,
                terminal_cause="incomplete",
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INCOMPLETE.value}

        if usage_tokens(usage)["total_tokens"] is None:
            error_code = ApiErrorCode.E_LLM_PROVIDER_DOWN.value
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                error_detail="provider terminal chunk carried no usage",
                resolved_key=resolved_key,
                usage=usage_provider_json(usage),
                last_provider_event_seq=last_provider_event_seq,
            )
            log_stream_observed(
                status="error",
                error_code=error_code,
                terminal_cause="missing_usage",
            )
            return {"status": "error", "error_code": error_code}

        try:
            emit_citation_index(db, run, full_content, emitter=emitter)
        except InvalidRequestError as exc:
            clear_message_citations(db, run)
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_BAD_REQUEST.value,
                error_detail=f"assistant citation markers invalid: {exc.message}",
                resolved_key=resolved_key,
                usage=usage_provider_json(usage),
                last_provider_event_seq=last_provider_event_seq,
            )
            log_stream_observed(
                status="error",
                error_code=ApiErrorCode.E_LLM_BAD_REQUEST.value,
                terminal_cause="bad_citations",
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_BAD_REQUEST.value}
        finalize_run(
            db,
            run_id=run.id,
            assistant_content=full_content,
            assistant_status="complete",
            run_status="complete",
            done_status="complete",
            error_code=None,
            resolved_key=resolved_key,
            usage=usage_provider_json(usage),
            last_provider_event_seq=last_provider_event_seq,
            cancelled=False,
        )
        db.commit()
        if resolved_key.mode == "platform":
            actual_tokens = actual_budget_tokens or usage_tokens(usage)["total_tokens"]
            assert actual_tokens is not None
            rate_limiter.commit_token_budget(
                run.owner_user_id, run.assistant_message_id, actual_tokens
            )
            budget_reserved = False
        log_stream_observed(status="complete", error_code=None, terminal_cause="complete")
        return {"status": "complete"}
    finally:
        if budget_reserved:
            rate_limiter.release_token_budget(run.owner_user_id, run.assistant_message_id)
        rate_limiter.release_inflight_slot(run.owner_user_id)
