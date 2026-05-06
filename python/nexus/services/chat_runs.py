"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming; the stream route only tails persisted
events.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, cast
from uuid import UUID

from llm_calling.errors import LLMError, LLMErrorCode
from llm_calling.router import LLMRouter
from llm_calling.types import LLMUsage
from sqlalchemy import bindparam, select, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.auth.permissions import can_read_highlight, can_read_media
from nexus.config import get_settings
from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    Conversation,
    Media,
    Message,
    MessageLLM,
    Model,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.conversation import (
    MAX_CONTEXTS,
    MAX_MESSAGE_CONTENT_LENGTH,
    ChatRunEventOut,
    ChatRunOut,
    ChatRunResponse,
    ContextItem,
    ConversationScopeRequest,
    WebSearchOptions,
)
from nexus.schemas.notes import ObjectRef
from nexus.services.agent_tools.app_search import execute_app_search
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_CALL_INDEX,
    WEB_SEARCH_TOOL_NAME,
    execute_web_search,
)
from nexus.services.api_key_resolver import (
    ResolvedKey,
    get_model_by_id,
    is_provider_enabled,
    resolve_api_key,
    update_user_key_status,
)
from nexus.services.context_assembler import (
    assemble_chat_context,
    load_message_context_refs,
    load_recent_history_units,
    message_context_ref_payloads,
    persist_prompt_assembly,
)
from nexus.services.context_lookup import ContextLookupError
from nexus.services.context_rendering import PROMPT_VERSION
from nexus.services.contexts import insert_contexts_batch
from nexus.services.conversation_memory import (
    collect_memory_source_refs,
    load_active_memory_items,
    load_active_state_snapshot,
    refresh_conversation_memory,
)
from nexus.services.conversations import (
    DEFAULT_CONVERSATION_TITLE,
    authorize_conversation_scope,
    conversation_scope_metadata,
    conversation_to_out,
    derive_conversation_title,
    get_message_count,
    load_message_context_snapshots_for_message_ids,
    load_message_evidence_for_message_ids,
    load_message_tool_calls_for_message_ids,
    message_to_out,
    resolve_conversation_for_scope,
)
from nexus.services.models import get_model_catalog_metadata
from nexus.services.object_refs import hydrate_object_ref
from nexus.services.prompt_budget import ContextBudgetError
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.retrieval_planner import build_retrieval_plan
from nexus.services.seq import assign_next_message_seq

logger = get_logger(__name__)

TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})
MAX_ASSISTANT_CONTENT_LENGTH = 50000
TRUNCATION_NOTICE = "\n\n[Response truncated due to length]"
LLM_TIMEOUT_SECONDS = 45.0

ERROR_CODE_TO_MESSAGE = {
    "E_LLM_TIMEOUT": "The model timed out while responding. Please try again.",
    "E_LLM_RATE_LIMIT": "The model is temporarily rate-limited. Please try again shortly.",
    "E_LLM_INVALID_KEY": "The configured API key is invalid or has been revoked.",
    "E_LLM_PROVIDER_DOWN": "The model provider is currently unavailable. Please try again later.",
    "E_LLM_BAD_REQUEST": (
        "The request was rejected by the model provider. Please try a different model or setting."
    ),
    "E_LLM_CONTEXT_TOO_LARGE": "The context was too large for the model. Please try with less context.",
    "E_MODEL_NOT_AVAILABLE": "The requested model is not available.",
    "E_LLM_INTERRUPTED": "The model response was interrupted. Please try again.",
    "E_LLM_INCOMPLETE": (
        "The model ran out of output tokens before it could finish. "
        "Try again with less context or a lower reasoning setting."
    ),
    "E_CONTEXT_TOO_LARGE": "One selected context is too large or unavailable. Remove it and try again.",
    "E_APP_SEARCH_FAILED": "The scoped content search failed. Please try again.",
    "E_CANCELLED": "Request cancelled.",
    "E_TOKEN_BUDGET_EXCEEDED": "Monthly AI token quota exceeded.",
}

LLM_INCOMPLETE_ERROR_CODE = ApiErrorCode.E_LLM_INCOMPLETE.value
REASONING_OUTPUT_TOKENS = 25000
DEFAULT_OUTPUT_TOKENS = 4096

LLM_ERROR_CODE_TO_API_ERROR_CODE = {
    LLMErrorCode.INVALID_KEY: ApiErrorCode.E_LLM_INVALID_KEY,
    LLMErrorCode.RATE_LIMIT: ApiErrorCode.E_LLM_RATE_LIMIT,
    LLMErrorCode.CONTEXT_TOO_LARGE: ApiErrorCode.E_LLM_CONTEXT_TOO_LARGE,
    LLMErrorCode.TIMEOUT: ApiErrorCode.E_LLM_TIMEOUT,
    LLMErrorCode.PROVIDER_DOWN: ApiErrorCode.E_LLM_PROVIDER_DOWN,
    LLMErrorCode.BAD_REQUEST: ApiErrorCode.E_LLM_BAD_REQUEST,
    LLMErrorCode.MODEL_NOT_AVAILABLE: ApiErrorCode.E_MODEL_NOT_AVAILABLE,
}


@dataclass
class PreparedMessages:
    conversation: Conversation
    user_message: Message
    assistant_message: Message


def _api_error_code_for_llm_error(error_code: LLMErrorCode) -> ApiErrorCode:
    return LLM_ERROR_CODE_TO_API_ERROR_CODE[error_code]


def _llm_error_code_value(exc: LLMError) -> str:
    return _api_error_code_for_llm_error(exc.error_code).value


