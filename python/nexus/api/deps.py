"""FastAPI dependencies owned by the API layer."""

from typing import Annotated
from uuid import UUID

import httpx
from fastapi import Header, Request

from nexus.auth.bearer import parse_bearer_token
from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import set_stream_jti
from nexus.services import stream_tokens
from nexus.services.generation_catalog import GenerationCatalogService
from nexus.services.generation_runtime import compose_generation_execution_runtime
from nexus.services.llm_execution import ExecutionRuntime
from nexus.services.tool_runtime.catalog import ComposedToolRuntime
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


def get_generation_runtime(request: Request) -> ExecutionRuntime:
    """Compose request-scoped routing over process-owned clients and catalogs."""

    http_client = getattr(request.app.state, "httpx_client", None)
    tools = getattr(request.app.state, "tool_runtime", None)
    if not isinstance(http_client, httpx.AsyncClient):
        raise RuntimeError("generation HTTP client is not initialized")
    if not isinstance(tools, ComposedToolRuntime):
        raise RuntimeError("generation tool runtime is not initialized")
    return compose_generation_execution_runtime(
        get_settings(),
        http_client=http_client,
        catalog=get_generation_catalog_service(request),
        tools=tools,
    )


def get_generation_catalog_service(request: Request) -> GenerationCatalogService:
    """Return the one process-owned generation catalog/cache service."""

    service = getattr(request.app.state, "generation_catalog_service", None)
    # justify-service-invariant-check: Starlette app.state is intentionally
    # dynamic, so this boundary must turn incomplete composition into one loud
    # operator defect instead of leaking Any into request handlers.
    if not isinstance(service, GenerationCatalogService):
        raise RuntimeError("generation catalog service is not initialized")
    return service
