"""Streaming API routes under /stream/*.

Per PR-08 spec §10:
- POST /stream/conversations/{id}/messages — existing conversation
- POST /stream/conversations/messages — new conversation
- Auth: Authorization: Bearer <stream_token> (not supabase)
- CORS via custom middleware (StreamCORSMiddleware)
- Same request body as non-streaming send-message

These routes are browser-callable. Auth middleware skips /stream/* paths;
authentication is handled by verify_stream_token dependency.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import StreamingResponse

from nexus.api.deps import get_llm_router, get_session_factory, get_web_search_provider
from nexus.auth.stream_token import verify_stream_token
from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger, set_stream_jti
from nexus.schemas.conversation import SendMessageRequest
from nexus.services.agent_tools.web_search import WebSearchProvider
from nexus.services.llm import LLMRouter
from nexus.services.send_message_stream import stream_send_message_async

logger = get_logger(__name__)

router = APIRouter(prefix="/stream", tags=["streaming"])


def get_stream_viewer(request: Request) -> UUID:
    """Dependency: verify stream token and return user_id.

    Extracts bearer token from Authorization header, verifies it
    using stream token verification (HS256, iss/aud/scope/jti checks).

    PR-09: Also sets stream_jti in logging context for correlation.
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.lower().startswith("bearer "):
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID,
            "Missing or invalid Authorization header",
        )

    token = auth_header[7:].strip()
    if not token:
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID,
            "Empty bearer token",
        )

    user_id, jti = verify_stream_token(token)

    # PR-09: Set stream_jti in logging context
    if jti:
        set_stream_jti(jti)

    return user_id


@router.post("/conversations/{conversation_id}/messages")
async def stream_send_existing(
    conversation_id: UUID,
    body: SendMessageRequest,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    llm_router: Annotated[LLMRouter, Depends(get_llm_router)],
    web_search_provider: Annotated[WebSearchProvider | None, Depends(get_web_search_provider)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> StreamingResponse:
    """Send a message with SSE streaming in an existing conversation.

    Browser-callable via stream token auth.
    """
    settings = get_settings()
    if not settings.enable_streaming:
        raise ApiError(ApiErrorCode.E_FORBIDDEN, "Streaming is disabled")

    db_factory = get_session_factory()

    return StreamingResponse(
        stream_send_message_async(
            db_factory=db_factory,
            viewer_id=viewer_id,
            conversation_id=conversation_id,
            content=body.content,
            model_id=body.model_id,
            reasoning=body.reasoning,
            key_mode=body.key_mode,
            contexts=body.contexts,
            web_search=body.web_search,
            idempotency_key=idempotency_key,
            llm_router=llm_router,
            web_search_provider=web_search_provider,
            web_search_country=settings.brave_search_country,
            web_search_language=settings.brave_search_language,
            web_search_safe_search=settings.brave_search_safe_search,
        ),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/conversations/messages")
async def stream_send_new(
    body: SendMessageRequest,
    viewer_id: Annotated[UUID, Depends(get_stream_viewer)],
    llm_router: Annotated[LLMRouter, Depends(get_llm_router)],
    web_search_provider: Annotated[WebSearchProvider | None, Depends(get_web_search_provider)],
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
) -> StreamingResponse:
    """Send a message with SSE streaming, creating a new conversation.

    Browser-callable via stream token auth.
    """
    settings = get_settings()
    if not settings.enable_streaming:
        raise ApiError(ApiErrorCode.E_FORBIDDEN, "Streaming is disabled")

    db_factory = get_session_factory()

    return StreamingResponse(
        stream_send_message_async(
            db_factory=db_factory,
            viewer_id=viewer_id,
            conversation_id=None,
            content=body.content,
            model_id=body.model_id,
            reasoning=body.reasoning,
            key_mode=body.key_mode,
            contexts=body.contexts,
            web_search=body.web_search,
            idempotency_key=idempotency_key,
            llm_router=llm_router,
            web_search_provider=web_search_provider,
            web_search_country=settings.brave_search_country,
            web_search_language=settings.brave_search_language,
            web_search_safe_search=settings.brave_search_safe_search,
        ),
        media_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )
