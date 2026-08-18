"""FastAPI dependencies owned by the API layer."""

from typing import Annotated
from uuid import UUID

from fastapi import Header, Request

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
from nexus.services.tool_runtime.declarations import BROWSER_TOOL_PROJECTION_REVISION

TOOL_PROJECTION_HEADER = "X-Nexus-Tool-Projection"


def require_tool_projection_revision(
    revision: Annotated[str | None, Header(alias=TOOL_PROJECTION_HEADER)] = None,
) -> None:
    """Reject stale same-system Chat clients before auth, reads, or mutation."""

    if revision != BROWSER_TOOL_PROJECTION_REVISION:
        raise ApiError(
            ApiErrorCode.E_TOOL_PROJECTION_RELOAD_REQUIRED,
            "Reload Nexus to continue",
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
