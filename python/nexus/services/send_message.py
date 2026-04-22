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

import hashlib
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.auth.permissions import can_read_media
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
    ContextItem,
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
from nexus.services.conversations import (
    DEFAULT_CONVERSATION_TITLE,
    conversation_to_out,
    derive_conversation_title,
    get_message_count,
    message_to_out,
)
from nexus.services.llm import LLMRouter
from nexus.services.llm.errors import LLMError, LLMErrorClass
from nexus.services.llm.prompt import render_prompt
from nexus.services.llm.types import LLMCallContext, LLMOperation, LLMRequest, LLMResponse, Turn
from nexus.services.models import get_model_catalog_metadata
from nexus.services.quote_context_errors import (
    QuoteContextBlockingError,
    get_quote_context_error_message,
)
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
    LLMErrorClass.BAD_REQUEST: "The request was rejected by the model provider. Please try a different model or setting.",
    LLMErrorClass.CONTEXT_TOO_LARGE: "The context was too large for the model. Please try with less context.",
    LLMErrorClass.MODEL_NOT_AVAILABLE: "The requested model is not available.",
}

# Limits
MAX_ASSISTANT_CONTENT_LENGTH = 50000
TRUNCATION_NOTICE = "\n\n[Response truncated due to length]"
MAX_RENDERED_CONTEXT_CHARS = 25000
LLM_TIMEOUT_SECONDS = 45.0
IDEMPOTENCY_EXPIRY_HOURS = 24
MAX_HISTORY_TURNS = 40


@dataclass
class PrepareResult:
    """Result of Phase 1 (prepare)."""

    conversation: Conversation
    user_message: Message
    assistant_message: Message


def _get_highlight_anchor_media_id(
    highlight: Highlight,
    *,
    operation: str,
) -> UUID | None:
    """Return the canonical anchor media for a highlight or fail closed."""

    media_id = highlight.anchor_media_id
    if media_id is None:
        logger.warning(
            "send_message_highlight_missing_anchor_media",
            highlight_id=str(highlight.id),
            operation=operation,
            anchor_kind=highlight.anchor_kind,
        )
        return None

    if highlight.anchor_kind == "fragment_offsets":
        fragment_anchor = highlight.fragment_anchor
        if fragment_anchor is None:
            logger.warning(
                "send_message_highlight_missing_fragment_anchor",
                highlight_id=str(highlight.id),
                operation=operation,
            )
            return None
        fragment = fragment_anchor.fragment
        if fragment is not None and fragment.media_id != media_id:
            logger.warning(
                "send_message_highlight_fragment_media_mismatch",
                highlight_id=str(highlight.id),
                operation=operation,
                anchor_media_id=str(media_id),
                fragment_media_id=str(fragment.media_id),
            )
            return None
        return media_id

    if highlight.anchor_kind == "pdf_page_geometry":
        pdf_anchor = highlight.pdf_anchor
        if pdf_anchor is None or pdf_anchor.media_id != media_id:
            logger.warning(
                "send_message_highlight_pdf_anchor_invalid",
                highlight_id=str(highlight.id),
                operation=operation,
                anchor_media_id=str(media_id),
                pdf_anchor_media_id=str(pdf_anchor.media_id) if pdf_anchor is not None else None,
            )
            return None
        return media_id

    logger.warning(
        "send_message_highlight_unknown_anchor_kind",
        highlight_id=str(highlight.id),
        operation=operation,
        anchor_kind=highlight.anchor_kind,
    )
    return None


def compute_payload_hash(
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
    conversation_id: UUID | None,
) -> str:
    """Compute a hash of the request payload for idempotency."""
    sorted_contexts = sorted(contexts, key=lambda c: (c.type, str(c.id)))
    payload_contexts = [(ctx.type, str(ctx.id)) for ctx in sorted_contexts]
    payload_str = (
        f"{conversation_id}|{content}|{model_id}|{reasoning}|{key_mode}|{payload_contexts}"
    )
    return hashlib.sha256(payload_str.encode()).hexdigest()


