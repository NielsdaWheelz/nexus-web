"""The anonymous share reader's routes, reachable only through the web BFF.

The token travels only in the X-Nexus-Share-Token header and authorizes before any path
segment or Range is read. The BFF's share lane stamps the public security headers on every
answer, errors included.
"""

from collections.abc import Generator
from threading import Lock
from typing import Annotated

from anyio import CancelScope, to_thread
from fastapi import APIRouter, Header, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.types import Receive, Scope, Send

from nexus.db.session import DbSession
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import Data, error_response
from nexus.schemas.public_resource_sharing import PublicShareOut
from nexus.schemas.reader_document import ReaderDocumentOut
from nexus.services import public_resource_sharing
from nexus.services.media_file_access import parse_single_byte_range
from nexus.storage.client import StorageError, get_storage_client

router = APIRouter(prefix="/public/resource-share", tags=["public-resource-sharing"])
ShareToken = Annotated[str, Header(alias="X-Nexus-Share-Token")]


class _PdfResponse(StreamingResponse):
    """Streams storage chunks whose first one was already read, so a missing object is a 404
    before any header leaves. ``next()`` and ``close()`` share a lock: a cancelled task can
    leave ``next()`` running in its worker, and Starlette never closes a sync iterator."""

    def __init__(
        self, first: bytes, rest: Generator[bytes, None, None], status: int, headers: dict[str, str]
    ) -> None:
        self._first = first
        self._rest = rest
        self._lock = Lock()
        super().__init__(
            self._chunks(), status_code=status, media_type="application/pdf", headers=headers
        )

    def _chunks(self) -> Generator[bytes, None, None]:
        yield self._first
        while True:
            with self._lock:
                chunk = next(self._rest, None)
            if chunk is None:
                return
            yield chunk

    def _close(self) -> None:
        with self._lock:
            self._rest.close()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with CancelScope(shield=True):
                await to_thread.run_sync(self._close)


@router.get("")
def get_public_resource_share(db: DbSession, share_token: ShareToken = "") -> Data[PublicShareOut]:
    return Data(data=public_resource_sharing.read_share(db, share_token))


@router.get("/document")
def get_public_resource_share_document(
    db: DbSession, share_token: ShareToken = ""
) -> Data[ReaderDocumentOut]:
    return Data(data=public_resource_sharing.read_document(db, share_token))


@router.get("/assets/{ordinal}")
def get_public_resource_share_asset(
    ordinal: str, db: DbSession, share_token: ShareToken = ""
) -> Response:
    data, content_type = public_resource_sharing.read_asset(db, share_token, ordinal)
    return Response(data, media_type=content_type)


@router.get("/file")
def get_public_resource_share_file(
    db: DbSession,
    share_token: ShareToken = "",
    range_header: Annotated[str | None, Header(alias="Range")] = None,
) -> Response:
    path, size = public_resource_sharing.pdf_source(db, share_token)
    headers = {"Accept-Ranges": "bytes", "Content-Disposition": 'inline; filename="document.pdf"'}
    # A Range in another unit, or several ranges, is ignored (RFC 9110 §14.2): the whole file.
    if range_header is None or not range_header.startswith("bytes=") or "," in range_header:
        start, end, status = 0, size - 1, 200
    else:
        try:
            byte_range = parse_single_byte_range(range_header, size_bytes=size)
        except ValueError:
            return JSONResponse(
                error_response(
                    ApiErrorCode.E_INVALID_REQUEST, "Requested range is not satisfiable"
                ),
                status_code=416,
                headers={"Accept-Ranges": "bytes", "Content-Range": f"bytes */{size}"},
            )
        start, end, status = byte_range.start, byte_range.end, 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    chunks = get_storage_client().stream_object(
        path, expected_size=size, byte_range=None if status == 200 else (start, end)
    )
    try:
        first = next(chunks)
    except (StorageError, StopIteration):
        chunks.close()
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Share unavailable") from None
    headers["Content-Length"] = str(end - start + 1)
    return _PdfResponse(first, chunks, status, headers)
