"""Local-upload transport: the upload-session entry points.

Validate input, call one service, return the envelope. This router is registered
before the ``media`` router so ``/media/uploads`` is never parsed as a UUID.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.logging import get_request_id
from nexus.responses import Data
from nexus.schemas.extension_capture import LocalFile
from nexus.schemas.media import (
    ConfirmUploadSessionRequest,
    CreateUploadSessionRequest,
    NeedsAttention,
    Published,
    RetryUploadSessionRequest,
    UploadRequired,
    UploadSessionResponse,
    UploadTransportFailureRequest,
)
from nexus.services import media_upload_sessions

router = APIRouter(tags=["media"])


@router.post("/media/uploads")
def create_upload_session(
    request_body: CreateUploadSessionRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    request: Request,
) -> Data[UploadSessionResponse]:
    return Data(
        data=media_upload_sessions.create_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            request=request_body,
            input_origin=LocalFile(),
            idempotency_key=request.headers.get("Idempotency-Key"),
        ),
    )


@router.post("/media/uploads/{session_handle}/transport-failure", status_code=204)
def record_upload_transport_failure(
    session_handle: str,
    request_body: UploadTransportFailureRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Response:
    media_upload_sessions.record_transport_failure(
        db=db,
        viewer_id=viewer.user_id,
        origin_kind="LocalFile",
        session_handle=session_handle,
        failure=request_body,
    )
    return Response(status_code=204)


@router.post("/media/uploads/{session_handle}/retry")
def retry_upload_session(
    session_handle: str,
    request_body: RetryUploadSessionRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[UploadRequired | NeedsAttention]:
    return Data(
        data=media_upload_sessions.retry_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            origin_kind="LocalFile",
            session_handle=session_handle,
            request=request_body,
        ),
    )


@router.post("/media/uploads/{session_handle}/confirm")
def confirm_upload_session(
    session_handle: str,
    request_body: ConfirmUploadSessionRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[Published]:
    return Data(
        data=media_upload_sessions.confirm_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            origin_kind="LocalFile",
            session_handle=session_handle,
            generation=request_body.generation,
            request_id=get_request_id(),
        ),
    )


@router.delete("/media/uploads/{session_handle}", status_code=204)
def delete_upload_session(
    session_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Response:
    # The account credential removes its own unpublished session of either
    # origin: a browser capture's bytes live in the extension, which alone can
    # retry it, but discarding the session needs no extension credential.
    media_upload_sessions.delete_upload_session(
        db=db, viewer_id=viewer.user_id, origin_kind=None, session_handle=session_handle
    )
    return Response(status_code=204)
