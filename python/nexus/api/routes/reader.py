"""Reader routes: evidence resolution, EPUB sections/navigation, reader state, file.

Transport-only: validate input, call one reader-family service, return the
envelope. All paths are `/media/{media_id}/...`.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok, success_response
from nexus.schemas.epub_find import EpubFindRequest
from nexus.schemas.media import MediaEvidenceResponse
from nexus.schemas.reader import CursorWrite
from nexus.services import (
    epub_find,
    epub_read,
    locator_resolver,
    media_file_access,
    reader_document_map,
    reader_navigation,
)
from nexus.services.consumption import service as consumption_service

router = APIRouter(tags=["media"])


@router.get(
    "/media/{media_id}/evidence/{evidence_span_id}",
    response_model=MediaEvidenceResponse,
)
def resolve_media_evidence(
    media_id: UUID,
    evidence_span_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = locator_resolver.resolve_evidence_span(
        db,
        viewer_id=viewer.user_id,
        evidence_span_id=evidence_span_id,
    )
    return success_response(result)


@router.get("/media/{media_id}/sections/{section_id:path}")
def get_epub_section(
    media_id: UUID,
    section_id: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a canonical EPUB section by encoded section id."""
    result = epub_read.get_epub_section_for_viewer(db, viewer.user_id, media_id, section_id)
    return ok(result)


@router.post("/media/{media_id}/epub-find")
def find_in_epub(
    media_id: UUID,
    payload: EpubFindRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """Find literal occurrences in one current EPUB snapshot."""
    return ok(epub_find.find_epub_for_viewer(db, viewer.user_id, media_id, payload))


@router.get("/media/{media_id}/navigation")
def get_media_navigation(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get canonical reader navigation payload."""
    result = reader_navigation.get_media_navigation_for_viewer(db, viewer.user_id, media_id)
    return ok(result)


@router.get("/media/{media_id}/document-map")
def get_reader_document_map(
    request: Request,
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """Get the reader Document Map aggregate."""
    unsupported_params = sorted(request.query_params)
    if unsupported_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Unsupported Document Map params: {', '.join(unsupported_params)}",
        )
    result = reader_document_map.get_reader_document_map(
        db,
        viewer_id=viewer.user_id,
        media_id=media_id,
    )
    return ok(result)


@router.get("/media/{media_id}/reader-state")
def get_reader_state(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get the canonical cursor snapshot (Empty or Positioned, never raw null)."""
    return ok(consumption_service.get_reader_cursor(db, viewer.user_id, media_id))


@router.put("/media/{media_id}/reader-state")
def put_reader_state(
    media_id: UUID,
    payload: CursorWrite,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> JSONResponse:
    """Atomically replace the cursor and current engagement."""
    snapshot = consumption_service.put_reader_cursor(viewer.user_id, media_id, payload)
    return JSONResponse(content=ok(snapshot))


@router.get("/media/{media_id}/file")
def get_media_file(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a short-lived signed download URL for a media file (PDF/EPUB only).

    Returns url and expires_at.
    """
    result = media_file_access.get_signed_download_url(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
    )
    return success_response(result)