def _max_output_tokens_for_reasoning(model: Model, reasoning: str) -> int:
    if model.provider == "openai" and reasoning in {"default", "low", "medium", "high", "max"}:
        return min(REASONING_OUTPUT_TOKENS, model.max_context_tokens)
    return min(DEFAULT_OUTPUT_TOKENS, model.max_context_tokens)


def compute_payload_hash(
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    web_search: WebSearchOptions,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
) -> str:
    sorted_contexts = sorted(
        (ctx.model_dump(mode="json") for ctx in contexts),
        key=lambda payload: json.dumps(payload, sort_keys=True, separators=(",", ":")),
    )
    payload_scope = conversation_scope.model_dump(mode="json") if conversation_scope else None
    payload = (
        f"{conversation_id}|{content}|{model_id}|{reasoning}|{key_mode}|"
        f"{payload_scope}|{sorted_contexts}|{web_search.model_dump(mode='json')}"
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    web_search: WebSearchOptions,
    idempotency_key: str | None,
) -> ChatRunResponse:
    contexts = list(contexts)
    if (conversation_id is None) == (conversation_scope is None):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Exactly one of conversation_id or conversation_scope is required",
        )
    normalized_key = (idempotency_key or "").strip()
    if not normalized_key:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is required")
    if len(normalized_key) > 128:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key is too long")

    payload_hash = compute_payload_hash(
        content,
        model_id,
        reasoning,
        key_mode,
        contexts,
        web_search,
        conversation_id,
        conversation_scope,
    )

    existing = _get_run_by_idempotency_key(db, viewer_id, normalized_key)
    if existing is not None:
        _raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
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
        use_platform_key = False

    validate_pre_phase(
        db,
        viewer_id,
        conversation_id,
        conversation_scope,
        content,
        model_id,
        reasoning,
        key_mode,
        contexts,
        use_platform_key,
    )

    try:
        _lock_idempotency_key(db, viewer_id, normalized_key)
        existing = _get_run_by_idempotency_key(db, viewer_id, normalized_key)
        if existing is not None:
            _raise_if_payload_mismatch(existing, payload_hash, viewer_id, normalized_key)
            db.commit()
            return build_chat_run_response(db, viewer_id, existing)

        prepared = prepare_messages(
            db,
            viewer_id,
            conversation_id,
            conversation_scope,
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


def get_chat_run(db: Session, *, viewer_id: UUID, run_id: UUID) -> ChatRunResponse:
    run = _get_run_for_owner(db, viewer_id, run_id)
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
    run = _get_run_for_owner(db, viewer_id, run_id)
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
    _get_run_for_owner(db, viewer_id, run_id)
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
    run = _get_run_for_owner(db, viewer_id, run_id)
    return run.status in TERMINAL_RUN_STATUSES


def assert_chat_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    _get_run_for_owner(db, viewer_id, run_id)


async def execute_chat_run(
    db: Session,
    *,
    run_id: UUID,
    llm_router: LLMRouter,
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
    except Exception as exc:
        logger.exception("chat_run.unhandled_error", run_id=str(run_id), error=str(exc))
        try:
            _finalize_run(
                db,
                run_id=run_id,
                assistant_content="An unexpected error occurred. Please try again.",
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=ApiErrorCode.E_INTERNAL.value,
                model=None,
                resolved_key=None,
                key_mode="auto",
                latency_ms=0,
                usage=None,
                provider_request_id=None,
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
    llm_router: LLMRouter,
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

    if _has_delta_without_terminal(db, run.id):
        _finalize_interrupted(db, run)
        return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

    model = db.get(Model, run.model_id)
    if model is None:
        _finalize_run(
            db,
            run_id=run.id,
            assistant_content=ERROR_CODE_TO_MESSAGE["E_MODEL_NOT_AVAILABLE"],
            assistant_status="error",
            run_status="error",
            done_status="error",
            error_code=ApiErrorCode.E_MODEL_NOT_AVAILABLE.value,
            model=None,
            resolved_key=None,
            key_mode=run.key_mode,
            latency_ms=0,
            usage=None,
            provider_request_id=None,
            viewer_id=run.owner_user_id,
        )
        return {"status": "error", "error_code": ApiErrorCode.E_MODEL_NOT_AVAILABLE.value}

    _mark_running(db, run.id)
    run = db.get(ChatRun, run.id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return {"status": "skipped", "reason": "terminal"}
    if run.cancel_requested_at is not None:
        _finalize_cancelled(db, run, model, None, 0)
        return {"status": "cancelled"}

    try:
        resolved_key = resolve_api_key(db, run.owner_user_id, model.provider, run.key_mode)
    except LLMError as exc:
        error_code = _llm_error_code_value(exc)
        _finalize_run(
            db,
            run_id=run.id,
            assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INVALID_KEY"],
            assistant_status="error",
            run_status="error",
            done_status="error",
            error_code=error_code,
            model=model,
            resolved_key=_dummy_resolved_key(model),
            key_mode=run.key_mode,
            latency_ms=0,
            usage=None,
            provider_request_id=None,
            viewer_id=run.owner_user_id,
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
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content="Conversation not found.",
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=ApiErrorCode.E_CONVERSATION_NOT_FOUND.value,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
                usage=None,
                provider_request_id=None,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_CONVERSATION_NOT_FOUND.value}

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
        history_units = load_recent_history_units(
            db,
            conversation_id=conversation.id,
            before_seq=user_message.seq,
            after_seq=after_seq,
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
            _append_and_commit(
                db,
                run.id,
                "tool_call",
                {
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_name": "app_search",
                    "tool_call_index": 0,
                    "status": "started",
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
                content=user_message.content,
                has_user_context=bool(attached_context_refs),
                scope=retrieval_plan.app_search.scope,
                history=planner_history,
                scope_metadata=scope_metadata,
                planned_query=retrieval_plan.app_search.query,
                planned_types=retrieval_plan.app_search.types,
                planned_filters=retrieval_plan.app_search.filters,
                force=True,
            )
            if app_search_run is not None:
                _append_and_commit(db, run.id, "tool_result", app_search_run.tool_result_event())
                if app_search_run.status == "error" and scope_metadata.get("type") in {
                    "media",
                    "library",
                }:
                    latency_ms = int((time.monotonic() - start_time) * 1000)
                    _finalize_run(
                        db,
                        run_id=run.id,
                        assistant_content=ERROR_CODE_TO_MESSAGE[
                            ApiErrorCode.E_APP_SEARCH_FAILED.value
                        ],
                        assistant_status="error",
                        run_status="error",
                        done_status="error",
                        error_code=ApiErrorCode.E_APP_SEARCH_FAILED.value,
                        model=model,
                        resolved_key=resolved_key,
                        key_mode=run.key_mode,
                        latency_ms=latency_ms,
                        usage=None,
                        provider_request_id=None,
                        viewer_id=run.owner_user_id,
                    )
                    return {
                        "status": "error",
                        "error_code": ApiErrorCode.E_APP_SEARCH_FAILED.value,
                    }

        if _is_cancel_requested(db, run.id):
            _finalize_cancelled(
                db, run, model, resolved_key, int((time.monotonic() - start_time) * 1000)
            )
            return {"status": "cancelled"}

        web_search = WebSearchOptions.model_validate(run.web_search)
        if retrieval_plan.web_search.enabled:
            _append_and_commit(
                db,
                run.id,
                "tool_call",
                {
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_name": WEB_SEARCH_TOOL_NAME,
                    "tool_call_index": WEB_SEARCH_TOOL_CALL_INDEX,
                    "status": "started",
                    "scope": "public_web",
                    "types": ["mixed"],
                    "semantic": False,
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
                _append_and_commit(db, run.id, "tool_result", web_search_run.tool_result_event())
                for citation in web_search_run.selected_citations:
                    _append_and_commit(
                        db,
                        run.id,
                        "citation",
                        citation.citation_event(
                            run.assistant_message_id,
                            web_search_run.tool_call_index,
                        ),
                    )

        if _is_cancel_requested(db, run.id):
            _finalize_cancelled(
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
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE[error_code],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=error_code,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
                usage=None,
                provider_request_id=None,
                viewer_id=run.owner_user_id,
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
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE[error_code],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=error_code,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=int((time.monotonic() - start_time) * 1000),
                usage=None,
                provider_request_id=None,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": error_code}

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
                        _append_and_commit(db, run.id, "delta", {"delta": delta})
                    if len(full_content) >= MAX_ASSISTANT_CONTENT_LENGTH:
                        locally_truncated = True
                        break
                if _is_cancel_requested(db, run.id):
                    _finalize_cancelled(
                        db,
                        run,
                        model,
                        resolved_key,
                        int((time.monotonic() - start_time) * 1000),
                    )
                    return {"status": "cancelled"}
        except LLMError as exc:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            error_code = _llm_error_code_value(exc)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=error_code,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                ),
            )
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE.get(
                    error_code,
                    "An unexpected error occurred. Please try again.",
                ),
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=error_code,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": error_code}

        if not terminal_seen and not locally_truncated:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INTERRUPTED"],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": ApiErrorCode.E_LLM_INTERRUPTED.value}

        if incomplete_reason is not None:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            logger.error(
                "llm.request.failed",
                **safe_kv(
                    **llm_log_fields,
                    outcome="error",
                    error_class=LLM_INCOMPLETE_ERROR_CODE,
                    incomplete_reason=incomplete_reason,
                    latency_ms=int((time.monotonic() - llm_start) * 1000),
                    tokens_input=_usage_input_tokens(usage),
                    tokens_output=_usage_output_tokens(usage),
                    tokens_total=_usage_total_tokens(usage),
                    tokens_reasoning=_usage_reasoning_tokens(usage),
                    cache_write_input_tokens=_usage_cache_write_input_tokens(usage),
                    cache_read_input_tokens=_usage_cache_read_input_tokens(usage),
                    cached_input_tokens=_usage_cached_input_tokens(usage),
                    provider_request_id=provider_request_id,
                ),
            )
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE[LLM_INCOMPLETE_ERROR_CODE],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=LLM_INCOMPLETE_ERROR_CODE,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": LLM_INCOMPLETE_ERROR_CODE}

        if _usage_total_tokens(usage) is None:
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
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=ERROR_CODE_TO_MESSAGE[error_code],
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=error_code,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=usage,
                provider_request_id=provider_request_id,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": error_code}

        logger.info(
            "llm.request.finished",
            **safe_kv(
                **llm_log_fields,
                outcome="success",
                latency_ms=int((time.monotonic() - llm_start) * 1000),
                tokens_input=_usage_input_tokens(usage),
                tokens_output=_usage_output_tokens(usage),
                tokens_total=_usage_total_tokens(usage),
                tokens_reasoning=_usage_reasoning_tokens(usage),
                cache_write_input_tokens=_usage_cache_write_input_tokens(usage),
                cache_read_input_tokens=_usage_cache_read_input_tokens(usage),
                cached_input_tokens=_usage_cached_input_tokens(usage),
                provider_request_id=provider_request_id,
            ),
        )

        latency_ms = int((time.monotonic() - start_time) * 1000)
        _finalize_run(
            db,
            run_id=run.id,
            assistant_content=full_content,
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
        )
        refresh_conversation_memory(
            db,
            conversation_id=run.conversation_id,
            prompt_version=PROMPT_VERSION,
        )
        db.commit()
        if resolved_key.mode == "platform":
            actual_tokens = _usage_total_tokens(usage)
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


def validate_pre_phase(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    use_platform_key: bool,
) -> Model:
    if len(content) > MAX_MESSAGE_CONTENT_LENGTH:
        raise ApiError(
            ApiErrorCode.E_MESSAGE_TOO_LONG,
            f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
        )
    if len(contexts) > MAX_CONTEXTS:
        raise ApiError(
            ApiErrorCode.E_CONTEXT_TOO_LARGE,
            f"Maximum {MAX_CONTEXTS} context items allowed",
        )

    model = get_model_by_id(db, model_id)
    if model is None or not model.is_available:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found or not available")
    metadata = get_model_catalog_metadata(model.provider, model.model_name)
    if metadata is None:
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model is outside the curated catalog")
    if not is_provider_enabled(model.provider):
        raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model provider is disabled")
    _, _, _, reasoning_modes = metadata
    if reasoning not in reasoning_modes:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reasoning mode '{reasoning}' is not supported for {model.provider}/{model.model_name}",
        )

    try:
        resolve_api_key(db, viewer_id, model.provider, key_mode)
    except LLMError as exc:
        raise ApiError(ApiErrorCode.E_LLM_NO_KEY, str(exc.message)) from exc

    for ctx in contexts:
        _validate_context_visibility(db, viewer_id, ctx)

    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer_id)
    rate_limiter.check_concurrent_limit(viewer_id)
    if use_platform_key:
        rate_limiter.check_token_budget(viewer_id)
    if conversation_id is not None:
        _check_conversation_not_busy(db, viewer_id, conversation_id)
    elif conversation_scope is not None:
        authorize_conversation_scope(db, viewer_id, conversation_scope)
        if conversation_scope.type == "media":
            existing_conversation = (
                db.execute(
                    select(Conversation).where(
                        Conversation.owner_user_id == viewer_id,
                        Conversation.scope_type == "media",
                        Conversation.scope_media_id == conversation_scope.media_id,
                    )
                )
                .scalars()
                .first()
            )
            if existing_conversation is not None:
                _check_conversation_not_busy(db, viewer_id, existing_conversation.id)
        elif conversation_scope.type == "library":
            existing_conversation = (
                db.execute(
                    select(Conversation).where(
                        Conversation.owner_user_id == viewer_id,
                        Conversation.scope_type == "library",
                        Conversation.scope_library_id == conversation_scope.library_id,
                    )
                )
                .scalars()
                .first()
            )
            if existing_conversation is not None:
                _check_conversation_not_busy(db, viewer_id, existing_conversation.id)
        elif conversation_scope.type == "general":
            pass
        else:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Invalid conversation scope")

    return model


def prepare_messages(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    conversation_scope: ConversationScopeRequest | None,
    content: str,
    model_id: UUID,
    contexts: Sequence[ContextItem],
) -> PreparedMessages:
    if conversation_id is None and conversation_scope is not None:
        conversation = resolve_conversation_for_scope(db, viewer_id, conversation_scope, content)
    elif conversation_id is not None and conversation_scope is None:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    else:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Exactly one of conversation_id or conversation_scope is required",
        )

    user_seq = assign_next_message_seq(db, conversation.id)
    if user_seq == 1 and conversation.title == DEFAULT_CONVERSATION_TITLE:
        conversation.title = derive_conversation_title(content)

    user_message = Message(
        conversation_id=conversation.id,
        seq=user_seq,
        role="user",
        content=content,
        status="complete",
        model_id=None,
    )
    db.add(user_message)
    db.flush()

    insert_contexts_batch(db=db, message_id=user_message.id, contexts=contexts)
    db.flush()

    assistant_message = Message(
        conversation_id=conversation.id,
        seq=assign_next_message_seq(db, conversation.id),
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
    )
    db.add(assistant_message)
    db.flush()

    return PreparedMessages(
        conversation=conversation,
        user_message=user_message,
        assistant_message=assistant_message,
    )


def append_run_event(db: Session, run: ChatRun, event_type: str, payload: dict[str, Any]) -> None:
    seq = run.next_event_seq
    db.add(ChatRunEvent(run_id=run.id, seq=seq, event_type=event_type, payload=payload))
    run.next_event_seq = seq + 1
    run.updated_at = datetime.now(UTC)
    db.flush()


def build_chat_run_response(db: Session, viewer_id: UUID, run: ChatRun) -> ChatRunResponse:
    conversation = db.get(Conversation, run.conversation_id)
    user_message = db.get(Message, run.user_message_id)
    assistant_message = db.get(Message, run.assistant_message_id)
    if conversation is None or user_message is None or assistant_message is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")

    message_ids = [user_message.id, assistant_message.id]
    contexts_by_message_id = load_message_context_snapshots_for_message_ids(db, message_ids)
    tool_calls_by_message_id = load_message_tool_calls_for_message_ids(db, message_ids)
    (
        evidence_summary_by_message_id,
        claims_by_message_id,
        claim_evidence_by_message_id,
    ) = load_message_evidence_for_message_ids(db, message_ids)
    return ChatRunResponse(
        run=ChatRunOut.model_validate(run),
        conversation=conversation_to_out(
            db,
            conversation,
            get_message_count(db, conversation.id),
            viewer_id=viewer_id,
        ),
        user_message=message_to_out(
            user_message,
            contexts_by_message_id.get(user_message.id, []),
            tool_calls_by_message_id.get(user_message.id, []),
            evidence_summary_by_message_id.get(user_message.id),
            claims_by_message_id.get(user_message.id, []),
            claim_evidence_by_message_id.get(user_message.id, []),
        ),
        assistant_message=message_to_out(
            assistant_message,
            contexts_by_message_id.get(assistant_message.id, []),
            tool_calls_by_message_id.get(assistant_message.id, []),
            evidence_summary_by_message_id.get(assistant_message.id),
            claims_by_message_id.get(assistant_message.id, []),
            claim_evidence_by_message_id.get(assistant_message.id, []),
        ),
    )


def _get_run_for_owner(db: Session, viewer_id: UUID, run_id: UUID) -> ChatRun:
    run = db.get(ChatRun, run_id)
    if run is None or run.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Chat run not found")
    return run


def _get_run_by_idempotency_key(
    db: Session, viewer_id: UUID, idempotency_key: str
) -> ChatRun | None:
    return (
        db.execute(
            select(ChatRun).where(
                ChatRun.owner_user_id == viewer_id,
                ChatRun.idempotency_key == idempotency_key,
            )
        )
        .scalars()
        .first()
    )


def _raise_if_payload_mismatch(
    run: ChatRun,
    payload_hash: str,
    viewer_id: UUID,
    idempotency_key: str,
) -> None:
    if run.payload_hash == payload_hash:
        return
    logger.warning(
        "chat_run.idempotency_mismatch",
        **safe_kv(idempotency_key=idempotency_key, viewer_id=str(viewer_id)),
    )
    raise ApiError(
        ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
        "Idempotency key reused with different payload",
    )


def _lock_idempotency_key(db: Session, viewer_id: UUID, idempotency_key: str) -> None:
    db.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:lock_key, 0))"),
        {"lock_key": f"chat_run:{viewer_id}:{idempotency_key}"},
    )


