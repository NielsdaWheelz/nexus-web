"""Durable chat-run service.

One chat send is one durable run. HTTP creates/cancels/reads runs; the worker
executes tools and provider streaming; the stream route only tails persisted
events.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, cast
from uuid import UUID

from llm_calling.errors import LLMError, LLMErrorCode
from llm_calling.router import LLMRouter
from llm_calling.types import LLMRequest, LLMUsage, ReasoningEffort, Turn
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from web_search_tool.types import WebSearchProvider

from nexus.auth.permissions import can_read_media
from nexus.db.models import (
    Annotation,
    ChatRun,
    ChatRunEvent,
    Conversation,
    Highlight,
    Media,
    Message,
    MessageContext,
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
    MessageContextRef,
    WebSearchOptions,
)
from nexus.services.agent_tools.app_search import execute_app_search, should_run_app_search
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_CALL_INDEX,
    WEB_SEARCH_TOOL_NAME,
    execute_web_search,
    should_run_web_search,
)
from nexus.services.api_key_resolver import (
    ResolvedKey,
    get_model_by_id,
    is_provider_enabled,
    resolve_api_key,
    update_user_key_status,
)
from nexus.services.chat_prompt import render_prompt
from nexus.services.context_rendering import PROMPT_VERSION, render_context_blocks
from nexus.services.contexts import insert_contexts_batch
from nexus.services.conversations import (
    DEFAULT_CONVERSATION_TITLE,
    conversation_to_out,
    derive_conversation_title,
    get_message_count,
    load_message_context_snapshots_for_message_ids,
    load_message_tool_calls_for_message_ids,
    message_to_out,
)
from nexus.services.models import get_model_catalog_metadata
from nexus.services.quote_context_errors import (
    QuoteContextBlockingError,
    get_quote_context_error_message,
)
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.seq import assign_next_message_seq

logger = get_logger(__name__)

TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})
MAX_ASSISTANT_CONTENT_LENGTH = 50000
TRUNCATION_NOTICE = "\n\n[Response truncated due to length]"
MAX_RENDERED_CONTEXT_CHARS = 25000
LLM_TIMEOUT_SECONDS = 45.0
MAX_HISTORY_TURNS = 40

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
) -> str:
    sorted_contexts = sorted(contexts, key=lambda item: (item.type, str(item.id)))
    payload_contexts = [(ctx.type, str(ctx.id)) for ctx in sorted_contexts]
    payload = (
        f"{conversation_id}|{content}|{model_id}|{reasoning}|{key_mode}|"
        f"{payload_contexts}|{web_search.model_dump(mode='json')}"
    )
    return hashlib.sha256(payload.encode()).hexdigest()


def create_chat_run(
    db: Session,
    *,
    viewer_id: UUID,
    conversation_id: UUID | None,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    web_search: WebSearchOptions,
    idempotency_key: str | None,
) -> ChatRunResponse:
    contexts = list(contexts)
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

        prepared = prepare_messages(db, viewer_id, conversation_id, content, model_id, contexts)
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

        contexts = load_context_refs(db, run.user_message_id)
        try:
            context_text, context_chars = render_context_blocks(db, contexts)
        except QuoteContextBlockingError as exc:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            _finalize_run(
                db,
                run_id=run.id,
                assistant_content=get_quote_context_error_message(exc.error_code),
                assistant_status="error",
                run_status="error",
                done_status="error",
                error_code=exc.error_code.value,
                model=model,
                resolved_key=resolved_key,
                key_mode=run.key_mode,
                latency_ms=latency_ms,
                usage=None,
                provider_request_id=None,
                viewer_id=run.owner_user_id,
            )
            return {"status": "error", "error_code": exc.error_code.value}

        if context_chars > MAX_RENDERED_CONTEXT_CHARS:
            logger.warning(
                "chat_run.context_exceeds_limit",
                run_id=str(run.id),
                context_chars=context_chars,
                limit=MAX_RENDERED_CONTEXT_CHARS,
            )

        context_blocks = [context_text] if context_text else []
        context_types = {ctx.type for ctx in contexts}
        content = run.user_message.content

        if should_run_app_search(content, has_user_context=bool(contexts)):
            _append_and_commit(
                db,
                run.id,
                "tool_call",
                {
                    "assistant_message_id": str(run.assistant_message_id),
                    "tool_name": "app_search",
                    "tool_call_index": 0,
                    "status": "started",
                },
            )
            app_search_run = execute_app_search(
                db,
                viewer_id=run.owner_user_id,
                conversation_id=run.conversation_id,
                user_message_id=run.user_message_id,
                assistant_message_id=run.assistant_message_id,
                content=content,
                has_user_context=bool(contexts),
            )
            if app_search_run is not None:
                _append_and_commit(db, run.id, "tool_result", app_search_run.tool_result_event())
                if app_search_run.context_text:
                    context_blocks.append(app_search_run.context_text)
                    context_types.add("app_search")

        if _is_cancel_requested(db, run.id):
            _finalize_cancelled(
                db, run, model, resolved_key, int((time.monotonic() - start_time) * 1000)
            )
            return {"status": "cancelled"}

        web_search = WebSearchOptions.model_validate(run.web_search)
        if should_run_web_search(content, web_search):
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
                content=content,
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
                if web_search_run.context_text:
                    context_blocks.append(web_search_run.context_text)
                    context_types.add("web_search")

        if _is_cancel_requested(db, run.id):
            _finalize_cancelled(
                db, run, model, resolved_key, int((time.monotonic() - start_time) * 1000)
            )
            return {"status": "cancelled"}

        history = load_prompt_history(db, run.conversation_id, run.user_message.seq)
        llm_request = LLMRequest(
            model_name=model.model_name,
            messages=render_prompt(
                user_content=content,
                history=history,
                context_blocks=context_blocks,
                context_types=context_types,
            ),
            max_tokens=max_output_tokens,
            temperature=0.7,
            reasoning_effort=cast(ReasoningEffort, run.reasoning),
        )
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
            message_chars=sum(len(message.content) for message in llm_request.messages),
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
                    tokens_input=usage.prompt_tokens if usage else None,
                    tokens_output=usage.completion_tokens if usage else None,
                    tokens_total=usage.total_tokens if usage else None,
                    tokens_reasoning=usage.reasoning_tokens if usage else None,
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

        logger.info(
            "llm.request.finished",
            **safe_kv(
                **llm_log_fields,
                outcome="success",
                latency_ms=int((time.monotonic() - llm_start) * 1000),
                tokens_input=usage.prompt_tokens if usage else None,
                tokens_output=usage.completion_tokens if usage else None,
                tokens_total=usage.total_tokens if usage else None,
                tokens_reasoning=usage.reasoning_tokens if usage else None,
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
        if resolved_key.mode == "platform":
            actual_tokens = (
                usage.total_tokens if usage and usage.total_tokens else len(full_content) // 4 + 100
            )
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

    return model


def prepare_messages(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    content: str,
    model_id: UUID,
    contexts: Sequence[ContextItem],
) -> PreparedMessages:
    if conversation_id is None:
        conversation = Conversation(
            owner_user_id=viewer_id,
            title=derive_conversation_title(content),
            sharing="private",
            next_seq=1,
        )
        db.add(conversation)
        db.flush()
    else:
        conversation = db.get(Conversation, conversation_id)
        if conversation is None or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

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
    return ChatRunResponse(
        run=ChatRunOut.model_validate(run),
        conversation=conversation_to_out(
            conversation,
            get_message_count(db, conversation.id),
            viewer_id=viewer_id,
        ),
        user_message=message_to_out(
            user_message,
            contexts_by_message_id.get(user_message.id, []),
            tool_calls_by_message_id.get(user_message.id, []),
        ),
        assistant_message=message_to_out(
            assistant_message,
            contexts_by_message_id.get(assistant_message.id, []),
            tool_calls_by_message_id.get(assistant_message.id, []),
        ),
    )


def load_prompt_history(db: Session, conversation_id: UUID, before_seq: int) -> list[Turn]:
    rows = list(
        db.execute(
            text(
                """
                SELECT role, content
                FROM messages
                WHERE conversation_id = :conversation_id
                  AND status = 'complete'
                  AND role IN ('user', 'assistant')
                  AND seq < :before_seq
                ORDER BY seq DESC
                LIMIT :limit
                """
            ),
            {
                "conversation_id": conversation_id,
                "before_seq": before_seq,
                "limit": MAX_HISTORY_TURNS,
            },
        ).fetchall()
    )
    rows.reverse()
    return [Turn(role=row[0], content=row[1]) for row in rows]


def load_context_refs(db: Session, user_message_id: UUID) -> list[MessageContextRef]:
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

    key = resolved_key or (model and _dummy_resolved_key(model))
    if assistant_message is not None and model is not None and key is not None:
        existing_llm = db.get(MessageLLM, assistant_message.id)
        prompt_tokens = usage.prompt_tokens if usage else None
        completion_tokens = usage.completion_tokens if usage else None
        total_tokens = usage.total_tokens if usage else None
        if existing_llm is None:
            db.add(
                MessageLLM(
                    message_id=assistant_message.id,
                    provider=model.provider,
                    model_name=model.model_name,
                    prompt_tokens=prompt_tokens,
                    completion_tokens=completion_tokens,
                    total_tokens=total_tokens,
                    key_mode_requested=key_mode,
                    key_mode_used=key.mode,
                    latency_ms=latency_ms,
                    error_class=error_code if assistant_status == "error" else None,
                    provider_request_id=provider_request_id,
                    prompt_version=PROMPT_VERSION,
                )
            )
        else:
            existing_llm.prompt_tokens = prompt_tokens
            existing_llm.completion_tokens = completion_tokens
            existing_llm.total_tokens = total_tokens
            existing_llm.key_mode_requested = key_mode
            existing_llm.key_mode_used = key.mode
            existing_llm.latency_ms = latency_ms
            existing_llm.error_class = error_code if assistant_status == "error" else None
            existing_llm.provider_request_id = provider_request_id
            existing_llm.prompt_version = PROMPT_VERSION

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


def _dummy_resolved_key(model: Model) -> ResolvedKey:
    return ResolvedKey(api_key="", mode="platform", provider=model.provider, user_key_id=None)


def _validate_context_visibility(db: Session, viewer_id: UUID, ctx: ContextItem) -> None:
    if ctx.type == "media":
        media = db.get(Media, ctx.id)
        if media is None or not can_read_media(db, viewer_id, ctx.id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    if ctx.type == "highlight":
        highlight = db.get(Highlight, ctx.id)
        if highlight is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        media_id = _get_highlight_anchor_media_id(highlight)
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        return

    if ctx.type == "annotation":
        annotation = db.get(Annotation, ctx.id)
        if annotation is None or annotation.highlight is None:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        media_id = _get_highlight_anchor_media_id(annotation.highlight)
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")


def _get_highlight_anchor_media_id(highlight: Highlight) -> UUID | None:
    media_id = highlight.anchor_media_id
    if media_id is None:
        logger.warning("chat_run.highlight_missing_anchor_media", highlight_id=str(highlight.id))
        return None
    if highlight.anchor_kind == "fragment_offsets":
        fragment_anchor = highlight.fragment_anchor
        if fragment_anchor is None:
            logger.warning(
                "chat_run.highlight_missing_fragment_anchor", highlight_id=str(highlight.id)
            )
            return None
        fragment = fragment_anchor.fragment
        if fragment is not None and fragment.media_id != media_id:
            logger.warning(
                "chat_run.highlight_fragment_media_mismatch", highlight_id=str(highlight.id)
            )
            return None
        return media_id
    if highlight.anchor_kind == "pdf_page_geometry":
        pdf_anchor = highlight.pdf_anchor
        if pdf_anchor is None or pdf_anchor.media_id != media_id:
            logger.warning("chat_run.highlight_pdf_anchor_invalid", highlight_id=str(highlight.id))
            return None
        return media_id
    logger.warning(
        "chat_run.highlight_unknown_anchor_kind",
        highlight_id=str(highlight.id),
        anchor_kind=highlight.anchor_kind,
    )
    return None


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
