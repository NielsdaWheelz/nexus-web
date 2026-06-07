"""Notes API routes."""

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.notes import (
    CreateNoteBlockRequest,
    CreatePageRequest,
    MoveNoteBlockRequest,
    PatchPageDocumentRequest,
    QuickCaptureRequest,
    SplitNoteBlockRequest,
    UpdateNoteBlockRequest,
    UpdatePageRequest,
)
from nexus.services import notes as notes_service

router = APIRouter(prefix="/notes", tags=["notes"])


@router.get("/pages")
def list_pages(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    pages = notes_service.list_pages(db, viewer.user_id)
    return success_response(
        {"pages": [page.model_dump(mode="json", by_alias=True) for page in pages]}
    )


@router.post("/pages", status_code=201)
def create_page(
    request: CreatePageRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    page = notes_service.create_page(db, viewer.user_id, request)
    return ok(page, by_alias=True)


@router.get("/pages/{page_id}")
def get_page(
    page_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    page = notes_service.get_page(db, viewer.user_id, page_id)
    return ok(page, by_alias=True)


@router.patch("/pages/{page_id}")
def update_page(
    page_id: UUID,
    request: UpdatePageRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    page = notes_service.update_page(db, viewer.user_id, page_id, request)
    return ok(page, by_alias=True)


@router.patch("/pages/{page_id}/document")
def patch_page_document(
    page_id: UUID,
    request: PatchPageDocumentRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = notes_service.patch_page_document(db, viewer.user_id, page_id, request)
    return ok(result, by_alias=True)


@router.delete("/pages/{page_id}", status_code=204)
def delete_page(
    page_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    notes_service.delete_page(db, viewer.user_id, page_id)
    return Response(status_code=204)


@router.get("/daily")
def get_daily_note_for_today(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    time_zone: Annotated[str, Query(alias="time_zone", min_length=1, max_length=100)] = "UTC",
) -> dict:
    daily = notes_service.get_daily_note_for_today(
        db,
        viewer.user_id,
        time_zone=time_zone,
    )
    return ok(daily, by_alias=True)


@router.post("/daily/{local_date}/quick-capture", status_code=201)
def quick_capture_to_daily_date(
    local_date: date,
    request: QuickCaptureRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    time_zone: Annotated[str, Query(alias="time_zone", min_length=1, max_length=100)] = "UTC",
) -> dict:
    block = notes_service.quick_capture_to_daily(
        db,
        viewer.user_id,
        local_date=local_date,
        request=request,
        time_zone=time_zone,
    )
    return ok(block, by_alias=True)


@router.get("/daily/{local_date}")
def get_daily_note_by_date(
    local_date: date,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    time_zone: Annotated[str, Query(alias="time_zone", min_length=1, max_length=100)] = "UTC",
) -> dict:
    daily = notes_service.get_daily_note(db, viewer.user_id, local_date, time_zone=time_zone)
    return ok(daily, by_alias=True)


@router.post("/blocks", status_code=201)
def create_note_block(
    request: CreateNoteBlockRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    block = notes_service.create_note_block(db, viewer.user_id, request)
    return ok(block, by_alias=True)


@router.get("/blocks/{block_id}")
def get_note_block(
    block_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    block = notes_service.get_note_block(db, viewer.user_id, block_id)
    return ok(block, by_alias=True)


@router.patch("/blocks/{block_id}")
def update_note_block(
    block_id: UUID,
    request: UpdateNoteBlockRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    block = notes_service.update_note_block(db, viewer.user_id, block_id, request)
    return ok(block, by_alias=True)


@router.delete("/blocks/{block_id}", status_code=204)
async def delete_note_block(
    block_id: UUID,
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    if (await request.body()).strip():
        raise HTTPException(status_code=422, detail="Delete note block does not accept a body")
    notes_service.delete_note_block(db, viewer.user_id, block_id)
    return Response(status_code=204)


@router.post("/blocks/{block_id}/move")
def move_note_block(
    block_id: UUID,
    request: MoveNoteBlockRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    block = notes_service.move_note_block(db, viewer.user_id, block_id, request)
    return ok(block, by_alias=True)


@router.post("/blocks/{block_id}/split")
def split_note_block(
    block_id: UUID,
    request: SplitNoteBlockRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    block = notes_service.split_note_block(db, viewer.user_id, block_id, request)
    return ok(block, by_alias=True)


@router.post("/blocks/{block_id}/merge")
def merge_note_block(
    block_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    block = notes_service.merge_note_block(db, viewer.user_id, block_id)
    return ok(block, by_alias=True)
