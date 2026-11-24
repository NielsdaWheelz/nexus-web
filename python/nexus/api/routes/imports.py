"""Imports register, detail, record and reader-owned attention dismissal."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.collection_index import CollectionIndex, parse_index_query
from nexus.schemas.import_refs import parse_import_ref
from nexus.schemas.imports import (
    DismissImportsRequest,
    ImportDetail,
    ImportHistory,
    ImportIndex,
    ImportItem,
    ImportSummary,
    parse_import_instant,
)
from nexus.services.import_dismissals import dismiss_imports
from nexus.services.imports import (
    read_import_detail,
    read_import_history,
    read_import_index,
    read_import_summary,
    read_recent_imports,
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
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ImportIndex]:
    query = parse_index_query(request.query_params.multi_items(), domain_keys={"from"})
    cutoff = parse_import_instant(query.get("from"), "from")
    if cutoff is None:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Missing from instant")
    return Data(data=read_import_index(db, viewer_id=viewer.user_id, arrived_from=cutoff))


@router.get("/imports/recent")
def get_recent_imports(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[CollectionIndex[ImportItem]]:
    parse_index_query(request.query_params.multi_items(), domain_keys=set())
    return Data(data=read_recent_imports(db, viewer_id=viewer.user_id))


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
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[ImportHistory]:
    parse_index_query(request.query_params.multi_items(), domain_keys=set())
    return Data(
        data=read_import_history(db, viewer_id=viewer.user_id, ref=parse_import_ref(ref)),
    )