def _append_and_commit(db: Session, run_id: UUID, event_type: str, payload: dict[str, Any]) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
    if run.status in TERMINAL_RUN_STATUSES:
        db.commit()
        return
    append_run_event(db, run, event_type, payload)
    db.commit()


def _mark_running(db: Session, run_id: UUID) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
    if run.status == "queued":
        run.status = "running"
        run.started_at = run.started_at or datetime.now(UTC)
        run.updated_at = datetime.now(UTC)
    db.commit()


def _is_cancel_requested(db: Session, run_id: UUID) -> bool:
    run = db.get(ChatRun, run_id)
    return run is not None and run.cancel_requested_at is not None


def _has_delta_without_terminal(db: Session, run_id: UUID) -> bool:
    rows = db.execute(
        text(
            """
            SELECT event_type
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type IN ('delta', 'done')
            """
        ),
        {"run_id": run_id},
    ).fetchall()
    event_types = {row[0] for row in rows}
    return "delta" in event_types and "done" not in event_types


def _finalize_interrupted(db: Session, run: ChatRun) -> None:
    model = db.get(Model, run.model_id)
    _finalize_run(
        db,
        run_id=run.id,
        assistant_content=ERROR_CODE_TO_MESSAGE["E_LLM_INTERRUPTED"],
        assistant_status="error",
        run_status="error",
        done_status="error",
        error_code=ApiErrorCode.E_LLM_INTERRUPTED.value,
        model=model,
        resolved_key=_dummy_resolved_key(model) if model is not None else None,
        key_mode=run.key_mode,
        latency_ms=0,
        usage=None,
        provider_request_id=None,
        viewer_id=run.owner_user_id,
    )


