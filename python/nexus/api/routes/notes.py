"""Notes routes."""

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
    DailyCaptureRequest,
    DailyCaptureResult,
    DailyPageDescriptor,
    NoteBlockOut,
    NotePageOut,
    NotePageSummaryOut,
    UpdatePageRequest,
)
from nexus.services import notes as notes_service

router = APIRouter(prefix="/notes", tags=["notes"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/pages")
def list_pages(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionPage[NotePageSummaryOut]]:
    """Keyset pages of the viewer's pages in the shared updated/title views."""
    items = request.query_params.multi_items()
    return Data(data=notes_service.list_pages(db, viewer.user_id, items))


@router.post("/pages", status_code=201)
def create_page(
    request: CreatePageRequest, viewer: ViewerDep, db: DbSession
) -> Data[NotePageSummaryOut]:
    """Create by the client's id; a retry returns the page, another owner's id is 409."""
    return Data(data=notes_service.create_page(db, viewer.user_id, request))


@router.get("/pages/{page_id}")
def get_page(page_id: UUID, viewer: ViewerDep, db: DbSession) -> Data[NotePageOut]:
    return Data(data=notes_service.get_page(db, viewer.user_id, page_id))


@router.patch("/pages/{page_id}")
def update_page(
    page_id: UUID, request: UpdatePageRequest, viewer: ViewerDep, db: DbSession
) -> Data[NotePageOut]:
    return Data(data=notes_service.update_page(db, viewer.user_id, page_id, request))


@router.delete("/pages/{page_id}", status_code=204)
def delete_page(page_id: UUID, viewer: ViewerDep, db: DbSession) -> Response:
    """Idempotent: a missing page is 204; the page's notes stay."""
    notes_service.delete_page(db, viewer.user_id, page_id)
    return Response(status_code=204)


@router.get("/daily/{local_date}")
def read_daily_page(
    local_date: date, viewer: ViewerDep, db: DbSession
) -> Data[DailyPageDescriptor]:
    return Data(data=notes_service.read_daily_page(db, viewer.user_id, local_date))


@router.post("/daily/{local_date}/captures", status_code=201)
def capture_daily_page_note(
    local_date: date, request: DailyCaptureRequest, viewer: ViewerDep, db: DbSession
) -> Data[DailyCaptureResult]:
    result = notes_service.capture_daily_page_note(
        db, viewer.user_id, local_date=local_date, request=request
    )
    return Data(data=result)


@router.get("/blocks/{block_id}")
def get_note_block(block_id: UUID, viewer: ViewerDep, db: DbSession) -> Data[NoteBlockOut]:
    return Data(data=notes_service.get_note_block(db, viewer.user_id, block_id))
