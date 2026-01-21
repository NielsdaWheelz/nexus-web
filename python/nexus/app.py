"""FastAPI application creation and configuration.

This module creates and configures the FastAPI application instance.
It registers exception handlers and routes.
"""

import json

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from nexus.api.routes import api_router
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import (
    api_error_handler,
    error_response,
    http_exception_handler,
    unhandled_exception_handler,
)


def create_app() -> FastAPI:
    """Create and configure the FastAPI application.

    Returns:
        Configured FastAPI application instance.
    """
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

    # Include API routes
    app.include_router(api_router)

    return app


# Create the application instance
app = create_app()
