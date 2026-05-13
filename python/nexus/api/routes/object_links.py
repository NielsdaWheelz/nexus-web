"""Universal object-link routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.schemas.notes import (
    OBJECT_TYPE_VALUES,
    CreateObjectLinkRequest,
    ObjectRef,
    UpdateObjectLinkRequest,
)
from nexus.services import object_links as object_links_service

router = APIRouter(prefix="/object-links", tags=["object-links"])


def _object_ref_or_400(
    object_type: str | None, object_id: UUID | None, name: str
) -> ObjectRef | None:
    if object_type is None and object_id is None:
        return None
    if object_type is None or object_id is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"{name}_type and {name}_id must be paired")
    if object_type not in OBJECT_TYPE_VALUES:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"{name}_type is invalid")
    return ObjectRef.model_validate({"object_type": object_type, "object_id": object_id})


@router.get("")
def list_object_links(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    object_type: Annotated[str | None, Query()] = None,
    object_id: Annotated[UUID | None, Query()] = None,
    a_type: Annotated[str | None, Query()] = None,
    a_id: Annotated[UUID | None, Query()] = None,
    b_type: Annotated[str | None, Query()] = None,
    b_id: Annotated[UUID | None, Query()] = None,
    relation_type: Annotated[str | None, Query()] = None,
) -> dict:
    links = object_links_service.list_object_links(
        db,
        viewer.user_id,
        _object_ref_or_400(object_type, object_id, "object"),
        _object_ref_or_400(a_type, a_id, "a"),
        _object_ref_or_400(b_type, b_id, "b"),
        relation_type,
    )
    return success_response(
        {"links": [link.model_dump(mode="json", by_alias=True) for link in links]}
    )


@router.post("", status_code=201)
def create_object_link(
    request: CreateObjectLinkRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    link = object_links_service.create_object_link(db, viewer.user_id, request)
    return success_response(link.model_dump(mode="json", by_alias=True))


@router.patch("/{link_id}")
def update_object_link(
    link_id: UUID,
    request: UpdateObjectLinkRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    link = object_links_service.update_object_link(db, viewer.user_id, link_id, request)
    return success_response(link.model_dump(mode="json", by_alias=True))


@router.delete("/{link_id}", status_code=204)
def delete_object_link(
    link_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    object_links_service.delete_object_link(db, viewer.user_id, link_id)
    return Response(status_code=204)
