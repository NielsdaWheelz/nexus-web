"""``GET /browse`` and ``GET /browse/preview``; provider failures map onto their error codes."""

import unicodedata
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.browse import (
    BrowseKind,
    BrowsePage,
    BrowsePreview,
    BrowsePreviewQuery,
    BrowseQuery,
    BrowseSort,
    BrowseSource,
)
from nexus.schemas.suggestions import (
    SuggestionsOut,
    SuggestionStateOut,
    SuggestionViewIn,
    SuggestionViewOut,
)
from nexus.services import suggestion_shortlists
from nexus.services.browse.service import preview_browse, search_browse
from nexus.services.browse.targets import (
    BrowseProviderFailure,
    BrowseTargetNotFound,
    is_plain,
    provider_api_error,
)


def _each_key_once(request: Request) -> None:
    """FastAPI keeps the last of a repeated key; Browse takes each key exactly once."""
    if len(request.query_params.multi_items()) != len(request.query_params):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Repeated query parameter")


router = APIRouter(tags=["browse"], dependencies=[Depends(_each_key_once)])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]
_NEWEST = (BrowseSort.Newest, BrowseKind.Video, BrowseSource.YouTube)  # the one sortable section
_SOURCES = {
    BrowseKind.Pdf: {BrowseSource.Nexus},
    BrowseKind.Epub: {BrowseSource.Nexus, BrowseSource.ProjectGutenberg},
    BrowseKind.WebArticle: {BrowseSource.Nexus, BrowseSource.Brave},
    BrowseKind.Video: {BrowseSource.Nexus, BrowseSource.YouTube},
    BrowseKind.Podcast: {BrowseSource.PodcastIndex},
}


@router.get("/browse")
async def browse_content(
    request: Request, params: Annotated[BrowseQuery, Query()], viewer: ViewerDep, db: DbSession
) -> Data[BrowsePage]:
    if (
        not is_plain(params.q)
        or params.q != unicodedata.normalize("NFC", params.q)
        or params.source not in _SOURCES[params.kind]
        or (params.sort is not None and (params.sort, params.kind, params.source) != _NEWEST)
    ):
        raise InvalidRequestError(ApiErrorCode.E_INVALID_BROWSE_QUERY, "Invalid Browse query")
    provider = request.app.state.web_search_provider
    try:
        page = await search_browse(db, viewer.user_id, params, provider)
    except BrowseProviderFailure as exc:
        raise provider_api_error(exc) from exc
    return Data(data=page)


@router.get("/browse/preview")
def browse_preview(
    params: Annotated[BrowsePreviewQuery, Query()], viewer: ViewerDep, db: DbSession
) -> Data[BrowsePreview]:
    try:
        return Data(data=preview_browse(db, viewer.user_id, params))
    except BrowseTargetNotFound as exc:
        raise ApiError(ApiErrorCode.E_NOT_FOUND, "No longer available") from exc
    except BrowseProviderFailure as exc:
        raise provider_api_error(exc) from exc


@router.get("/browse/selection")
def read_selection(viewer: ViewerDep, db: RepeatableReadDbSession) -> Data[SuggestionsOut]:
    return Data(
        data=suggestion_shortlists.read_suggestions(db, viewer_id=viewer.user_id, mode="browse")
    )


@router.post("/browse/selection/view")
def view_selection(
    request: SuggestionViewIn, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[SuggestionViewOut]:
    return Data(
        data=suggestion_shortlists.reconcile_suggestions_view(
            db, viewer_id=viewer.user_id, request=request, mode="browse"
        )
    )


@router.post("/browse/selection/refresh", status_code=202)
def refresh_selection(viewer: ViewerDep, db: DbSession) -> Data[SuggestionStateOut]:
    return Data(
        data=suggestion_shortlists.request_suggestions_refresh(
            db, viewer_id=viewer.user_id, mode="browse"
        )
    )
