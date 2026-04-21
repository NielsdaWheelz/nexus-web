"""Highlights API routes.

Route handlers for highlight and annotation CRUD operations.
Routes are transport-only: each calls exactly one service function.

S6 PR-04 additions:
- POST /media/{media_id}/pdf-highlights (PDF highlight create)
- GET /media/{media_id}/pdf-highlights (PDF highlight page-scoped list)
- Generic routes extended to return TypedHighlightOut for detail/update
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.schemas.highlights import (
    CreateHighlightRequest,
    CreatePdfHighlightRequest,
    UpdateHighlightRequest,
    UpsertAnnotationRequest,
)
from nexus.services import highlights as highlights_service

router = APIRouter(tags=["highlights"])


# =============================================================================
# Fragment Highlight Endpoints
# =============================================================================


@router.post("/fragments/{fragment_id}/highlights", status_code=201)
def create_highlight(
    fragment_id: UUID,
    request: CreateHighlightRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a highlight on a fragment."""
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
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """List highlights for a fragment."""
    mine_only_raw = request.query_params.get("mine_only", "true")
    if mine_only_raw not in ("true", "false"):
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST,
            "mine_only must be 'true' or 'false'",
        )
    mine_only = mine_only_raw == "true"

    result = highlights_service.list_highlights_for_fragment(
        db=db,
        viewer_id=viewer.user_id,
        fragment_id=fragment_id,
        mine_only=mine_only,
    )
    return success_response({"highlights": [h.model_dump(mode="json") for h in result]})


# =============================================================================
# PDF Highlight Endpoints (S6 PR-04)
# =============================================================================


@router.post("/media/{media_id}/pdf-highlights", status_code=201)
def create_pdf_highlight(
    media_id: UUID,
    request: CreatePdfHighlightRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a PDF geometry highlight on a page."""
    from nexus.services.pdf_highlights import create_pdf_highlight as svc_create

    result = svc_create(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        req=request,
    )
    return success_response(result.model_dump(mode="json"))


@router.get("/media/{media_id}/pdf-highlights")
def list_pdf_highlights(
    media_id: UUID,
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """List PDF highlights for a single page."""
    from nexus.services.pdf_highlights import list_pdf_highlights as svc_list

    page_raw = request.query_params.get("page_number")
    if page_raw is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "page_number is required")
    try:
        page_number = int(page_raw)
    except (TypeError, ValueError):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "page_number must be an integer") from None

    mine_only_raw = request.query_params.get("mine_only", "true")
    if mine_only_raw not in ("true", "false"):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "mine_only must be 'true' or 'false'")
    mine_only = mine_only_raw == "true"

    result = svc_list(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        page_number=page_number,
        mine_only=mine_only,
    )
    return success_response(
        {
            "page_number": page_number,
            "highlights": [h.model_dump(mode="json") for h in result],
        }
    )


# =============================================================================
# Generic Highlight Endpoints
# =============================================================================


@router.get("/highlights/{highlight_id}")
def get_highlight(
    highlight_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get a single highlight by ID (anchor-discriminated typed output)."""
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
    """Update a highlight (unified PATCH for fragment + PDF)."""
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
    """Delete a highlight (cascades annotation for all anchor kinds)."""
    highlights_service.delete_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
    )
    return Response(status_code=204)


# =============================================================================
# Annotation Endpoints (0..1 per highlight, all anchor kinds)
# =============================================================================


@router.put("/highlights/{highlight_id}/annotation")
def upsert_annotation(
    highlight_id: UUID,
    request: UpsertAnnotationRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> dict:
    """Create or update the annotation for a highlight."""
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
    """Delete the annotation for a highlight."""
    highlights_service.delete_annotation_for_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
    )
    return Response(status_code=204)
