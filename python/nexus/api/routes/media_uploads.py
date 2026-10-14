"""Local-upload transport: create, confirm and remove an upload session.

Validate, call one service, answer ``Data``. Registered before the media router,
so ``/media/uploads`` is never read as a media id. Every write's retry rule is
stated on its service function.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.logging import get_request_id
from nexus.responses import Data
from nexus.schemas.extension_capture import LocalFile
from nexus.schemas.media_sources import (
    ConfirmUploadRequest,
    CreateUploadRequest,
    Published,
    UploadSessionOut,
)
from nexus.services import media_upload_sessions

router = APIRouter(tags=["media"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/media/uploads")
def create_upload(
    body: CreateUploadRequest, viewer: ViewerDep, db: DbSession
) -> Data[UploadSessionOut]:
    return Data(
        data=media_upload_sessions.create_session(
            db, viewer_id=viewer.user_id, request=body, origin=LocalFile()
        )
    )


@router.post("/media/uploads/{session_id}/confirm")
def confirm_upload(
    session_id: UUID, body: ConfirmUploadRequest, viewer: ViewerDep, db: DbSession
) -> Data[Published]:
    return Data(
        data=media_upload_sessions.confirm_session(
            db,
            viewer_id=viewer.user_id,
            origin_kind="LocalFile",
            session_id=session_id,
            generation=body.generation,
            request_id=get_request_id(),
        )
    )


@router.delete("/media/uploads/{session_id}", status_code=204)
def delete_upload(session_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    # the account removes its own unpublished session of either origin: a capture
    # Firefox forgot is discarded from Imports
    media_upload_sessions.delete_session(
        db, viewer_id=viewer.user_id, origin_kind=None, session_id=session_id
    )
    return Response(status_code=204)
