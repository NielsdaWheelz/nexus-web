"""The Lectern, its suggestions and the read-state writes. Transport only: the consumption
services own transactions and fences. Registers before the media router (static
``/media/{id}/<literal>`` paths)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas import consumption as wire
from nexus.schemas.suggestions import QuickReadsOut, SuggestionsOut
from nexus.services import suggestions
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
    return Data(data=suggestions.build_lectern_suggestions(db, viewer_id=viewer.user_id))


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
