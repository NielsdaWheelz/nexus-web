"""Pinned knowledge-object navigation routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok, success_response
from nexus.schemas.resource_items import (
    CreatePinnedObjectRefRequest,
    ObjectRef,
    UpdatePinnedObjectRefRequest,
)
from nexus.services.pinned_objects import (
    PinObjectRefInput,
    UpdatePinnedObjectRefPatch,
    list_pinned_object_refs,
    pin_object_ref,
    unpin_object_ref,
    update_pinned_object_ref,
)

router = APIRouter(prefix="/pinned-objects", tags=["pinned-objects"])


@router.get("")
def list_pinned_objects(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    surface_key: str = Query("navbar", min_length=1, max_length=64),
) -> dict:
    pins = list_pinned_object_refs(db, viewer.user_id, surface_key=surface_key)
    return success_response({"pins": [pin.model_dump(mode="json", by_alias=True) for pin in pins]})


@router.post("", status_code=201)
def create_pinned_object(
    request: CreatePinnedObjectRefRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    pin = pin_object_ref(
        db,
        viewer.user_id,
        PinObjectRefInput(
            object_ref=ObjectRef(object_type=request.object_type, object_id=request.object_id),
            surface_key=request.surface_key,
            order_key=request.order_key,
        ),
    )
    return ok(pin, by_alias=True)


@router.patch("/{pin_id}")
def update_pinned_object(
    pin_id: UUID,
    request: UpdatePinnedObjectRefRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    pin = update_pinned_object_ref(
        db,
        viewer.user_id,
        pin_id,
        UpdatePinnedObjectRefPatch(
            surface_key=request.surface_key,
            order_key=request.order_key,
        ),
    )
    return ok(pin, by_alias=True)


@router.delete("/{pin_id}", status_code=204)
def delete_pinned_object(
    pin_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    unpin_object_ref(db, viewer.user_id, pin_id)
    return Response(status_code=204)
