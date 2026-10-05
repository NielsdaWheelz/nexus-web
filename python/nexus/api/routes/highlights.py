"""Highlight routes: one create for text and pdf, read, recolour/rebound, delete, note."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.highlights import (
    CreateMediaHighlightRequest,
    LinkedNoteBlockRef,
    SetHighlightNoteRequest,
    TypedHighlightOut,
    UpdateHighlightRequest,
)
from nexus.schemas.resource_items import NoteBodyVersionsOut
from nexus.services import highlights as highlights_service
from nexus.services import notes as notes_service
from nexus.services import pdf_highlights as pdf_highlights_service

router = APIRouter(tags=["highlights"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/media/{media_id}/highlights", status_code=201)
def create_highlight(
    media_id: UUID, request: CreateMediaHighlightRequest, viewer: ViewerDep, db: DbSession
) -> Data[TypedHighlightOut]:
    anchor = request.anchor
    if anchor.kind == "pdf":
        return Data(
            data=pdf_highlights_service.create_pdf_highlight(
                db, viewer.user_id, media_id, anchor, request.color
            )
        )
    return Data(
        data=highlights_service.create_text_highlight(
            db, viewer.user_id, media_id, anchor, request.color
        )
    )


@router.get("/highlights/{highlight_id}")
def get_highlight(highlight_id: UUID, viewer: ViewerDep, db: DbSession) -> Data[TypedHighlightOut]:
    return Data(data=highlights_service.get_highlight(db, viewer.user_id, highlight_id))


@router.patch("/highlights/{highlight_id}")
def update_highlight(
    highlight_id: UUID, request: UpdateHighlightRequest, viewer: ViewerDep, db: DbSession
) -> Data[TypedHighlightOut]:
    return Data(data=highlights_service.update_highlight(db, viewer.user_id, highlight_id, request))


@router.put("/highlights/{highlight_id}/note")
def set_highlight_note(
    highlight_id: UUID, request: SetHighlightNoteRequest, viewer: ViewerDep, db: DbSession
) -> Data[LinkedNoteBlockRef]:
    block = notes_service.set_highlight_note_body_pm_json(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        block_id=request.note_block_id,
        body_pm_json=request.body_pm_json,
        expected_body=request.expected_body,
        client_mutation_id=request.client_mutation_id,
    )
    return Data(
        data=LinkedNoteBlockRef(
            note_block_id=block.id,
            body_pm_json=block.body_pm_json,
            body_text=block.body_text,
            version_by_lane=NoteBodyVersionsOut.model_validate(block.version_by_lane),
        )
    )


@router.delete("/highlights/{highlight_id}/note", status_code=204)
def delete_highlight_note(
    highlight_id: UUID,
    viewer: ViewerDep,
    db: DbSession,
    client_mutation_id: Annotated[str, Query(min_length=1, max_length=120)],
    note_block_id: Annotated[UUID, Query()],
) -> Response:
    notes_service.detach_highlight_note(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        note_block_id=note_block_id,
        client_mutation_id=client_mutation_id,
    )
    return Response(status_code=204)


@router.delete("/highlights/{highlight_id}", status_code=204)
def delete_highlight(highlight_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    highlights_service.delete_highlight(db, viewer.user_id, highlight_id)
    return Response(status_code=204)
