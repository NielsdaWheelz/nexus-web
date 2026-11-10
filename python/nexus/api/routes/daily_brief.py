"""Account-wide editions use the ordinary shortlist publication and visit contract."""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.suggestions import (
    SuggestionsOut,
    SuggestionStateOut,
    SuggestionViewIn,
    SuggestionViewOut,
)
from nexus.services import suggestion_shortlists

router = APIRouter(tags=["daily selection"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/daily-brief")
def read_daily(viewer: ViewerDep, db: RepeatableReadDbSession) -> Data[SuggestionsOut]:
    return Data(
        data=suggestion_shortlists.read_suggestions(db, viewer_id=viewer.user_id, mode="daily")
    )


@router.post("/daily-brief/view")
def view_daily(
    request: SuggestionViewIn, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[SuggestionViewOut]:
    return Data(
        data=suggestion_shortlists.reconcile_suggestions_view(
            db, viewer_id=viewer.user_id, request=request, mode="daily"
        )
    )


@router.post("/daily-brief/refresh", status_code=202)
def refresh_daily(viewer: ViewerDep, db: DbSession) -> Data[SuggestionStateOut]:
    return Data(
        data=suggestion_shortlists.request_suggestions_refresh(
            db, viewer_id=viewer.user_id, mode="daily"
        )
    )