def _finalize_cancelled(
    db: Session,
    run: ChatRun,
    model: Model,
    resolved_key: ResolvedKey | None,
    latency_ms: int,
) -> None:
    _finalize_run(
        db,
        run_id=run.id,
        assistant_content=ERROR_CODE_TO_MESSAGE["E_CANCELLED"],
        assistant_status="error",
        run_status="cancelled",
        done_status="cancelled",
        error_code=ApiErrorCode.E_CANCELLED.value,
        model=model,
        resolved_key=resolved_key,
        key_mode=run.key_mode,
        latency_ms=latency_ms,
        usage=None,
        provider_request_id=None,
        viewer_id=run.owner_user_id,
    )


def _usage_value(usage: LLMUsage | None, name: str) -> int | None:
    if usage is None:
        return None
    value = getattr(usage, name, None)
    if isinstance(value, int):
        return value
    return None


def _usage_input_tokens(usage: LLMUsage | None) -> int | None:
    return _usage_value(usage, "input_tokens")


def _usage_output_tokens(usage: LLMUsage | None) -> int | None:
    return _usage_value(usage, "output_tokens")


def _usage_total_tokens(usage: LLMUsage | None) -> int | None:
    total = _usage_value(usage, "total_tokens")
    if total is not None:
        return total
    input_tokens = _usage_input_tokens(usage)
    output_tokens = _usage_output_tokens(usage)
    if input_tokens is None or output_tokens is None:
        return None
    return input_tokens + output_tokens + (_usage_reasoning_tokens(usage) or 0)


