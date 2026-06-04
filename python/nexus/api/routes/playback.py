"""Playback queue routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.playback import PlaybackQueueAddRequest, PlaybackQueueOrderRequest
from nexus.services import playback_queue as playback_queue_service

router = APIRouter(tags=["playback"])


@router.get("/playback/queue")
def get_playback_queue(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = playback_queue_service.list_queue_for_viewer(db, viewer.user_id)
    return ok(rows)


@router.post("/playback/queue/items")
def post_playback_queue_items(
    body: PlaybackQueueAddRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = playback_queue_service.add_queue_items_for_viewer(
        db,
        viewer.user_id,
        media_ids=body.media_ids,
        insert_position=body.insert_position,
        current_media_id=body.current_media_id,
    )
    return ok(rows)


@router.delete("/playback/queue/items/{item_id}")
def delete_playback_queue_item(
    item_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = playback_queue_service.remove_queue_item_for_viewer(db, viewer.user_id, item_id)
    return ok(rows)


@router.put("/playback/queue/order")
def put_playback_queue_order(
    body: PlaybackQueueOrderRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = playback_queue_service.reorder_queue_for_viewer(
        db,
        viewer.user_id,
        item_ids=body.item_ids,
    )
    return ok(rows)


@router.post("/playback/queue/clear")
def clear_playback_queue(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = playback_queue_service.clear_queue_for_viewer(db, viewer.user_id)
    return ok(rows)


@router.get("/playback/queue/next")
def get_playback_queue_next(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    current_media_id: Annotated[UUID, Query(description="Currently-playing media ID")],
) -> dict:
    row = playback_queue_service.get_next_queue_item_for_viewer(
        db, viewer.user_id, current_media_id
    )
    payload = row.model_dump(mode="json") if row is not None else None
    return success_response(payload)
