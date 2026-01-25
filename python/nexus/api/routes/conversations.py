"""Conversations and Messages API routes.

Route handlers for conversation and message CRUD operations.
Routes are transport-only: each calls exactly one service function.

Per PR-02 spec:
- Conversations: GET/POST/DELETE
- Messages: GET (list), DELETE

Per PR-05 spec:
- Message creation: POST /conversations/{id}/messages (send message + LLM response)

All routes require authentication.
Response envelope: {"data": ...} or {"data": [...], "page": {...}}
Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from nexus.api.deps import get_db, get_llm_router
from nexus.auth.middleware import Viewer, get_viewer
from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.schemas.conversation import SendMessageRequest
from nexus.services import conversations as conversations_service
from nexus.services import send_message as send_message_service
from nexus.services import send_message_stream
from nexus.services.llm import LLMRouter

router = APIRouter(tags=["conversations"])


# =============================================================================
# Conversation Endpoints
# =============================================================================


@router.get("/conversations")
def list_conversations(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=100, description="Maximum results (1-100)"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
) -> dict:
    """List conversations owned by the viewer.

    Returns conversations ordered by updated_at DESC, id DESC.
    Supports cursor-based pagination.

    Errors:
        E_INVALID_CURSOR (400): Cursor is malformed or unparseable.
    """
    conversations, page = conversations_service.list_conversations(
        db=db,
        viewer_id=viewer.user_id,
        limit=limit,
        cursor=cursor,
    )
    return {
        "data": [c.model_dump(mode="json") for c in conversations],
        "page": page.model_dump(mode="json"),
    }


@router.post("/conversations", status_code=201)
def create_conversation(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create an empty private conversation.

    Returns 201 Created with the conversation object.
    """
    result = conversations_service.create_conversation(
        db=db,
        viewer_id=viewer.user_id,
    )
    return success_response(result.model_dump(mode="json"))


@router.get("/conversations/{conversation_id}")
def get_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a conversation by ID.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    result = conversations_service.get_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return success_response(result.model_dump(mode="json"))


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a conversation.

    Cascades to messages, message_context, conversation_media, conversation_shares.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
    """
    conversations_service.delete_conversation(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
    )
    return Response(status_code=204)


# =============================================================================
# Message Endpoints
# =============================================================================


@router.get("/conversations/{conversation_id}/messages")
def list_messages(
    conversation_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=100, description="Maximum results (1-100)"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
) -> dict:
    """List messages in a conversation.

    Returns messages ordered by seq ASC, id ASC (oldest first, chat order).
    Supports cursor-based pagination.

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
        E_INVALID_CURSOR (400): Cursor is malformed or unparseable.
    """
    messages, page = conversations_service.list_messages(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        limit=limit,
        cursor=cursor,
    )
    return {
        "data": [m.model_dump(mode="json") for m in messages],
        "page": page.model_dump(mode="json"),
    }


@router.delete("/messages/{message_id}", status_code=204)
def delete_message(
    message_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a single message.

    If this is the last message in the conversation, deletes the conversation too.
    Cascades to message_context.

    Errors:
        E_MESSAGE_NOT_FOUND (404): Message doesn't exist or viewer is not conversation owner.
    """
    conversations_service.delete_message(
        db=db,
        viewer_id=viewer.user_id,
        message_id=message_id,
    )
    return Response(status_code=204)


# =============================================================================
# Send Message Endpoints (PR-05)
# =============================================================================