def _usage_reasoning_tokens(usage: LLMUsage | None) -> int | None:
    return _usage_value(usage, "reasoning_tokens")


def _usage_cache_write_input_tokens(usage: LLMUsage | None) -> int | None:
    if usage is None:
        return None
    return _usage_value(usage, "cache_write_input_tokens") or 0


def _usage_cache_read_input_tokens(usage: LLMUsage | None) -> int | None:
    if usage is None:
        return None
    return _usage_value(usage, "cache_read_input_tokens") or 0


def _usage_cached_input_tokens(usage: LLMUsage | None) -> int | None:
    if usage is None:
        return None
    return _usage_value(usage, "cached_input_tokens") or 0


def _usage_provider_json(usage: LLMUsage | None) -> dict[str, object] | None:
    if usage is None:
        return None
    provider_usage = getattr(usage, "provider_usage", None)
    if isinstance(provider_usage, dict):
        return provider_usage
    return {
        "input_tokens": _usage_input_tokens(usage),
        "output_tokens": _usage_output_tokens(usage),
        "total_tokens": _usage_total_tokens(usage),
        "reasoning_tokens": _usage_reasoning_tokens(usage),
        "cache_write_input_tokens": _usage_cache_write_input_tokens(usage),
        "cache_read_input_tokens": _usage_cache_read_input_tokens(usage),
        "cached_input_tokens": _usage_cached_input_tokens(usage),
    }


