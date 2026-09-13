"""FastAPI dependencies owned by the API layer."""

from uuid import UUID

from fastapi import Request

from nexus.auth.bearer import parse_bearer_token
from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import set_stream_jti
from nexus.services import stream_tokens
from nexus.services.llm_execution import (
    ExecutionRuntime,
    ProviderRetryMode,
    build_execution_runtime,
)


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


def get_single_attempt_execution_runtime(request: Request) -> ExecutionRuntime:
    return build_execution_runtime(
        get_settings(),
        request.app.state.httpx_client,
        retry_mode=ProviderRetryMode.SingleAttempt,
    )
