"""Media ingestion routes: URL/capture/upload entry points, confirm-ingest, retry.

Transport-only: validate input, call one service, return the envelope. Every
static `/media/<literal>` path here is declared before this router's dynamic
`/media/{media_id}/...` paths, and this router is registered before the `media`
router (see create_api_router) so the literals are not parsed as UUIDs.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Request
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from nexus.api.query_params import parse_comma_list
from nexus.auth.extension import get_extension_viewer
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok, success_response
from nexus.schemas.media import (
    ArticleCaptureRequest,
    FromUrlRequest,
    MediaIngestRequest,
    RetryRequest,
    UploadInitRequest,
)
from nexus.services import media_ingest, media_retry, media_source_ingest
from nexus.services import upload as upload_service

router = APIRouter(tags=["media"])


@router.post("/media/from_url", status_code=202)
def create_from_url(
    request_body: FromUrlRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    """Create media from a URL and enqueue ingestion (kind classified in service).

    Returns 202 Accepted with media_id, idempotency_outcome, processing_status,
    and ingest_enqueued. Clients poll GET /media/{id} for status.
    """
    result = media_ingest.enqueue_media_from_url(
        db=db,
        viewer_id=viewer.user_id,
        url=request_body.url,
        library_ids=request_body.library_ids,
        request_id=getattr(request.state, "request_id", None),
        idempotency_key=request.headers.get("Idempotency-Key"),
    )
    return ok(result)


@router.post("/media/capture/article", status_code=202)
def create_captured_article(
    request_body: ArticleCaptureRequest,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    result = media_source_ingest.accept_browser_article_capture(
        db=db,
        viewer_id=viewer.user_id,
        url=request_body.url,
        title=request_body.title,
        byline=request_body.byline,
        excerpt=request_body.excerpt,
        site_name=request_body.site_name,
        published_time=request_body.published_time,
        content_html=request_body.content_html,
        source_html=request_body.source_html,
        library_ids=request_body.library_ids,
        request_id=getattr(request.state, "request_id", None),
        idempotency_key=request.headers.get("Idempotency-Key"),
    )
    return ok(result)


@router.post("/media/capture/file", status_code=202)
async def create_captured_file(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    library_ids_header = request.headers.get("x-nexus-library-ids", "")
    try:
        library_ids = [UUID(value) for value in parse_comma_list(library_ids_header) or []]
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "invalid x-nexus-library-ids header"
        ) from exc
    body = await request.body()
    result = await run_in_threadpool(
        media_source_ingest.accept_browser_file_capture,
        db=db,
        viewer_id=viewer.user_id,
        payload=body,
        filename=request.headers.get("x-nexus-filename") or "",
        content_type=request.headers.get("content-type") or "",
        library_ids=library_ids,
        source_url=request.headers.get("x-nexus-source-url"),
        request_id=getattr(request.state, "request_id", None),
        idempotency_key=request.headers.get("Idempotency-Key"),
    )
    return ok(result)


@router.post("/media/capture/url", status_code=202)
def create_captured_url(
    request_body: FromUrlRequest,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    result = media_ingest.enqueue_media_from_url(
        db=db,
        viewer_id=viewer.user_id,
        url=request_body.url,
        library_ids=request_body.library_ids,
        request_id=getattr(request.state, "request_id", None),
        idempotency_key=request.headers.get("Idempotency-Key"),
    )
    return ok(result)


@router.post("/media/upload/init")
def upload_init(
    request: UploadInitRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    http_request: Request,
) -> dict:
    """Initialize a file upload: create the media stub and return a signed PUT URL.

    Client uploads directly to storage, then calls POST /media/{id}/ingest.
    Returns media_id, upload_url, expires_at.
    """
    result = upload_service.init_upload(
        db=db,
        viewer_id=viewer.user_id,
        kind=request.kind,
        filename=request.filename,
        content_type=request.content_type,
        size_bytes=request.size_bytes,
        library_ids=request.library_ids,
        request_id=getattr(http_request.state, "request_id", None),
        idempotency_key=http_request.headers.get("Idempotency-Key"),
    )
    return success_response(result)


@router.post("/media/{media_id}/ingest")
def confirm_ingest(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
    body: Annotated[MediaIngestRequest | None, Body()] = None,
) -> dict:
    """Confirm an upload and dispatch processing.

    Validates the uploaded file, computes its hash, deduplicates, and (for EPUB)
    runs the archive-safety preflight. Only the creator can confirm.
    Returns media_id, duplicate, processing_status, ingest_enqueued.
    """
    ingest_request = body if body is not None else MediaIngestRequest()
    result = media_source_ingest.confirm_uploaded_source(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        library_ids=ingest_request.library_ids,
        request_id=getattr(request.state, "request_id", None),
    )
    return success_response(result)


@router.post("/media/{media_id}/retry", status_code=202)
def retry_ingest(
    media_id: UUID,
    body: RetryRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    """Retry processing or re-enrich metadata for a viewer's media."""
    result = media_retry.retry_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        from_stage=body.from_stage,
        request_id=getattr(request.state, "request_id", None),
        idempotency_key=request.headers.get("Idempotency-Key"),
    )
    return success_response(result)
