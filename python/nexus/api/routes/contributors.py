"""Contributor routes: parse the handle at ingress, call one facade function, envelope."""

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
from nexus.services import contributors as contributors_service
from nexus.services.contributor_taxonomy import ContributorHandle, parse_contributor_handle

router = APIRouter(prefix="/contributors", tags=["contributors"])


def _require_nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("Query must not be blank")
    return value


def _parse_handle(contributor_handle: str) -> ContributorHandle:
    """A grammar violation or a reserved segment 404s without revealing anything."""
    try:
        return parse_contributor_handle(contributor_handle)
    except ValueError:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found") from None


@router.get("")
def search_contributors(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    q: Annotated[str, Query(min_length=1, max_length=200), AfterValidator(_require_nonblank)],
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
) -> Data[ContributorSearchPageOut]:
    page = contributors_service.search_contributors(
        db, viewer_id=viewer.user_id, q=q, cursor=cursor, limit=limit
    )
    return Data(data=page)


@router.get("/{contributor_handle}")
def get_contributor(
    contributor_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[ContributorDetailOut]:
    detail = contributors_service.get_contributor_detail(
        db, viewer_id=viewer.user_id, contributor_handle=_parse_handle(contributor_handle)
    )
    return Data(data=detail)


@router.get("/{contributor_handle}/works")
def list_contributor_works(
    request: Request,
    contributor_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
) -> Data[CollectionPage[ContributorWorkItemOut]]:
    plan, query = contributors_service.parse_contributor_works_query(
        request.query_params.multi_items()
    )
    page = contributors_service.list_contributor_works(
        db,
        viewer_id=viewer.user_id,
        contributor_handle=_parse_handle(contributor_handle),
        plan=plan,
        cursor=query.cursor,
        collection_revision=query.collection_revision,
        limit=query.limit,
    )
    return Data(data=page)
