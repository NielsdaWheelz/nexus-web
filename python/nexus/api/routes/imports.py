"""Imports register, detail, record and reader-owned attention dismissal."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.import_refs import parse_import_ref
from nexus.schemas.imports import (
    DismissImportsRequest,
    HistoryPage,
    ImportDetail,
    ImportListQuery,
    ImportPage,
    ImportSummary,
)
from nexus.services.import_dismissals import dismiss_imports
from nexus.services.imports import (
    read_import_detail,
    read_import_history,
    read_import_page,
    read_import_summary,
)

router = APIRouter(tags=["imports"])


@router.put("/imports/dismissals", status_code=204)
def put_import_dismissals(
    body: DismissImportsRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Response:
    dismiss_imports(
        db,
        viewer_id=viewer.user_id,
        dismissals=[(parse_import_ref(item.ref), item.through) for item in body.dismissals],
    )
    return Response(status_code=204)


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
