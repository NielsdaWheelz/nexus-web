"""Authenticated complete catalog export; no arbitrary account, scope or paging input."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.offline_catalog import OfflineCatalogOut
from nexus.services.offline_catalog import read_catalog

router = APIRouter(tags=["offline-catalog"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/offline-catalog")
def get_offline_catalog(
    request: Request, response: Response, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[OfflineCatalogOut]:
    if request.query_params:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Catalog export takes no query parameters"
        )
    response.headers["Cache-Control"] = "private, no-store"
    return Data(data=read_catalog(db, viewer.user_id))
