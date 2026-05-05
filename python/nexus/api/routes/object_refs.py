"""Universal object-ref routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.schemas.notes import OBJECT_TYPE_VALUES, ObjectRef
from nexus.services.object_refs import hydrate_object_ref, search_object_refs

router = APIRouter(prefix="/object-refs", tags=["object-refs"])


@router.get("/resolve")
def resolve_object_refs(
    refs: Annotated[list[str], Query(alias="ref")],
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    objects = []
    for raw in refs:
        object_type, separator, object_id_raw = raw.partition(":")
        if not separator:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "ref must be type:id")
        try:
            object_id = UUID(object_id_raw)
        except ValueError:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "ref id must be a UUID") from None
        if object_type not in OBJECT_TYPE_VALUES:
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "ref type is invalid")
        hydrated = hydrate_object_ref(
            db,
            viewer.user_id,
            ObjectRef.model_validate({"object_type": object_type, "object_id": object_id}),
        )
        objects.append(hydrated.model_dump(mode="json", by_alias=True))
    return success_response({"objects": objects})


@router.get("/search")
def search_object_ref_targets(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(default=8, ge=1, le=20),
) -> dict:
    objects = search_object_refs(db, viewer.user_id, q, limit=limit)
    return success_response(
        {"objects": [item.model_dump(mode="json", by_alias=True) for item in objects]}
    )