def _prompt_assembly_metadata(
    db: Session,
    *,
    run_id: UUID,
) -> tuple[str | None, str | None]:
    row = db.execute(
        text(
            """
            SELECT prompt_plan_version, stable_prefix_hash
            FROM chat_prompt_assemblies
            WHERE chat_run_id = :run_id
            """
        ),
        {"run_id": run_id},
    ).first()
    if row is None:
        return None, None
    return row[0], row[1]


def _finalize_run(
    db: Session,
    *,
    run_id: UUID,
    assistant_content: str,
    assistant_status: str,
    run_status: str,
    done_status: str,
    error_code: str | None,
    model: Model | None,
    resolved_key: ResolvedKey | None,
    key_mode: str,
    latency_ms: int,
    usage: LLMUsage | None,
    provider_request_id: str | None,
    viewer_id: UUID | None,
) -> None:
    run = (
        db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().first()
    )
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        db.commit()
        return

    assistant_message = db.get(Message, run.assistant_message_id)
    if assistant_message is not None:
        content = assistant_content
        if assistant_status == "complete" and len(content) > MAX_ASSISTANT_CONTENT_LENGTH:
            content = content[:MAX_ASSISTANT_CONTENT_LENGTH] + TRUNCATION_NOTICE
        assistant_message.content = content
        assistant_message.status = assistant_status
        assistant_message.error_code = error_code
        assistant_message.updated_at = datetime.now(UTC)
        if assistant_status == "complete":
            _finalize_message_evidence(db, run, assistant_message)

    key = resolved_key or (model and _dummy_resolved_key(model))
    if assistant_message is not None and model is not None and key is not None:
        existing_llm = db.get(MessageLLM, assistant_message.id)
        input_tokens = _usage_input_tokens(usage)
        output_tokens = _usage_output_tokens(usage)
        total_tokens = _usage_total_tokens(usage)
        reasoning_tokens = _usage_reasoning_tokens(usage)
        cache_write_input_tokens = _usage_cache_write_input_tokens(usage)
        cache_read_input_tokens = _usage_cache_read_input_tokens(usage)
        cached_input_tokens = _usage_cached_input_tokens(usage)
        provider_usage = _usage_provider_json(usage)
        prompt_plan_version, stable_prefix_hash = _prompt_assembly_metadata(db, run_id=run.id)
        if existing_llm is None:
            db.add(
                MessageLLM(
                    message_id=assistant_message.id,
                    provider=model.provider,
                    model_name=model.model_name,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    total_tokens=total_tokens,
                    reasoning_tokens=reasoning_tokens,
                    cache_write_input_tokens=cache_write_input_tokens,
                    cache_read_input_tokens=cache_read_input_tokens,
                    cached_input_tokens=cached_input_tokens,
                    key_mode_requested=key_mode,
                    key_mode_used=key.mode,
                    latency_ms=latency_ms,
                    error_class=error_code if assistant_status == "error" else None,
                    provider_request_id=provider_request_id,
                    prompt_version=PROMPT_VERSION,
                    prompt_plan_version=prompt_plan_version,
                    stable_prefix_hash=stable_prefix_hash,
                    provider_usage=provider_usage,
                )
            )
        else:
            existing_llm.input_tokens = input_tokens
            existing_llm.output_tokens = output_tokens
            existing_llm.total_tokens = total_tokens
            existing_llm.reasoning_tokens = reasoning_tokens
            existing_llm.cache_write_input_tokens = cache_write_input_tokens
            existing_llm.cache_read_input_tokens = cache_read_input_tokens
            existing_llm.cached_input_tokens = cached_input_tokens
            existing_llm.key_mode_requested = key_mode
            existing_llm.key_mode_used = key.mode
            existing_llm.latency_ms = latency_ms
            existing_llm.error_class = error_code if assistant_status == "error" else None
            existing_llm.provider_request_id = provider_request_id
            existing_llm.prompt_version = PROMPT_VERSION
            existing_llm.prompt_plan_version = prompt_plan_version
            existing_llm.stable_prefix_hash = stable_prefix_hash
            existing_llm.provider_usage = provider_usage

        if key.mode == "byok":
            if assistant_status == "complete":
                update_user_key_status(db, key.user_key_id, "valid")
            elif error_code == ApiErrorCode.E_LLM_INVALID_KEY.value:
                update_user_key_status(db, key.user_key_id, "invalid")

    run.status = run_status
    run.error_code = error_code
    run.completed_at = datetime.now(UTC)
    run.updated_at = datetime.now(UTC)
    done_payload: dict[str, Any] = {"status": done_status}
    if error_code is not None:
        done_payload["error_code"] = error_code
    if assistant_message is not None and done_status == "complete":
        done_payload["final_chars"] = len(assistant_message.content)
    append_run_event(db, run, "done", done_payload)
    db.commit()


