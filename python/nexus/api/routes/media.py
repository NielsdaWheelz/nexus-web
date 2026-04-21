"""Media routes.

Routes are transport-only:
- Extract viewer_user_id from request.state
- Call exactly one service function
- Return success(...) or raise ApiError

No domain logic or raw DB access in routes.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.extension import get_extension_viewer
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.media import (
    ArticleCaptureRequest,
    FromUrlRequest,
    ListeningStateBatchUpsertRequest,
    ListeningStateUpsertRequest,
    TranscriptForecastBatchRequest,
    TranscriptRequestBatchRequest,
    TranscriptRequestBatchResponse,
    TranscriptRequestRequest,
    TranscriptRequestResponse,
    UploadInitRequest,
)
from nexus.schemas.reader import ReaderMediaStatePut
from nexus.services import epub_lifecycle, epub_read, image_proxy
from nexus.services import libraries as libraries_service
from nexus.services import media as media_service
from nexus.services import podcasts as podcast_service
from nexus.services import reader as reader_service
from nexus.services import upload as upload_service

router = APIRouter()


# =============================================================================
# Image Proxy Endpoint (MUST be defined before /media/{media_id} to avoid
# FastAPI matching "image" as a UUID)
# =============================================================================


@router.get("/media/image")
def get_proxied_image(
    url: str,
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Response:
    """Proxy an external image through the server with SSRF protection.

    This endpoint fetches external images safely, validating URLs and content
    to prevent SSRF attacks and ensure only valid images are served.

    The endpoint:
    - Validates URL scheme (http/https only), port (80/443 only), no credentials
    - Blocks requests to private/internal IP addresses
    - Validates image content type and decodes with Pillow
    - Caches images by normalized URL with ETag support
    - Returns 304 Not Modified for conditional GET with matching ETag

    Args:
        url: The external image URL to fetch (must be percent-encoded).
        request: FastAPI request object for reading If-None-Match header.
        viewer: Authenticated viewer (required for auth enforcement).

    Returns:
        Response with image bytes and appropriate headers.

    Raises:
        E_SSRF_BLOCKED (403): URL violates security rules.
        E_IMAGE_FETCH_FAILED (502): Failed to fetch from upstream.
        E_INGEST_TIMEOUT (504): Upstream fetch timed out.
        E_IMAGE_TOO_LARGE (413): Image exceeds 10MB or 4096x4096 dimensions.
        E_INVALID_REQUEST (400): Malformed URL or invalid image content.
    """
    # Check If-None-Match for conditional GET
    if_none_match = request.headers.get("If-None-Match")

    result = image_proxy.fetch_image(url, if_none_match=if_none_match)

    if result.not_modified:
        return Response(
            status_code=304,
            headers={"ETag": result.etag},
        )

    return Response(
        content=result.data,
        media_type=result.content_type,
        headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": result.etag,
        },
    )


# =============================================================================
# Media CRUD Endpoints
# =============================================================================


@router.get("/media")
def list_media(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    kind: str | None = Query(
        default=None,
        description="Comma-separated media kind filter (web_article, epub, pdf, video, podcast_episode)",
    ),
    search: str | None = Query(default=None, description="Optional title substring filter"),
    cursor: str | None = Query(default=None, description="Pagination cursor"),
    limit: int = Query(default=50, ge=1, le=200, description="Maximum results per page"),
) -> dict:
    """List media visible to the viewer across all libraries/provenance paths."""
    media_list, next_cursor = media_service.list_visible_media(
        db=db,
        viewer_id=viewer.user_id,
        kind=kind,
        search=search,
        cursor=cursor,
        limit=limit,
    )
    return {
        "data": [media.model_dump(mode="json") for media in media_list],
        "page": {"next_cursor": next_cursor},
    }


@router.post("/media/from_url", status_code=202)
def create_from_url(
    request_body: FromUrlRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    """Create media from URL and enqueue ingestion.

    Kind classification happens in the service layer:
    - YouTube URLs -> canonical `video` identity with create-or-reuse semantics
    - X/Twitter post URLs -> canonical `web_article` from official oEmbed
    - PDF/EPUB URLs -> file-backed `pdf`/`epub` media
    - Other URLs -> provisional `web_article`

    Returns 202 Accepted with:
        - media_id: UUID of the created or reused media
        - idempotency_outcome: `created` or `reused`
        - processing_status: current lifecycle snapshot (`pending`, `ready_for_reading`, etc.)
        - ingest_enqueued: True if task was enqueued

    Clients should poll GET /media/{id} for status updates after submitting a PDF, EPUB, article, or video URL.
    """
    # Get request_id from state if available (set by request-id middleware)
    request_id = getattr(request.state, "request_id", None)

    result = media_service.enqueue_media_from_url(
        db=db,
        viewer_id=viewer.user_id,
        url=request_body.url,
        library_id=request_body.library_id,
        request_id=request_id,
    )
    return success_response(result.model_dump(mode="json"))


@router.post("/media/capture/article", status_code=201)
def create_captured_article(
    request_body: ArticleCaptureRequest,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = media_service.create_captured_web_article(
        db=db,
        viewer_id=viewer.user_id,
        url=request_body.url,
        title=request_body.title,
        byline=request_body.byline,
        excerpt=request_body.excerpt,
        site_name=request_body.site_name,
        published_time=request_body.published_time,
        content_html=request_body.content_html,
    )
    return success_response(result.model_dump(mode="json"))


@router.post("/media/capture/file", status_code=202)
async def create_captured_file(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = media_service.create_captured_file(
        db=db,
        viewer_id=viewer.user_id,
        payload=await request.body(),
        filename=request.headers.get("x-nexus-filename") or "",
        content_type=request.headers.get("content-type") or "",
        source_url=request.headers.get("x-nexus-source-url"),
        request_id=getattr(request.state, "request_id", None),
    )
    return success_response(result.model_dump(mode="json"))


@router.post("/media/capture/url", status_code=202)
def create_captured_url(
    request_body: FromUrlRequest,
    viewer: Annotated[Viewer, Depends(get_extension_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    result = media_service.enqueue_media_from_url(
        db=db,
        viewer_id=viewer.user_id,
        url=request_body.url,
        library_id=request_body.library_id,
        request_id=getattr(request.state, "request_id", None),
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


@router.get("/media/{media_id}/libraries")
def get_media_libraries(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = libraries_service.list_media_item_libraries(db, viewer.user_id, media_id)
    return success_response([row.model_dump(mode="json") for row in rows])


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


@router.get("/media/{media_id}/reader-state")
def get_reader_state(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get per-media reader state."""
    result = reader_service.get_reader_media_state(db, viewer.user_id, media_id)
    return success_response(result.model_dump(mode="json"))


