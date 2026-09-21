"""Notes routes. camelCase envelopes; the index parses its own query keys."""

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.notes import (
    CreatePageRequest,
    DailyCaptureRequest,
    NotePagesOut,
    UpdatePageRequest,
)
from nexus.services import notes as notes_service

router = APIRouter(prefix="/notes", tags=["notes"])

ViewerDep = Annotated[Viewer, Depends(get_viewer)]
DbDep = Annotated[Session, Depends(get_db)]


@router.get("/pages")
def list_pages(request: Request, viewer: ViewerDep, db: DbDep) -> dict:
    view = notes_service.parse_notes_index_query(request.query_params.multi_items())
    return ok(
        NotePagesOut(pages=notes_service.list_pages(db, viewer.user_id, view=view)), by_alias=True
    )


@router.post("/pages", status_code=201)
def create_page(request: CreatePageRequest, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(notes_service.create_page(db, viewer.user_id, request), by_alias=True)


@router.get("/pages/{page_id}")
def get_page(page_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(notes_service.get_page(db, viewer.user_id, page_id), by_alias=True)


@router.patch("/pages/{page_id}")
def update_page(page_id: UUID, request: UpdatePageRequest, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(notes_service.update_page(db, viewer.user_id, page_id, request), by_alias=True)


@router.delete("/pages/{page_id}", status_code=204)
def delete_page(page_id: UUID, viewer: ViewerDep, db: DbDep) -> Response:
    notes_service.delete_page(db, viewer.user_id, page_id)
    return Response(status_code=204)


@router.get("/daily/{local_date}")
def read_daily_page(local_date: date, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(notes_service.read_daily_page(db, viewer.user_id, local_date), by_alias=True)


@router.post("/daily/{local_date}/captures", status_code=201)
def capture_daily_page_note(
    local_date: date, request: DailyCaptureRequest, viewer: ViewerDep, db: DbDep
) -> dict:
    result = notes_service.capture_daily_page_note(
        db, viewer.user_id, local_date=local_date, request=request
    )
    return ok(result, by_alias=True)


@router.get("/blocks/{block_id}")
def get_note_block(block_id: UUID, viewer: ViewerDep, db: DbDep) -> dict:
    return ok(notes_service.get_note_block(db, viewer.user_id, block_id), by_alias=True)
