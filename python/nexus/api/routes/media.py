"""Media routes.

Routes are transport-only:
- Extract viewer_user_id from request.state
- Call exactly one service function
- Return success(...) or raise ApiError

No domain logic or raw DB access in routes.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.media import FromUrlRequest, UploadInitRequest
from nexus.services import media as media_service
from nexus.services import upload as upload_service

router = APIRouter()


@router.post("/media/from_url", status_code=201)
def create_from_url(
    request: FromUrlRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a provisional web_article from a URL.

    Creates a media row with processing_status='pending' and attaches it
    to the viewer's default library. No fetching or parsing occurs.

    Returns:
        - media_id: UUID of the created media
        - duplicate: Always false in PR-03 (true dedup in PR-04)
        - processing_status: Always 'pending'
        - ingest_enqueued: Always false (ingestion not implemented yet)
    """
    result = media_service.create_provisional_web_article(
        db=db,
        viewer_id=viewer.user_id,
        url=request.url,
    )
    return success_response(result.model_dump(mode="json"))


@router.get("/media/{media_id}")
def get_media(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get media by ID.

    Returns media metadata if the viewer can read it.
    Returns 404 if media does not exist or viewer cannot read it (masks existence).
    """
    result = media_service.get_media_for_viewer(db, viewer.user_id, media_id)
    return success_response(result.model_dump(mode="json"))


@router.get("/media/{media_id}/fragments")
def get_media_fragments(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get fragments for a media item.

    Returns fragments ordered by idx ASC if the viewer can read the media.
    Returns 404 if media does not exist or viewer cannot read it (masks existence).
    """
    result = media_service.list_fragments_for_viewer(db, viewer.user_id, media_id)
    return success_response([fragment.model_dump(mode="json") for fragment in result])


# =============================================================================
# Upload / Ingest Endpoints
# =============================================================================


@router.post("/media/upload/init")
def upload_init(
    request: UploadInitRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Initialize a file upload.

    Creates media stub and returns signed upload URL.
    Client should upload file directly to storage using the returned token,
    then call POST /media/{id}/ingest to confirm.

    Returns:
        - media_id: UUID of the created media
        - storage_path: Path in storage bucket
        - token: Token for uploadToSignedUrl()
        - expires_at: When the signed URL expires
    """
    result = upload_service.init_upload(
        db=db,
        viewer_id=viewer.user_id,
        kind=request.kind,
        filename=request.filename,
        content_type=request.content_type,
        size_bytes=request.size_bytes,
    )
    return success_response(result)


@router.post("/media/{media_id}/ingest")
def confirm_ingest(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Confirm upload and process file.

    Validates the uploaded file, computes SHA-256 hash, and handles deduplication.
    Only the creator can confirm their upload.

    NOTE: In S1, no tasks are enqueued. Media stays in 'pending' status.

    Returns:
        - media_id: UUID of the media (may differ if duplicate detected)
        - duplicate: True if an existing duplicate was found
    """
    result = upload_service.confirm_ingest(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
    )
    return success_response(result)


@router.get("/media/{media_id}/file")
def get_media_file(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get signed download URL for a media file.

    Returns a short-lived signed URL for downloading the original file.
    Only available for PDF/EPUB media with uploaded files.

    Returns:
        - url: Signed download URL
        - expires_at: When the URL expires
    """
    result = upload_service.get_signed_download_url(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
    )
    return success_response(result)