def _finalize_message_evidence(db: Session, run: ChatRun, assistant_message: Message) -> None:
    db.execute(
        text(
            """
            DELETE FROM assistant_message_claim_evidence
            WHERE claim_id IN (
                SELECT id
                FROM assistant_message_claims
                WHERE message_id = :message_id
            )
            """
        ),
        {"message_id": assistant_message.id},
    )
    db.execute(
        text("DELETE FROM assistant_message_claims WHERE message_id = :message_id"),
        {"message_id": assistant_message.id},
    )
    db.execute(
        text("DELETE FROM assistant_message_evidence_summaries WHERE message_id = :message_id"),
        {"message_id": assistant_message.id},
    )

    conversation = db.get(Conversation, run.conversation_id)
    scope_type = conversation.scope_type if conversation is not None else "general"
    scope_ref: dict[str, object] | None = None
    if conversation is not None and scope_type == "media" and conversation.scope_media_id:
        scope_ref = {"type": "media", "media_id": str(conversation.scope_media_id)}
    elif conversation is not None and scope_type == "library" and conversation.scope_library_id:
        scope_ref = {"type": "library", "library_id": str(conversation.scope_library_id)}

    assembly_row = db.execute(
        text(
            """
            SELECT id, included_retrieval_ids
            FROM chat_prompt_assemblies
            WHERE chat_run_id = :run_id
            """
        ),
        {"run_id": run.id},
    ).first()
    prompt_assembly_id = assembly_row[0] if assembly_row is not None else None
    included_retrieval_ids = {
        str(retrieval_id) for retrieval_id in (assembly_row[1] if assembly_row else [])
    }
    for retrieval_id in included_retrieval_ids:
        db.execute(
            text(
                """
                UPDATE message_retrievals
                SET included_in_prompt = true,
                    retrieval_status = CASE
                        WHEN result_type = 'web_result' THEN 'web_result'
                        ELSE 'included_in_prompt'
                    END
                WHERE id = :retrieval_id
                """
            ),
            {"retrieval_id": retrieval_id},
        )

    retrieval_rows = db.execute(
        text(
            """
            SELECT mr.id,
                   mr.result_type,
                   mr.source_id,
                   mr.media_id,
                   mr.context_ref,
                   mr.result_ref,
                   mr.deep_link,
                   mr.score,
                   mr.selected,
                   mr.source_title,
                   mr.exact_snippet,
                   mr.snippet_prefix,
                   mr.snippet_suffix,
                   mr.locator,
                   mr.retrieval_status,
                   mr.included_in_prompt,
                   mr.source_version,
                   mr.evidence_span_id
            FROM message_retrievals mr
            JOIN message_tool_calls mtc ON mtc.id = mr.tool_call_id
            WHERE mtc.assistant_message_id = :assistant_message_id
              AND mr.selected = true
            ORDER BY mtc.tool_call_index ASC, mr.ordinal ASC
            """
        ),
        {"assistant_message_id": assistant_message.id},
    ).fetchall()

    evidence_rows = []
    for row in retrieval_rows:
        result_ref = row[5] if isinstance(row[5], dict) else {}
        if result_ref.get("status") in {"no_indexed_evidence", "no_results"}:
            continue
        snippet = row[10] or result_ref.get("snippet")
        if not isinstance(snippet, str) or not snippet.strip():
            continue
        if not row[15]:
            continue
        retrieval_status = row[14]
        if row[1] == "web_result":
            retrieval_status = "web_result"
        elif row[15]:
            retrieval_status = "included_in_prompt"
        elif row[8]:
            retrieval_status = "selected"
        source_ref = {
            "type": "message_retrieval",
            "id": str(row[0]),
            "retrieval_id": str(row[0]),
            "label": row[9] or result_ref.get("title") or result_ref.get("source_label"),
            "context_ref": row[4],
            "result_ref": result_ref,
            "deep_link": row[6],
        }
        if row[3] is not None:
            source_ref["media_id"] = str(row[3])
        if row[17] is not None:
            source_ref["evidence_span_id"] = str(row[17])
        evidence_rows.append(
            {
                "retrieval_id": row[0],
                "evidence_span_id": row[17],
                "source_ref": source_ref,
                "context_ref": row[4],
                "result_ref": result_ref,
                "exact_snippet": snippet.strip(),
                "snippet_prefix": row[11],
                "snippet_suffix": row[12],
                "locator": row[13],
                "deep_link": row[6],
                "score": row[7],
                "retrieval_status": retrieval_status,
                "selected": bool(row[8]),
                "included_in_prompt": bool(row[15]),
                "source_version": row[16],
            }
        )

    answer = assistant_message.content.strip()
    if evidence_rows:
        claim_spans: list[tuple[str, int | None, int | None]] = []
        segment_start = 0
        for index, char in enumerate(assistant_message.content):
            if char not in ".!?\n":
                continue
            segment = assistant_message.content[segment_start : index + 1].strip()
            if segment:
                start = assistant_message.content.find(segment, segment_start, index + 1)
                claim_spans.append((segment, start, start + len(segment)))
            segment_start = index + 1
        segment = assistant_message.content[segment_start:].strip()
        if segment:
            start = assistant_message.content.find(segment, segment_start)
            claim_spans.append((segment, start, start + len(segment)))
        if not claim_spans:
            start = assistant_message.content.find(answer) if answer else -1
            claim_spans.append(
                (
                    answer or "Assistant answer.",
                    start if start >= 0 else None,
                    start + len(answer) if start >= 0 else None,
                )
            )
        support_status = "supported"
        retrieval_status = (
            "web_result"
            if all(row["retrieval_status"] == "web_result" for row in evidence_rows)
            else "included_in_prompt"
        )
        claim_count = len(claim_spans)
        supported_count = len(claim_spans)
        unsupported_count = 0
        not_enough_count = 0
        claim_kind = "answer"
    elif scope_type in {"media", "library"}:
        claim_spans = [(answer or "Not enough evidence in this scope.", None, None)]
        support_status = "not_enough_evidence"
        retrieval_status = "retrieved"
        claim_count = 1
        supported_count = 0
        unsupported_count = 1
        not_enough_count = 1
        claim_kind = "insufficient_evidence"
    else:
        claim_spans = []
        support_status = "not_source_grounded"
        retrieval_status = "retrieved"
        claim_count = 0
        supported_count = 0
        unsupported_count = 0
        not_enough_count = 0
        claim_kind = "answer"

    db.execute(
        text(
            """
            INSERT INTO assistant_message_evidence_summaries (
                message_id,
                scope_type,
                scope_ref,
                retrieval_status,
                support_status,
                verifier_status,
                claim_count,
                supported_claim_count,
                unsupported_claim_count,
                not_enough_evidence_count,
                prompt_assembly_id
            )
            VALUES (
                :message_id,
                :scope_type,
                :scope_ref,
                :retrieval_status,
                :support_status,
                'verified',
                :claim_count,
                :supported_claim_count,
                :unsupported_claim_count,
                :not_enough_evidence_count,
                :prompt_assembly_id
            )
            """
        ).bindparams(bindparam("scope_ref", type_=JSONB)),
        {
            "message_id": assistant_message.id,
            "scope_type": scope_type,
            "scope_ref": scope_ref,
            "retrieval_status": retrieval_status,
            "support_status": support_status,
            "claim_count": claim_count,
            "supported_claim_count": supported_count,
            "unsupported_claim_count": unsupported_count,
            "not_enough_evidence_count": not_enough_count,
            "prompt_assembly_id": prompt_assembly_id,
        },
    )

    if claim_count == 0:
        return

    insert_claim = text(
        """
        INSERT INTO assistant_message_claims (
            message_id,
            ordinal,
            claim_text,
            answer_start_offset,
            answer_end_offset,
            claim_kind,
            support_status,
            verifier_status
        )
        VALUES (
            :message_id,
            :ordinal,
            :claim_text,
            :answer_start_offset,
            :answer_end_offset,
            :claim_kind,
            :support_status,
            'verified'
        )
        RETURNING id
        """
    )

    insert_evidence = text(
        """
        INSERT INTO assistant_message_claim_evidence (
            claim_id,
            ordinal,
            evidence_role,
            source_ref,
            retrieval_id,
            evidence_span_id,
            context_ref,
            result_ref,
            exact_snippet,
            snippet_prefix,
            snippet_suffix,
            locator,
            deep_link,
            score,
            retrieval_status,
            selected,
            included_in_prompt,
            source_version
        )
        VALUES (
            :claim_id,
            :ordinal,
            'supports',
            :source_ref,
            :retrieval_id,
            :evidence_span_id,
            :context_ref,
            :result_ref,
            :exact_snippet,
            :snippet_prefix,
            :snippet_suffix,
            :locator,
            :deep_link,
            :score,
            :retrieval_status,
            :selected,
            :included_in_prompt,
            :source_version
        )
        """
    ).bindparams(
        bindparam("source_ref", type_=JSONB),
        bindparam("context_ref", type_=JSONB),
        bindparam("result_ref", type_=JSONB),
        bindparam("locator", type_=JSONB),
    )
    for claim_ordinal, (claim_text, answer_start, answer_end) in enumerate(claim_spans):
        claim_id = db.execute(
            insert_claim,
            {
                "message_id": assistant_message.id,
                "ordinal": claim_ordinal,
                "claim_text": claim_text,
                "answer_start_offset": answer_start,
                "answer_end_offset": answer_end,
                "claim_kind": claim_kind,
                "support_status": support_status,
            },
        ).scalar_one()
        for evidence_ordinal, row in enumerate(evidence_rows):
            db.execute(
                insert_evidence,
                {"claim_id": claim_id, "ordinal": evidence_ordinal, **row},
            )


