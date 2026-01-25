"""Streaming send message service.

Implements SSE (Server-Sent Events) streaming for LLM responses.

Per PR-05 spec:
- Feature-flagged via ENABLE_STREAMING
- SSE protocol with events: meta, delta, done
- No partial DB writes - finalization happens once at stream end
- Inactivity timeout of 45s between chunks

Events:
- meta: conversation_id, user_message_id, assistant_message_id, model_id, provider
- delta: {"delta": "text chunk"}
- done: {"status": "complete|error", "usage": {...}, "error_code": "..."}
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from uuid import UUID

import httpx
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import Message, MessageLLM, Model
from nexus.errors import ApiError
from nexus.logging import get_logger
from nexus.services.api_key_resolver import (
    ResolvedKey,
    get_model_by_id,
    resolve_api_key,
    update_user_key_status,
)
from nexus.services.context_rendering import PROMPT_VERSION, render_context_blocks
from nexus.services.llm import LLMRouter
from nexus.services.llm.errors import LLMError, LLMErrorClass
from nexus.services.llm.prompt import DEFAULT_SYSTEM_PROMPT
from nexus.services.llm.types import LLMChunk, LLMRequest, Turn
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.send_message import (
    ERROR_CLASS_TO_MESSAGE,
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
    check_idempotency,
    compute_payload_hash,
    phase1_prepare,
    validate_pre_phase,
)

logger = get_logger(__name__)

LLM_TIMEOUT_SECONDS = 45.0


async def _stream_llm_async(
    provider: str,
    request: LLMRequest,
    api_key: str,
    timeout_s: int,
) -> AsyncIterator[LLMChunk]:
    """Execute async LLM streaming call using PR-04's LLMRouter."""
    settings = get_settings()
    async with httpx.AsyncClient() as client:
        router = LLMRouter(
            client,
            enable_openai=settings.enable_openai,
            enable_anthropic=settings.enable_anthropic,
            enable_gemini=settings.enable_gemini,
        )
        async for chunk in router.generate_stream(provider, request, api_key, timeout_s=timeout_s):
            yield chunk


def _stream_llm_sync(
    provider: str,
    request: LLMRequest,
    api_key: str,
    timeout_s: int,
) -> Iterator[LLMChunk]:
    """Sync wrapper for async streaming LLM call.

    Uses a background thread to run the async generator and queues results.
    """
    import queue
    import threading

    result_queue: queue.Queue[LLMChunk | Exception | None] = queue.Queue()

    async def _run_stream():
        try:
            async for chunk in _stream_llm_async(provider, request, api_key, timeout_s):
                result_queue.put(chunk)
            result_queue.put(None)  # Signal completion
        except Exception as e:
            result_queue.put(e)

    def _thread_target():
        asyncio.run(_run_stream())

    thread = threading.Thread(target=_thread_target, daemon=True)
    thread.start()

    while True:
        try:
            item = result_queue.get(timeout=timeout_s + 5)
            if item is None:
                break
            if isinstance(item, Exception):
                raise item
            yield item
        except queue.Empty:
            raise LLMError(
                error_class=LLMErrorClass.TIMEOUT,
                message="Stream timed out waiting for chunks",
            ) from None


