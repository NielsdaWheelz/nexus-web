"""FastAPI dependencies owned by the API layer."""

from uuid import UUID

from fastapi import Request
from web_search_tool.types import WebSearchProvider

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


def get_web_search_provider(request: Request) -> WebSearchProvider:
    """Get the shared web-search provider from app state.

    Initialized at app startup over the shared httpx client, the same instance the
    chat ``web_search`` tool uses. ``None`` means no provider key is configured.
    """
    provider = request.app.state.web_search_provider
    if provider is None:
        raise ApiError(
            ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE,
            "Web search provider is not configured",
        )
    return provider
