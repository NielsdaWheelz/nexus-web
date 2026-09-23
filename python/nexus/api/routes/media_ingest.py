"""Media ingestion transport: URL and local-upload entry points and recovery.

Validate input, call one service, return the envelope. Every static
``/media/<literal>`` path here is declared before this router's dynamic
``/media/{media_id}/...`` paths, and this router is registered before the
``media`` router so the literals are never parsed as UUIDs.
"""

from typing import Annotated, assert_never
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.extension_capture import LocalFile
from nexus.schemas.media import (
    ConfirmUploadSessionRequest,
    CreateUploadSessionRequest,
    FromUrlRequest,
    MediaRepairRequest,
    RetryMetadataRequest,
    RetryRequest,
    RetrySourceRequest,
    RetryUploadSessionRequest,
    SearchRepairRequest,
    SourceRepairRequest,
    UploadTransportFailureRequest,
)
from nexus.services import (
    content_indexing,
    media_source_ingest,
    media_upload_sessions,
    metadata_lifecycle,
)
from nexus.services.capabilities import ViewerRecovery

router = APIRouter(tags=["media"])


def _request_id(request: Request) -> str | None:
    return getattr(request.state, "request_id", None)


@router.post("/media/from_url", status_code=202)
def create_from_url(
    request_body: FromUrlRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    """Accept a URL source; the service classifies the kind. Clients then poll GET /media/{id}."""
    return ok(
        media_source_ingest.accept_url_source(
            db=db,
            viewer_id=viewer.user_id,
            url=request_body.url,
            library_ids=request_body.library_ids,
            request_id=_request_id(request),
            idempotency_key=request.headers.get("Idempotency-Key"),
        )
    )


@router.post("/media/uploads")
def create_upload_session(
    request_body: CreateUploadSessionRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    return ok(
        media_upload_sessions.create_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            request=request_body,
            input_origin=LocalFile(),
            request_id=_request_id(request),
            idempotency_key=request.headers.get("Idempotency-Key"),
        ),
        by_alias=True,
    )


@router.post("/media/uploads/{session_handle}/transport-failure", status_code=204)
def record_upload_transport_failure(
    session_handle: str,
    request_body: UploadTransportFailureRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
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
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        media_upload_sessions.retry_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            origin_kind="LocalFile",
            session_handle=session_handle,
            request=request_body,
        ),
        by_alias=True,
    )


@router.post("/media/uploads/{session_handle}/confirm")
def confirm_upload_session(
    session_handle: str,
    request_body: ConfirmUploadSessionRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    return ok(
        media_upload_sessions.confirm_upload_session(
            db=db,
            viewer_id=viewer.user_id,
            origin_kind="LocalFile",
            session_handle=session_handle,
            generation=request_body.generation,
            request_id=_request_id(request),
        ),
        by_alias=True,
    )


@router.delete("/media/uploads/{session_handle}", status_code=204)
def delete_upload_session(
    session_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    # The account credential removes its own unpublished session of either
    # origin: a browser capture's bytes live in the extension, which alone can
    # retry it, but discarding the session needs no extension credential.
    media_upload_sessions.delete_upload_session(
        db=db, viewer_id=viewer.user_id, origin_kind=None, session_handle=session_handle
    )
    return Response(status_code=204)


@router.post("/media/{media_id}/retry", status_code=202)
def retry_ingest(
    media_id: UUID,
    body: RetryRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    """Admit a new source attempt, or re-enrich metadata, for a viewer's media."""
    match body:
        case RetrySourceRequest():
            return ok(
                media_source_ingest.retry_source_for_viewer(
                    db,
                    viewer_id=viewer.user_id,
                    media_id=media_id,
                    client_mutation_id=body.client_mutation_id,
                    expected_attempt_id=body.expected_attempt_id,
                    request_id=_request_id(request),
                )
            )
        case RetryMetadataRequest():
            return success_response(
                metadata_lifecycle.retry_metadata_for_viewer(
                    db, viewer.user_id, media_id, request_id=_request_id(request)
                )
            )
        case _:
            assert_never(body)


@router.post("/media/{media_id}/repair", status_code=202)
def repair_media(
    media_id: UUID,
    body: MediaRepairRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Requeue the exact dead job the viewer inspected: source or search."""
    actor = ViewerRecovery(viewer_id=viewer.user_id, client_mutation_id=body.client_mutation_id)
    match body:
        case SourceRepairRequest():
            return ok(
                media_source_ingest.repair_dead_source_execution(
                    db,
                    actor=actor,
                    media_id=media_id,
                    expected_attempt_id=body.expected_attempt_id,
                    expected_job_id=body.expected_job_id,
                )
            )
        case SearchRepairRequest():
            return ok(
                content_indexing.repair_dead_media_reindex(
                    db,
                    actor=actor,
                    media_id=media_id,
                    expected_revision=body.expected_revision,
                    expected_job_id=body.expected_job_id,
                )
            )
        case _:
            assert_never(body)
