"""Highlight routes: ensure text/pdf, read, recolour/rebound, delete and note commands."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.highlights import (
    DeleteHighlightNoteRequest,
    EnsureMediaHighlightRequest,
    SetHighlightNoteRequest,
    TypedHighlightOut,
    UpdateHighlightRequest,
)
from nexus.schemas.writing import WritingAck
from nexus.services import highlights as highlights_service
from nexus.services import notes

router = APIRouter(tags=["highlights"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/media/{media_id}/highlights")
def ensure_highlight(
    media_id: UUID, request: EnsureMediaHighlightRequest, viewer: ViewerDep, db: DbSession
) -> Data[WritingAck]:
    return Data(data=highlights_service.ensure_highlight(db, viewer.user_id, media_id, request))


@router.get("/highlights/{highlight_id}")
def get_highlight(
    highlight_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[TypedHighlightOut]:
    return Data(data=highlights_service.get_highlight(db, viewer.user_id, highlight_id))


@router.patch("/highlights/{highlight_id}")
def update_highlight(
    highlight_id: UUID, request: UpdateHighlightRequest, viewer: ViewerDep, db: DbSession
) -> Data[WritingAck]:
    return Data(data=highlights_service.update_highlight(db, viewer.user_id, highlight_id, request))


@router.put("/highlights/{highlight_id}/note")
def put_highlight_note(
    highlight_id: UUID, request: SetHighlightNoteRequest, viewer: ViewerDep, db: DbSession
) -> Data[WritingAck]:
    """Create in the loaded empty slot or update the exact attached note."""
    out = notes.set_highlight_note(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        note_id=request.note_id,
        link_id=request.link_id,
        body_pm_json=request.body_pm_json,
        expected=request.expected,
    )
    return Data(data=out)


@router.delete("/highlights/{highlight_id}/note/{note_id}")
def detach_highlight_note(
    highlight_id: UUID, note_id: UUID, link_id: UUID, viewer: ViewerDep, db: DbSession
) -> Data[WritingAck]:
    """Detach the note (idempotent); the note stays."""
    return Data(
        data=notes.detach_highlight_note(
            db, viewer.user_id, highlight_id=highlight_id, note_id=note_id, link_id=link_id
        )
    )


@router.post("/highlights/{highlight_id}/note/delete")
def delete_highlight_note(
    highlight_id: UUID, request: DeleteHighlightNoteRequest, viewer: ViewerDep, db: DbSession
) -> Data[WritingAck]:
    out = notes.delete_highlight_note(
        db,
        viewer.user_id,
        highlight_id=highlight_id,
        note_id=request.note_id,
        expected_version=request.expected_version,
    )
    return Data(data=out)


@router.delete("/highlights/{highlight_id}")
def delete_highlight(highlight_id: UUID, viewer: ViewerDep, db: DbSession) -> Data[WritingAck]:
    return Data(data=highlights_service.delete_highlight(db, viewer.user_id, highlight_id))
