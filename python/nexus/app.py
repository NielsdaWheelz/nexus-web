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

The stack a request passes through, outermost to innermost:
1. RequestIDMiddleware (sets request_id, starts timer, stamps X-Request-ID)
2. APIResponsePolicyMiddleware (private no-store / public share header policy,
   and delegation of pre-start exceptions to the handlers below)
3. StreamCORSMiddleware when configured (stream route CORS)
4. RequestDbSessionMiddleware (releases request DB sessions at response start,
   before body transfer)
5. AuthMiddleware (verifies auth, sets viewer)
6. Routing, then the route-level read admission owner for the admitted route
   families (see nexus.api.read_admission), then the route handler

Every layer above is pure ASGI, not BaseHTTPMiddleware, and must stay that way:
BaseHTTPMiddleware runs the downstream app in a child task and buffers its
response, which breaks the admission owner's shielded permit (a caller
cancellation would unwind the request while its synchronous worker still holds
DB resources), breaks streaming responses, and leaves its inner send wrapper
unable to stamp headers on a ServerErrorMiddleware 500.

Outbound client lifecycle:
- httpx.AsyncClient is created at startup, stored in app.state, and shared by
  the Brave-backed Nexus tool runtime. Generation catalogs compose the private
  Codex UDS with configured API-provider rows.
- validate_policy() runs at startup to fail fast on drift in the developer
  plans, operation catalog, bounds, or eval pin (mirrors worker startup).
- Client is closed gracefully at shutdown
"""

import re
from collections.abc import Callable
from contextlib import asynccontextmanager
from urllib.parse import urlparse
from uuid import UUID

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import ClientDisconnect

from nexus.api.read_admission import configured_read_admission
from nexus.api.routes import create_api_router
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import SupabaseJwksVerifier
from nexus.config import Environment, get_settings, require_image_decoder_limits
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.jobs.registry import get_task_contract_digest
from nexus.logging import get_logger
from nexus.middleware.db_session import RequestDbSessionMiddleware
from nexus.middleware.request_id import RequestIDMiddleware
from nexus.middleware.response_policy import APIResponsePolicyMiddleware
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.responses import (
    api_error_handler,
    client_disconnect_handler,
    error_response,
    http_exception_handler,
    unhandled_exception_handler,
)
from nexus.runtime_health import get_runtime_identity
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.generation_catalog import build_generation_catalog_service
from nexus.services.generation_policy import validate_policy
from nexus.services.tool_runtime.composition import (
    compose_configured_web_search_provider,
    compose_product_tool_runtime,
)

logger = get_logger(__name__)


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
    - Fails fast on any drift in the developer generation policy; config.py
      separately enforces retained non-generation service credentials
    - Creates shared httpx.AsyncClient for connection pooling (web search)
    - Cleans up on shutdown
    """
    settings = get_settings()
    get_runtime_identity()
    get_task_contract_digest()
    (
        app.state.read_admission,
        app.state.image_admission,
        app.state.package_transfer_admission,
    ) = configured_read_admission()
    require_image_decoder_limits()

    validate_policy()

    app.state.generation_catalog_service = build_generation_catalog_service(settings)
    if settings.nexus_env in (Environment.STAGING, Environment.PROD):
        await app.state.generation_catalog_service.startup()

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
    app.state.tool_runtime = compose_product_tool_runtime(app.state.web_search_provider)

    logger.info(
        "app_lifespan_started",
        web_search_provider="brave" if settings.brave_search_api_key else None,
    )

    # Initialize Postgres-backed rate limiter runtime state.
    from nexus.services.rate_limit import RateLimiter, set_rate_limiter

    rate_limiter = RateLimiter(
        session_factory=get_session_factory(),
        rpm_limit=settings.rate_limit_rpm,
    )
    set_rate_limiter(rate_limiter)

    yield

    # Shutdown: close shared HTTP client.
    await app.state.httpx_client.aclose()
    logger.info("httpx_client_closed")


def create_app(
    skip_auth_middleware: bool = False,
    install_auth_middleware: Callable[[FastAPI], None] | None = None,
) -> FastAPI:
    """Create and configure the FastAPI application.

    Args:
        skip_auth_middleware: If True (and no installer is given), run without
            auth middleware (for testing).
        install_auth_middleware: Test-tier hook that installs a
            custom-verifier ``AuthMiddleware`` at the exact production
            position in the stack. Adding auth after ``create_app`` returns
            would place it outermost and change middleware ordering — e.g.
            ``private_reader_no_store`` would no longer stamp 401 responses.

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
    # Routes that read the request body themselves (Stripe webhook, email ingest)
    # raise ClientDisconnect directly; FastAPI's own body read re-raises it as an
    # HTTPException cause. Both classify as 499, never as an internal defect.
    app.add_exception_handler(ClientDisconnect, client_disconnect_handler)
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

        This is the only owner of the malformed-JSON 400, and it sees a body only
        where the route declares one: nothing reads a request body before the
        route is admitted, so a mutation route that declares no body model ignores
        whatever bytes arrive with it. A route that needs the 400 contract declares
        its body model, which also puts the shape in the OpenAPI contract and lets
        pydantic own validity.

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
        malformed_json = any(error.get("type") == "json_invalid" for error in exc.errors())
        invalid_chat_selection = (
            request.method == "POST"
            and bool(chat_selection_route_re.fullmatch(request.url.path))
            and any(
                len(error.get("loc", ())) >= 2
                and error["loc"][0] == "body"
                and error["loc"][1] in {"selection", "catalog_definition_revision"}
                for error in exc.errors()
            )
        )
        status_code = (
            422
            if not malformed_json
            and (invalid_chat_selection or author_surface_422_re.search(request.url.path))
            else 400
        )
        code = (
            ApiErrorCode.E_INVALID_GENERATION_SELECTION
            if invalid_chat_selection
            else ApiErrorCode.E_INVALID_REQUEST
        )
        return JSONResponse(
            status_code=status_code,
            content=error_response(
                code, "Malformed JSON body" if malformed_json else "Invalid request body"
            ),
        )

    # Include API routes (must be before middleware for correct ordering)
    # Use router factory to avoid import-time settings loading. The factory owns
    # every router, including the browser-callable SSE streams and the BFF
    # stream-token mint.
    api_router = create_api_router()
    app.include_router(api_router)

    # Add auth middleware (runs on all requests except public paths)
    if install_auth_middleware is not None:
        install_auth_middleware(app)
    elif not skip_auth_middleware:
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

    # Header policy wraps auth and route failures without buffering responses.
    app.add_middleware(APIResponsePolicyMiddleware)

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
