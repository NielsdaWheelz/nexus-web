"""FastAPI application creation and configuration.

This module creates and configures the FastAPI application instance.
It registers exception handlers, auth middleware, request-id middleware, and routes.

Token Verification:
- All environments (local, test, staging, prod) use SupabaseJwksVerifier
- Runtime always verifies JWTs via Supabase JWKS endpoint
- Only environment values change between environments

Middleware Ordering (Critical):
- Middleware runs in reverse order of registration
- RequestIDMiddleware is added LAST so it runs FIRST (outermost)
- This ensures all requests (including auth failures) get X-Request-ID

Order of registration:
1. AuthMiddleware (innermost auth boundary)
2. StreamCORSMiddleware when configured (stream route CORS)
3. RequestIDMiddleware (outermost request logging and X-Request-ID)

Actual execution order per request:
1. RequestIDMiddleware (sets request_id, starts timer)
2. StreamCORSMiddleware when configured (stream route CORS)
3. AuthMiddleware (verifies auth, sets viewer)
4. Route handler and function-scoped database dependencies
5. AuthMiddleware (returns response)
6. StreamCORSMiddleware when configured (stream route CORS)
7. RequestIDMiddleware (logs, sets response header)

Outbound client lifecycle:
- httpx.AsyncClient is created at startup, stored in app.state, and shared by
  the Brave-backed Nexus tool runtime. Generation catalogs compose the private
  Codex UDS with configured API-provider rows.
- validate_policy() runs at startup to fail fast when the operation table is
  not total or names a tool plan that does not exist (mirrors worker startup).
- Client is closed gracefully at shutdown
"""

import re
from contextlib import asynccontextmanager
from uuid import UUID

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from nexus.api.routes import create_api_router
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import SupabaseJwksVerifier
from nexus.config import Environment, get_settings
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.middleware.request_id import RequestIDMiddleware
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.public_resource_security import (
    PUBLIC_RESOURCE_SHARE_PATH_RE,
    apply_public_resource_share_headers,
)
from nexus.responses import (
    api_error_handler,
    error_response,
    http_exception_handler,
    unhandled_exception_handler,
)
from nexus.runtime_health import get_runtime_identity
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.generation.catalog import Catalog
from nexus.services.generation.policy import validate_policy
from nexus.services.memory_client import load_memory_client_config
from nexus.services.tool_runtime.catalog import (
    compose_configured_web_search_provider,
    compose_tool_runtime,
)

logger = get_logger(__name__)

# Exact private response paths. These responses carry per-viewer state or
# private source capabilities and must never be retained by an intermediary.
PRIVATE_NO_STORE_PATH_RE = re.compile(
    r"/llm-catalog|/imports(/.*)?|/media/[^/]+/reader-state"
    r"|/me/reader-profile|/consumption/(activity|activity-exclusions|stats|sessions)"
)


def create_bootstrap_callback():
    """Create a bootstrap callback that creates its own database session.

    The callback is called by the auth middleware for each authenticated request.
    It creates a fresh database session, runs the bootstrap, and closes it.
    """
    session_factory = get_session_factory()

    def bootstrap(user_id: UUID, email: str | None = None) -> UUID:
        # AuthMiddleware owns the process-local successful-result cache and
        # coalesces same-process cold misses before invoking this blocking path
        # in its threadpool. The durable SERIALIZABLE bootstrap remains
        # idempotent across processes.
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id, email=email)
        finally:
            db.close()

    return bootstrap


