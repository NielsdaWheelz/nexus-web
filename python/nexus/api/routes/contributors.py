"""Contributor routes.

Transport-only: parse/validate input, invoke exactly one facade function, return
the envelope. These four endpoints plus ``PUT /media/{id}/authors`` are the whole
contributor HTTP surface — there is no directory, reconciliation, merge, split,
tombstone, alias or external-id route. All four speak strict camelCase: responses
envelope via ``ok(model, by_alias=True)``.

Handles are parsed once at ingress by ``parse_contributor_handle``; reserved
collection segments (``directory``/``reconciliation-candidates``) and grammar
violations 404 without revealing whether an internal record exists (spec 6).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import AfterValidator
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.responses import ok
from nexus.schemas.contributors import ContributorRenameRequest
from nexus.services import contributors as contributors_service
from nexus.services.contributor_taxonomy import (
    ContributorHandle,
    parse_contributor_handle,
)

router = APIRouter(prefix="/contributors", tags=["contributors"])


def _require_nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("Query must not be blank")
    return value


def _parse_handle(contributor_handle: str) -> ContributorHandle:
    try:
        return parse_contributor_handle(contributor_handle)
    except ValueError:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Contributor not found") from None


@router.get("")
def search_contributors(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: Annotated[str, Query(min_length=1, max_length=200), AfterValidator(_require_nonblank)],
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=50),
) -> dict:
    page = contributors_service.search_contributors(
        db,
        viewer_id=viewer.user_id,
        q=q,
        cursor=cursor,
        limit=limit,
    )
    return ok(page, by_alias=True)


@router.get("/{contributor_handle}")
def get_contributor(
    contributor_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    detail = contributors_service.get_contributor_detail(
        db,
        viewer_id=viewer.user_id,
        contributor_handle=_parse_handle(contributor_handle),
        viewer_roles=viewer.roles,
    )
    return ok(detail, by_alias=True)


@router.get("/{contributor_handle}/works")
def list_contributor_works(
    contributor_handle: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    cursor: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=100),
) -> dict:
    page = contributors_service.list_contributor_works(
        db,
        viewer_id=viewer.user_id,
        contributor_handle=_parse_handle(contributor_handle),
        cursor=cursor,
        limit=limit,
    )
    return ok(page, by_alias=True)


@router.patch("/{contributor_handle}")
def rename_contributor(
    contributor_handle: str,
    request: ContributorRenameRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    detail = contributors_service.ensure_contributor_display_name(
        viewer=viewer,
        contributor_handle=_parse_handle(contributor_handle),
        request=request,
    )
    return ok(detail, by_alias=True)
