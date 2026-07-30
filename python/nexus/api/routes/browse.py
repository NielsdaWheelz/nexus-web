"""Strict Browse and non-mutating Preview routes."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import ok
from nexus.schemas.browse import (
    QuotaExhaustedFailure,
    RateLimitedFailure,
    UnavailableFailure,
    parse_browse_preview_query,
    parse_browse_query,
)
from nexus.schemas.presence import absent, present
from nexus.services.browse.models import (
    BrowseProviderFailure,
    BrowseSectionFailureKind,
    BrowseTargetNotFound,
)
from nexus.services.browse.service import preview_browse, search_browse

router = APIRouter(tags=["browse"])


@router.get("/browse")
async def browse_content(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    query = parse_browse_query(request.query_params.multi_items())
    try:
        page = await search_browse(
            db,
            viewer_id=viewer.user_id,
            query=query,
            web_search_provider=request.app.state.web_search_provider,
        )
    except BrowseProviderFailure as exc:
        raise _provider_error(exc) from exc
    return ok(page, by_alias=True)


@router.get("/browse/preview")
def browse_preview(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    query = parse_browse_preview_query(request.query_params.multi_items())
    try:
        preview = preview_browse(
            db,
            viewer_id=viewer.user_id,
            query=query,
        )
    except BrowseTargetNotFound as exc:
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "No longer available") from exc
    except BrowseProviderFailure as exc:
        raise _provider_error(exc) from exc
    return ok(preview, by_alias=True)


def _provider_error(exc: BrowseProviderFailure) -> ApiError:
    match exc.kind:
        case BrowseSectionFailureKind.Unavailable:
            failure = UnavailableFailure()
            code = ApiErrorCode.E_BROWSE_PROVIDER_UNAVAILABLE
        case BrowseSectionFailureKind.RateLimited:
            failure = RateLimitedFailure(
                retry_at=absent() if exc.retry_at is None else present(exc.retry_at)
            )
            code = ApiErrorCode.E_BROWSE_PROVIDER_RATE_LIMITED
        case BrowseSectionFailureKind.QuotaExhausted:
            failure = QuotaExhaustedFailure(
                reset_at=absent() if exc.reset_at is None else present(exc.reset_at)
            )
            code = ApiErrorCode.E_BROWSE_PROVIDER_QUOTA_EXHAUSTED
    return ApiError(
        code,
        "Browse provider request failed",
        details=failure.model_dump(mode="json", by_alias=True),
    )
