"""Send message service - core LLM execution flow.

Implements the three-phase send message flow per PR-05 spec:

Phase 0 - Pre-Validation (no DB writes):
- Model availability check
- Key availability check
- Message length validation
- Context limit validation
- Context visibility validation
- Rate limit check
- Token budget check
- Conversation busy check

Phase 1 - Prepare (single DB transaction):
- Create conversation if needed
- Lock conversation row
- Assign seq via next_seq
- Insert user message
- Insert message_context rows
- Upsert conversation_media
- Insert assistant placeholder
- Insert idempotency row

Phase 2 - Execute (no DB transaction held):
- Resolve API key
- Render prompt
- Call LLM adapter
- Capture result or error

Phase 3 - Finalize (single DB transaction):
- Update assistant message
- Insert message_llm row
- Update BYOK status
- Charge token budget

Invariants:
- No DB transaction held during LLM call
- Pending assistant must be last message
- Idempotency prevents duplicate execution
"""

import asyncio
import hashlib
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.models import (
    Annotation,
    Conversation,
    Highlight,
    IdempotencyKey,
    Media,
    Message,
    MessageLLM,
    Model,
)
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.logging import get_logger, set_flow_id
from nexus.schemas.conversation import (
    MAX_CONTEXTS,
    MAX_MESSAGE_CONTENT_LENGTH,
    SendMessageResponse,
)
from nexus.services.api_key_resolver import (
    ResolvedKey,
    get_model_by_id,
    resolve_api_key,
    update_user_key_status,
)
from nexus.services.context_rendering import PROMPT_VERSION, render_context_blocks
from nexus.services.contexts import insert_context
from nexus.services.conversations import conversation_to_out, get_message_count, message_to_out
from nexus.services.llm import LLMRouter
from nexus.services.llm.errors import LLMError, LLMErrorClass
from nexus.services.llm.prompt import DEFAULT_SYSTEM_PROMPT, render_prompt
from nexus.services.llm.types import LLMCallContext, LLMOperation, LLMRequest, LLMResponse
from nexus.services.media import can_read_media
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.redact import safe_kv
from nexus.services.seq import assign_next_message_seq

logger = get_logger(__name__)

# User-friendly error messages for assistant content
ERROR_CLASS_TO_MESSAGE: dict[LLMErrorClass, str] = {
    LLMErrorClass.TIMEOUT: "The model timed out while responding. Please try again.",
    LLMErrorClass.RATE_LIMIT: "The model is temporarily rate-limited. Please try again shortly.",
    LLMErrorClass.INVALID_KEY: "The configured API key is invalid or has been revoked.",
    LLMErrorClass.PROVIDER_DOWN: "The model provider is currently unavailable. Please try again later.",
    LLMErrorClass.CONTEXT_TOO_LARGE: "The context was too large for the model. Please try with less context.",
    LLMErrorClass.MODEL_NOT_AVAILABLE: "The requested model is not available.",
}

# Limits
MAX_ASSISTANT_CONTENT_LENGTH = 50000
TRUNCATION_NOTICE = "\n\n[Response truncated due to length]"
MAX_RENDERED_CONTEXT_CHARS = 25000
LLM_TIMEOUT_SECONDS = 45.0
IDEMPOTENCY_EXPIRY_HOURS = 24