def load_prompt_history(
    db: Session,
    conversation_id: UUID,
    before_seq: int,
) -> list[Turn]:
    """Load bounded user/assistant history for prompt construction."""
    rows = db.execute(
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

    rows.reverse()
    return [Turn(role=row[0], content=row[1]) for row in rows]


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
    reasoning: str,
    key_mode: str,
    contexts: Sequence[ContextItem],
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
    metadata = get_model_catalog_metadata(model.provider, model.model_name)
    if metadata is None:
        raise ApiError(
            ApiErrorCode.E_MODEL_NOT_AVAILABLE,
            "Model is outside the curated catalog",
        )
    _, _, _, reasoning_modes = metadata
    if reasoning not in reasoning_modes:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Reasoning mode '{reasoning}' is not supported for {model.provider}/{model.model_name}",
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
    ctx: ContextItem,
) -> None:
    """Validate that viewer can see the context target.

    Raises:
        NotFoundError: If context target not visible (prevents existence leaks).
    """
    ctx_type = ctx.type
    ctx_id = ctx.id

    if ctx_type == "media":
        media = db.get(Media, ctx_id)
        if not media or not can_read_media(db, viewer_id, ctx_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")

    elif ctx_type == "highlight":
        highlight = db.get(Highlight, ctx_id)
        if not highlight:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        media_id = _get_highlight_anchor_media_id(
            highlight,
            operation="send_message_validate_context_visibility",
        )
        if media_id is None or not can_read_media(db, viewer_id, media_id):
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")

    elif ctx_type == "annotation":
        annotation = db.get(Annotation, ctx_id)
        if not annotation:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        highlight = annotation.highlight
        if not highlight:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Context not found")
        media_id = _get_highlight_anchor_media_id(
            highlight,
            operation="send_message_validate_context_visibility",
        )
        if media_id is None or not can_read_media(db, viewer_id, media_id):
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
    contexts: Sequence[ContextItem],
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
            title=derive_conversation_title(content),
            sharing="private",
            next_seq=1,
        )
        db.add(conversation)
        db.flush()

    # Lock conversation and assign seq for user message
    user_seq = assign_next_message_seq(db, conversation.id)
    if user_seq == 1 and conversation.title == DEFAULT_CONVERSATION_TITLE:
        conversation.title = derive_conversation_title(content)

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
    context_items: list[dict] = []
    for i, ctx in enumerate(contexts):
        ctx_type = ctx.type
        ctx_id = ctx.id

        item = {"type": ctx_type, "id": str(ctx_id)}

        if ctx_type == "media":
            media = db.get(Media, ctx_id)
            if media is not None:
                item["media_id"] = str(media.id)
                item["media_title"] = media.title
                item["media_kind"] = media.kind
                item["preview"] = media.title

        elif ctx_type == "highlight":
            highlight = db.get(Highlight, ctx_id)
            if highlight is not None:
                item["color"] = highlight.color
                item["exact"] = highlight.exact
                item["preview"] = highlight.exact
                item["prefix"] = highlight.prefix
                item["suffix"] = highlight.suffix
                if highlight.annotation is not None:
                    item["annotation_body"] = highlight.annotation.body

                media_id = _get_highlight_anchor_media_id(
                    highlight,
                    operation="send_message_prepare_highlight_context",
                )
                if media_id is not None:
                    media = db.get(Media, media_id)
                    if media is not None:
                        item["media_id"] = str(media.id)
                        item["media_title"] = media.title
                        item["media_kind"] = media.kind

        elif ctx_type == "annotation":
            annotation = db.get(Annotation, ctx_id)
            if annotation is not None and annotation.highlight is not None:
                highlight = annotation.highlight
                item["annotation_body"] = annotation.body
                item["exact"] = highlight.exact
                item["preview"] = highlight.exact
                item["prefix"] = highlight.prefix
                item["suffix"] = highlight.suffix
                item["color"] = highlight.color

                media_id = _get_highlight_anchor_media_id(
                    highlight,
                    operation="send_message_prepare_annotation_context",
                )
                if media_id is not None:
                    media = db.get(Media, media_id)
                    if media is not None:
                        item["media_id"] = str(media.id)
                        item["media_title"] = media.title
                        item["media_kind"] = media.kind

        context_items.append(item)

        insert_context(
            db=db,
            message_id=user_message.id,
            ordinal=i,
            target_type=ctx_type,
            media_id=ctx_id if ctx_type == "media" else None,
            highlight_id=ctx_id if ctx_type == "highlight" else None,
            annotation_id=ctx_id if ctx_type == "annotation" else None,
        )

    user_message.context_items = context_items
    db.flush()

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


def finalize_pre_llm_quote_failure(
    db: Session,
    assistant_message: Message,
    model: Model,
    resolved_key: ResolvedKey,
    key_mode: str,
    error_code: ApiErrorCode,
    latency_ms: int,
) -> None:
    """Finalize assistant/message_llm for quote-blocking pre-LLM failures."""
    if assistant_message.status != "pending":
        return

    assistant_message.content = get_quote_context_error_message(error_code)
    assistant_message.status = "error"
    assistant_message.error_code = error_code.value
    assistant_message.updated_at = datetime.now(UTC)

    existing_llm = db.get(MessageLLM, assistant_message.id)
    if existing_llm is None:
        db.add(
            MessageLLM(
                message_id=assistant_message.id,
                provider=model.provider,
                model_name=model.model_name,
                key_mode_requested=key_mode,
                key_mode_used=resolved_key.mode,
                latency_ms=latency_ms,
                error_class=error_code.value,
                prompt_version=PROMPT_VERSION,
            )
        )

    db.commit()


