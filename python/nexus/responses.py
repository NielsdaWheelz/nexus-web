"""The envelope every answer uses, and the handlers that render errors in it.

- success: ``{"data": ...}`` or ``{"data": [...], "page": {...}}``;
- error: ``{"error": {"code", "message", "request_id"?, "details"?}}``. The status is the
  code's own (``ApiErrorCode.status``), so a client branches on ``code``.

A typed route returns ``Data[XOut]`` or ``DataPage[XOut, PageOut]``. ``ok``, ``ok_page``
and ``success_response`` serve the routes not yet typed and leave with the last of them.
The last-resort 500 is the edge middleware's (``nexus.api.edge``).
"""

from collections.abc import Sequence
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger, get_request_id

logger = get_logger(__name__)
_HTTP_CODES = {
    400: ApiErrorCode.E_INVALID_REQUEST,
    401: ApiErrorCode.E_UNAUTHENTICATED,
    403: ApiErrorCode.E_FORBIDDEN,
    404: ApiErrorCode.E_NOT_FOUND,
    405: ApiErrorCode.E_INVALID_REQUEST,
    422: ApiErrorCode.E_INVALID_REQUEST,
}


class Data[T](BaseModel):
    """``{"data": T}``: the success envelope of a typed JSON route."""

    data: T


class DataPage[T, P](BaseModel):
    """``{"data": [T], "page": P}``: the envelope of a typed page route."""

    data: list[T]
    page: P


def success_response(data: Any) -> dict[str, Any]:
    return {"data": data}


def ok(data: BaseModel | Sequence[BaseModel]) -> dict[str, Any]:
    if isinstance(data, BaseModel):
        return {"data": data.model_dump(mode="json")}
    return {"data": [item.model_dump(mode="json") for item in data]}


def ok_page(items: Sequence[BaseModel], page: BaseModel) -> dict[str, Any]:
    return {
        "data": [item.model_dump(mode="json") for item in items],
        "page": page.model_dump(mode="json"),
    }


def error_response(
    code: ApiErrorCode, message: str, details: dict[str, Any] | None = None
) -> dict[str, Any]:
    """The error envelope, carrying the current request's id."""
    error: dict[str, Any] = {"code": code.value, "message": message}
    if details is not None:
        error["details"] = details
    request_id = get_request_id()
    if request_id:
        error["request_id"] = request_id
    return {"error": error}


async def api_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    logger.warning("api_error", code=exc.code.value, status=exc.status_code, message=exc.message)
    return JSONResponse(
        status_code=exc.status_code, content=error_response(exc.code, exc.message, exc.details)
    )


async def http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, HTTPException)
    code = _HTTP_CODES.get(exc.status_code, ApiErrorCode.E_INTERNAL)
    return JSONResponse(
        status_code=exc.status_code,
        content=error_response(code, str(exc.detail) if exc.detail else "An error occurred"),
    )
