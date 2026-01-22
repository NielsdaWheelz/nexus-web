"""API response envelope helpers and exception handlers.

All API responses use a consistent envelope:
- Success: { "data": ... }
- Error: { "error": { "code": "E_...", "message": "...", "request_id": "..." } }

The request_id is included in error responses for debugging and support.
"""

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger, get_request_id

logger = get_logger(__name__)


def success_response(data: Any) -> dict[str, Any]:
    """Create a success response envelope.

    Args:
        data: The response data to wrap.

    Returns:
        Dict with "data" key containing the response.
    """
    return {"data": data}


def error_response(
    code: ApiErrorCode, message: str, request_id: str | None = None
) -> dict[str, Any]:
    """Create an error response envelope.

    Args:
        code: The error code enum value.
        message: Human-readable error message.
        request_id: Optional request ID for correlation (auto-populated from context if None).

    Returns:
        Dict with "error" key containing code, message, and request_id.
    """
    # Get request_id from context if not explicitly provided
    if request_id is None:
        request_id = get_request_id()

    error = {"code": code.value, "message": message}
    if request_id:
        error["request_id"] = request_id

    return {"error": error}


async def api_error_handler(request: Request, exc: ApiError) -> JSONResponse:
    """Handle ApiError exceptions and return proper JSON response."""
    return JSONResponse(
        status_code=exc.status_code,
        content=error_response(exc.code, exc.message),
    )


async def http_exception_handler(request: Request, exc: Any) -> JSONResponse:
    """Handle FastAPI HTTPException and return proper JSON response."""
    # Map common HTTP status codes to our error codes
    status_to_code = {
        400: ApiErrorCode.E_INVALID_REQUEST,
        401: ApiErrorCode.E_UNAUTHENTICATED,
        403: ApiErrorCode.E_FORBIDDEN,
        404: ApiErrorCode.E_NOT_FOUND,
        422: ApiErrorCode.E_INVALID_REQUEST,
    }
    code = status_to_code.get(exc.status_code, ApiErrorCode.E_INTERNAL)
    message = str(exc.detail) if exc.detail else "An error occurred"
    return JSONResponse(
        status_code=exc.status_code,
        content=error_response(code, message),
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Handle unhandled exceptions and return 500 with E_INTERNAL.

    Logs the exception server-side but never leaks details to client.
    """
    logger.exception("Unhandled exception: %s", exc)

    return JSONResponse(
        status_code=500,
        content=error_response(ApiErrorCode.E_INTERNAL, "Internal server error"),
    )
