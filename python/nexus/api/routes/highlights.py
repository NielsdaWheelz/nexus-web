"""Highlight routes: one create for text and pdf, read, recolour/rebound, delete, note."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.highlights import (
    CreateMediaHighlightRequest,
    LinkedNoteBlockRef,
    TypedHighlightOut,
    UpdateHighlightRequest,
)
from nexus.schemas.notes import AnnotationNoteRequest
from nexus.services import highlights as highlights_service
from nexus.services import notes
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
def put_highlight_note(
    highlight_id: UUID, request: AnnotationNoteRequest, viewer: ViewerDep, db: DbSession
) -> Data[LinkedNoteBlockRef]:
    """Create the highlight's one note and attach it. That note already attached has
    landed; another note attached is 409 E_NOTE_CONFLICT. Later edits are outline
    ``set_body`` commands."""
    note = notes.attach_highlight_note(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        note_id=request.note_id,
        body_pm_json=request.body_pm_json,
    )
    return Data(
        data=LinkedNoteBlockRef(
            note_block_id=note.id,
            body_pm_json=note.body_pm_json,
            body_text=note.body_text,
            body_version=note.body_version,
        )
    )


@router.delete("/highlights/{highlight_id}/note/{note_id}", status_code=204)
def delete_highlight_note(
    highlight_id: UUID, note_id: UUID, viewer: ViewerDep, db: DbSession
) -> Response:
    """Detach the note (idempotent); the note stays."""
    notes.detach_highlight_note(db, viewer.user_id, highlight_id=highlight_id, note_id=note_id)
    return Response(status_code=204)


@router.delete("/highlights/{highlight_id}", status_code=204)
def delete_highlight(highlight_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    highlights_service.delete_highlight(db, viewer.user_id, highlight_id)
    return Response(status_code=204)