def format_sse_event(event: str, data: dict) -> str:
    """Format data as an SSE event."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def stream_send_message(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    content: str,
    model_id: UUID,
    key_mode: str = "auto",
    contexts: list[dict] | None = None,
    idempotency_key: str | None = None,
) -> Iterator[str]:
    """Stream a message send with SSE events.

    Yields SSE-formatted events:
    - meta: Initial metadata
    - delta: Incremental content
    - done: Final status and usage

    Args:
        db: Database session.
        viewer_id: User sending the message.
        conversation_id: Existing conversation ID, or None to create new.
        content: User message content.
        model_id: Model to use.
        key_mode: Key resolution mode.
        contexts: Context items to include.
        idempotency_key: Optional idempotency key.

    Yields:
        SSE-formatted event strings.
    """
    contexts = contexts or []
    rate_limiter = get_rate_limiter()

    # Compute payload hash for idempotency
    context_dicts = [{"type": c.get("type"), "id": str(c.get("id"))} for c in contexts]
    payload_hash = compute_payload_hash(content, model_id, key_mode, context_dicts)

    # Check idempotency replay
    replay = check_idempotency(db, viewer_id, idempotency_key, payload_hash)
    if replay:
        user_message, assistant_message, conversation = replay

        # Return existing result as SSE
        yield format_sse_event(
            "meta",
            {
                "conversation_id": str(conversation.id),
                "user_message_id": str(user_message.id),
                "assistant_message_id": str(assistant_message.id),
                "model_id": str(model_id),
                "provider": "",  # Unknown from replay
            },
        )

        # Return full content as single delta if complete
        if assistant_message.status == "complete":
            yield format_sse_event("delta", {"delta": assistant_message.content})
            yield format_sse_event("done", {"status": "complete"})
        elif assistant_message.status == "error":
            yield format_sse_event(
                "done",
                {
                    "status": "error",
                    "error_code": assistant_message.error_code,
                },
            )
        else:
            # Still pending - client should wait
            yield format_sse_event("done", {"status": "pending"})
        return

    # Get model
    model = get_model_by_id(db, model_id)
    if not model:
        yield format_sse_event(
            "done",
            {
                "status": "error",
                "error_code": "E_MODEL_NOT_AVAILABLE",
            },
        )
        return

    # Determine if using platform key
    try:
        resolved = resolve_api_key(db, viewer_id, model.provider, key_mode)
        use_platform_key = resolved.mode == "platform"
    except LLMError:
        use_platform_key = False

    # Phase 0: Pre-validation
    try:
        model = validate_pre_phase(
            db, viewer_id, conversation_id, content, model_id, key_mode, contexts, use_platform_key
        )
    except ApiError as e:
        yield format_sse_event(
            "done",
            {
                "status": "error",
                "error_code": e.code.value,
            },
        )
        return

    # Increment in-flight counter
    rate_limiter.increment_inflight(viewer_id)

    try:
        # Phase 1: Prepare
        prepare_result = phase1_prepare(
            db,
            viewer_id,
            conversation_id,
            content,
            model_id,
            contexts,
            idempotency_key,
            payload_hash,
        )

        # Resolve key for execution
        resolved_key = resolve_api_key(db, viewer_id, model.provider, key_mode)

        # Send meta event
        yield format_sse_event(
            "meta",
            {
                "conversation_id": str(prepare_result.conversation.id),
                "user_message_id": str(prepare_result.user_message.id),
                "assistant_message_id": str(prepare_result.assistant_message.id),
                "model_id": str(model.id),
                "provider": model.provider,
            },
        )

        # Phase 2: Execute with streaming
        start_time = time.monotonic()
        full_content = ""
        error: LLMError | None = None

        try:
            # Render prompt
            context_text, _ = render_context_blocks(db, contexts)

            messages: list[Turn] = [Turn(role="system", content=DEFAULT_SYSTEM_PROMPT)]
            if context_text:
                messages.append(
                    Turn(
                        role="user",
                        content=f"Here is the context for my question:\n\n{context_text}",
                    )
                )
            messages.append(Turn(role="user", content=content))

            request = LLMRequest(
                model_name=model.model_name,
                messages=messages,
                max_tokens=4096,
                temperature=0.7,
            )

            # Stream chunks using async-to-sync wrapper
            for chunk in _stream_llm_sync(
                model.provider, request, resolved_key.api_key, int(LLM_TIMEOUT_SECONDS)
            ):
                if chunk.delta_text:
                    full_content += chunk.delta_text
                    yield format_sse_event("delta", {"delta": chunk.delta_text})

                    # Truncate if too long
                    if len(full_content) > MAX_ASSISTANT_CONTENT_LENGTH:
                        full_content = full_content[:MAX_ASSISTANT_CONTENT_LENGTH]
                        break

                if chunk.done:
                    break

        except LLMError as e:
            error = e
            logger.warning(
                "stream_llm_error",
                error_class=e.error_class.value,
                message=e.message,
            )

        latency_ms = int((time.monotonic() - start_time) * 1000)

        # Phase 3: Finalize
        _finalize_stream(
            db,
            viewer_id,
            prepare_result.assistant_message,
            model,
            full_content,
            error,
            resolved_key,
            key_mode,
            latency_ms,
        )

        # Send done event
        if error:
            yield format_sse_event(
                "done",
                {
                    "status": "error",
                    "error_code": error.error_class.value,
                },
            )
        else:
            yield format_sse_event("done", {"status": "complete"})

    except Exception as e:
        logger.error("stream_unexpected_error", error=str(e))
        yield format_sse_event(
            "done",
            {
                "status": "error",
                "error_code": "E_INTERNAL",
            },
        )

    finally:
        rate_limiter.decrement_inflight(viewer_id)


def _finalize_stream(
    db: Session,
    viewer_id: UUID,
    assistant_message: Message,
    model: Model,
    content: str,
    error: LLMError | None,
    resolved_key: ResolvedKey,
    key_mode: str,
    latency_ms: int,
) -> None:
    """Finalize the assistant message after streaming completes."""
    rate_limiter = get_rate_limiter()

    if error is None and content:
        # Truncate if needed
        if len(content) > MAX_ASSISTANT_CONTENT_LENGTH:
            content = content[:MAX_ASSISTANT_CONTENT_LENGTH] + TRUNCATION_NOTICE

        assistant_message.content = content
        assistant_message.status = "complete"
        assistant_message.updated_at = datetime.now(UTC)

        # Insert message_llm (no usage data from streaming)
        message_llm = MessageLLM(
            message_id=assistant_message.id,
            provider=model.provider,
            model_name=model.model_name,
            key_mode_requested=key_mode,
            key_mode_used=resolved_key.mode,
            latency_ms=latency_ms,
            prompt_version=PROMPT_VERSION,
        )
        db.add(message_llm)

        # Update BYOK status
        if resolved_key.mode == "byok":
            update_user_key_status(db, resolved_key.user_key_id, "valid")

        # Estimate tokens for budget (no usage from streaming)
        estimated_tokens = len(content) // 4 + 100  # Rough estimate
        if resolved_key.mode == "platform":
            rate_limiter.charge_token_budget(viewer_id, assistant_message.id, estimated_tokens)

    else:
        error_class = error.error_class if error else LLMErrorClass.PROVIDER_DOWN
        default_message = "An unexpected error occurred. Please try again."
        error_message = ERROR_CLASS_TO_MESSAGE.get(error_class, default_message)

        assistant_message.content = error_message
        assistant_message.status = "error"
        assistant_message.error_code = error_class.value
        assistant_message.updated_at = datetime.now(UTC)

        message_llm = MessageLLM(
            message_id=assistant_message.id,
            provider=model.provider,
            model_name=model.model_name,
            key_mode_requested=key_mode,
            key_mode_used=resolved_key.mode,
            latency_ms=latency_ms,
            error_class=error_class.value,
            prompt_version=PROMPT_VERSION,
        )
        db.add(message_llm)

        # Update BYOK status if invalid key
        if resolved_key.mode == "byok" and error_class == LLMErrorClass.INVALID_KEY:
            update_user_key_status(db, resolved_key.user_key_id, "invalid")

    db.commit()