def create_token_verifier():
    """Create the token verifier using Supabase JWKS.

    All environments (local, test, staging, prod) use the same verifier.
    Only the configuration values (JWKS URL, issuer, audiences) change.

    Returns:
        SupabaseJwksVerifier configured with settings from environment.
    """
    settings = get_settings()
    jwks_url = settings.supabase_jwks_url
    issuer = settings.normalized_issuer
    if not jwks_url or not issuer:
        raise RuntimeError("Supabase auth settings are not configured")

    return SupabaseJwksVerifier(
        jwks_url=jwks_url,
        issuer=issuer,
        audiences=settings.audience_list,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle resources.

    Lifecycle behavior:
    - Fails fast on an incomplete generation operation table; config.py
      separately enforces retained non-generation service credentials
    - Creates shared httpx.AsyncClient for connection pooling (web search)
    - Cleans up on shutdown
    """
    settings = get_settings()
    get_runtime_identity()

    validate_policy()
    memory_config = load_memory_client_config(settings.memory_client_config_path)

    # Create shared HTTP client for outbound calls (web search).
    app.state.httpx_client = httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=10.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
        trust_env=False,
    )

    app.state.web_search_provider = compose_configured_web_search_provider(
        app.state.httpx_client,
        settings=settings,
    )
    app.state.tool_runtime = compose_tool_runtime(
        app.state.web_search_provider,
        embedding_available=bool(settings.openai_api_key),
        memory_config=memory_config,
    )
    app.state.generation_catalog = Catalog(settings, app.state.tool_runtime)
    logger.info(
        "app_lifespan_started",
        web_search_provider="brave" if settings.brave_search_api_key else None,
    )

    yield

    # Shutdown: close shared HTTP client.
    await app.state.httpx_client.aclose()
    logger.info("httpx_client_closed")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    settings = get_settings()

    # Interactive API docs are exposed only in non-production environments.
    # In staging/prod they are disabled so the schema is not served publicly.
    docs_disabled = settings.nexus_env in (Environment.STAGING, Environment.PROD)

    app = FastAPI(
        title="Nexus API",
        description="Backend API for Nexus - a reading and notes platform",
        version="0.1.0",
        docs_url=None if docs_disabled else "/docs",
        redoc_url=None if docs_disabled else "/redoc",
        openapi_url=None if docs_disabled else "/openapi.json",
        lifespan=lifespan,
    )

    # Register exception handlers
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

    # The five author-surface endpoints return 422 for structural/bounds
    # validation failures (author-dedup spec §6 / D-10); the rest of the wire
    # keeps its established 400 convention.
    author_surface_422_re = re.compile(r"^/contributors(?:/|$)|^/media/[^/]+/authors$")
    chat_selection_route_re = re.compile(r"^/chat-runs$|^/messages/[^/]+/(?:rerun|regenerate)$")

    # Handle JSON parsing errors specifically
    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Handle request validation errors (including malformed JSON).

        Logged errors are redacted to location/type only: the pydantic ``input``
        and ``ctx`` values echo request content (reader locators, quote context,
        URL targets) and must never reach logs.
        """
        logger.warning(
            "request_validation_failed",
            path=request.url.path,
            method=request.method,
            errors=[
                {"type": err.get("type"), "loc": err.get("loc"), "msg": err.get("msg")}
                for err in exc.errors()
            ],
        )
        invalid_chat_selection = (
            request.method == "POST"
            and bool(chat_selection_route_re.fullmatch(request.url.path))
            and any(
                len(error.get("loc", ())) >= 2
                and error["loc"][0] == "body"
                and error["loc"][1] == "selection"
                for error in exc.errors()
            )
        )
        status_code = (
            422 if invalid_chat_selection or author_surface_422_re.search(request.url.path) else 400
        )
        code = (
            ApiErrorCode.E_INVALID_GENERATION_SELECTION
            if invalid_chat_selection
            else ApiErrorCode.E_INVALID_REQUEST
        )
        return JSONResponse(
            status_code=status_code,
            content=error_response(code, "Invalid request body"),
        )

    # Include API routes (must be before middleware for correct ordering). The
    # factory owns every router, including the browser-callable SSE streams and
    # the BFF stream-token mint.
    app.include_router(
        create_api_router(
            podcasts=settings.podcasts_enabled, email_ingest=settings.email_ingest_enabled
        )
    )

    # Add auth middleware (runs on all requests except public paths)
    verifier = create_token_verifier()
    bootstrap_callback = create_bootstrap_callback()

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=settings.requires_internal_header,
        internal_secret=settings.nexus_internal_secret,
        bootstrap_callback=bootstrap_callback,
    )

    logger.info(
        "auth_middleware_enabled",
        env=settings.nexus_env.value,
        internal_header_required=settings.requires_internal_header,
    )

    # Add StreamCORSMiddleware for browser-callable stream routes.
    # Must be added AFTER auth middleware (runs before it in the stack)
    cors_origins = settings.stream_cors_origin_list
    if cors_origins:
        app.add_middleware(StreamCORSMiddleware, allowed_origins=cors_origins)
        logger.info("stream_cors_middleware_enabled", origins=cors_origins)

    # Reader-state and reader-profile responses are never cacheable: the
    # cursor is revalidated event-driven and the profile is per-user private
    # state, so a cached snapshot would defeat revision arbitration or leak
    # across accounts. Registered after the auth and stream-CORS
    # middleware so it runs outside them and stamps every matched response,
    # including auth failures, validation errors, and exception-handler output; for a
    # matched path it also owns the raw-500 stamp by delegating once to the
    # canonical exception handler instead of letting the exception propagate
    # to the outer ServerErrorMiddleware unstamped.
    @app.middleware("http")
    async def private_history_no_store(request: Request, call_next):
        if not PRIVATE_NO_STORE_PATH_RE.fullmatch(request.url.path):
            return await call_next(request)
        try:
            response = await call_next(request)
        except Exception as exc:
            response = await unhandled_exception_handler(request, exc)
        response.headers["Cache-Control"] = "private, no-store"
        return response

    @app.middleware("http")
    async def public_resource_share_security(request: Request, call_next):
        """Stamp every route/error outcome in the anonymous public API tree."""
        if PUBLIC_RESOURCE_SHARE_PATH_RE.fullmatch(request.url.path) is None:
            return await call_next(request)
        try:
            response = await call_next(request)
        except Exception as exc:
            response = await unhandled_exception_handler(request, exc)
        apply_public_resource_share_headers(response)
        return response

    # Added last so it runs first: every response, including auth failures and
    # exception-handler output, carries X-Request-ID.
    app.add_middleware(RequestIDMiddleware)

    return app
