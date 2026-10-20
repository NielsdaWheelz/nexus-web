"""Notes routes: pages, the daily page, note rows and outlines."""

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.collection_page import CollectionPage
from nexus.schemas.notes import (
    CreatePageRequest,
    DailyCaptureOut,
    DailyCaptureRequest,
    DailyPageOut,
    NoteBlockOut,
    NotePageSummaryOut,
)
from nexus.services import note_bodies, notes

router = APIRouter(prefix="/notes", tags=["notes"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/pages")
def list_pages(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionPage[NotePageSummaryOut]]:
    """Keyset pages of the viewer's pages in the chats index's four views."""
    items = request.query_params.multi_items()
    return Data(data=notes.list_pages(db, viewer.user_id, items))


@router.post("/pages", status_code=201)
def create_page(
    request: CreatePageRequest, viewer: ViewerDep, db: DbSession
) -> Data[NotePageSummaryOut]:
    """Create by the client's id; a retry returns the page, another owner's id is 409."""
    return Data(data=notes.create_page(db, viewer.user_id, request.id, request.title))


@router.delete("/pages/{page_id}", status_code=204)
def delete_page(page_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    """Idempotent: a missing page is 204. The page's notes stay."""
    notes.delete_page(db, viewer.user_id, page_id)
    return Response(status_code=204)


@router.get("/daily/{local_date}")
def read_daily_page(
    local_date: date, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[DailyPageOut]:
    """The day's page outline, or a latent one; writes nothing."""
    return Data(data=notes.read_daily_page(db, viewer.user_id, local_date))


@router.post("/daily/{local_date}/captures")
def capture(
    local_date: date, request: DailyCaptureRequest, viewer: ViewerDep, db: DbSession
) -> Data[DailyCaptureOut]:
    """Append the text last on the day's page. A retry with the same note id has landed.

    Errors: E_EMPTY_NOTE_BODY (400) for blank text; E_NOTE_CONFLICT (409) for another
    owner's note id."""
    page_id = notes.capture(
        db, viewer.user_id, local_date=local_date, note_id=request.note_id, text=request.text
    )
    return Data(data=DailyCaptureOut(page_id=page_id))


@router.get("/blocks/{note_id}")
def read_note(note_id: UUID, viewer: ViewerDep, db: DbSession) -> Data[NoteBlockOut]:
    return Data(data=note_bodies.read_note(db, viewer_id=viewer.user_id, note_id=note_id))