def generate(
    provider: str,
    request: LLMRequest,
    api_key: str,
    timeout_s: int = 45,
    router: LLMRouter | None = None,
    key_mode: str = "unknown",
    call_context: LLMCallContext | None = None,
) -> LLMResponse:
    """Sync wrapper for LLM generation.

    This function exists to maintain test compatibility with mocking.

    Args:
        provider: LLM provider name.
        request: The LLM request.
        api_key: API key for the provider.
        timeout_s: Timeout in seconds.
        router: Optional shared LLMRouter (from app.state). If None, creates a
                temporary client (less efficient, used in tests).
        key_mode: Key resolution mode for logging.
        call_context: Observability metadata.

    Returns:
        LLMResponse from the provider.
    """
    if router is not None:
        # Use provided router (from app.state) - async call wrapped in sync
        async def _call_with_router():
            return await router.generate(
                provider,
                request,
                api_key,
                timeout_s=timeout_s,
                key_mode=key_mode,
                call_context=call_context,
            )

        return asyncio.run(_call_with_router())

    # Fallback: create temporary client (for tests or when router not available)
    settings = get_settings()

    async def _call():
        async with httpx.AsyncClient() as client:
            temp_router = LLMRouter(
                client,
                enable_openai=settings.enable_openai,
                enable_anthropic=settings.enable_anthropic,
                enable_gemini=settings.enable_gemini,
            )
            return await temp_router.generate(
                provider,
                request,
                api_key,
                timeout_s=timeout_s,
                key_mode=key_mode,
                call_context=call_context,
            )

    return asyncio.run(_call())


@dataclass
class PrepareResult:
    """Result of Phase 1 (prepare)."""

    conversation: Conversation
    user_message: Message
    assistant_message: Message


@dataclass
class ExecuteResult:
    """Result of Phase 2 (execute)."""

    success: bool
    response: LLMResponse | None = None
    error: LLMError | None = None
    latency_ms: int = 0


def compute_payload_hash(
    content: str,
    model_id: UUID,
    key_mode: str,
    contexts: list[dict],
) -> str:
    """Compute a hash of the request payload for idempotency."""
    # Sort contexts by type and id for deterministic hashing
    sorted_contexts = sorted(contexts, key=lambda c: (c.get("type", ""), str(c.get("id", ""))))
    payload_str = f"{content}|{model_id}|{key_mode}|{sorted_contexts}"
    return hashlib.sha256(payload_str.encode()).hexdigest()


def check_idempotency(
    db: Session,
    user_id: UUID,
    idempotency_key: str | None,
    payload_hash: str,
) -> tuple[Message, Message, Conversation] | None:
    """Check for existing idempotency record.

    Returns:
        Tuple of (user_message, assistant_message, conversation) if replay,
        None if new request.

    Raises:
        ApiError(E_IDEMPOTENCY_KEY_REPLAY_MISMATCH): If key reused with different payload.
    """
    if not idempotency_key:
        return None

    # Look up existing record
    record = (
        db.query(IdempotencyKey)
        .filter(
            IdempotencyKey.user_id == user_id,
            IdempotencyKey.key == idempotency_key,
        )
        .first()
    )

    if not record:
        return None

    # Check expiry
    if record.expires_at < datetime.now(UTC):
        # Expired, delete and treat as new
        db.delete(record)
        db.flush()
        return None

    # Check payload match
    if record.payload_hash != payload_hash:
        # PR-09: Emit idempotency.replay_mismatch event
        logger.warning(
            "idempotency.replay_mismatch",
            **safe_kv(
                idempotency_key=idempotency_key,
                viewer_id=str(user_id),
            ),
        )
        raise ApiError(
            ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
            "Idempotency key reused with different payload",
        )

    # Return existing messages
    user_message = db.get(Message, record.user_message_id)
    assistant_message = db.get(Message, record.assistant_message_id)

    if not user_message or not assistant_message:
        # Messages deleted, treat as new
        db.delete(record)
        db.flush()
        return None

    conversation = user_message.conversation

    logger.info(
        "idempotency_replay",
        user_id=str(user_id),
        idempotency_key=idempotency_key,
        assistant_status=assistant_message.status,
    )

    return user_message, assistant_message, conversation


