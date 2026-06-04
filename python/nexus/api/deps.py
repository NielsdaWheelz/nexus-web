"""FastAPI dependencies owned by the API layer."""

from uuid import UUID

from fastapi import Request
from llm_calling.router import LLMRouter

from nexus.auth.bearer import parse_bearer_token
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import set_stream_jti
from nexus.services import stream_tokens


def get_stream_viewer(request: Request) -> UUID:
    """Authenticate a browser-callable SSE request via its stream-token bearer.

    Shared by the chat-run, oracle, and media event streams, so it lives here
    rather than in any one route module.
    """
    token = parse_bearer_token(request.headers.get("authorization"))
    if token is None:
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID, "Missing or invalid Authorization header"
        )
    verified = stream_tokens.verify_stream_token(token)
    set_stream_jti(verified.jti)
    return verified.user_id


def get_llm_router(request: Request) -> LLMRouter:
    """Get the shared LLM router from app state.

    App lifecycle contract:
    - LLMRouter is initialized at app startup with shared httpx.AsyncClient
    - Provides connection pooling and proper cleanup

    Args:
        request: The incoming request (provides access to app.state)

    Returns:
        The shared LLMRouter instance.
    """
    return request.app.state.llm_router
