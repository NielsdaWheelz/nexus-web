"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming; the stream route only tails persisted
events.
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any, Literal, cast
from uuid import UUID

import httpx
from llm_calling.errors import LLMError, LLMErrorCode, classify_provider_error
from llm_calling.types import LLMUsage
from sqlalchemy import select
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.config import get_settings
from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    Conversation,
    Message,
    Model,
)
from nexus.errors import (
    LLM_ERROR_CODE_TO_API_ERROR_CODE,
    ApiError,
    ApiErrorCode,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.conversation import (
    ArtifactIntentOptions,
    BranchAnchorRequest,
    ChatRunEventOut,
    ChatRunResponse,
    ContextItem,
    ConversationScopeRequest,
    WebSearchOptions,
)
from nexus.services.agent_tools.app_search import execute_app_search
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_CALL_INDEX,
    WEB_SEARCH_TOOL_NAME,
    execute_web_search,
)
from nexus.services.api_key_resolver import (
    get_model_by_id,
    resolve_api_key,
)
from nexus.services.chat_run_access import (
    copy_context_rows,
    get_run_for_owner,
    load_context_rows_for_message,
    load_retryable_failed_assistant_message,
    load_source_run_for_retry,
)
from nexus.services.chat_run_artifact_persistence import append_generated_artifact_delta
from nexus.services.chat_run_event_store import (
    TERMINAL_RUN_STATUSES,
    append_and_commit,
    append_run_event,
    has_delta_without_terminal,
    is_cancel_requested,
    mark_running,
)
from nexus.services.chat_run_evidence import (
    message_prompt_evidence_rows,
)
from nexus.services.chat_run_finalize import (
    ERROR_CODE_TO_MESSAGE,
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
    dummy_resolved_key,
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
from nexus.services.chat_run_scope import is_source_backed_run
from nexus.services.chat_run_usage import usage_log_fields, usage_tokens
from nexus.services.chat_run_validation import validate_pre_phase
from nexus.services.chat_run_verification import (
    LLM_TIMEOUT_SECONDS,
    ChatRunLLMRouter,
    verified_assistant_content,
)
from nexus.services.context_assembler import (
    assemble_chat_context,
    load_message_context_refs,
    load_recent_history_units,
    message_context_ref_payloads,
    persist_prompt_assembly,
)
from nexus.services.context_lookup import (
    ContextLookupError,
)
from nexus.services.context_rendering import PROMPT_VERSION
from nexus.services.conversation_branches import (
    ensure_branch_metadata,
    load_message_path,
    persist_active_leaf,
)
from nexus.services.conversation_memory import (
    collect_memory_source_refs,
    load_active_memory_items,
    refresh_conversation_memory,
)
from nexus.services.conversations import (
    conversation_scope_metadata,
)
from nexus.services.prompt_budget import ContextBudgetError
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.retrieval_planner import build_retrieval_plan
from nexus.services.seq import assign_next_message_seq

logger = get_logger(__name__)

REASONING_OUTPUT_TOKENS = 25000
DEFAULT_OUTPUT_TOKENS = 4096


def _llm_error_from_unread_stream_response(
    exc: httpx.ResponseNotRead,
    provider: str,
) -> LLMError:
    context = exc.__context__
    if isinstance(context, httpx.HTTPStatusError):
        status_code = context.response.status_code
        return LLMError(
            classify_provider_error(provider, status_code, None, None),
            f"Provider returned HTTP {status_code}",
            provider=provider,
        )
    return LLMError(
        LLMErrorCode.PROVIDER_DOWN,
        "Provider stream error response was not readable",
        provider=provider,
    )


def _max_output_tokens_for_reasoning(model: Model, reasoning: str) -> int:
    if model.provider == "openai" and reasoning in {"default", "low", "medium", "high", "max"}:
        return min(REASONING_OUTPUT_TOKENS, model.max_context_tokens)
    return min(DEFAULT_OUTPUT_TOKENS, model.max_context_tokens)


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    parent_message_id: UUID | None,
    branch_anchor: BranchAnchorRequest,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    web_search: WebSearchOptions,
    artifact_intent: ArtifactIntentOptions,
    idempotency_key: str | None,
) -> ChatRunResponse:
    contexts = list(contexts)
    if (conversation_id is None) == (conversation_scope is None):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Exactly one of conversation_id or conversation_scope is required",
        )
    normalized_key = normalize_idempotency_key(idempotency_key)

    payload_hash = compute_payload_hash(
        content,
        model_id,
        reasoning,
        key_mode,
        contexts,
        web_search,
        artifact_intent,
        conversation_id,
        conversation_scope,
        parent_message_id,
        branch_anchor,
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
    except LLMError:
        # justify-ignore-error: BYOK probe may fail when the user has no key
        # yet; treat as "no platform key in use" and continue pre-validation.
        use_platform_key = False

    validate_pre_phase(
        db,
        viewer_id,
        conversation_id,
        conversation_scope,
        parent_message_id,
        branch_anchor,
        content,
        model_id,
        reasoning,
        key_mode,
        contexts,
        use_platform_key,
    )

    try:
        lock_idempotency_key(db, viewer_id, normalized_key)
        existing = get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        prepared = prepare_messages(
            db,
            viewer_id,
            conversation_id,
            conversation_scope,
            parent_message_id,
            branch_anchor,
            content,
            model_id,
            contexts,
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
            web_search=web_search.model_dump(mode="json"),
            artifact_intent=artifact_intent.model_dump(mode="json"),
            next_event_seq=1,
        )
        db.add(run)
        db.flush()
        append_run_event(
            db,
            run,
            "meta",
            {
                "run_id": str(run.id),
                "conversation_id": str(prepared.conversation.id),
                "user_message_id": str(prepared.user_message.id),
                "assistant_message_id": str(prepared.assistant_message.id),
                "model_id": str(model.id),
                "provider": model.provider,
            },
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
        context_rows = load_context_rows_for_message(db, source_user_message.id)
        payload_hash = compute_retry_payload_hash(
            failed_assistant_message_id=assistant_message_id,
            source_run=source_run,
            source_user_message=source_user_message,
            context_rows=context_rows,
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
        copy_context_rows(
            db,
            viewer_id=viewer_id,
            source_message_id=source_user_message.id,
            target_message_id=user_message.id,
            rows=context_rows,
        )
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
            web_search=dict(source_run.web_search or {}),
            artifact_intent=dict(source_run.artifact_intent),
            next_event_seq=1,
        )
        db.add(run)
        db.flush()
        append_run_event(
            db,
            run,
            "meta",
            {
                "run_id": str(run.id),
                "conversation_id": str(source_run.conversation_id),
                "user_message_id": str(user_message.id),
                "assistant_message_id": str(assistant_retry_message.id),
                "model_id": str(model.id),
                "provider": model.provider,
            },
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
    status: str,
) -> list[ChatRunResponse]:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    if status == "active":
        filters = [ChatRun.status.notin_(TERMINAL_RUN_STATUSES)]
    elif status in {"queued", "running", "complete", "error", "cancelled"}:
        filters = [ChatRun.status == status]
    else:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid chat run status")

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
    return build_chat_run_response(db, viewer_id, run)


def get_chat_run_events(
    db: Session,
    *,
    viewer_id: UUID,
    run_id: UUID,
    after: int,
) -> list[ChatRunEventOut]:
    get_run_for_owner(db, viewer_id, run_id)
    rows = (
        db.execute(
            select(ChatRunEvent)
            .where(ChatRunEvent.run_id == run_id, ChatRunEvent.seq > after)
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    return [
        ChatRunEventOut(
            seq=row.seq,
            event_type=cast(Any, row.event_type),
            payload=row.payload,
            created_at=row.created_at,
        )
        for row in rows
    ]


def is_chat_run_terminal(db: Session, *, viewer_id: UUID, run_id: UUID) -> bool:
    run = get_run_for_owner(db, viewer_id, run_id)
    return run.status in TERMINAL_RUN_STATUSES


def assert_chat_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    get_run_for_owner(db, viewer_id, run_id)


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: ChatRunLLMRouter,
    web_search_provider: WebSearchProvider | None,
    web_search_country: str = "US",
    web_search_language: str = "en",
    web_search_safe_search: Literal["off", "moderate", "strict"] = "moderate",
) -> dict[str, str]:
    flow_id = str(run_id)
    set_flow_id(flow_id)
    try:
        return await _execute_chat_run(
            db,
            run_id=run_id,
            llm_router=llm_router,
            web_search_provider=web_search_provider,
            web_search_country=web_search_country,
            web_search_language=web_search_language,
            web_search_safe_search=web_search_safe_search,
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
                viewer_id=None,
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
                viewer_id=None,
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
    llm_router: ChatRunLLMRouter,
    web_search_provider: WebSearchProvider | None,
    web_search_country: str,
    web_search_language: str,
    web_search_safe_search: Literal["off", "moderate", "strict"],
) -> dict[str, str]:
    run = db.get(ChatRun, run_id)
    if run is None:
        return {"status": "skipped", "reason": "run_not_found"}
    if run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}

    if has_delta_without_terminal(db, run.id):
        finalize_interrupted(db, run)
        return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

    model = db.get(Model, run.model_id)
    if model is None:
        finalize_error(
            db,
            run_id=run.id,
            error_code=ApiErrorCode.E_MODEL_NOT_AVAILABLE.value,
            viewer_id=run.owner_user_id,
            key_mode=run.key_mode,
        )
        return {"status": "error", "error_code": ApiErrorCode.E_MODEL_NOT_AVAILABLE.value}

    mark_running(db, run.id)
    run = db.get(ChatRun, run.id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}
    if run.cancel_requested_at is not None:
        finalize_cancelled(db, run, model, None, 0)
        return {"status": "cancelled"}

    try:
        resolved_key = resolve_api_key(db, run.owner_user_id, model.provider, run.key_mode)
    except LLMError as exc:
        error_code = LLM_ERROR_CODE_TO_API_ERROR_CODE[exc.error_code].value
        finalize_error(
            db,
            run_id=run.id,
            error_code=error_code,
            viewer_id=run.owner_user_id,
            model=model,
            resolved_key=dummy_resolved_key(model),
            key_mode=run.key_mode,
            assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INVALID_KEY"],
        )
        return {"status": "error", "error_code": error_code}

    rate_limiter = get_rate_limiter()
    rate_limiter.acquire_inflight_slot(run.owner_user_id)
    budget_reserved = False
    start_time = time.monotonic()
    max_output_tokens = _max_output_tokens_for_reasoning(model, run.reasoning)
    try:
        if resolved_key.mode == "platform":
            est_tokens = len(run.user_message.content) // 4 + max_output_tokens
            rate_limiter.reserve_token_budget(
                run.owner_user_id, run.assistant_message_id, est_tokens
            )
            budget_reserved = True

        conversation = db.get(Conversation, run.conversation_id)
        user_message = db.get(Message, run.user_message_id)
        if conversation is None or user_message is None:
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_CONVERSATION_NOT_FOUND.value,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
                assistant_content="Conversation not found.",
            )
            return {"status": "error", "error_code": ApiErrorCode.E_CONVERSATION_NOT_FOUND.value}

        scope_metadata = conversation_scope_metadata(db, conversation)
        attached_context_refs = load_message_context_refs(db, run.user_message_id)
        path_messages = load_message_path(
            db,
            conversation_id=conversation.id,
            leaf_message_id=user_message.id,
        )
        path_message_ids = [
            message.id for message in path_messages if message.id != user_message.id
        ]
        snapshot = None
        after_seq = None
        memory_items = load_active_memory_items(
            db,
            conversation_id=conversation.id,
            after_seq=after_seq,
            prompt_version=PROMPT_VERSION,
            allowed_message_ids=set(path_message_ids),
        )
        history_units = load_recent_history_units(
            db,
            conversation_id=conversation.id,
            before_seq=user_message.seq,
            after_seq=after_seq,
            path_message_ids=path_message_ids,
        )
        planner_history = [
            turn for history_unit in history_units[-4:] for turn in history_unit.turns
        ]
        attached_context_ref_payloads = message_context_ref_payloads(db, attached_context_refs)

        retrieval_plan = build_retrieval_plan(
            user_content=user_message.content,
            history=planner_history,
            scope_metadata=scope_metadata,
            attached_context_refs=attached_context_ref_payloads,
            memory_source_refs=collect_memory_source_refs(
                memory_items=memory_items,
                snapshot=snapshot,
            ),
            web_search_options=run.web_search,
        )

        if retrieval_plan.app_search.enabled:
            # justify-service-invariant-check: the planner only leaves query None
            # when app_search is disabled; an enabled plan without a query is a defect.
            planned_query = retrieval_plan.app_search.query
            if planned_query is None:
                raise AssertionError("enabled app-search plan is missing a query")
            append_and_commit(
                db,
                run.id,
                "tool_call",
                {
                    "tool_call_id": None,
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_name": "app_search",
                    "tool_call_index": 0,
                    "status": "running",
                    "scope": retrieval_plan.app_search.scope,
                    "types": list(retrieval_plan.app_search.types),
                    "semantic": retrieval_plan.app_search.semantic,
                    "filters": dict(retrieval_plan.app_search.filters),
                },
            )
            app_search_run = execute_app_search(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                user_message_id=run.user_message_id,
                assistant_message_id=run.assistant_message_id,
                scope=retrieval_plan.app_search.scope,
                planned_query=planned_query,
                planned_types=retrieval_plan.app_search.types,
                planned_filters=retrieval_plan.app_search.filters,
            )
            app_result_event = app_search_run.retrieval_result_event()
            append_and_commit(db, run.id, "retrieval_result", app_result_event)
            append_and_commit(
                db,
                run.id,
                "source_manifest_delta",
                {
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_call_id": str(app_search_run.tool_call_id)
                    if app_search_run.tool_call_id
                    else None,
                    "tool_name": "app_search",
                    "tool_call_index": app_search_run.tool_call_index,
                    "query_hash": app_search_run.query_hash,
                    "scope": app_search_run.scope,
                    "filters": dict(app_search_run.filters),
                    "requested_types": app_search_run.requested_types,
                    "candidate_count": len(app_search_run.citations),
                    "result_count": len(app_search_run.citations),
                    "selected_count": len(app_search_run.selected_citations),
                    "included_in_prompt_count": 0,
                    "excluded_by_budget_count": 0,
                    "excluded_by_scope_count": 0,
                    "stale_count": 0,
                    "unreadable_count": 0,
                    "index_versions": [],
                    "metadata": (
                        {"empty_status": app_search_run.empty_status}
                        if app_search_run.empty_status
                        else {}
                    ),
                    "latency_ms": app_search_run.latency_ms,
                    "status": app_search_run.status,
                },
            )
            if app_search_run.status == "error" and scope_metadata.get("type") in {
                "media",
                "library",
            }:
                error_code = app_search_run.error_code or ApiErrorCode.E_APP_SEARCH_FAILED.value
                latency_ms = int((time.monotonic() - start_time) * 1000)
                finalize_error(
                    db,
                    run_id=run.id,
                    error_code=error_code,
                    viewer_id=run.owner_user_id,
                    model=model,
                    resolved_key=resolved_key,
                    key_mode=run.key_mode,
                    latency_ms=latency_ms,
                    assistant_content=ERROR_CODE_TO_MESSAGE.get(
                        error_code,
                        ERROR_CODE_TO_MESSAGE[ApiErrorCode.E_APP_SEARCH_FAILED.value],
                    ),
                )
                return {
                    "status": "error",
                    "error_code": error_code,
                }

        if is_cancel_requested(db, run.id):
            finalize_cancelled(
                db, run, model, resolved_key, int((time.monotonic() - start_time) * 1000)
            )
            return {"status": "cancelled"}

        web_search = WebSearchOptions.model_validate(run.web_search)
        if retrieval_plan.web_search.enabled:
            append_and_commit(
                db,
                run.id,
                "tool_call",
                {
                    "tool_call_id": None,
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_name": WEB_SEARCH_TOOL_NAME,
                    "tool_call_index": WEB_SEARCH_TOOL_CALL_INDEX,
                    "status": "running",
                    "scope": "public_web",
                    "types": ["mixed"],
                    "semantic": False,
                    "filters": {
                        "freshness_days": web_search.freshness_days,
                        "allowed_domains": web_search.allowed_domains,
                        "blocked_domains": web_search.blocked_domains,
                    },
                },
            )
            web_search_run = await execute_web_search(
                db,
                provider=web_search_provider,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                user_message_id=run.user_message_id,
                assistant_message_id=run.assistant_message_id,
                content=user_message.content,
                options=web_search,
                country=web_search_country,
                search_lang=web_search_language,
                safe_search=web_search_safe_search,
            )
            if web_search_run is not None:
                web_result_event = web_search_run.retrieval_result_event()
                append_and_commit(db, run.id, "retrieval_result", web_result_event)
                append_and_commit(
                    db,
                    run.id,
                    "source_manifest_delta",
                    {
                        "assistant_message_id": str(run.assistant_message_id),
                        "tool_call_id": str(web_search_run.tool_call_id)
                        if web_search_run.tool_call_id
                        else None,
                        "tool_name": WEB_SEARCH_TOOL_NAME,
                        "tool_call_index": web_search_run.tool_call_index,
                        "query_hash": web_search_run.query_hash,
                        "scope": "public_web",
                        "filters": {
                            "freshness_days": web_search.freshness_days,
                            "allowed_domains": web_search.allowed_domains,
                            "blocked_domains": web_search.blocked_domains,
                        },
                        "requested_types": [web_search_run.result_type],
                        "candidate_count": len(web_search_run.citations),
                        "result_count": len(web_search_run.citations),
                        "selected_count": len(web_search_run.selected_citations),
                        "included_in_prompt_count": 0,
                        "excluded_by_budget_count": 0,
                        "excluded_by_scope_count": 0,
                        "stale_count": 0,
                        "unreadable_count": 0,
                        "web_search_mode": web_search.mode,
                        "index_versions": [],
                        "metadata": (
                            {"empty_status": web_search_run.empty_status}
                            if web_search_run.empty_status
                            else {}
                        ),
                        "latency_ms": web_search_run.latency_ms,
                        "status": web_search_run.status,
                    },
                )
        if is_cancel_requested(db, run.id):
            finalize_cancelled(
                db, run, model, resolved_key, int((time.monotonic() - start_time) * 1000)
            )
            return {"status": "cancelled"}

        try:
            assembly = assemble_chat_context(
                db,
                run=run,
                model=model,
                environment=get_settings().nexus_env.value,
                key_mode_used=resolved_key.mode,
                provider_account_boundary=resolved_key.user_key_id or resolved_key.mode,
                max_output_tokens=max_output_tokens,
            )
            persist_prompt_assembly(db, run=run, assembly=assembly)
            reconcile_prompt_retrievals(db, run=run, assembly=assembly)
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
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
            )
            return {"status": "error", "error_code": error_code}
        except ContextLookupError as exc:
            failure = exc.result.failure
            logger.warning(
                "chat_run.context_lookup_failed",
                run_id=str(run.id),
                failure_code=failure.code if failure is not None else None,
                failure_message=failure.message if failure is not None else str(exc),
            )
            error_code = ApiErrorCode.E_CONTEXT_TOO_LARGE.value
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
            )
            return {"status": "error", "error_code": error_code}

        assistant_message = db.get(Message, run.assistant_message_id)
        _, prompt_evidence_rows = (
            message_prompt_evidence_rows(
                db,
                run,
                assistant_message,
                reconcile_inclusion=False,
            )
            if assistant_message is not None
            else (None, [])
        )
        buffer_provider_deltas = (
            is_source_backed_run(
                db,
                run=run,
                assistant_message=assistant_message,
                evidence_rows=prompt_evidence_rows,
            )
            if assistant_message is not None
            else False
        )
        artifact_intent = ArtifactIntentOptions.model_validate(run.artifact_intent)
        if artifact_intent.kind != "off" and assistant_message is not None:
            await append_generated_artifact_delta(
                db,
                run=run,
                user_message=user_message,
                model=model,
                resolved_key=resolved_key,
                llm_router=llm_router,
                artifact_intent=artifact_intent,
                evidence_rows=prompt_evidence_rows,
                source_backed=buffer_provider_deltas,
            )
            if is_cancel_requested(db, run.id):
                finalize_cancelled(
                    db,
                    run,
                    model,
                    resolved_key,
                    int((time.monotonic() - start_time) * 1000),
                )
                return {"status": "cancelled"}

        llm_request = assembly.llm_request
        full_content = ""
        usage: LLMUsage | None = None
        provider_request_id: str | None = None
        incomplete_reason: str | None = None
        terminal_seen = False
        locally_truncated = False
        llm_start = time.monotonic()
        llm_log_fields = safe_kv(
            provider=model.provider,
            model_name=llm_request.model_name,
            reasoning_effort=llm_request.reasoning_effort,
            key_mode=resolved_key.mode,
            streaming=True,
            llm_operation="chat_send",
            conversation_id=str(run.conversation_id),
            assistant_message_id=str(run.assistant_message_id),
            prompt_chars=assembly.prompt_plan.text_char_count(),
            stable_prefix_hash=assembly.prompt_plan.stable_prefix_hash,
            provider_request_hash=assembly.prompt_plan.provider_request_hash,
            cacheable_input_tokens_estimate=assembly.prompt_plan.cacheable_input_tokens_estimate,
            scope_type=str(assembly.scope_metadata.get("type") or "general"),
        )
        logger.info("llm.request.started", **llm_log_fields)
        try:
            async for chunk in llm_router.generate_stream(
                model.provider,
                llm_request,
                resolved_key.api_key,
                timeout_s=int(LLM_TIMEOUT_SECONDS),
            ):
                if chunk.done:
                    terminal_seen = True
                    usage = chunk.usage
                    provider_request_id = chunk.provider_request_id
                    if chunk.status == "incomplete":
                        incomplete_reason = "unknown"
                        if chunk.incomplete_details is not None:
                            reason = chunk.incomplete_details.get("reason")
                            incomplete_reason = reason if isinstance(reason, str) else "unknown"
                    break
                if chunk.delta_text:
                    delta = chunk.delta_text
                    if len(full_content) + len(delta) > MAX_ASSISTANT_CONTENT_LENGTH:
                        remaining = MAX_ASSISTANT_CONTENT_LENGTH - len(full_content)
                        delta = delta[: max(remaining, 0)] + TRUNCATION_NOTICE
                    if delta:
                        full_content += delta
                        if not buffer_provider_deltas:
                            append_and_commit(db, run.id, "delta", {"delta": delta})
                    if len(full_content) >= MAX_ASSISTANT_CONTENT_LENGTH:
                        locally_truncated = True
                        break
                if is_cancel_requested(db, run.id):
                    finalize_cancelled(
                        db,
                        run,
                        model,
                        resolved_key,
                        int((time.monotonic() - start_time) * 1000),
                    )
                    return {"status": "cancelled"}
        except (LLMError, httpx.ResponseNotRead) as exc:
            llm_error = (
                _llm_error_from_unread_stream_response(exc, model.provider)
                if isinstance(exc, httpx.ResponseNotRead)
                else exc
            )
            latency_ms = int((time.monotonic() - start_time) * 1000)
            error_code = LLM_ERROR_CODE_TO_API_ERROR_CODE[llm_error.error_code].value
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=error_code,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                ),
            )
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
            )
            return {"status": "error", "error_code": error_code}

        if not terminal_seen and not locally_truncated:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

        if incomplete_reason is not None:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=ApiErrorCode.E_LLM_INCOMPLETE.value,
                    incomplete_reason=incomplete_reason,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                    **usage_log_fields(usage),
                    provider_request_id=provider_request_id,
                ),
            )
            finalize_error(
                db,
                run_id=run.id,
                error_code=ApiErrorCode.E_LLM_INCOMPLETE.value,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INCOMPLETE.value}

        if usage_tokens(usage)["total_tokens"] is None:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            error_code = ApiErrorCode.E_LLM_PROVIDER_DOWN.value
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=error_code,
                    missing_provider_usage=True,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                    provider_request_id=provider_request_id,
                ),
            )
            finalize_error(
                db,
                run_id=run.id,
                error_code=error_code,
                viewer_id=run.owner_user_id,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
            )
            return {"status": "error", "error_code": error_code}

        logger.info(
            "llm.request.finished",
            **safe_kv(
                **llm_log_fields,
                outcome="success",
                latency_ms=int((time.monotonic() - llm_start) * 1000),
                **usage_log_fields(usage),
                provider_request_id=provider_request_id,
            ),
        )

        verified_content, verifier_hint = await verified_assistant_content(
            db,
            run=run,
            model=model,
            resolved_key=resolved_key,
            llm_router=llm_router,
            assistant_content=full_content,
        )
        if buffer_provider_deltas and verified_content:
            append_and_commit(db, run.id, "delta", {"delta": verified_content})

        latency_ms = int((time.monotonic() - start_time) * 1000)
        finalize_run(
            db,
            run_id=run.id,
            assistant_content=verified_content,
            assistant_status="complete",
            run_status="complete",
            done_status="complete",
            error_code=None,
            model=model,
            resolved_key=resolved_key,
            key_mode=run.key_mode,
            latency_ms=latency_ms,
            usage=usage,
            provider_request_id=provider_request_id,
            viewer_id=run.owner_user_id,
            verifier_hint=verifier_hint,
        )
        refresh_conversation_memory(
            db,
            conversation_id=run.conversation_id,
            prompt_version=PROMPT_VERSION,
        )
        db.commit()
        if resolved_key.mode == "platform":
            actual_tokens = usage_tokens(usage)["total_tokens"]
            assert actual_tokens is not None
            rate_limiter.commit_token_budget(
                run.owner_user_id, run.assistant_message_id, actual_tokens
            )
            budget_reserved = False
        return {"status": "complete"}
    finally:
        if budget_reserved:
            rate_limiter.release_token_budget(run.owner_user_id, run.assistant_message_id)
        rate_limiter.release_inflight_slot(run.owner_user_id)