def validate_pre_phase(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    content: str,
    model_id: UUID,
    key_mode: str,
    contexts: list[dict],
    use_platform_key: bool,
) -> Model:
    """Phase 0: Pre-validation (no DB writes).

    Returns:
        The Model object if validation passes.

    Raises:
        ApiError: Various error codes on validation failure.
    """
    # Validate message length
    if len(content) > MAX_MESSAGE_CONTENT_LENGTH:
        raise ApiError(
            ApiErrorCode.E_MESSAGE_TOO_LONG,
            f"Message exceeds {MAX_MESSAGE_CONTENT_LENGTH} character limit",
        )

    # Validate context count
    if len(contexts) > MAX_CONTEXTS:
        raise ApiError(
            ApiErrorCode.E_CONTEXT_TOO_LARGE,
            f"Maximum {MAX_CONTEXTS} context items allowed",
        )

    # Validate model exists and is available
    model = get_model_by_id(db, model_id)
    if not model or not model.is_available:
        raise ApiError(
            ApiErrorCode.E_MODEL_NOT_AVAILABLE,
            "Model not found or not available",
        )

    # Validate key availability (will raise if no key)
    try:
        resolve_api_key(db, viewer_id, model.provider, key_mode)
    except LLMError as e:
        raise ApiError(ApiErrorCode.E_LLM_NO_KEY, str(e.message)) from e

    # Validate context visibility
    for ctx in contexts:
        _validate_context_visibility(db, viewer_id, ctx)

    # Check rate limits
    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer_id)
    rate_limiter.check_concurrent_limit(viewer_id)

    # Check token budget (only for platform keys)
    if use_platform_key:
        rate_limiter.check_token_budget(viewer_id)

    # Check conversation not busy (if existing conversation)
    if conversation_id:
        _check_conversation_not_busy(db, viewer_id, conversation_id)

    return model