def phase3_finalize(
    db: Session,
    viewer_id: UUID,
    assistant_message: Message,
    model: Model,
    response: LLMResponse | None,
    error: LLMError | None,
    latency_ms: int,
    resolved_key: ResolvedKey,
    key_mode: str,
) -> None:
    """Phase 3: Finalize (single DB transaction).

    Updates assistant message, inserts message_llm, updates key status.
    """
    rate_limiter = get_rate_limiter()

    if response is not None:
        response_text = response.text
        if len(response_text) > MAX_ASSISTANT_CONTENT_LENGTH:
            response_text = response_text[:MAX_ASSISTANT_CONTENT_LENGTH] + TRUNCATION_NOTICE

        assistant_message.content = response_text
        assistant_message.status = "complete"
        assistant_message.updated_at = datetime.now(UTC)

        usage = response.usage
        prompt_tokens = usage.prompt_tokens if usage else None
        completion_tokens = usage.completion_tokens if usage else None
        total_tokens = usage.total_tokens if usage else None

        db.add(
            MessageLLM(
                message_id=assistant_message.id,
                provider=model.provider,
                model_name=model.model_name,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                key_mode_requested=key_mode,
                key_mode_used=resolved_key.mode,
                latency_ms=latency_ms,
                provider_request_id=response.provider_request_id,
                prompt_version=PROMPT_VERSION,
            )
        )

        if resolved_key.mode == "byok":
            update_user_key_status(db, resolved_key.user_key_id, "valid")

        if resolved_key.mode == "platform" and total_tokens:
            rate_limiter.charge_token_budget(viewer_id, assistant_message.id, total_tokens)

    else:
        error_class = error.error_class if error else LLMErrorClass.PROVIDER_DOWN
        error_message = ERROR_CLASS_TO_MESSAGE.get(
            error_class, "An unexpected error occurred. Please try again."
        )

        assistant_message.content = error_message
        assistant_message.status = "error"
        assistant_message.error_code = error_class.value
        assistant_message.updated_at = datetime.now(UTC)

        db.add(
            MessageLLM(
                message_id=assistant_message.id,
                provider=model.provider,
                model_name=model.model_name,
                key_mode_requested=key_mode,
                key_mode_used=resolved_key.mode,
                latency_ms=latency_ms,
                error_class=error_class.value,
                prompt_version=PROMPT_VERSION,
            )
        )

        if resolved_key.mode == "byok" and error_class == LLMErrorClass.INVALID_KEY:
            update_user_key_status(db, resolved_key.user_key_id, "invalid")

    db.commit()


