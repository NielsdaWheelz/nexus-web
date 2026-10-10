"""Contributor routes: parse the handle first, then the view, then call the facade."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from pydantic import AfterValidator

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import Data
from nexus.schemas.collection_page import CollectionPage
from nexus.schemas.contributors import (
    ContributorDetailOut,
    ContributorSearchPageOut,
    ContributorWorkItemOut,
)
from nexus.services import contributors
from nexus.services.contributor_taxonomy import ContributorHandle, try_parse_contributor_handle

router = APIRouter(prefix="/contributors", tags=["contributors"])


def _nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("Query must not be blank")
    return value


def _handle(value: str) -> ContributorHandle:
    """A malformed handle is a 404, indistinguishable from an unknown one."""
    handle = try_parse_contributor_handle(value)
    if handle is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found")
    return handle


@router.get("")
def search_contributors(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    q: Annotated[str, Query(min_length=1, max_length=200), AfterValidator(_nonblank)],
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
) -> Data[ContributorSearchPageOut]:
    page = contributors.search_contributors(
        db, viewer_id=viewer.user_id, q=q, cursor=cursor, limit=limit
    )
    return Data(data=page)


@router.get("/{contributor_handle}")
def get_contributor(
    contributor_handle: str, viewer: Annotated[Viewer, Depends(get_viewer)], db: DbSession
) -> Data[ContributorDetailOut]:
    detail = contributors.get_contributor_detail(
        db, viewer_id=viewer.user_id, contributor_handle=_handle(contributor_handle)
    )
    return Data(data=detail)


@router.get("/{contributor_handle}/works")
def list_contributor_works(
    request: Request,
    contributor_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[CollectionPage[ContributorWorkItemOut]]:
    handle = _handle(contributor_handle)
    plan, query = contributors.parse_contributor_works_query(request.query_params.multi_items())
    page = contributors.list_contributor_works(
        db,
        viewer_id=viewer.user_id,
        contributor_handle=handle,
        plan=plan,
        cursor=query.cursor,
        collection_revision=query.collection_revision,
        limit=query.limit,
    )
    return Data(data=page)
