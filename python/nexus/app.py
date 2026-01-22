"""FastAPI application creation and configuration.

This module creates and configures the FastAPI application instance.
It registers exception handlers, auth middleware, request-id middleware, and routes.

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
"""

import json
from uuid import UUID

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from nexus.api.routes import api_router
from nexus.auth.middleware import AuthMiddleware
from nexus.auth.verifier import MockTokenVerifier, SupabaseJwksVerifier
from nexus.config import Environment, get_settings
from nexus.db.session import get_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import configure_logging, get_logger
from nexus.middleware.request_id import RequestIDMiddleware
from nexus.responses import (
    api_error_handler,
    error_response,
    http_exception_handler,
    unhandled_exception_handler,
)
from nexus.services.bootstrap import ensure_user_and_default_library

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
    """Create the appropriate token verifier based on environment.

    Returns:
        SupabaseJwksVerifier in staging/prod, MockTokenVerifier in local/test.
    """
    settings = get_settings()

    if settings.nexus_env in (Environment.STAGING, Environment.PROD):
        # Production verifier with Supabase JWKS
        return SupabaseJwksVerifier(
            jwks_url=settings.supabase_jwks_url,  # type: ignore
            issuer=settings.normalized_issuer,  # type: ignore
            audiences=settings.audience_list,
        )
    else:
        # Test verifier for local/test environments
        return MockTokenVerifier(
            issuer=settings.test_token_issuer,
            audiences=settings.test_audience_list,
        )


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
    app.include_router(api_router)

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


# Create the application instance
app = create_app()
# Add request-id middleware LAST so it runs FIRST (outermost)
add_request_id_middleware(app)
