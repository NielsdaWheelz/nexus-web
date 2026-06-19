"""Resource item routes."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok, success_response
from nexus.schemas.resource_items import (
    ResourceBodyMutationRequest,
    ResourceLocatorResolveRequest,
    ResourceLocatorResolveResponse,
    ResourceSurfaceMutationRequest,
    ResourceTitleMutationRequest,
)
from nexus.services.resource_graph import refs as refs_service
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items import locators as locator_service
from nexus.services.resource_items import mutations, surfaces

router = APIRouter(prefix="/resource-items", tags=["resource-items"])


def _parse_ref(raw: str) -> ResourceRef:
    parsed = refs_service.parse_resource_ref(raw)
    if isinstance(parsed, refs_service.ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
        )
    return parsed


@router.post("/resolve")
def resolve_resource_items(
    refs: list[str],
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return success_response(
        {
            "items": [
                surfaces.resource_item_out(db, viewer_id=viewer.user_id, ref=_parse_ref(ref))
                for ref in refs
            ]
        }
    )


@router.post("/locators/resolve")
def resolve_resource_locators(
    request: ResourceLocatorResolveRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        ResourceLocatorResolveResponse(
            resolutions=locator_service.resolve_resource_locators(
                db,
                viewer_id=viewer.user_id,
                locators=request.locators,
            )
        ),
        by_alias=True,
    )


@router.get("/{resource_ref}")
def get_resource_item(
    resource_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        surfaces.resource_item_out(db, viewer_id=viewer.user_id, ref=_parse_ref(resource_ref))
    )


@router.get("/{resource_ref}/surface")
def get_resource_surface(
    resource_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(surfaces.get_surface(db, viewer_id=viewer.user_id, source=_parse_ref(resource_ref)))


@router.put("/{resource_ref}/adjacency")
def replace_resource_surface(
    resource_ref: str,
    request: ResourceSurfaceMutationRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        surfaces.replace_surface(
            db,
            viewer_id=viewer.user_id,
            source=_parse_ref(resource_ref),
            request=request,
        )
    )


@router.patch("/{resource_ref}/title")
def update_resource_title(
    resource_ref: str,
    request: ResourceTitleMutationRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        mutations.update_title(
            db,
            viewer_id=viewer.user_id,
            ref=_parse_ref(resource_ref),
            request=request,
        ),
        by_alias=True,
    )


@router.patch("/{resource_ref}/body")
def update_resource_body(
    resource_ref: str,
    request: ResourceBodyMutationRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        mutations.update_body(
            db,
            viewer_id=viewer.user_id,
            ref=_parse_ref(resource_ref),
            request=request,
        ),
        by_alias=True,
    )
