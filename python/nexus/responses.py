"""API response envelope helpers and exception handlers.

All API responses use a consistent envelope:
- Success: { "data": ... }
- Error: { "error": { "code": "E_...", "message": "...", "request_id": "..." } }

The request_id is included in error responses for debugging and support.
"""

from collections.abc import Sequence
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy.exc import TimeoutError as SAQueuePoolTimeout
from sqlalchemy.pool import QueuePool

from nexus.db.engine import get_engine
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


def ok(data: BaseModel | Sequence[BaseModel], *, by_alias: bool = False) -> dict[str, Any]:
    """Envelope a model (or list of models) as ``{"data": ...}``.

    The single owner of the serialize-then-envelope projection for model payloads,
    replacing the hand-written ``success_response(x.model_dump(mode="json"))`` idiom.
    Binary/204 and named-key wrapper responses are not plain model payloads and keep
    their own shape.
    """
    if isinstance(data, BaseModel):
        return {"data": data.model_dump(mode="json", by_alias=by_alias)}
    return {"data": [item.model_dump(mode="json", by_alias=by_alias) for item in data]}


def ok_page(
    items: Sequence[BaseModel], page: BaseModel, *, by_alias: bool = False
) -> dict[str, Any]:
    """Envelope a page of models as ``{"data": [...], "page": {...}}``."""
    return {
        "data": [item.model_dump(mode="json", by_alias=by_alias) for item in items],
        "page": page.model_dump(mode="json", by_alias=by_alias),
    }


def error_response(
    code: ApiErrorCode,
    message: str,
    request_id: str | None = None,
    details: dict[str, Any] | None = None,
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
    if details is not None:
        error["details"] = details
    if request_id:
        error["request_id"] = request_id

    return {"error": error}


async def api_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Handle ApiError exceptions and return proper JSON response."""
    if not isinstance(exc, ApiError):
        raise exc
    logger.warning(
        "api_error",
        code=exc.code.value,
        status=exc.status_code,
        message=exc.message,
        path=request.url.path,
        method=request.method,
    )
    return JSONResponse(
        status_code=exc.status_code,
        content=error_response(exc.code, exc.message, details=exc.details),
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
    pool = get_engine().pool
    if isinstance(exc, SAQueuePoolTimeout) and isinstance(pool, QueuePool):
        logger.error(
            "db_pool_exhausted",
            pool_checked_out=pool.checkedout(),
            pool_overflow=pool.overflow(),
            pool_size=pool.size(),
            path=request.url.path,
        )
    else:
        logger.exception("Unhandled exception: %s", exc)

    return JSONResponse(
        status_code=500,
        content=error_response(ApiErrorCode.E_INTERNAL, "Internal server error"),
    )
