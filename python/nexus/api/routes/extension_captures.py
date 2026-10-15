"""Browser-extension routes behind the extension bearer: destinations and captures.

Every session these routes reach carries a ``BrowserCapture`` origin (I6); any
other is not found. The bearer authorizes nothing outside ``/extension/*`` and
its own session route.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.extension import get_extension_viewer
from nexus.auth.middleware import Viewer
from nexus.db.session import DbSession
from nexus.logging import get_request_id
from nexus.responses import Data
from nexus.schemas.collection_page import CollectionPage
from nexus.schemas.extension_capture import BrowserCapture, CreateCaptureRequest
from nexus.schemas.library import LibraryDestinationOut
from nexus.schemas.media_sources import ConfirmUploadRequest, Published, UploadSessionOut
from nexus.services import libraries, media_upload_sessions

router = APIRouter(prefix="/extension", tags=["extension"])
ExtensionViewer = Annotated[Viewer, Depends(get_extension_viewer)]


@router.get("/library-destinations")
def list_library_destinations(
    viewer: ExtensionViewer,
    db: DbSession,
    q: Annotated[str, Query(max_length=100)] = "",
    cursor: Annotated[str | None, Query(min_length=1)] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 25,
) -> Data[CollectionPage[LibraryDestinationOut]]:
    """The viewer's writable named libraries; the extension cannot create one."""
    return Data(
        data=libraries.list_writable_library_destinations(
            db, viewer.user_id, q=q, cursor=cursor, limit=limit
        )
    )


@router.post("/captures")
def create_capture(
    body: CreateCaptureRequest, viewer: ExtensionViewer, db: DbSession
) -> Data[UploadSessionOut]:
    origin = BrowserCapture(source_url=body.source_url, sha256=body.sha256)
    return Data(
        data=media_upload_sessions.create_session(
            db, viewer_id=viewer.user_id, request=body, origin=origin
        )
    )


@router.post("/captures/{session_id}/confirm")
def confirm_capture(
    session_id: UUID, body: ConfirmUploadRequest, viewer: ExtensionViewer, db: DbSession
) -> Data[Published]:
    return Data(
        data=media_upload_sessions.confirm_session(
            db,
            viewer_id=viewer.user_id,
            origin_kind="BrowserCapture",
            session_id=session_id,
            generation=body.generation,
            request_id=get_request_id(),
        )
    )


@router.delete("/captures/{session_id}", status_code=204)
def delete_capture(session_id: UUID, viewer: ExtensionViewer, db: DbSession) -> Response:
    media_upload_sessions.delete_session(
        db, viewer_id=viewer.user_id, origin_kind="BrowserCapture", session_id=session_id
    )
    return Response(status_code=204)
