"""Highlight API routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import ok, success_response
from nexus.schemas.highlights import (
    CreateHighlightRequest,
    CreatePdfHighlightRequest,
    LinkedNoteBlockRef,
    SetHighlightNoteRequest,
    UpdateHighlightRequest,
)
from nexus.services import highlights as highlights_service
from nexus.services import notes as notes_service
from nexus.services import pdf_highlights as pdf_highlights_service

router = APIRouter(tags=["highlights"])


def _parse_mine_only(raw: str) -> bool:
    """Coerce the `mine_only` query token, 400ing on anything but true/false."""
    if raw not in ("true", "false"):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "mine_only must be 'true' or 'false'")
    return raw == "true"


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
    return ok(result)


@router.get("/fragments/{fragment_id}/highlights")
def list_highlights(
    fragment_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    mine_only: Annotated[str, Query()] = "true",
) -> dict:
    """List highlights for a fragment."""
    result = highlights_service.list_highlights_for_fragment(
        db=db,
        viewer_id=viewer.user_id,
        fragment_id=fragment_id,
        mine_only=_parse_mine_only(mine_only),
    )
    return success_response({"highlights": [h.model_dump(mode="json") for h in result]})


@router.get("/media/{media_id}/highlights")
def list_media_highlights(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    mine_only: Annotated[str, Query()] = "true",
) -> dict:
    """List every highlight of a media across all fragments and PDF pages."""
    result = highlights_service.list_highlights_for_media(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        mine_only=_parse_mine_only(mine_only),
    )
    return success_response({"highlights": [h.model_dump(mode="json") for h in result]})


# =============================================================================
# PDF Geometry Highlight Endpoints
# =============================================================================


@router.post("/media/{media_id}/pdf-highlights", status_code=201)
def create_pdf_highlight(
    media_id: UUID,
    request: CreatePdfHighlightRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a PDF geometry highlight on a page."""
    result = pdf_highlights_service.create_pdf_highlight(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        req=request,
    )
    return ok(result)


@router.get("/media/{media_id}/pdf-highlights")
def list_pdf_highlights(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    page_number: Annotated[int, Query(ge=1, description="1-based PDF page number")],
    mine_only: Annotated[str, Query()] = "true",
) -> dict:
    """List PDF highlights for a single page."""
    result = pdf_highlights_service.list_pdf_highlights(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        page_number=page_number,
        mine_only=_parse_mine_only(mine_only),
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
    """Get a single highlight by ID."""
    result = highlights_service.get_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
    )
    return ok(result)


@router.patch("/highlights/{highlight_id}")
def update_highlight(
    highlight_id: UUID,
    request: UpdateHighlightRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Update a highlight with the canonical typed PATCH contract."""
    result = highlights_service.update_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
        req=request,
    )
    return ok(result)


@router.put("/highlights/{highlight_id}/note")
def set_highlight_note(
    highlight_id: UUID,
    request: SetHighlightNoteRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create or update the note attached to a highlight."""
    block = notes_service.set_highlight_note_body_pm_json(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
        block_id=request.note_block_id,
        body_pm_json=request.body_pm_json,
        client_mutation_id=request.client_mutation_id,
    )
    return ok(
        LinkedNoteBlockRef(
            note_block_id=block.id,
            body_pm_json=block.body_pm_json,
            body_text=block.body_text,
        )
    )


@router.delete("/highlights/{highlight_id}/note", status_code=204)
def delete_highlight_note(
    highlight_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    client_mutation_id: Annotated[
        str, Query(alias="client_mutation_id", min_length=1, max_length=120)
    ],
    note_block_id: Annotated[UUID | None, Query(alias="note_block_id")] = None,
) -> Response:
    """Delete the note attached to a highlight through the document command path."""
    notes_service.delete_highlight_note(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
        note_block_id=note_block_id,
        client_mutation_id=client_mutation_id,
    )
    return Response(status_code=204)


@router.delete("/highlights/{highlight_id}", status_code=204)
def delete_highlight(
    highlight_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Delete a highlight."""
    highlights_service.delete_highlight(
        db=db,
        viewer_id=viewer.user_id,
        highlight_id=highlight_id,
    )
    return Response(status_code=204)
