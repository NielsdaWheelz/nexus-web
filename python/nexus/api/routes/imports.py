"""Imports workspace reads: summary, filtered pages, one import's detail and history."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.imports import (
    HistoryPage,
    ImportDetail,
    ImportListQuery,
    ImportPage,
    ImportSummary,
    parse_import_ref,
)
from nexus.services.imports import (
    read_import_detail,
    read_import_history,
    read_import_page,
    read_import_summary,
)

router = APIRouter(tags=["imports"])


@router.get("/imports/summary")
def get_import_summary(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ImportSummary]:
    return Data(data=read_import_summary(db, viewer_id=viewer.user_id))


@router.get("/imports")
def list_imports(
    query: Annotated[ImportListQuery, Query()],
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ImportPage]:
    return Data(data=read_import_page(db, viewer_id=viewer.user_id, query=query))


@router.get("/imports/{ref}")
def get_import(
    ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ImportDetail]:
    return Data(data=read_import_detail(db, viewer_id=viewer.user_id, ref=parse_import_ref(ref)))


@router.get("/imports/{ref}/history")
def get_import_history(
    ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
) -> Data[HistoryPage]:
    return Data(
        data=read_import_history(
            db,
            viewer_id=viewer.user_id,
            ref=parse_import_ref(ref),
            cursor=cursor,
            limit=limit,
        )
    )