@router.put("/media/{media_id}/reader-state")
def put_reader_state(
    media_id: UUID,
    body: ReaderMediaStatePut,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Replace per-media reader state."""
    result = reader_service.put_reader_media_state(db, viewer.user_id, media_id, body)
    return success_response(result.model_dump(mode="json"))


@router.get("/media/{media_id}/listening-state")
def get_listening_state(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get per-media listening state for the authenticated viewer."""
    result = media_service.get_listening_state_for_viewer(db, viewer.user_id, media_id)
    return success_response(result.model_dump(mode="json"))


@router.put("/media/{media_id}/listening-state", status_code=204)
def put_listening_state(
    media_id: UUID,
    body: ListeningStateUpsertRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Upsert per-media listening state for the authenticated viewer."""
    media_service.upsert_listening_state_for_viewer(db, viewer.user_id, media_id, body)
    return Response(status_code=204)


@router.post("/media/listening-state/batch", status_code=204)
def post_listening_state_batch(
    body: ListeningStateBatchUpsertRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Batch mark many visible podcast episodes played/unplayed."""
    media_service.batch_mark_listening_state_for_viewer(db, viewer.user_id, body)
    return Response(status_code=204)


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
        library_id=request.library_id,
    )
    return success_response(result)


@router.post("/media/{media_id}/ingest")
def confirm_ingest(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    """Confirm upload and process file.

    Validates the uploaded file, computes SHA-256 hash, and handles deduplication.
    For EPUB: runs archive safety preflight and dispatches extraction.
    Only the creator can confirm their upload.

    Returns:
        - media_id: UUID of the media (may differ if duplicate detected)
        - duplicate: True if an existing duplicate was found
        - processing_status: Current processing status snapshot
        - ingest_enqueued: True if extraction task was dispatched
    """
    request_id = getattr(request.state, "request_id", None)
    result = epub_lifecycle.confirm_ingest_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        request_id=request_id,
    )
    return success_response(result)


@router.post("/media/{media_id}/retry", status_code=202)
def retry_ingest(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
) -> dict:
    """Retry failed ingest/transcription for supported media kinds.

    Routes by media kind:
    - `pdf` -> PDF retry lifecycle
    - `epub` -> EPUB retry lifecycle
    - `podcast_episode` / `video` -> transcription retry lifecycle

    Returns 202 with:
        - media_id: UUID of the media
        - processing_status: 'extracting'
        - retry_enqueued: True if a retry task was dispatched
    """
    from nexus.services.pdf_lifecycle import retry_for_viewer_unified

    request_id = getattr(request.state, "request_id", None)
    result = retry_for_viewer_unified(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        request_id=request_id,
    )
    return success_response(result)


@router.post("/media/transcript/request/batch")
def request_podcast_transcript_batch(
    body: TranscriptRequestBatchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Admit transcript requests for multiple podcast episodes sequentially."""
    result = podcast_service.request_podcast_transcripts_batch_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_ids=body.media_ids,
        reason=body.reason,
    )
    payload = TranscriptRequestBatchResponse.model_validate(result).model_dump(mode="json")
    return success_response(payload)


@router.post("/media/{media_id}/transcript/request")
def request_podcast_transcript(
    media_id: UUID,
    body: TranscriptRequestRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Admit (or forecast) an explicit transcript request for a podcast episode."""
    result = podcast_service.request_podcast_transcript_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        reason=body.reason,
        dry_run=body.dry_run,
    )
    payload = TranscriptRequestResponse.model_validate(result).model_dump(mode="json")
    status_code = 202 if result["request_enqueued"] else 200
    return JSONResponse(status_code=status_code, content=success_response(payload))


@router.post("/media/transcript/forecasts")
def forecast_podcast_transcripts(
    body: TranscriptForecastBatchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Return dry-run transcript forecasts for many visible podcast episodes."""
    result = podcast_service.forecast_podcast_transcripts_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        requests=[(item.media_id, item.reason) for item in body.requests],
    )
    payload = [
        TranscriptRequestResponse.model_validate(row).model_dump(mode="json") for row in result
    ]
    return success_response(payload)


@router.get("/media/{media_id}/assets/{asset_key:path}")
def get_epub_asset(
    media_id: UUID,
    asset_key: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Serve an EPUB-internal asset (image, font, css) through canonical safe fetch path.

    Returns binary payload with resolved content type and cache headers.
    Visibility, kind, readiness, and key-format guards enforced by service layer.
    """
    result = media_service.get_epub_asset_for_viewer(db, viewer.user_id, media_id, asset_key)
    return Response(
        content=result.data,
        media_type=result.content_type,
        headers={
            "Cache-Control": "private, max-age=86400, immutable",
        },
    )


# =============================================================================
# EPUB Read Endpoints
# =============================================================================


@router.get("/media/{media_id}/sections/{section_id:path}")
def get_epub_section(
    media_id: UUID,
    section_id: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a canonical EPUB section by encoded section id."""
    result = epub_read.get_epub_section_for_viewer(db, viewer.user_id, media_id, section_id)
    return success_response(result.model_dump(mode="json"))

@router.get("/media/{media_id}/navigation")
def get_epub_navigation(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get canonical EPUB navigation payload (persisted sections + TOC links)."""
    result = epub_read.get_epub_navigation_for_viewer(db, viewer.user_id, media_id)
    return success_response(result.model_dump(mode="json"))


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