@router.post("/conversations/messages", status_code=200)
def send_message_new_conversation(
    body: SendMessageRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    llm_router: Annotated[LLMRouter, Depends(get_llm_router)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    """Send a message and create a new conversation.

    Creates a new conversation, sends the user message, and returns the
    assistant response from the selected LLM model.

    Per PR-05 spec, this endpoint:
    - Creates conversation + user message + assistant message atomically
    - Executes LLM call outside DB transaction
    - Supports idempotency via Idempotency-Key header
    - Enforces rate limits and token budgets

    Errors:
        E_MESSAGE_TOO_LONG (400): Message exceeds 20,000 char limit.
        E_CONTEXT_TOO_LARGE (400): Context exceeds limits.
        E_MODEL_NOT_AVAILABLE (400): Model not found or not available.
        E_LLM_NO_KEY (400): No API key available for provider.
        E_RATE_LIMITED (429): Per-user rate limit exceeded.
        E_TOKEN_BUDGET_EXCEEDED (429): Platform token budget exceeded.
        E_IDEMPOTENCY_KEY_REPLAY_MISMATCH (409): Key reused with different payload.
    """
    # Convert contexts to dicts
    contexts = [{"type": c.type, "id": c.id} for c in body.contexts]

    result = send_message_service.send_message(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=None,  # New conversation
        content=body.content,
        model_id=body.model_id,
        key_mode=body.key_mode,
        contexts=contexts,
        idempotency_key=idempotency_key,
        router=llm_router,
    )

    return success_response(result.model_dump(mode="json"))


@router.post("/conversations/{conversation_id}/messages", status_code=200)
def send_message_existing_conversation(
    conversation_id: UUID,
    body: SendMessageRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    llm_router: Annotated[LLMRouter, Depends(get_llm_router)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> dict:
    """Send a message in an existing conversation.

    Sends the user message in the specified conversation and returns the
    assistant response from the selected LLM model.

    Per PR-05 spec, this endpoint:
    - Locks conversation and assigns seq atomically
    - Executes LLM call outside DB transaction
    - Supports idempotency via Idempotency-Key header
    - Enforces rate limits and token budgets

    Errors:
        E_CONVERSATION_NOT_FOUND (404): Conversation doesn't exist or viewer is not owner.
        E_CONVERSATION_BUSY (409): Pending assistant already exists.
        E_MESSAGE_TOO_LONG (400): Message exceeds 20,000 char limit.
        E_CONTEXT_TOO_LARGE (400): Context exceeds limits.
        E_MODEL_NOT_AVAILABLE (400): Model not found or not available.
        E_LLM_NO_KEY (400): No API key available for provider.
        E_RATE_LIMITED (429): Per-user rate limit exceeded.
        E_TOKEN_BUDGET_EXCEEDED (429): Platform token budget exceeded.
        E_IDEMPOTENCY_KEY_REPLAY_MISMATCH (409): Key reused with different payload.
    """
    # Convert contexts to dicts
    contexts = [{"type": c.type, "id": c.id} for c in body.contexts]

    result = send_message_service.send_message(
        db=db,
        viewer_id=viewer.user_id,
        conversation_id=conversation_id,
        content=body.content,
        model_id=body.model_id,
        key_mode=body.key_mode,
        contexts=contexts,
        idempotency_key=idempotency_key,
        router=llm_router,
    )

    return success_response(result.model_dump(mode="json"))


# =============================================================================
# Streaming Endpoints (Feature-Flagged)
# =============================================================================


@router.post("/conversations/messages/stream")
def send_message_stream_new(
    body: SendMessageRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> StreamingResponse:
    """Send a message with streaming response (new conversation).

    Creates a new conversation and streams the assistant response via SSE.

    Requires ENABLE_STREAMING=true in environment.

    SSE Events:
    - meta: Initial metadata (conversation_id, message IDs, model, provider)
    - delta: Incremental content chunks
    - done: Final status and usage

    Errors:
        E_FORBIDDEN (403): Streaming is disabled.
        (Same errors as non-streaming endpoint)
    """
    settings = get_settings()
    if not settings.enable_streaming:
        raise ApiError(ApiErrorCode.E_FORBIDDEN, "Streaming is disabled")

    contexts = [{"type": c.type, "id": c.id} for c in body.contexts]

    return StreamingResponse(
        send_message_stream.stream_send_message(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=None,
            content=body.content,
            model_id=body.model_id,
            key_mode=body.key_mode,
            contexts=contexts,
            idempotency_key=idempotency_key,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # Disable nginx buffering
        },
    )


@router.post("/conversations/{conversation_id}/messages/stream")
def send_message_stream_existing(
    conversation_id: UUID,
    body: SendMessageRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> StreamingResponse:
    """Send a message with streaming response (existing conversation).

    Streams the assistant response via SSE in an existing conversation.

    Requires ENABLE_STREAMING=true in environment.

    SSE Events:
    - meta: Initial metadata (conversation_id, message IDs, model, provider)
    - delta: Incremental content chunks
    - done: Final status and usage

    Errors:
        E_FORBIDDEN (403): Streaming is disabled.
        (Same errors as non-streaming endpoint)
    """
    settings = get_settings()
    if not settings.enable_streaming:
        raise ApiError(ApiErrorCode.E_FORBIDDEN, "Streaming is disabled")

    contexts = [{"type": c.type, "id": c.id} for c in body.contexts]

    return StreamingResponse(
        send_message_stream.stream_send_message(
            db=db,
            viewer_id=viewer.user_id,
            conversation_id=conversation_id,
            content=body.content,
            model_id=body.model_id,
            key_mode=body.key_mode,
            contexts=contexts,
            idempotency_key=idempotency_key,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
