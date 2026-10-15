"""Highlight routes: ensure text/pdf, read, recolour/rebound, delete and note commands."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.highlights import (
    DeleteHighlightNoteOut,
    DeleteHighlightNoteRequest,
    EnsureMediaHighlightOut,
    EnsureMediaHighlightRequest,
    LinkedNoteBlockRef,
    SetHighlightNoteRequest,
    TypedHighlightOut,
    UpdateHighlightRequest,
)
from nexus.services import highlights as highlights_service
from nexus.services import notes

router = APIRouter(tags=["highlights"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/media/{media_id}/highlights")
def ensure_highlight(
    media_id: UUID, request: EnsureMediaHighlightRequest, viewer: ViewerDep, db: DbSession
) -> Data[EnsureMediaHighlightOut]:
    return Data(data=highlights_service.ensure_highlight(db, viewer.user_id, media_id, request))


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
    highlight_id: UUID, request: SetHighlightNoteRequest, viewer: ViewerDep, db: DbSession
) -> Data[LinkedNoteBlockRef]:
    """Create in the loaded empty slot or update the exact attached note."""
    note = notes.set_highlight_note(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        note_id=request.note_id,
        body_pm_json=request.body_pm_json,
        expected=request.expected,
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
def detach_highlight_note(
    highlight_id: UUID, note_id: UUID, viewer: ViewerDep, db: DbSession
) -> Response:
    """Detach the note (idempotent); the note stays."""
    notes.detach_highlight_note(db, viewer.user_id, highlight_id=highlight_id, note_id=note_id)
    return Response(status_code=204)


@router.post("/highlights/{highlight_id}/note/delete")
def delete_highlight_note(
    highlight_id: UUID, request: DeleteHighlightNoteRequest, viewer: ViewerDep, db: DbSession
) -> Data[DeleteHighlightNoteOut]:
    notes.delete_highlight_note(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        note_id=request.note_id,
        expected_version=request.expected_version,
    )
    return Data(data=DeleteHighlightNoteOut(deleted_note_id=request.note_id))


@router.delete("/highlights/{highlight_id}", status_code=204)
def delete_highlight(highlight_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    highlights_service.delete_highlight(db, viewer.user_id, highlight_id)
    return Response(status_code=204)
