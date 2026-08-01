"""FastAPI dependencies owned by the API layer."""

from uuid import UUID

from fastapi import Request
from provider_runtime import ProviderRuntime

from nexus.auth.bearer import parse_bearer_token
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import set_stream_jti
from nexus.services import stream_tokens
from nexus.services.llm_execution import ExecutionRuntime, ProductionExecutionRuntime


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


def get_execution_runtime(request: Request) -> ExecutionRuntime:
    """Build the request-scoped LLM runtime over the app's shared HTTP client."""
    return ProductionExecutionRuntime(ProviderRuntime(request.app.state.httpx_client))