def _dummy_resolved_key(model: Model) -> ResolvedKey:
    return ResolvedKey(api_key="", mode="platform", provider=model.provider, user_key_id=None)


def _validate_context_visibility(db: Session, viewer_id: UUID, ctx: ContextItem) -> None:
    if ctx.kind == "reader_selection":
        media = db.get(Media, ctx.media_id)
        if media is None or not can_read_media(db, viewer_id, ctx.media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    if ctx.type == "media":
        media = db.get(Media, ctx.id)
        if media is None or not can_read_media(db, viewer_id, ctx.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    if ctx.type == "highlight":
        if not can_read_highlight(db, viewer_id, ctx.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    hydrate_object_ref(db, viewer_id, ObjectRef(object_type=ctx.type, object_id=ctx.id))
    if ctx.type == "content_chunk" and ctx.evidence_span_ids:
        _validate_context_chunk_evidence_spans(db, ctx.id, ctx.evidence_span_ids)


def _validate_context_chunk_evidence_spans(
    db: Session,
    chunk_id: UUID,
    evidence_span_ids: Sequence[UUID],
) -> None:
    if not evidence_span_ids:
        return
    matched_ids = set(
        db.execute(
            text(
                """
                SELECT es.id
                FROM content_chunks cc
                JOIN media_content_index_states mcis ON mcis.media_id = cc.media_id
                    AND mcis.active_run_id = cc.index_run_id
                JOIN evidence_spans es ON es.media_id = cc.media_id
                    AND es.index_run_id = cc.index_run_id
                WHERE cc.id = :chunk_id
                  AND es.id = ANY(:evidence_span_ids)
                """
            ),
            {"chunk_id": chunk_id, "evidence_span_ids": list(evidence_span_ids)},
        ).scalars()
    )
    if matched_ids != set(evidence_span_ids):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Evidence span is not valid for context")


def _check_conversation_not_busy(db: Session, viewer_id: UUID, conversation_id: UUID) -> None:
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    pending = (
        db.execute(
            select(Message).where(
                Message.conversation_id == conversation_id,
                Message.role == "assistant",
                Message.status == "pending",
            )
        )
        .scalars()
        .first()
    )
    if pending is not None:
        raise ApiError(
            ApiErrorCode.E_CONVERSATION_BUSY,
            "Conversation has a pending assistant message",
        )
