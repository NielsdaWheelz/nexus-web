"""Highlight routes. Snake_case envelopes; the two PDF endpoints delegate."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.highlights import (
    CreateHighlightRequest,
    CreatePdfHighlightRequest,
    LinkedNoteBlockRef,
    SetHighlightNoteRequest,
    UpdateHighlightRequest,
)
from nexus.schemas.reader import ResolvedHighlightReaderTargetResponse
from nexus.services import highlights as highlights_service
from nexus.services import notes as notes_service
from nexus.services import pdf_highlights as pdf_highlights_service

router = APIRouter(tags=["highlights"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]
DbDep = Annotated[Session, Depends(get_db)]
MineOnly = Annotated[bool, Query()]


@router.post("/fragments/{fragment_id}/highlights", status_code=201)
def create_highlight(
    fragment_id: UUID, request: CreateHighlightRequest, viewer: ViewerDep, db: DbDep
) -> dict:
    return ok(
        highlights_service.create_highlight_for_fragment(db, viewer.user_id, fragment_id, request)
    )


@router.get("/fragments/{fragment_id}/highlights")
def list_highlights(
    fragment_id: UUID, viewer: ViewerDep, db: DbDep, mine_only: MineOnly = True
) -> dict:
    highlights = highlights_service.list_highlights_for_fragment(
        db, viewer.user_id, fragment_id, mine_only
    )
    return success_response({"highlights": [item.model_dump(mode="json") for item in highlights]})


@router.post("/media/{media_id}/pdf-highlights", status_code=201)
def create_pdf_highlight(
    media_id: UUID, request: CreatePdfHighlightRequest, viewer: ViewerDep, db: DbDep
) -> dict:
    return ok(
        pdf_highlights_service.create_pdf_highlight(
            db=db, viewer_id=viewer.user_id, media_id=media_id, req=request
        )
    )


@router.get("/media/{media_id}/pdf-highlights")
def list_pdf_highlights(
    media_id: UUID,
    viewer: ViewerDep,
    db: DbDep,
    page_number: Annotated[int, Query(ge=1, description="1-based PDF page number")],
    mine_only: MineOnly = True,
) -> dict:
    highlights = pdf_highlights_service.list_pdf_highlights(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        page_number=page_number,
        mine_only=mine_only,
    )
    return success_response(
        {
            "page_number": page_number,
            "highlights": [item.model_dump(mode="json") for item in highlights],
        }
    )


@router.get("/highlights/{highlight_id}")
def get_highlight(highlight_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(highlights_service.get_highlight(db, viewer.user_id, highlight_id))


@router.get(
    "/highlights/{highlight_id}/reader-target", response_model=ResolvedHighlightReaderTargetResponse
)
def get_highlight_reader_target(
    highlight_id: UUID, viewer: ViewerDep, db: DbDep
) -> ResolvedHighlightReaderTargetResponse:
    return ResolvedHighlightReaderTargetResponse(
        data=highlights_service.get_highlight_reader_target(
            db, viewer_id=viewer.user_id, highlight_id=highlight_id
        )
    )


@router.patch("/highlights/{highlight_id}")
def update_highlight(
    highlight_id: UUID, request: UpdateHighlightRequest, viewer: ViewerDep, db: DbDep
) -> dict:
    return ok(highlights_service.update_highlight(db, viewer.user_id, highlight_id, request))


@router.put("/highlights/{highlight_id}/note")
def set_highlight_note(
    highlight_id: UUID, request: SetHighlightNoteRequest, viewer: ViewerDep, db: DbDep
) -> dict:
    block = notes_service.set_highlight_note_body_pm_json(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        block_id=request.note_block_id,
        body_pm_json=request.body_pm_json,
        client_mutation_id=request.client_mutation_id,
    )
    return ok(
        LinkedNoteBlockRef(
            note_block_id=block.id, body_pm_json=block.body_pm_json, body_text=block.body_text
        )
    )


@router.delete("/highlights/{highlight_id}/note", status_code=204)
def delete_highlight_note(
    highlight_id: UUID,
    viewer: ViewerDep,
    db: DbDep,
    client_mutation_id: Annotated[str, Query(min_length=1, max_length=120)],
    note_block_id: Annotated[UUID | None, Query()] = None,
) -> Response:
    notes_service.delete_highlight_note(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        note_block_id=note_block_id,
        client_mutation_id=client_mutation_id,
    )
    return Response(status_code=204)


@router.delete("/highlights/{highlight_id}", status_code=204)
def delete_highlight(highlight_id: UUID, viewer: ViewerDep, db: DbDep) -> Response:
    highlights_service.delete_highlight(db, viewer.user_id, highlight_id)
    return Response(status_code=204)
