"""Anonymous resource-share reads, reachable only through the trusted BFF."""

from __future__ import annotations

from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from nexus.db.session import get_db
from nexus.errors import ApiErrorCode
from nexus.public_resource_security import apply_public_resource_share_headers
from nexus.responses import error_response, ok
from nexus.services import public_resource_sharing

router = APIRouter(prefix="/public/resource-share", tags=["public-resource-sharing"])


def _token(value: str | None) -> str:
    return value or ""


def _query_items(request: Request) -> list[tuple[str, str]]:
    return list(request.query_params.multi_items())


def _raise_validation(exc: public_resource_sharing.PublicRequestValidation) -> None:
    raise HTTPException(status_code=422, detail=str(exc)) from exc


def _apply_public_headers(response: Response) -> None:
    apply_public_resource_share_headers(response)


@router.get("")
def get_public_resource_share(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    share_token: Annotated[str | None, Header(alias="X-Nexus-Share-Token")] = None,
) -> dict:
    try:
        result = public_resource_sharing.get_public_bootstrap(
            db,
            raw_token=_token(share_token),
            query_items=_query_items(request),
        )
    except public_resource_sharing.PublicRequestValidation as exc:
        _raise_validation(exc)
    _apply_public_headers(response)
    return ok(result)


@router.get("/fragments")
def get_public_resource_share_fragments(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    share_token: Annotated[str | None, Header(alias="X-Nexus-Share-Token")] = None,
) -> dict:
    try:
        result = public_resource_sharing.get_public_fragments(
            db,
            raw_token=_token(share_token),
            query_items=_query_items(request),
        )
    except public_resource_sharing.PublicRequestValidation as exc:
        _raise_validation(exc)
    _apply_public_headers(response)
    return ok(result)


@router.get("/navigation")
def get_public_resource_share_navigation(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    share_token: Annotated[str | None, Header(alias="X-Nexus-Share-Token")] = None,
) -> dict:
    try:
        result = public_resource_sharing.get_public_navigation(
            db,
            raw_token=_token(share_token),
            query_items=_query_items(request),
        )
    except public_resource_sharing.PublicRequestValidation as exc:
        _raise_validation(exc)
    _apply_public_headers(response)
    return ok(result)


@router.get("/sections/{section_handle}")
def get_public_resource_share_section(
    section_handle: str,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
    share_token: Annotated[str | None, Header(alias="X-Nexus-Share-Token")] = None,
) -> dict:
    try:
        result = public_resource_sharing.get_public_section(
            db,
            raw_token=_token(share_token),
            raw_section_handle=section_handle,
            query_items=_query_items(request),
        )
    except public_resource_sharing.PublicRequestValidation as exc:
        _raise_validation(exc)
    _apply_public_headers(response)
    return ok(result)


@router.get("/assets/{asset_handle}")
def get_public_resource_share_asset(
    asset_handle: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    share_token: Annotated[str | None, Header(alias="X-Nexus-Share-Token")] = None,
) -> Response:
    try:
        result = public_resource_sharing.get_public_asset(
            db,
            raw_token=_token(share_token),
            raw_asset_handle=asset_handle,
            query_items=_query_items(request),
        )
    except public_resource_sharing.PublicRequestValidation as exc:
        _raise_validation(exc)
    response = Response(
        content=result.data,
        media_type=result.content_type,
        headers={
            "Content-Length": str(len(result.data)),
        },
    )
    apply_public_resource_share_headers(response)
    return response


@router.get("/file")
def get_public_resource_share_file(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    share_token: Annotated[str | None, Header(alias="X-Nexus-Share-Token")] = None,
    range_header: Annotated[str | None, Header(alias="Range")] = None,
) -> Response:
    try:
        result = public_resource_sharing.get_public_pdf_file(
            db,
            raw_token=_token(share_token),
            raw_range=range_header,
            query_items=_query_items(request),
        )
    except public_resource_sharing.PublicRequestValidation as exc:
        _raise_validation(exc)
    except public_resource_sharing.PublicRangeNotSatisfiable as exc:
        response = JSONResponse(
            status_code=416,
            content=error_response(
                ApiErrorCode.E_INVALID_REQUEST,
                "Requested range is not satisfiable",
            ),
            headers={
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes */{exc.size_bytes}",
            },
        )
        apply_public_resource_share_headers(response)
        return response
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(result.content_length),
        "Content-Disposition": (
            f"inline; filename=\"document.pdf\"; filename*=UTF-8''{quote(result.filename, safe='')}"
        ),
    }
    if result.content_range is not None:
        headers["Content-Range"] = result.content_range
    response = StreamingResponse(
        result.chunks,
        status_code=result.status_code,
        media_type="application/pdf",
        headers=headers,
    )
    apply_public_resource_share_headers(response)
    return response
