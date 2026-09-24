"""Browser-extension capture routes: the one upload lifecycle behind the extension bearer.

Every session these routes touch carries a ``BrowserCapture`` input origin; the
service refuses any other session as not found.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.extension import get_extension_viewer
from nexus.auth.middleware import Viewer
from nexus.db.session import get_db
from nexus.responses import ok, ok_page
from nexus.schemas.extension_capture import BrowserCapture, BrowserCaptureIntent
from nexus.schemas.library import LibraryPageInfo
from nexus.schemas.media import (
    ConfirmUploadSessionRequest,
    RetryUploadSessionRequest,
    UploadTransportFailureRequest,
)
from nexus.services import library_governance, media_upload_sessions

router = APIRouter(prefix="/extension", tags=["extension"])


def _request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


@router.get("/library-destinations")
def list_library_destinations(
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str | None = Query(default=None, max_length=100),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=25, ge=1, le=50),
) -> dict:
    """The viewer's writable named libraries; the extension cannot create one."""
    result, next_cursor = library_governance.list_writable_library_destinations(
        db, viewer.user_id, q=(q or "").strip().lower(), cursor=cursor, limit=limit
    )
    return ok_page(
        result, LibraryPageInfo(has_more=next_cursor is not None, next_cursor=next_cursor)
    )


@router.post("/captures")
def create_capture(
    request_body: BrowserCaptureIntent,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    return ok(
        media_upload_sessions.create_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            request=request_body,
            input_origin=BrowserCapture(
                source_url=request_body.source_url, sha256=request_body.sha256
            ),
            request_id=_request_id(request),
            idempotency_key=request.headers.get("Idempotency-Key"),
        ),
        by_alias=True,
    )


@router.get("/captures/{session_handle}")
def read_capture(
    session_handle: str,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        media_upload_sessions.read_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            origin_kind="BrowserCapture",
            session_handle=session_handle,
        ),
        by_alias=True,
    )


@router.post("/captures/{session_handle}/confirm")
def confirm_capture(
    session_handle: str,
    request_body: ConfirmUploadSessionRequest,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    return ok(
        media_upload_sessions.confirm_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            origin_kind="BrowserCapture",
            session_handle=session_handle,
            generation=request_body.generation,
            request_id=_request_id(request),
        ),
        by_alias=True,
    )


@router.post("/captures/{session_handle}/retry")
def retry_capture(
    session_handle: str,
    request_body: RetryUploadSessionRequest,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        media_upload_sessions.retry_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            origin_kind="BrowserCapture",
            session_handle=session_handle,
            request=request_body,
        ),
        by_alias=True,
    )


@router.post("/captures/{session_handle}/transport-failure", status_code=204)
def record_capture_transport_failure(
    session_handle: str,
    request_body: UploadTransportFailureRequest,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    media_upload_sessions.record_transport_failure(
        db=db,
        viewer_id=viewer.user_id,
        origin_kind="BrowserCapture",
        session_handle=session_handle,
        failure=request_body,
    )
    return Response(status_code=204)


@router.delete("/captures/{session_handle}", status_code=204)
def delete_capture(
    session_handle: str,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    media_upload_sessions.delete_upload_session(
        db=db,
        viewer_id=viewer.user_id,
        origin_kind="BrowserCapture",
        session_handle=session_handle,
    )
    return Response(status_code=204)
