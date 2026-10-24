"""The Lectern, its suggestions and the read-state writes. Transport only: the consumption
services own transactions and fences. Registers before the media router (static
``/media/{id}/<literal>`` paths)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas import collection_actions as collection_wire
from nexus.schemas import consumption as wire
from nexus.schemas.collection_order import OrderRevision
from nexus.schemas.suggestions import (
    QuickReadsOut,
    SuggestionsOut,
    SuggestionStateOut,
    SuggestionViewIn,
    SuggestionViewOut,
)
from nexus.services import suggestion_shortlists, suggestions
from nexus.services.consumption import collections, lectern, observation, state

router = APIRouter(tags=["consumption"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/consumption/collections/prepare")
def prepare_collection_consumption(
    body: collection_wire.CollectionConsumptionPrepareRequest,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
) -> Data[collection_wire.CollectionConsumptionPreparedOut]:
    return Data(data=collections.prepare(db, viewer.user_id, body.selection))


@router.put("/consumption/collections")
def apply_collection_consumption(
    body: collection_wire.CollectionConsumptionRequest, viewer: ViewerDep
) -> Data[collection_wire.CollectionConsumptionOut]:
    return Data(data=collections.apply(viewer.user_id, body))


@router.put("/consumption/collections/undo")
def undo_collection_consumption(
    body: collection_wire.CollectionConsumptionUndoReceipt, viewer: ViewerDep
) -> Data[collection_wire.CollectionConsumptionUndoOut]:
    return Data(data=collections.undo(viewer.user_id, body))


@router.post("/lectern/collections/prepare")
def prepare_collection_lectern(
    body: collection_wire.CollectionLecternPrepareRequest,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
) -> Data[collection_wire.CollectionLecternPreparedOut]:
    return Data(data=lectern.prepare_collection(db, viewer.user_id, body.target))


@router.put("/lectern/collections")
def append_collection_lectern(
    body: collection_wire.CollectionLecternRequest, viewer: ViewerDep
) -> Data[collection_wire.CollectionLecternOut]:
    return Data(data=lectern.append_collection(viewer.user_id, body))


@router.get("/lectern")
def get_lectern(
    viewer: ViewerDep, db: RepeatableReadDbSession, response: Response
) -> wire.ConsumptionData[wire.LecternOut]:
    response.headers["Cache-Control"] = "private, no-store"
    data = lectern.get_lectern(db, viewer.user_id)
    return observation.stamp(
        db, viewer.user_id, data, [row.media_summary.media_id for row in data.items]
    )


@router.put("/lectern/items/{media_id}")
def place_on_lectern(
    media_id: UUID, body: wire.PlaceIn, viewer: ViewerDep
) -> Data[wire.LecternWriteOut]:
    return Data(
        data=lectern.place(
            viewer.user_id, media_id, body.placement, int(body.expected_order_revision)
        )
    )


@router.delete("/lectern/items/{media_id}")
def remove_from_lectern(
    media_id: UUID,
    expected_order_revision: Annotated[OrderRevision, Query()],
    viewer: ViewerDep,
) -> Data[wire.LecternWriteOut]:
    return Data(data=lectern.remove(viewer.user_id, media_id, int(expected_order_revision)))


@router.put("/lectern/items/{media_id}/position")
def move_on_lectern(
    media_id: UUID, body: wire.MoveLecternItemRequest, viewer: ViewerDep
) -> Data[wire.LecternOrderOut]:
    return Data(
        data=lectern.move(
            viewer.user_id, media_id, body.before_media_id, int(body.expected_order_revision)
        )
    )


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
def refresh_lectern_suggestions(viewer: ViewerDep, db: DbSession) -> Data[SuggestionStateOut]:
    return Data(
        data=suggestion_shortlists.request_suggestions_refresh(db, viewer_id=viewer.user_id)
    )


@router.get("/lectern/quick-reads")
def get_quick_reads(viewer: ViewerDep, db: RepeatableReadDbSession) -> Data[QuickReadsOut]:
    return Data(data=suggestions.build_quick_reads(db, viewer_id=viewer.user_id))


@router.post("/media/{media_id}/finish")
def finish(media_id: UUID, body: wire.FinishIn, viewer: ViewerDep) -> Data[wire.Finish]:
    return Data(data=state.finish(viewer.user_id, media_id, body))


@router.post("/media/{media_id}/finish/undo")
def undo_finish(
    media_id: UUID, body: wire.Finish, viewer: ViewerDep
) -> Data[wire.ConsumptionOverrideOut]:
    return Data(data=state.undo_finish(viewer.user_id, media_id, body))


@router.post("/media/{media_id}/unread")
def mark_unread(media_id: UUID, viewer: ViewerDep) -> Data[wire.ConsumptionOverrideOut]:
    return Data(data=state.mark_unread(viewer.user_id, media_id))


@router.post("/media/{media_id}/progress/reset")
def reset_progress(media_id: UUID, viewer: ViewerDep) -> Data[wire.ConsumptionOverrideOut]:
    return Data(data=state.reset_progress(viewer.user_id, media_id))


@router.post("/media/{media_id}/natural-end")
def settle_natural_end(
    media_id: UUID, body: wire.NaturalEndIn, viewer: ViewerDep
) -> Data[wire.EpisodeConsumptionObservation]:
    return Data(data=state.settle_natural_end(viewer.user_id, media_id, body))
