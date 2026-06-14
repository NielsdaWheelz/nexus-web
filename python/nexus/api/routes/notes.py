"""Notes API routes."""

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.notes import (
    CreatePageRequest,
    QuickCaptureRequest,
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


@router.post("/quick-capture", status_code=201)
def quick_capture(
    request: QuickCaptureRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    time_zone: Annotated[str, Query(alias="time_zone", min_length=1, max_length=100)] = "UTC",
) -> dict:
    block = notes_service.quick_capture(
        db,
        viewer.user_id,
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


@router.get("/blocks/{block_id}")
def get_note_block(
    block_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    block = notes_service.get_note_block(db, viewer.user_id, block_id)
    return ok(block, by_alias=True)
