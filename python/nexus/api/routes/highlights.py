"""Highlights API routes.

Route handlers for highlight and annotation CRUD operations.
Routes are transport-only: each calls exactly one service function.

Per PR-06 spec:
- Highlights: POST/GET/PATCH/DELETE
- Annotation (0..1 per highlight): PUT/DELETE
- All routes require authentication
- Response envelope: {"data": ...}
- Error envelope: {"error": {"code": "...", "message": "...", "request_id": "..."}}
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.schemas.highlights import (
    CreateHighlightRequest,
    UpdateHighlightRequest,
    UpsertAnnotationRequest,
)
from nexus.services import highlights as highlights_service

router = APIRouter(tags=["highlights"])


# =============================================================================
# Highlight Endpoints
# =============================================================================


@router.post("/fragments/{fragment_id}/highlights", status_code=201)
def create_highlight(
    fragment_id: UUID,
    request: CreateHighlightRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a highlight on a fragment.

    Client sends offsets + color only. Server derives exact/prefix/suffix
    from fragment.canonical_text.

    Returns 201 Created with the highlight object.

    Errors:
        E_MEDIA_NOT_FOUND (404): Fragment doesn't exist or viewer cannot read it.
        E_MEDIA_NOT_READY (409): Media not in ready state.
        E_HIGHLIGHT_INVALID_RANGE (400): Invalid offset range.
        E_HIGHLIGHT_CONFLICT (409): Highlight already exists at this range.
    """
    result = highlights_service.create_highlight_for_fragment(
        db=db,
        viewer_id=viewer.user_id,
        fragment_id=fragment_id,
        req=request,
    )
    return success_response(result.model_dump(mode="json"))


@router.get("/fragments/{fragment_id}/highlights")
def list_highlights(
    fragment_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """List all highlights for a fragment owned by the viewer.

    Returns highlights ordered by start_offset ASC, created_at ASC.
    Each highlight includes its annotation if present.

    Does NOT require media to be in ready state (read-only operation).

    Errors:
        E_MEDIA_NOT_FOUND (404): Fragment doesn't exist or viewer cannot read it.
    """
    result = highlights_service.list_highlights_for_fragment(
        db=db,
        viewer_id=viewer.user_id,
        fragment_id=fragment_id,
    )
    return success_response({"highlights": [h.model_dump(mode="json") for h in result]})


@router.get("/highlights/{highlight_id}")
def get_highlight(
    highlight_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a single highlight by ID.

    Includes annotation if present.
    Does NOT require media to be in ready state (read-only operation).

    Errors:
        E_MEDIA_NOT_FOUND (404): Highlight doesn't exist, not owned, or media not readable.
    """
    result = highlights_service.get_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
    )
    return success_response(result.model_dump(mode="json"))


@router.patch("/highlights/{highlight_id}")
def update_highlight(
    highlight_id: UUID,
    request: UpdateHighlightRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update a highlight.

    All fields are optional. If offsets change, server re-derives
    exact/prefix/suffix from fragment.canonical_text.

    Requires media to be in ready state.

    Errors:
        E_MEDIA_NOT_FOUND (404): Highlight doesn't exist, not owned, or media not readable.
        E_MEDIA_NOT_READY (409): Media not in ready state.
        E_HIGHLIGHT_INVALID_RANGE (400): Invalid offset range.
        E_HIGHLIGHT_CONFLICT (409): New range conflicts with existing highlight.
    """
    result = highlights_service.update_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
        req=request,
    )
    return success_response(result.model_dump(mode="json"))


@router.delete("/highlights/{highlight_id}", status_code=204)
def delete_highlight(
    highlight_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a highlight.

    Deleting a highlight cascades to delete its annotation.
    Does NOT require media to be in ready state (allows cleanup).

    Errors:
        E_MEDIA_NOT_FOUND (404): Highlight doesn't exist, not owned, or media not readable.
    """
    highlights_service.delete_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
    )
    return Response(status_code=204)


# =============================================================================
# Annotation Endpoints (0..1 per highlight)
# =============================================================================


@router.put("/highlights/{highlight_id}/annotation")
def upsert_annotation(
    highlight_id: UUID,
    request: UpsertAnnotationRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> dict:
    """Create or update the annotation for a highlight.

    PUT semantics: creates if not exists, updates if exists.

    Returns 201 Created if new, 200 OK if updated.
    Requires media to be in ready state.

    Errors:
        E_MEDIA_NOT_FOUND (404): Highlight doesn't exist, not owned, or media not readable.
        E_MEDIA_NOT_READY (409): Media not in ready state.
    """
    result, created = highlights_service.upsert_annotation_for_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
        req=request,
    )

    if created:
        response.status_code = 201

    return success_response(result.model_dump(mode="json"))


@router.delete("/highlights/{highlight_id}/annotation", status_code=204)
def delete_annotation(
    highlight_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete the annotation for a highlight.

    Idempotent: returns 204 even if annotation doesn't exist.
    Does NOT require media to be in ready state (allows cleanup).

    Errors:
        E_MEDIA_NOT_FOUND (404): Highlight doesn't exist, not owned, or media not readable.
    """
    highlights_service.delete_annotation_for_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
    )
    return Response(status_code=204)