async def send_message(
    db: Session,
    viewer_id: UUID,
    conversation_id: UUID | None,
    content: str,
    model_id: UUID,
    reasoning: str,
    key_mode: str = "auto",
    contexts: Sequence[ContextItem] | None = None,
    idempotency_key: str | None = None,
    *,
    router: LLMRouter,
) -> SendMessageResponse:
    """Send a message and get LLM response.

    Async entry point for the non-streaming send-message flow.
    Sync DB calls run via run_in_threadpool; the LLM call awaits on the
    main event loop so the shared httpx.AsyncClient is used correctly.
    """
    contexts = list(contexts or [])
    rate_limiter = get_rate_limiter()

    flow_id = str(uuid4())
    set_flow_id(flow_id)
    total_start = time.monotonic()

    try:
        context_dicts = [{"type": c.type, "id": c.id} for c in contexts]
        payload_hash = compute_payload_hash(
            content,
            model_id,
            reasoning,
            key_mode,
            contexts,
            conversation_id,
        )

        # Idempotency replay
        replay = await run_in_threadpool(
            check_idempotency, db, viewer_id, idempotency_key, payload_hash
        )
        if replay:
            user_message, assistant_message, conversation = replay
            message_count = await run_in_threadpool(get_message_count, db, conversation.id)
            return SendMessageResponse(
                conversation=conversation_to_out(conversation, message_count, viewer_id=viewer_id),
                user_message=message_to_out(user_message),
                assistant_message=message_to_out(assistant_message),
            )

        model = await run_in_threadpool(get_model_by_id, db, model_id)
        if not model:
            raise ApiError(ApiErrorCode.E_MODEL_NOT_AVAILABLE, "Model not found")

        try:
            resolved = await run_in_threadpool(
                resolve_api_key, db, viewer_id, model.provider, key_mode
            )
            use_platform_key = resolved.mode == "platform"
        except LLMError:
            use_platform_key = False

        # Phase 0: Pre-validation
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

        rate_limiter.acquire_inflight_slot(viewer_id)

        try:
            # Phase 1: Prepare
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
            phase1_ms = int((time.monotonic() - phase1_start) * 1000)

            call_ctx = LLMCallContext(
                operation=LLMOperation.CHAT_SEND,
                conversation_id=str(prepare_result.conversation.id),
                assistant_message_id=str(prepare_result.assistant_message.id),
            )

            # Phase 2: Resolve key, render context, call LLM
            phase2_start = time.monotonic()

            resolved_key = await run_in_threadpool(
                resolve_api_key, db, viewer_id, model.provider, key_mode
            )

            try:
                context_text, context_chars = await run_in_threadpool(
                    render_context_blocks, db, context_dicts
                )
            except QuoteContextBlockingError as quote_err:
                phase2_ms = int((time.monotonic() - phase2_start) * 1000)
                phase3_start = time.monotonic()
                await run_in_threadpool(
                    finalize_pre_llm_quote_failure,
                    db,
                    prepare_result.assistant_message,
                    model,
                    resolved_key,
                    key_mode,
                    quote_err.error_code,
                    phase2_ms,
                )
                phase3_ms = int((time.monotonic() - phase3_start) * 1000)
                total_ms = int((time.monotonic() - total_start) * 1000)
                logger.warning(
                    "send.quote_context_blocked",
                    **safe_kv(
                        conversation_id=str(prepare_result.conversation.id),
                        assistant_message_id=str(prepare_result.assistant_message.id),
                        error_code=quote_err.error_code.value,
                        phase1_db_ms=phase1_ms,
                        phase2_pre_llm_ms=phase2_ms,
                        phase3_finalize_ms=phase3_ms,
                        total_ms=total_ms,
                    ),
                )
                raise ApiError(quote_err.error_code, quote_err.message) from quote_err

            if context_chars > MAX_RENDERED_CONTEXT_CHARS:
                logger.warning(
                    "context_exceeds_limit",
                    context_chars=context_chars,
                    limit=MAX_RENDERED_CONTEXT_CHARS,
                )

            history = await run_in_threadpool(
                load_prompt_history,
                db,
                prepare_result.conversation.id,
                prepare_result.user_message.seq,
            )
            messages = render_prompt(
                user_content=content,
                history=history,
                context_blocks=[context_text] if context_text else [],
                context_types={c.type for c in contexts},
            )
            llm_request = LLMRequest(
                model_name=model.model_name,
                messages=messages,
                max_tokens=4096,
                temperature=0.7,
                reasoning_effort=reasoning,
            )

            # LLM call — await on main event loop (no asyncio.run)
            response: LLMResponse | None = None
            llm_error: LLMError | None = None
            try:
                response = await router.generate(
                    model.provider,
                    llm_request,
                    resolved_key.api_key,
                    timeout_s=int(LLM_TIMEOUT_SECONDS),
                    key_mode=resolved_key.mode,
                    call_context=call_ctx,
                )
            except LLMError as e:
                llm_error = e

            phase2_ms = int((time.monotonic() - phase2_start) * 1000)

            # Phase 3: Finalize
            phase3_start = time.monotonic()
            await run_in_threadpool(
                phase3_finalize,
                db,
                viewer_id,
                prepare_result.assistant_message,
                model,
                response,
                llm_error,
                phase2_ms,
                resolved_key,
                key_mode,
            )
            phase3_ms = int((time.monotonic() - phase3_start) * 1000)

            await run_in_threadpool(db.refresh, prepare_result.conversation)
            await run_in_threadpool(db.refresh, prepare_result.user_message)
            await run_in_threadpool(db.refresh, prepare_result.assistant_message)

            outcome = "success" if response is not None else "error"
            total_ms = int((time.monotonic() - total_start) * 1000)

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

            message_count = await run_in_threadpool(
                get_message_count, db, prepare_result.conversation.id
            )

            return SendMessageResponse(
                conversation=conversation_to_out(
                    prepare_result.conversation, message_count, viewer_id=viewer_id
                ),
                user_message=message_to_out(prepare_result.user_message),
                assistant_message=message_to_out(prepare_result.assistant_message),
            )

        finally:
            rate_limiter.release_inflight_slot(viewer_id)

    finally:
        set_flow_id(None)
