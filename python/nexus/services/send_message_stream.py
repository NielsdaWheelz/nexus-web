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

import json
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.orm import Session

from nexus.db.models import Message, MessageLLM, Model
from nexus.errors import ApiError
from nexus.logging import get_logger
from nexus.services.llm.prompt import PROMPT_VERSION, render_context_blocks, render_system_prompt
from nexus.services.llm.router import generate_stream, resolve_api_key, update_user_key_status
from nexus.services.llm.types import (
    ChatMessage,
    LLMError,
    LLMErrorClass,
    LLMRequest,
    ResolvedKey,
)
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.send_message import (
    MAX_ASSISTANT_CONTENT_LENGTH,
    TRUNCATION_NOTICE,
    check_idempotency,
    compute_payload_hash,
    phase1_prepare,
    validate_pre_phase,
)

logger = get_logger(__name__)

LLM_TIMEOUT_SECONDS = 45.0


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
    from nexus.services.llm.router import get_model_by_id

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
            system_prompt = render_system_prompt()
            context_text, _ = render_context_blocks(db, contexts)

            messages = [ChatMessage(role="system", content=system_prompt)]
            if context_text:
                messages.append(
                    ChatMessage(
                        role="user",
                        content=f"Here is the context for my question:\n\n{context_text}",
                    )
                )
            messages.append(ChatMessage(role="user", content=content))

            request = LLMRequest(
                messages=messages,
                model=model.model_name,
                max_tokens=4096,
                temperature=0.7,
            )

            # Stream chunks
            for chunk in generate_stream(request, resolved_key, LLM_TIMEOUT_SECONDS):
                if chunk.delta:
                    full_content += chunk.delta
                    yield format_sse_event("delta", {"delta": chunk.delta})

                    # Truncate if too long
                    if len(full_content) > MAX_ASSISTANT_CONTENT_LENGTH:
                        full_content = full_content[:MAX_ASSISTANT_CONTENT_LENGTH]
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
    from nexus.services.llm.types import ERROR_CLASS_TO_MESSAGE

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
        error_class = error.error_class if error else LLMErrorClass.UNKNOWN
        error_message = ERROR_CLASS_TO_MESSAGE.get(
            error_class, ERROR_CLASS_TO_MESSAGE[LLMErrorClass.UNKNOWN]
        )

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
