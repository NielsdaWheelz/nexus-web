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
2. RequestDbSessionMiddleware (releases sessions before body transfer)
3. StreamCORSMiddleware when configured (stream route CORS)
4. RequestIDMiddleware (outermost request logging and X-Request-ID)

Actual execution order per request:
1. RequestIDMiddleware (sets request_id, starts timer)
2. StreamCORSMiddleware when configured (stream route CORS)
3. RequestDbSessionMiddleware (tracks response-start DB release)
4. AuthMiddleware (verifies auth, sets viewer)
5. Route handler
6. AuthMiddleware (returns response)
7. RequestDbSessionMiddleware (releases request DB sessions before body transfer)
8. StreamCORSMiddleware when configured (stream route CORS)
9. RequestIDMiddleware (logs, sets response header)

LLM client lifecycle:
- httpx.AsyncClient is created at startup, stored in app.state
- ModelRuntime wraps the shared client for connection pooling
- Client is closed gracefully at shutdown
"""

import json
from contextlib import asynccontextmanager
from urllib.parse import urlparse
from uuid import UUID

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from provider_runtime import ModelRuntime
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import ClientDisconnect
from web_search_tool.brave import BraveSearchProvider

from nexus.api.routes import create_api_router
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import SupabaseJwksVerifier
from nexus.config import Environment, get_settings
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.middleware.db_session import RequestDbSessionMiddleware
from nexus.middleware.request_id import RequestIDMiddleware
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.responses import (
    api_error_handler,
    error_response,
    http_exception_handler,
    unhandled_exception_handler,
)
from nexus.services.bootstrap import ensure_user_and_default_library

logger = get_logger(__name__)


async def validate_json_request_body(request: Request) -> JSONResponse | None:
    """Pre-validate JSON request bodies without treating disconnects as 500s."""
    if request.method not in ("POST", "PUT", "PATCH"):
        return None
    content_type = request.headers.get("content-type", "")
    if "application/json" not in content_type:
        return None
    try:
        body = await request.body()
    except ClientDisconnect:
        logger.info(
            "request_body_client_disconnected",
            path=request.url.path,
            method=request.method,
        )
        return JSONResponse(
            status_code=499,
            content=error_response(ApiErrorCode.E_CLIENT_DISCONNECT, "Client disconnected"),
        )
    if not body:
        return None
    try:
        json.loads(body)
    except json.JSONDecodeError:
        return JSONResponse(
            status_code=400,
            content=error_response(ApiErrorCode.E_INVALID_REQUEST, "Malformed JSON body"),
        )
    return None


def create_bootstrap_callback():
    """Create a bootstrap callback that creates its own database session.

    The callback is called by the auth middleware for each authenticated request.
    It creates a fresh database session, runs the bootstrap, and closes it.
    """
    session_factory = get_session_factory()
    # Process-local cache: user_id -> default_library_id. Bootstrap is first-login
    # setup, so we run it once per user per process, not per request. The cache
    # resets on restart and re-populates on first touch.
    cache: dict[UUID, UUID] = {}

    def bootstrap(user_id: UUID, email: str | None = None) -> UUID:
        # No lock: bootstrap now runs in a threadpool (the middleware calls it via
        # run_in_threadpool), so two threads could race for the same new user, but
        # ensure_user_and_default_library is idempotent and the dict write is atomic
        # under CPython's GIL, so a race merely repeats harmless idempotent work.
        cached = cache.get(user_id)
        if cached is not None:
            return cached
        # Email is synced inside ensure_user_and_default_library; with caching that
        # sync now happens only on the first request per process per user.
        db = session_factory()
        try:
            library_id = ensure_user_and_default_library(db, user_id, email=email)
        finally:
            db.close()
        cache[user_id] = library_id
        return library_id

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
    - Creates shared httpx.AsyncClient for connection pooling
    - Initializes ModelRuntime with feature flags
    - Cleans up on shutdown
    """
    settings = get_settings()

    # Create shared HTTP client for LLM calls
    app.state.httpx_client = httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=10.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )

    app.state.llm_router = ModelRuntime(
        app.state.httpx_client,
        enable_openai=settings.enable_openai,
        enable_anthropic=settings.enable_anthropic,
        enable_gemini=settings.enable_gemini,
        enable_openrouter=settings.enable_openrouter,
        enable_cloudflare=settings.enable_cloudflare,
        cloudflare_account_id=settings.cloudflare_ai_account_id,
    )
    app.state.web_search_provider = (
        BraveSearchProvider(
            app.state.httpx_client,
            api_key=settings.brave_search_api_key,
            base_url=settings.brave_search_base_url,
            timeout_seconds=settings.brave_search_timeout_seconds,
        )
        if settings.brave_search_api_key
        else None
    )

    logger.info(
        "llm_router_initialized",
        enable_openai=settings.enable_openai,
        enable_anthropic=settings.enable_anthropic,
        enable_gemini=settings.enable_gemini,
        enable_openrouter=settings.enable_openrouter,
        enable_cloudflare=settings.enable_cloudflare,
        web_search_provider="brave" if settings.brave_search_api_key else None,
    )

    # Initialize Postgres-backed rate limiter runtime state.
    from nexus.services.rate_limit import RateLimiter, set_rate_limiter

    rate_limiter = RateLimiter(
        session_factory=get_session_factory(),
        rpm_limit=settings.rate_limit_rpm,
        concurrent_limit=settings.rate_limit_concurrent,
    )
    set_rate_limiter(rate_limiter)

    yield

    # Shutdown: close shared HTTP client.
    await app.state.httpx_client.aclose()
    logger.info("httpx_client_closed")


