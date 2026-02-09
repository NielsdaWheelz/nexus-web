"""FastAPI application creation and configuration.

This module creates and configures the FastAPI application instance.
It registers exception handlers, auth middleware, request-id middleware, and routes.

Token Verification:
- All environments (local, test, staging, prod) use SupabaseJwksVerifier
- Runtime always verifies JWTs via Supabase JWKS endpoint
- No local/test fallback - only env values change between environments

Middleware Ordering (Critical):
- Middleware runs in reverse order of registration
- RequestIDMiddleware is added LAST so it runs FIRST (outermost)
- This ensures all requests (including auth failures) get X-Request-ID

Order of registration:
1. AuthMiddleware (runs second - after request-id)
2. RequestIDMiddleware (runs first - outermost)

Actual execution order per request:
1. RequestIDMiddleware (sets request_id, starts timer)
2. AuthMiddleware (verifies auth, sets viewer)
3. Route handler
4. AuthMiddleware (returns response)
5. RequestIDMiddleware (logs, sets response header)

LLM Client Lifecycle (PR-04 spec):
- httpx.AsyncClient is created at startup, stored in app.state
- LLMRouter wraps the shared client for connection pooling
- Client is closed gracefully at shutdown
"""

import json
from contextlib import asynccontextmanager
from uuid import UUID

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from nexus.api.routes import create_api_router
from nexus.api.routes.stream import router as stream_router
from nexus.api.routes.stream_tokens import router as stream_tokens_router
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import SupabaseJwksVerifier
from nexus.config import Environment, get_settings
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import configure_logging, get_logger
from nexus.middleware.request_id import RequestIDMiddleware
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.responses import (
    api_error_handler,
    error_response,
    http_exception_handler,
    unhandled_exception_handler,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.llm import LLMRouter

# Configure structured logging at import time
configure_logging()

logger = get_logger(__name__)


def create_bootstrap_callback():
    """Create a bootstrap callback that creates its own database session.

    The callback is called by the auth middleware for each authenticated request.
    It creates a fresh database session, runs the bootstrap, and closes it.
    """
    session_factory = get_session_factory()

    def bootstrap(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
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

    return SupabaseJwksVerifier(
        jwks_url=settings.supabase_jwks_url,  # type: ignore
        issuer=settings.normalized_issuer,  # type: ignore
        audiences=settings.audience_list,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle resources.

    Per PR-04 spec Section 8:
    - Creates shared httpx.AsyncClient for connection pooling
    - Initializes LLMRouter with feature flags
    - Cleans up on shutdown
    """
    settings = get_settings()

    # Create shared HTTP client for LLM calls
    app.state.httpx_client = httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=10.0),
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )

    # Create LLM router with shared client
    app.state.llm_router = LLMRouter(
        app.state.httpx_client,
        enable_openai=settings.enable_openai,
        enable_anthropic=settings.enable_anthropic,
        enable_gemini=settings.enable_gemini,
    )

    logger.info(
        "llm_router_initialized",
        enable_openai=settings.enable_openai,
        enable_anthropic=settings.enable_anthropic,
        enable_gemini=settings.enable_gemini,
    )

    # PR-08: Initialize Redis client for stream token jti, liveness, budget
    redis_client = None
    if settings.redis_url:
        try:
            import redis

            redis_client = redis.Redis.from_url(
                settings.redis_url, decode_responses=True, socket_timeout=5
            )
            redis_client.ping()
            logger.info("redis_client_initialized", redis_url=settings.redis_url[:30] + "...")
        except Exception as e:
            logger.warning("redis_client_init_failed", error=str(e))
            redis_client = None

    app.state.redis_client = redis_client

    # Initialize rate limiter with redis client
    from nexus.services.rate_limit import RateLimiter, set_rate_limiter

    rate_limiter = RateLimiter(
        redis_client=redis_client,
        rpm_limit=settings.rate_limit_rpm,
        concurrent_limit=settings.rate_limit_concurrent,
        token_budget=settings.token_budget_daily,
    )
    set_rate_limiter(rate_limiter)

    yield

    # Shutdown: close HTTP client and Redis
    await app.state.httpx_client.aclose()
    if redis_client:
        try:
            redis_client.close()
        except Exception:
            pass
    logger.info("httpx_client_closed")


def create_app(
    skip_auth_middleware: bool = False,
    token_verifier=None,
) -> FastAPI:
    """Create and configure the FastAPI application.

    Args:
        skip_auth_middleware: If True, skip adding auth middleware (for testing).
        token_verifier: Optional custom token verifier (for testing).

    Returns:
        Configured FastAPI application instance.
    """
    settings = get_settings()

    app = FastAPI(
        title="Nexus API",
        description="Backend API for Nexus - a reading and annotation platform",
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
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
        return JSONResponse(
            status_code=400,
            content=error_response(ApiErrorCode.E_INVALID_REQUEST, "Invalid request body"),
        )

    # Handle JSON decode errors from malformed JSON bodies
    @app.middleware("http")
    async def catch_json_decode_errors(request: Request, call_next):
        """Catch JSON decode errors before they reach route handlers."""
        if request.method in ("POST", "PUT", "PATCH"):
            content_type = request.headers.get("content-type", "")
            if "application/json" in content_type:
                body = await request.body()
                if body:
                    try:
                        json.loads(body)
                    except json.JSONDecodeError:
                        return JSONResponse(
                            status_code=400,
                            content=error_response(
                                ApiErrorCode.E_INVALID_REQUEST, "Malformed JSON body"
                            ),
                        )
        return await call_next(request)

    # Include API routes (must be before middleware for correct ordering)
    # Use router factory to avoid import-time settings loading
    api_router = create_api_router(include_test_routes=settings.nexus_env == Environment.TEST)
    app.include_router(api_router)

    # PR-08: Include stream router (/stream/*) — browser-callable, stream token auth
    app.include_router(stream_router)

    # PR-08: Include stream token minting route (/internal/stream-tokens) — BFF-only
    app.include_router(stream_tokens_router)

    # Add auth middleware (runs on all requests except public paths)
    if not skip_auth_middleware:
        verifier = token_verifier or create_token_verifier()
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

    # PR-08: Add StreamCORSMiddleware for /stream/* routes
    # Must be added AFTER auth middleware (runs before it in the stack)
    cors_origins = settings.stream_cors_origin_list
    if cors_origins:
        app.add_middleware(StreamCORSMiddleware, allowed_origins=cors_origins)
        logger.info("stream_cors_middleware_enabled", origins=cors_origins)

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