def _validate_context_visibility(
    db: Session,
    viewer_id: UUID,
    ctx: dict,
) -> None:
    """Validate that viewer can see the context target.

    Raises:
        NotFoundError: If context target not visible (prevents existence leaks).
    """
    ctx_type = ctx.get("type")
    ctx_id = ctx.get("id")

    if ctx_type == "media":
        media = db.get(Media, ctx_id)
        if not media or not can_read_media(db, viewer_id, ctx_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")

    elif ctx_type == "highlight":
        highlight = db.get(Highlight, ctx_id)
        if not highlight:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        # Check media visibility
        media_id = highlight.fragment.media_id
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")

    elif ctx_type == "annotation":
        annotation = db.get(Annotation, ctx_id)
        if not annotation:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        # Check media visibility
        media_id = annotation.highlight.fragment.media_id
        if not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")


def _check_conversation_not_busy(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID,
) -> None:
    """Check that conversation has no pending assistant.

    Raises:
        ApiError(E_CONVERSATION_BUSY): If pending assistant exists.
        NotFoundError: If conversation not found or not owned.
    """
    conversation = db.get(Conversation, conversation_id)
    if not conversation or conversation.owner_user_id != viewer_id:
        raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")

    # Check for pending assistant
    pending = (
        db.query(Message)
        .filter(
            Message.conversation_id == conversation_id,
            Message.role == "assistant",
            Message.status == "pending",
        )
        .first()
    )

    if pending:
        raise ApiError(
            ApiErrorCode.E_CONVERSATION_BUSY,
            "Conversation has a pending assistant message",
        )


def phase1_prepare(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    content: str,
    model_id: UUID,
    contexts: list[dict],
    idempotency_key: str | None,
    payload_hash: str,
) -> PrepareResult:
    """Phase 1: Prepare (single DB transaction).

    Creates/locks conversation, inserts messages and contexts.
    """
    # Create conversation if needed
    if conversation_id:
        conversation = db.get(Conversation, conversation_id)
        if not conversation or conversation.owner_user_id != viewer_id:
            raise NotFoundError(ApiErrorCode.E_CONVERSATION_NOT_FOUND, "Conversation not found")
    else:
        conversation = Conversation(
            owner_user_id=viewer_id,
            sharing="private",
            next_seq=1,
        )
        db.add(conversation)
        db.flush()

    # Lock conversation and assign seq for user message
    user_seq = assign_next_message_seq(db, conversation.id)

    # Insert user message
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

    # Insert contexts
    for i, ctx in enumerate(contexts):
        ctx_type = ctx.get("type")
        ctx_id = ctx.get("id")

        insert_context(
            db=db,
            message_id=user_message.id,
            ordinal=i,
            target_type=ctx_type,
            media_id=ctx_id if ctx_type == "media" else None,
            highlight_id=ctx_id if ctx_type == "highlight" else None,
            annotation_id=ctx_id if ctx_type == "annotation" else None,
        )

    # Assign seq for assistant message
    assistant_seq = assign_next_message_seq(db, conversation.id)

    # Insert assistant placeholder
    assistant_message = Message(
        conversation_id=conversation.id,
        seq=assistant_seq,
        role="assistant",
        content="",
        status="pending",
        model_id=model_id,
    )
    db.add(assistant_message)
    db.flush()

    # Insert idempotency record
    if idempotency_key:
        expires_at = datetime.now(UTC) + timedelta(hours=IDEMPOTENCY_EXPIRY_HOURS)
        idempotency_record = IdempotencyKey(
            user_id=viewer_id,
            key=idempotency_key,
            payload_hash=payload_hash,
            user_message_id=user_message.id,
            assistant_message_id=assistant_message.id,
            expires_at=expires_at,
        )
        db.add(idempotency_record)

    db.commit()

    return PrepareResult(
        conversation=conversation,
        user_message=user_message,
        assistant_message=assistant_message,
    )


def phase2_execute(
    db: Session,
    viewer_id: UUID,
    model: Model,
    content: str,
    key_mode: str,
    contexts: list[dict],
    router: LLMRouter | None = None,
    call_context: LLMCallContext | None = None,
) -> tuple[ExecuteResult, ResolvedKey]:
    """Phase 2: Execute (no DB transaction held).

    Resolves key, renders prompt, calls LLM.

    Args:
        db: Database session.
        viewer_id: User ID.
        model: Model to use.
        content: User message content.
        key_mode: Key resolution mode.
        contexts: Context items.
        router: Optional shared LLMRouter from app.state.
        call_context: Observability metadata for the LLM call.

    Returns:
        Tuple of (ExecuteResult, ResolvedKey).
    """
    start_time = time.monotonic()

    # Resolve key
    resolved_key = resolve_api_key(db, viewer_id, model.provider, key_mode)

    # Render context blocks (from context_rendering.py - has DB access)
    context_text, context_chars = render_context_blocks(db, contexts)

    if context_chars > MAX_RENDERED_CONTEXT_CHARS:
        logger.warning(
            "context_exceeds_limit",
            context_chars=context_chars,
            limit=MAX_RENDERED_CONTEXT_CHARS,
        )

    # Split context into blocks for render_prompt
    context_blocks = [context_text] if context_text else []

    # Use PR-04's render_prompt for provider-agnostic prompt building
    messages = render_prompt(
        user_content=content,
        history=[],  # No history for single-turn
        context_blocks=context_blocks,
        system_prompt=DEFAULT_SYSTEM_PROMPT,
    )

    # Build request using PR-04's LLMRequest format
    request = LLMRequest(
        model_name=model.model_name,
        messages=messages,
        max_tokens=4096,
        temperature=0.7,
    )

    # Call LLM using sync wrapper (tests can mock this)
    try:
        response = generate(
            model.provider,
            request,
            resolved_key.api_key,
            int(LLM_TIMEOUT_SECONDS),
            router=router,
            key_mode=resolved_key.mode,
            call_context=call_context,
        )
        latency_ms = int((time.monotonic() - start_time) * 1000)

        return ExecuteResult(
            success=True,
            response=response,
            latency_ms=latency_ms,
        ), resolved_key

    except LLMError as e:
        latency_ms = int((time.monotonic() - start_time) * 1000)

        return ExecuteResult(
            success=False,
            error=e,
            latency_ms=latency_ms,
        ), resolved_key


def phase3_finalize(
    db: Session,
    viewer_id: UUID,
    assistant_message: Message,
    model: Model,
    execute_result: ExecuteResult,
    resolved_key: ResolvedKey,
    key_mode: str,
) -> None:
    """Phase 3: Finalize (single DB transaction).

    Updates assistant message, inserts message_llm, updates key status.
    """
    rate_limiter = get_rate_limiter()

    if execute_result.success and execute_result.response:
        response = execute_result.response

        # Truncate if needed (PR-04 uses 'text' instead of 'content')
        response_text = response.text
        if len(response_text) > MAX_ASSISTANT_CONTENT_LENGTH:
            response_text = response_text[:MAX_ASSISTANT_CONTENT_LENGTH] + TRUNCATION_NOTICE

        # Update assistant message
        assistant_message.content = response_text
        assistant_message.status = "complete"
        assistant_message.updated_at = datetime.now(UTC)

        # Extract usage (may be None per PR-04 spec)
        usage = response.usage
        prompt_tokens = usage.prompt_tokens if usage else None
        completion_tokens = usage.completion_tokens if usage else None
        total_tokens = usage.total_tokens if usage else None

        # Insert message_llm (with provider_request_id from PR-09)
        message_llm = MessageLLM(
            message_id=assistant_message.id,
            provider=model.provider,
            model_name=model.model_name,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            key_mode_requested=key_mode,
            key_mode_used=resolved_key.mode,
            latency_ms=execute_result.latency_ms,
            provider_request_id=response.provider_request_id,
            prompt_version=PROMPT_VERSION,
        )
        db.add(message_llm)

        # Update BYOK status
        if resolved_key.mode == "byok":
            update_user_key_status(db, resolved_key.user_key_id, "valid")

        # Charge token budget (platform keys only)
        if resolved_key.mode == "platform" and total_tokens:
            rate_limiter.charge_token_budget(
                viewer_id,
                assistant_message.id,
                total_tokens,
            )

    else:
        error = execute_result.error
        # Handle unknown error class gracefully
        error_class = error.error_class if error else LLMErrorClass.PROVIDER_DOWN

        # Set user-friendly error message
        default_message = "An unexpected error occurred. Please try again."
        error_message = ERROR_CLASS_TO_MESSAGE.get(error_class, default_message)

        # Update assistant message
        assistant_message.content = error_message
        assistant_message.status = "error"
        assistant_message.error_code = error_class.value
        assistant_message.updated_at = datetime.now(UTC)

        # Insert message_llm with error
        message_llm = MessageLLM(
            message_id=assistant_message.id,
            provider=model.provider,
            model_name=model.model_name,
            key_mode_requested=key_mode,
            key_mode_used=resolved_key.mode,
            latency_ms=execute_result.latency_ms,
            error_class=error_class.value,
            prompt_version=PROMPT_VERSION,
        )
        db.add(message_llm)

        # Update BYOK status if invalid key
        if resolved_key.mode == "byok" and error_class == LLMErrorClass.INVALID_KEY:
            update_user_key_status(db, resolved_key.user_key_id, "invalid")

    db.commit()


def send_message(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    content: str,
    model_id: UUID,
    key_mode: str = "auto",
    contexts: list[dict] | None = None,
    idempotency_key: str | None = None,
    router: LLMRouter | None = None,
) -> SendMessageResponse:
    """Send a message and get LLM response.

    Main entry point for the send-message flow.

    Args:
        db: Database session.
        viewer_id: User sending the message.
        conversation_id: Existing conversation ID, or None to create new.
        content: User message content.
        model_id: Model to use.
        key_mode: Key resolution mode (auto, byok_only, platform_only).
        contexts: Context items to include.
        idempotency_key: Optional idempotency key.
        router: Optional shared LLMRouter from app.state (for connection pooling).

    Returns:
        SendMessageResponse with conversation and messages.

    Raises:
        ApiError: Various error codes on failure.
    """
    contexts = contexts or []
    rate_limiter = get_rate_limiter()

    # PR-09: Generate flow_id for phase correlation
    flow_id = str(uuid4())
    set_flow_id(flow_id)
    total_start = time.monotonic()

    try:
        # Compute payload hash for idempotency
        context_dicts = [{"type": c.get("type"), "id": str(c.get("id"))} for c in contexts]
        payload_hash = compute_payload_hash(content, model_id, key_mode, context_dicts)

        # Check idempotency replay
        replay = check_idempotency(db, viewer_id, idempotency_key, payload_hash)
        if replay:
            user_message, assistant_message, conversation = replay
            message_count = get_message_count(db, conversation.id)

            return SendMessageResponse(
                conversation=conversation_to_out(conversation, message_count, viewer_id=viewer_id),
                user_message=message_to_out(user_message),
                assistant_message=message_to_out(assistant_message),
            )

        # Determine if using platform key
        model = get_model_by_id(db, model_id)
        if not model:
            raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found")

        try:
            resolved = resolve_api_key(db, viewer_id, model.provider, key_mode)
            use_platform_key = resolved.mode == "platform"
        except LLMError:
            use_platform_key = False

        # Phase 0: Pre-validation
        model = validate_pre_phase(
            db, viewer_id, conversation_id, content, model_id, key_mode, contexts, use_platform_key
        )

        # Increment in-flight counter
        rate_limiter.increment_inflight(viewer_id)

        try:
            # Phase 1: Prepare
            phase1_start = time.monotonic()
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
            phase1_ms = int((time.monotonic() - phase1_start) * 1000)

            # Build LLM call context for observability
            call_ctx = LLMCallContext(
                operation=LLMOperation.CHAT_SEND,
                conversation_id=str(prepare_result.conversation.id),
                assistant_message_id=str(prepare_result.assistant_message.id),
            )

            # Phase 2: Execute
            phase2_start = time.monotonic()
            execute_result, resolved_key = phase2_execute(
                db,
                viewer_id,
                model,
                content,
                key_mode,
                contexts,
                router=router,
                call_context=call_ctx,
            )
            phase2_ms = int((time.monotonic() - phase2_start) * 1000)

            # Phase 3: Finalize
            phase3_start = time.monotonic()
            phase3_finalize(
                db,
                viewer_id,
                prepare_result.assistant_message,
                model,
                execute_result,
                resolved_key,
                key_mode,
            )
            phase3_ms = int((time.monotonic() - phase3_start) * 1000)

            # Refresh to get updated data
            db.refresh(prepare_result.conversation)
            db.refresh(prepare_result.user_message)
            db.refresh(prepare_result.assistant_message)

            outcome = "success" if execute_result.success else "error"
            total_ms = int((time.monotonic() - total_start) * 1000)

            # PR-09: Emit send.completed event
            log_fn = logger.info if outcome == "success" else logger.error
            log_fn(
                "send.completed",
                **safe_kv(
                    conversation_id=str(prepare_result.conversation.id),
                    assistant_message_id=str(prepare_result.assistant_message.id),
                    outcome=outcome,
                    phase1_db_ms=phase1_ms,
                    phase2_provider_ms=phase2_ms,
                    phase3_finalize_ms=phase3_ms,
                    total_ms=total_ms,
                ),
            )

            message_count = get_message_count(db, prepare_result.conversation.id)

            return SendMessageResponse(
                conversation=conversation_to_out(
                    prepare_result.conversation, message_count, viewer_id=viewer_id
                ),
                user_message=message_to_out(prepare_result.user_message),
                assistant_message=message_to_out(prepare_result.assistant_message),
            )

        finally:
            # Decrement in-flight counter
            rate_limiter.decrement_inflight(viewer_id)

    finally:
        # PR-09: Clear flow_id
        set_flow_id(None)
