"""The Lectern, its suggestions and the read-state writes. Transport only: the consumption
services own transactions and fences. Registers before the media router (static
``/media/{id}/<literal>`` paths)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas import consumption as wire
from nexus.schemas.suggestions import (
    QuickReadsOut,
    SuggestionRefreshIn,
    SuggestionsOut,
    SuggestionStateOut,
    SuggestionViewIn,
    SuggestionViewOut,
)
from nexus.services import suggestion_shortlists, suggestions
from nexus.services.consumption import lectern, state

router = APIRouter(tags=["consumption"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.get("/lectern")
def get_lectern(viewer: ViewerDep, db: RepeatableReadDbSession) -> Data[wire.LecternOut]:
    return Data(data=lectern.get_lectern(db, viewer.user_id))


@router.put("/lectern/items/{media_id}", status_code=204)
def place_on_lectern(media_id: UUID, body: wire.PlaceIn, viewer: ViewerDep) -> Response:
    lectern.place(viewer.user_id, media_id, body.placement)
    return Response(status_code=204)


@router.delete("/lectern/items/{media_id}", status_code=204)
def remove_from_lectern(media_id: UUID, viewer: ViewerDep) -> Response:
    lectern.remove(viewer.user_id, media_id)
    return Response(status_code=204)


@router.get("/lectern/suggestions")
def get_lectern_suggestions(viewer: ViewerDep, db: RepeatableReadDbSession) -> Data[SuggestionsOut]:
    return Data(data=suggestion_shortlists.read_suggestions(db, viewer_id=viewer.user_id))


@router.post("/lectern/suggestions/view")
def reconcile_lectern_suggestions(
    request: SuggestionViewIn, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[SuggestionViewOut]:
    return Data(
        data=suggestion_shortlists.reconcile_suggestions_view(
            db, viewer_id=viewer.user_id, request=request
        )
    )


@router.post("/lectern/suggestions/refresh", status_code=202)
def refresh_lectern_suggestions(
    request: SuggestionRefreshIn, viewer: ViewerDep, db: DbSession
) -> Data[SuggestionStateOut]:
    return Data(
        data=suggestion_shortlists.request_suggestions_refresh(
            db, viewer_id=viewer.user_id, request=request
        )
    )


@router.get("/lectern/quick-reads")
def get_quick_reads(viewer: ViewerDep, db: RepeatableReadDbSession) -> Data[QuickReadsOut]:
    return Data(data=suggestions.build_quick_reads(db, viewer_id=viewer.user_id))


@router.post("/media/{media_id}/finish")
def finish(media_id: UUID, body: wire.FinishIn, viewer: ViewerDep) -> Data[wire.Finish]:
    return Data(data=state.finish(viewer.user_id, media_id, body))


@router.post("/media/{media_id}/finish/undo", status_code=204)
def undo_finish(media_id: UUID, body: wire.Finish, viewer: ViewerDep) -> Response:
    state.undo_finish(viewer.user_id, media_id, body)
    return Response(status_code=204)


@router.post("/media/{media_id}/unread", status_code=204)
def mark_unread(media_id: UUID, viewer: ViewerDep) -> Response:
    state.mark_unread(viewer.user_id, media_id)
    return Response(status_code=204)


@router.post("/media/{media_id}/progress/reset", status_code=204)
def reset_progress(media_id: UUID, viewer: ViewerDep) -> Response:
    state.reset_progress(viewer.user_id, media_id)
    return Response(status_code=204)


@router.post("/media/{media_id}/natural-end", status_code=204)
def settle_natural_end(media_id: UUID, body: wire.NaturalEndIn, viewer: ViewerDep) -> Response:
    state.settle_natural_end(viewer.user_id, media_id, body)
    return Response(status_code=204)
