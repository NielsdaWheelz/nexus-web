"""Resource item routes."""

import time
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok, success_response
from nexus.schemas.resource_action_snapshots import ResourceActionSnapshotResolveRequest
from nexus.schemas.resource_items import (
    ResourceBodyMutationRequest,
    ResourceLocatorResolveRequest,
    ResourceLocatorResolveResponse,
    ResourceSurfaceCommandRequest,
    ResourceTitleMutationRequest,
)
from nexus.schemas.resource_openables import ResourceOpenableSearchRequest
from nexus.schemas.resource_targets import ResourceTargetSearchRequest
from nexus.services.resource_graph import refs as refs_service
from nexus.services.resource_graph.refs import ResourceRef
from nexus.services.resource_items import action_snapshots, mutations, openables, surfaces, targets
from nexus.services.resource_items import locators as locator_service

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
                surfaces.resource_item_out(
                    db, viewer_id=viewer.user_id, ref=_parse_ref(ref)
                ).model_dump(mode="json", by_alias=True)
                for ref in refs
            ]
        }
    )


@router.post("/action-snapshots/resolve")
def resolve_action_snapshots(
    request: ResourceActionSnapshotResolveRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Resolve one action-facts snapshot per ref (order preserved; missing kept).

    Request validation (1..100, unique, parseable) lives in the request model and
    raises ``E_INVALID_REQUEST``. Reads are set-based; see ``action_snapshots``.
    """
    return ok(
        action_snapshots.resolve_action_snapshots(
            db,
            viewer_id=viewer.user_id,
            refs=[_parse_ref(raw) for raw in request.refs],
        ),
        by_alias=True,
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


@router.post("/targets/search")
def search_resource_targets(
    request: ResourceTargetSearchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        targets.search_targets(db, viewer_id=viewer.user_id, request=request),
        by_alias=True,
    )


@router.post("/openables/search")
def search_openable_resources(
    request: ResourceOpenableSearchRequest,
    response: Response,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    started_at = time.monotonic()
    result = openables.search_openable_resources(
        db,
        viewer_id=viewer.user_id,
        request=request,
    )
    duration_ms = (time.monotonic() - started_at) * 1000
    response.headers.append("Server-Timing", f"nexus_openables;dur={duration_ms:.2f}")
    return ok(result, by_alias=True)


@router.get("/{resource_ref}")
def get_resource_item(
    resource_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        surfaces.resource_item_out(db, viewer_id=viewer.user_id, ref=_parse_ref(resource_ref)),
        by_alias=True,
    )


@router.get("/{resource_ref}/surface")
def get_resource_surface(
    resource_ref: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        surfaces.get_surface(db, viewer_id=viewer.user_id, source=_parse_ref(resource_ref)),
        by_alias=True,
    )


@router.post("/{resource_ref}/surface/commands")
def execute_resource_surface_command(
    resource_ref: str,
    request: ResourceSurfaceCommandRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    return ok(
        surfaces.execute_surface_command(
            db,
            viewer_id=viewer.user_id,
            source=_parse_ref(resource_ref),
            request=request,
        ),
        by_alias=True,
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
