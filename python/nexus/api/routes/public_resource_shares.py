"""The anonymous share reader's routes, reachable only through the web BFF.

The token travels only in the X-Nexus-Share-Token header and authorizes before
any handle or Range is read. app.py's middleware stamps the public security
headers on every response under this prefix, errors included.
"""

from typing import Annotated

from fastapi import APIRouter, Header, Response
from fastapi.responses import JSONResponse, StreamingResponse

from nexus.db.session import DbSession
from nexus.errors import ApiErrorCode
from nexus.responses import Data, error_response
from nexus.schemas.public_resource_sharing import PublicSectionOut, PublicShareOut
from nexus.services import public_resource_sharing
from nexus.services.media_file_access import parse_single_byte_range
from nexus.storage.client import get_storage_client

router = APIRouter(prefix="/public/resource-share", tags=["public-resource-sharing"])
ShareToken = Annotated[str, Header(alias="X-Nexus-Share-Token")]


@router.get("")
def get_public_resource_share(db: DbSession, share_token: ShareToken = "") -> Data[PublicShareOut]:
    return Data(data=public_resource_sharing.read_share(db, share_token))


@router.get("/sections/{section_handle}")
def get_public_resource_share_section(
    section_handle: str, db: DbSession, share_token: ShareToken = ""
) -> Data[PublicSectionOut]:
    return Data(data=public_resource_sharing.read_section(db, share_token, section_handle))


@router.get("/assets/{asset_handle}")
def get_public_resource_share_asset(
    asset_handle: str, db: DbSession, share_token: ShareToken = ""
) -> Response:
    data, content_type = public_resource_sharing.read_asset(db, share_token, asset_handle)
    return Response(data, media_type=content_type)


@router.get("/file")
def get_public_resource_share_file(
    db: DbSession,
    share_token: ShareToken = "",
    range_header: Annotated[str | None, Header(alias="Range")] = None,
) -> Response:
    source = public_resource_sharing.pdf_source(db, share_token)
    size = source.size_bytes
    headers = {"Accept-Ranges": "bytes", "Content-Disposition": 'inline; filename="document.pdf"'}
    if range_header is None:
        return StreamingResponse(
            get_storage_client().stream_object(source.storage_path),
            media_type="application/pdf",
            headers={**headers, "Content-Length": str(size)},
        )
    try:
        byte_range = parse_single_byte_range(range_header, size_bytes=size)
    except ValueError:
        return JSONResponse(
            error_response(ApiErrorCode.E_INVALID_REQUEST, "Requested range is not satisfiable"),
            status_code=416,
            headers={"Accept-Ranges": "bytes", "Content-Range": f"bytes */{size}"},
        )
    return StreamingResponse(
        get_storage_client().stream_object_range(
            source.storage_path, start=byte_range.start, end_inclusive=byte_range.end
        ),
        status_code=206,
        media_type="application/pdf",
        headers={
            **headers,
            "Content-Length": str(byte_range.length),
            "Content-Range": f"bytes {byte_range.start}-{byte_range.end}/{size}",
        },
    )
