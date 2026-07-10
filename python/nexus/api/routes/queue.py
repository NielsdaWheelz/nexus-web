"""Unified consumption queue routes (all media kinds)."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.queue import (
    ConsumptionQueueAddRequest,
    ConsumptionQueueKindFilter,
    ConsumptionQueueOrderRequest,
)
from nexus.services import consumption_queue as consumption_queue_service

router = APIRouter(tags=["queue"])


@router.get("/queue")
def get_queue(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    kind_filter: Annotated[ConsumptionQueueKindFilter | None, Query()] = None,
) -> dict:
    rows = consumption_queue_service.list_queue_for_viewer(
        db, viewer.user_id, kind_filter=kind_filter
    )
    return ok(rows)


@router.post("/queue/items")
def post_queue_items(
    body: ConsumptionQueueAddRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = consumption_queue_service.add_queue_items_for_viewer(
        db,
        viewer.user_id,
        media_ids=body.media_ids,
        insert_position=body.insert_position,
        current_media_id=body.current_media_id,
    )
    return ok(rows)


@router.delete("/queue/items/{item_id}")
def delete_queue_item(
    item_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = consumption_queue_service.remove_queue_item_for_viewer(db, viewer.user_id, item_id)
    return ok(rows)


@router.put("/queue/order")
def put_queue_order(
    body: ConsumptionQueueOrderRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = consumption_queue_service.reorder_queue_for_viewer(
        db,
        viewer.user_id,
        item_ids=body.item_ids,
    )
    return ok(rows)


@router.post("/queue/clear")
def clear_queue(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = consumption_queue_service.clear_queue_for_viewer(db, viewer.user_id)
    return ok(rows)


@router.get("/queue/next")
def get_queue_next(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    current_media_id: Annotated[UUID, Query(description="Currently-active media ID")],
    kind: Annotated[ConsumptionQueueKindFilter, Query()] = "audio",
) -> dict:
    row = consumption_queue_service.get_next_queue_item_for_viewer(
        db, viewer.user_id, current_media_id, kind_filter=kind
    )
    payload = row.model_dump(mode="json") if row is not None else None
    return success_response(payload)
