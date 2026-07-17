"""Reader routes: evidence resolution, EPUB sections/navigation, reader state, file.

Transport-only: validate input, call one reader-family service, return the
envelope. All paths are `/media/{media_id}/...`.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.media import MediaEvidenceResponse
from nexus.schemas.reader import CursorWrite
from nexus.services import (
    epub_read,
    locator_resolver,
    media_file_access,
    reader_document_map,
    reader_navigation,
)
from nexus.services import reader as reader_service
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
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    include_unanchored: bool = Query(default=True),
    limit: int = Query(default=500, ge=1, le=1000),
) -> dict:
    """Get the reader Document Map aggregate."""
    result = reader_document_map.get_reader_document_map(
        db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        include_unanchored=include_unanchored,
        limit=limit,
    )
    return ok(result)


@router.get("/media/{media_id}/reader-state")
def get_reader_state(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get the canonical cursor snapshot (Empty or Positioned, never raw null)."""
    return ok(reader_service.get_reader_cursor(db, viewer.user_id, media_id))


@router.put("/media/{media_id}/reader-state")
def put_reader_state(
    media_id: UUID,
    payload: CursorWrite,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """Replace the cursor, then record the retry-safe current-state engagement.

    The cursor write commits (or raises 409 on conflict) first; a conflict
    records no engagement. On cursor success/idempotent success, the engagement
    command follows in its own transaction; its failure surfaces (not swallowed)
    and the same cursor write may be retried safely (spec §4.4).
    """
    snapshot = reader_service.put_reader_cursor(db, viewer.user_id, media_id, payload)
    consumption_service.record_reader_engagement(viewer.user_id, media_id, payload.locator)
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
