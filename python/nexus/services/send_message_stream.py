"""Streaming send message service for the canonical /stream/* transport.

Implemented as an async generator so the ASGI server owns iteration directly.
This enables:
- Natural disconnect detection (ASGI stops iterating -> finally runs)
- Provider connection close on disconnect (async with client.stream())
- Keepalive pings during idle periods
- Liveness markers for sweeper + replay logic
- Budget pre-reservation for platform keys
- Conditional finalize (exactly-once via WHERE status='pending')

SSE Events:
- meta: conversation_id, user_message_id, assistant_message_id, model_id, provider
- delta: {"delta": "text chunk"}
- done: {"status": "complete|error", "error_code": "...", "final_chars": N}

Sync DB access uses run_in_threadpool (starlette) to avoid blocking the event loop.
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import cast
from uuid import UUID, uuid4

from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.config import get_settings
from nexus.db.models import MessageLLM, Model
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.conversation import ContextItem, WebSearchOptions
from nexus.services.agent_tools.app_search import execute_app_search, should_run_app_search
from nexus.services.agent_tools.web_search import (
    WEB_SEARCH_TOOL_CALL_INDEX,
    WEB_SEARCH_TOOL_NAME,
    WebSearchProvider,
    execute_web_search,
    should_run_web_search,
)
from nexus.services.api_key_resolver import (
    ResolvedKey,
    get_model_by_id,
    resolve_api_key,
    update_user_key_status,
)
from nexus.services.context_rendering import PROMPT_VERSION, render_context_blocks
from nexus.services.llm import LLMRouter
from nexus.services.llm.errors import LLMError, LLMErrorClass
from nexus.services.llm.prompt import render_prompt
from nexus.services.llm.types import (
    LLMCallContext,
    LLMOperation,
    LLMRequest,
    LLMUsage,
    ReasoningEffort,
)
from nexus.services.quote_context_errors import (
    QuoteContextBlockingError,
    get_quote_context_error_message,
)
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.send_message import (
    ERROR_CLASS_TO_MESSAGE,
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
    check_idempotency,
    compute_payload_hash,
    load_prompt_history,
    phase1_prepare,
    validate_pre_phase,
)
from nexus.services.stream_liveness import (
    check_liveness_marker,
    clear_liveness_marker,
    refresh_liveness_marker,
    set_liveness_marker,
)

logger = get_logger(__name__)

LLM_TIMEOUT_SECONDS = 45.0
KEEPALIVE_INTERVAL_SECONDS = 15.0


def format_sse_event(event: str, data: dict) -> str:
    """Format data as an SSE event."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _finalize_stream_conditional(
    db: Session,
    assistant_message_id: UUID,
    content: str,
    status: str,
    error_code: str | None,
    model: Model,
    resolved_key: ResolvedKey,
    key_mode: str,
    latency_ms: int,
    usage: LLMUsage | None,
    viewer_id: UUID,
    provider_request_id: str | None = None,
    quote_context_error: bool = False,
) -> bool:
    """Finalize the assistant message with conditional update (exactly-once).

    Uses WHERE status='pending' to prevent race with sweeper.

    Returns:
        True if this call finalized (rowcount==1), False if already finalized.
    """
    rate_limiter = get_rate_limiter()

    final_content = content
    if status == "complete" and content:
        if len(content) > MAX_ASSISTANT_CONTENT_LENGTH:
            final_content = content[:MAX_ASSISTANT_CONTENT_LENGTH] + TRUNCATION_NOTICE
    elif status == "error":
        if not content:
            error_class_enum = None
            if error_code:
                if quote_context_error:
                    final_content = get_quote_context_error_message(error_code)
                else:
                    try:
                        error_class_enum = LLMErrorClass(error_code)
                    except ValueError:
                        pass
            default_message = "An unexpected error occurred. Please try again."
            if final_content == content:
                final_content = (
                    ERROR_CLASS_TO_MESSAGE.get(error_class_enum, default_message)
                    if error_class_enum
                    else default_message
                )

    # Conditional update: only finalize if still pending
    result = db.execute(
        sa_text("""
            UPDATE messages
            SET content = :content, status = :status, error_code = :error_code,
                updated_at = :now
            WHERE id = :id AND status = 'pending'
        """),
        {
            "content": final_content,
            "status": status,
            "error_code": error_code,
            "now": datetime.now(UTC),
            "id": assistant_message_id,
        },
    )

    if getattr(result, "rowcount", 0) == 0:
        # Already finalized (sweeper or another path got there first)
        # PR-09: Emit stream.double_finalize_detected
        logger.error(
            "stream.double_finalize_detected",
            **safe_kv(
                assistant_message_id=str(assistant_message_id),
                attempted_status=status,
                reason="status_not_pending",
            ),
        )
        db.rollback()
        return False

    # Insert message_llm for the finalized assistant row.
    prompt_tokens = usage.prompt_tokens if usage else None
    completion_tokens = usage.completion_tokens if usage else None
    total_tokens = usage.total_tokens if usage else None

    db.add(
        MessageLLM(
            message_id=assistant_message_id,
            provider=model.provider,
            model_name=model.model_name,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            key_mode_requested=key_mode,
            key_mode_used=resolved_key.mode,
            latency_ms=latency_ms,
            error_class=error_code if status == "error" else None,
            provider_request_id=provider_request_id,
            prompt_version=PROMPT_VERSION,
        )
    )

    # Update BYOK status
    if resolved_key.mode == "byok":
        if status == "complete":
            update_user_key_status(db, resolved_key.user_key_id, "valid")
        elif error_code and error_code == LLMErrorClass.INVALID_KEY.value:
            update_user_key_status(db, resolved_key.user_key_id, "invalid")

    db.commit()

    # Budget: commit or release
    if resolved_key.mode == "platform":
        actual_tokens = total_tokens or (len(final_content) // 4 + 100)
        rate_limiter.commit_token_budget(viewer_id, assistant_message_id, actual_tokens)

    return True


async def stream_send_message_async(
    db_factory,
    viewer_id: UUID,
    conversation_id: UUID | None,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str = "auto",
    contexts: list[ContextItem] | None = None,
    web_search: WebSearchOptions | None = None,
    idempotency_key: str | None = None,
    llm_router: LLMRouter | None = None,
    web_search_provider: WebSearchProvider | None = None,
    web_search_country: str = "US",
    web_search_language: str = "en",
    web_search_safe_search: str = "moderate",
) -> AsyncIterator[str]:
    """Async generator for streaming message send via SSE.

    Yields SSE-formatted events. Handles disconnect via finally block.
    Sync DB calls are wrapped in run_in_threadpool.

    Args:
        db_factory: Callable returning a new sync Session.
        viewer_id: Authenticated user ID.
        conversation_id: Existing conversation or None for new.
        content: User message text.
        model_id: Model to use.
        reasoning: Reasoning mode for the selected model.
        key_mode: Key resolution mode.
        contexts: Context items.
        idempotency_key: Optional idempotency key.
        llm_router: Shared LLMRouter from app.state.

    Yields:
        SSE-formatted event strings.
    """
    contexts = contexts or []
    if web_search is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "web_search.mode is required")
    rate_limiter = get_rate_limiter()
    settings = get_settings()
    db = db_factory()

    # PR-09: Generate flow_id for phase correlation
    flow_id = str(uuid4())
    set_flow_id(flow_id)

    # Compute payload hash for idempotency
    payload_hash = compute_payload_hash(
        content,
        model_id,
        reasoning,
        key_mode,
        contexts,
        web_search,
        conversation_id,
    )

    # --- Idempotency replay ---
    replay = await run_in_threadpool(
        check_idempotency, db, viewer_id, idempotency_key, payload_hash
    )
    if replay:
        user_message, assistant_message, conversation = replay

        # PR-08 §4.3: eliminate done{status:"pending"}
        if assistant_message.status == "pending":
            # Check liveness marker
            is_active = check_liveness_marker(assistant_message.id)
            if is_active:
                # Stream still running — emit meta then done with E_STREAM_IN_PROGRESS
                yield format_sse_event(
                    "meta",
                    {
                        "conversation_id": str(conversation.id),
                        "user_message_id": str(user_message.id),
                        "assistant_message_id": str(assistant_message.id),
                        "model_id": str(model_id),
                        "provider": "",
                    },
                )
                yield format_sse_event(
                    "done",
                    {
                        "status": "error",
                        "error_code": "E_STREAM_IN_PROGRESS",
                    },
                )
            else:
                # Orphaned — finalize to error
                model = await run_in_threadpool(get_model_by_id, db, model_id)
                if model:
                    dummy_key = ResolvedKey(
                        api_key="",
                        mode="platform",
                        provider=model.provider,
                        user_key_id=None,
                    )
                    await run_in_threadpool(
                        _finalize_stream_conditional,
                        db,
                        assistant_message.id,
                        "Request timed out — please try again.",
                        "error",
                        "E_ORPHANED_PENDING",
                        model,
                        dummy_key,
                        key_mode,
                        0,
                        None,
                        viewer_id,
                    )
                yield format_sse_event(
                    "meta",
                    {
                        "conversation_id": str(conversation.id),
                        "user_message_id": str(user_message.id),
                        "assistant_message_id": str(assistant_message.id),
                        "model_id": str(model_id),
                        "provider": "",
                    },
                )
                yield format_sse_event(
                    "done",
                    {
                        "status": "error",
                        "error_code": "E_ORPHANED_PENDING",
                    },
                )
        elif assistant_message.status == "complete":
            yield format_sse_event(
                "meta",
                {
                    "conversation_id": str(conversation.id),
                    "user_message_id": str(user_message.id),
                    "assistant_message_id": str(assistant_message.id),
                    "model_id": str(model_id),
                    "provider": "",
                },
            )
            yield format_sse_event("delta", {"delta": assistant_message.content})
            yield format_sse_event(
                "done",
                {
                    "status": "complete",
                    "final_chars": len(assistant_message.content),
                },
            )
        else:
            # error status
            yield format_sse_event(
                "meta",
                {
                    "conversation_id": str(conversation.id),
                    "user_message_id": str(user_message.id),
                    "assistant_message_id": str(assistant_message.id),
                    "model_id": str(model_id),
                    "provider": "",
                },
            )
            yield format_sse_event(
                "done",
                {
                    "status": "error",
                    "error_code": assistant_message.error_code,
                },
            )
        db.close()
        return

    # --- Get model ---
    model = await run_in_threadpool(get_model_by_id, db, model_id)
    if not model:
        yield format_sse_event(
            "done",
            {
                "status": "error",
                "error_code": "E_MODEL_NOT_AVAILABLE",
            },
        )
        db.close()
        return

    # --- Determine platform key usage ---
    try:
        resolved = await run_in_threadpool(resolve_api_key, db, viewer_id, model.provider, key_mode)
        use_platform_key = resolved.mode == "platform"
    except ApiError as e:
        if e.code != ApiErrorCode.E_MODEL_NOT_AVAILABLE:
            yield format_sse_event(
                "done",
                {
                    "status": "error",
                    "error_code": e.code.value,
                },
            )
            db.close()
            return
        use_platform_key = False
    except LLMError:
        use_platform_key = False

    # --- Phase 0: Pre-validation ---
    try:
        model = await run_in_threadpool(
            validate_pre_phase,
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
    except ApiError as e:
        yield format_sse_event(
            "done",
            {
                "status": "error",
                "error_code": e.code.value,
            },
        )
        db.close()
        return

    # Acquire one in-flight slot for this stream.
    rate_limiter.acquire_inflight_slot(viewer_id)

    error: Exception | None = None
    full_content = ""
    usage: LLMUsage | None = None
    assistant_message_id: UUID | None = None
    resolved_key: ResolvedKey | None = None
    prepare_result = None
    budget_reserved = False
    start_time = time.monotonic()
    phase1_ms: int = 0
    chunks_count: int = 0
    first_delta_emitted = False
    provider_request_id: str | None = None

    try:
        # --- Phase 1: Prepare (sync DB) ---
        phase1_start = time.monotonic()
        prepare_result = await run_in_threadpool(
            phase1_prepare,
            db,
            viewer_id,
            conversation_id,
            content,
            model_id,
            contexts,
            idempotency_key,
            payload_hash,
        )
        assistant_message_id = prepare_result.assistant_message.id
        phase1_ms = int((time.monotonic() - phase1_start) * 1000)

        # Resolve key
        resolved_key = await run_in_threadpool(
            resolve_api_key,
            db,
            viewer_id,
            model.provider,
            key_mode,
        )

        # Set liveness marker BEFORE first byte
        await set_liveness_marker(assistant_message_id)

        # Budget pre-reservation (platform key only) — PR-08 §8
        if resolved_key.mode == "platform":
            prompt_est = len(content) // 4 + 100
            output_ceiling = min(
                getattr(model, "max_context_tokens", 4096),
                settings.stream_max_output_tokens_default,
            )
            est_tokens = prompt_est + output_ceiling
            try:
                rate_limiter.reserve_token_budget(viewer_id, assistant_message_id, est_tokens)
                budget_reserved = True
            except ApiError:
                # Budget exceeded — release and report
                yield format_sse_event(
                    "meta",
                    {
                        "conversation_id": str(prepare_result.conversation.id),
                        "user_message_id": str(prepare_result.user_message.id),
                        "assistant_message_id": str(assistant_message_id),
                        "model_id": str(model.id),
                        "provider": model.provider,
                    },
                )
                yield format_sse_event(
                    "done",
                    {
                        "status": "error",
                        "error_code": "E_TOKEN_BUDGET_EXCEEDED",
                    },
                )
                # Finalize the assistant message as error
                await run_in_threadpool(
                    _finalize_stream_conditional,
                    db,
                    assistant_message_id,
                    "",
                    "error",
                    "E_TOKEN_BUDGET_EXCEEDED",
                    model,
                    resolved_key,
                    key_mode,
                    0,
                    None,
                    viewer_id,
                )
                return

        # --- Yield meta event (first event, always) ---
        yield format_sse_event(
            "meta",
            {
                "conversation_id": str(prepare_result.conversation.id),
                "user_message_id": str(prepare_result.user_message.id),
                "assistant_message_id": str(assistant_message_id),
                "model_id": str(model.id),
                "provider": model.provider,
            },
        )

        # PR-09: Emit stream.started
        logger.info(
            "stream.started",
            **safe_kv(
                assistant_message_id=str(assistant_message_id),
                provider=model.provider,
                model_name=model.model_name,
            ),
        )
        stream_start_time = time.monotonic()

        # --- Phase 2: Stream from provider (async, same event loop) ---
        context_text, _ = await run_in_threadpool(render_context_blocks, db, contexts)
        app_search_run = None
        if should_run_app_search(content, has_user_context=bool(contexts)):
            yield format_sse_event(
                "tool_call",
                {
                    "assistant_message_id": str(assistant_message_id),
                    "tool_name": "app_search",
                    "tool_call_index": 0,
                    "status": "started",
                },
            )
            app_search_run = await run_in_threadpool(
                execute_app_search,
                db,
                viewer_id=viewer_id,
                conversation_id=prepare_result.conversation.id,
                user_message_id=prepare_result.user_message.id,
                assistant_message_id=assistant_message_id,
                content=content,
                has_user_context=bool(contexts),
            )
            yield format_sse_event("tool_result", app_search_run.tool_result_event())

        context_blocks = [context_text] if context_text else []
        context_types = {c.type for c in contexts}
        if app_search_run and app_search_run.context_text:
            context_blocks.append(app_search_run.context_text)
            context_types.add("app_search")

        web_search_run = None
        if should_run_web_search(content, web_search):
            yield format_sse_event(
                "tool_call",
                {
                    "assistant_message_id": str(assistant_message_id),
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
                viewer_id=viewer_id,
                conversation_id=prepare_result.conversation.id,
                user_message_id=prepare_result.user_message.id,
                assistant_message_id=assistant_message_id,
                content=content,
                options=web_search,
                country=web_search_country,
                search_lang=web_search_language,
                safe_search=web_search_safe_search,
            )
        if web_search_run:
            yield format_sse_event("tool_result", web_search_run.tool_result_event())
            for citation in web_search_run.selected_citations:
                yield format_sse_event(
                    "citation",
                    citation.citation_event(assistant_message_id, web_search_run.tool_call_index),
                )
            if web_search_run.context_text:
                context_blocks.append(web_search_run.context_text)
                context_types.add("web_search")

        history = await run_in_threadpool(
            load_prompt_history,
            db,
            prepare_result.conversation.id,
            prepare_result.user_message.seq,
        )
        messages = render_prompt(
            user_content=content,
            history=history,
            context_blocks=context_blocks,
            context_types=context_types,
        )

        llm_request = LLMRequest(
            model_name=model.model_name,
            messages=messages,
            max_tokens=4096,
            temperature=0.7,
            reasoning_effort=cast(ReasoningEffort, reasoning),
        )

        if llm_router is None:
            # Shouldn't happen in production, but handle gracefully
            raise LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message="LLM router not available",
            )

        # Build LLM call context for observability
        call_ctx = LLMCallContext(
            operation=LLMOperation.CHAT_SEND,
            conversation_id=str(prepare_result.conversation.id),
            assistant_message_id=str(assistant_message_id),
        )

        last_keepalive = time.monotonic()

        async for chunk in llm_router.generate_stream(
            model.provider,
            llm_request,
            resolved_key.api_key,
            timeout_s=int(LLM_TIMEOUT_SECONDS),
            key_mode=resolved_key.mode,
            call_context=call_ctx,
        ):
            if chunk.done:
                usage = chunk.usage
                provider_request_id = chunk.provider_request_id
                break

            if chunk.delta_text:
                full_content += chunk.delta_text
                chunks_count += 1
                yield format_sse_event("delta", {"delta": chunk.delta_text})
                await refresh_liveness_marker(assistant_message_id)

                # PR-09: Emit stream.first_delta exactly once
                if not first_delta_emitted:
                    first_delta_emitted = True
                    ttft_ms = int((time.monotonic() - stream_start_time) * 1000)
                    logger.info(
                        "stream.first_delta",
                        **safe_kv(
                            assistant_message_id=str(assistant_message_id),
                            ttft_ms=ttft_ms,
                            provider=model.provider,
                            model_name=model.model_name,
                        ),
                    )

                # Truncation check
                if len(full_content) > MAX_ASSISTANT_CONTENT_LENGTH:
                    full_content = full_content[:MAX_ASSISTANT_CONTENT_LENGTH]
                    break

            # Keepalive check
            now = time.monotonic()
            if now - last_keepalive > KEEPALIVE_INTERVAL_SECONDS:
                yield ": keepalive\n\n"
                await refresh_liveness_marker(assistant_message_id)
                last_keepalive = now

    except QuoteContextBlockingError as e:
        error = e
    except LLMError as e:
        error = e
    except asyncio.CancelledError:
        error = Exception("E_CLIENT_DISCONNECT")
    except GeneratorExit:
        error = Exception("E_CLIENT_DISCONNECT")
    except Exception as e:
        error = e
    finally:
        # --- Phase 3: Finalize (sync DB, never skip) ---
        latency_ms = int((time.monotonic() - start_time) * 1000)
        finalize_start = time.monotonic()

        if assistant_message_id and resolved_key and model:
            if error:
                error_code = "E_INTERNAL"
                if isinstance(error, QuoteContextBlockingError):
                    error_code = error.error_code.value
                elif isinstance(error, LLMError):
                    error_code = error.error_class.value
                elif "E_CLIENT_DISCONNECT" in str(error):
                    error_code = "E_CLIENT_DISCONNECT"

                await run_in_threadpool(
                    _finalize_stream_conditional,
                    db,
                    assistant_message_id,
                    full_content,
                    "error",
                    error_code,
                    model,
                    resolved_key,
                    key_mode,
                    latency_ms,
                    usage,
                    viewer_id,
                    provider_request_id,
                    isinstance(error, QuoteContextBlockingError),
                )
            else:
                await run_in_threadpool(
                    _finalize_stream_conditional,
                    db,
                    assistant_message_id,
                    full_content,
                    "complete",
                    None,
                    model,
                    resolved_key,
                    key_mode,
                    latency_ms,
                    usage,
                    viewer_id,
                    provider_request_id,
                    False,
                )

            # Release budget if reserved but not committed through finalize
            if budget_reserved and error and resolved_key.mode == "platform":
                rate_limiter.release_token_budget(viewer_id, assistant_message_id)

        finalize_ms = int((time.monotonic() - finalize_start) * 1000)
        await clear_liveness_marker(assistant_message_id)
        rate_limiter.release_inflight_slot(viewer_id)
        db.close()

        # PR-09: Emit terminal stream event + phase timing
        is_disconnect = error and "E_CLIENT_DISCONNECT" in str(error)
        is_llm_error = isinstance(error, LLMError)
        is_quote_blocking = isinstance(error, QuoteContextBlockingError)

        if error:
            if is_disconnect:
                outcome = "client_disconnect"
                logger.warning(
                    "stream.client_disconnected",
                    **safe_kv(
                        assistant_message_id=str(assistant_message_id),
                        duration_ms=latency_ms,
                        chunks_count=chunks_count,
                        outcome=outcome,
                    ),
                )
            else:
                outcome = "error"
                if is_quote_blocking:
                    err_class = error.error_code.value
                elif is_llm_error:
                    err_class = error.error_class.value
                else:
                    err_class = "E_INTERNAL"
                logger.error(
                    "stream.finalized_error",
                    **safe_kv(
                        assistant_message_id=str(assistant_message_id),
                        error_class=err_class,
                        duration_ms=latency_ms,
                        chunks_count=chunks_count,
                        outcome=outcome,
                        provider_request_id=provider_request_id,
                    ),
                )
        else:
            outcome = "success"
            total_tokens = usage.total_tokens if usage else None
            logger.info(
                "stream.completed",
                **safe_kv(
                    assistant_message_id=str(assistant_message_id),
                    duration_ms=latency_ms,
                    chunks_count=chunks_count,
                    tokens_total=total_tokens,
                    outcome=outcome,
                    provider_request_id=provider_request_id,
                ),
            )

        # PR-09: Emit stream.phases timing
        logger.info(
            "stream.phases",
            **safe_kv(
                phase1_db_ms=phase1_ms,
                provider_stream_duration_ms=latency_ms - phase1_ms - finalize_ms,
                finalize_ms=finalize_ms,
            ),
        )

        # PR-09: Clear flow_id
        set_flow_id(None)

    # Yield done event (after finally, if generator wasn't cancelled)
    if error:
        error_code = "E_INTERNAL"
        if isinstance(error, QuoteContextBlockingError):
            error_code = error.error_code.value
        elif isinstance(error, LLMError):
            error_code = error.error_class.value
        elif "E_CLIENT_DISCONNECT" in str(error):
            error_code = "E_CLIENT_DISCONNECT"

        yield format_sse_event(
            "done",
            {
                "status": "error",
                "error_code": error_code,
            },
        )
    else:
        yield format_sse_event(
            "done",
            {
                "status": "complete",
                "final_chars": len(full_content),
            },
        )