def create_app(skip_auth_middleware: bool = False) -> FastAPI:
    """Create and configure the FastAPI application.

    Args:
        skip_auth_middleware: If True, skip adding auth middleware (for testing).

    Returns:
        Configured FastAPI application instance.
    """
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

    # Handle JSON parsing errors specifically
    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Handle request validation errors (including malformed JSON)."""
        logger.warning(
            "request_validation_failed",
            path=request.url.path,
            method=request.method,
            errors=exc.errors(),
        )
        return JSONResponse(
            status_code=400,
            content=error_response(ApiErrorCode.E_INVALID_REQUEST, "Invalid request body"),
        )

    # Handle JSON decode errors from malformed JSON bodies
    @app.middleware("http")
    async def catch_json_decode_errors(request: Request, call_next):
        """Catch JSON decode errors before they reach route handlers."""
        body_error_response = await validate_json_request_body(request)
        if body_error_response is not None:
            return body_error_response
        return await call_next(request)

    # Include API routes (must be before middleware for correct ordering)
    # Use router factory to avoid import-time settings loading. The factory owns
    # every router, including the browser-callable SSE streams and the BFF
    # stream-token mint.
    api_router = create_api_router()
    app.include_router(api_router)

    # Add auth middleware (runs on all requests except public paths)
    if not skip_auth_middleware:
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

    # Release request-scoped DB sessions when the response starts, not after the
    # response body finishes transferring. This prevents slow clients or aborted
    # BFF requests from pinning PostgreSQL connections across every route.
    app.add_middleware(RequestDbSessionMiddleware)
    logger.info("request_db_session_middleware_enabled")

    # Add StreamCORSMiddleware for browser-callable stream routes.
    # Must be added AFTER auth middleware (runs before it in the stack)
    cors_origins = settings.stream_cors_origin_list
    if cors_origins:
        app_url = urlparse(settings.app_public_url)
        stream_url = urlparse(settings.effective_stream_base_url)
        if (
            app_url.scheme,
            app_url.hostname,
            app_url.port,
        ) != (
            stream_url.scheme,
            stream_url.hostname,
            stream_url.port,
        ) and not any(
            (parsed.scheme, parsed.hostname, parsed.port)
            == (app_url.scheme, app_url.hostname, app_url.port)
            for parsed in (urlparse(o) for o in cors_origins)
        ):
            if settings.nexus_env in (Environment.STAGING, Environment.PROD):
                raise RuntimeError(
                    f"STREAM_CORS_ORIGINS is missing APP_PUBLIC_URL origin "
                    f"{settings.app_public_url!r}; current list: {cors_origins!r}"
                )
            logger.warning(
                "stream_cors_middleware_missing_app_public_url_origin",
                app_public_url=settings.app_public_url,
                stream_cors_origins=cors_origins,
            )
        app.add_middleware(StreamCORSMiddleware, allowed_origins=cors_origins)
        logger.info("stream_cors_middleware_enabled", origins=cors_origins)
    else:
        app_url = urlparse(settings.app_public_url)
        stream_url = urlparse(settings.effective_stream_base_url)
        if (
            app_url.scheme,
            app_url.hostname,
            app_url.port,
        ) != (
            stream_url.scheme,
            stream_url.hostname,
            stream_url.port,
        ):
            if settings.nexus_env in (Environment.STAGING, Environment.PROD):
                raise RuntimeError(
                    "STREAM_CORS_ORIGINS is required when STREAM_BASE_URL is cross-origin"
                )
            logger.warning(
                "stream_cors_middleware_disabled_for_cross_origin_stream",
                app_public_url=settings.app_public_url,
                stream_base_url=settings.effective_stream_base_url,
            )

    return app


def add_request_id_middleware(app: FastAPI, log_requests: bool = True) -> None:
    """Add request-id middleware to the app.

    This should be called AFTER all other middleware is added, so it runs FIRST.
    This ensures every response includes X-Request-ID, including auth failures.

    Args:
        app: The FastAPI application.
        log_requests: Whether to log access entries for each request.
    """
    app.add_middleware(RequestIDMiddleware, log_requests=log_requests)
    logger.info("request_id_middleware_enabled")
