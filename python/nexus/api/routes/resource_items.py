"""Resource-item routes: parse the ref, delegate, envelope camelCase.

The static paths are registered before ``/{resource_ref}/…`` so they are not swallowed
by the ref parameter.
"""

import time
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data, ok
from nexus.schemas.resource_action_snapshots import (
    ResourceActionSnapshotResolveRequest,
    ResourceActionSnapshotResolveResponse,
)
from nexus.schemas.resource_items import (
    ResourceBodyMutationRequest,
    ResourceLocatorResolveRequest,
    ResourceLocatorResolveResponse,
    ResourceSurfaceCommandOut,
    ResourceSurfaceCommandRequest,
    ResourceSurfaceOut,
    ResourceTitleMutationOut,
    ResourceTitleMutationRequest,
)
from nexus.schemas.resource_openables import (
    ResourceOpenableSearchRequest,
    ResourceOpenableSearchResponse,
)
from nexus.schemas.resource_targets import ResourceTargetSearchRequest, ResourceTargetSearchResponse
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_items import action_snapshots, mutations, openables, surfaces, targets
from nexus.services.resource_items import locators as locator_service

ViewerDep = Annotated[Viewer, Depends(get_viewer)]

router = APIRouter(prefix="/resource-items", tags=["resource-items"])


def _parse_ref(raw: str) -> ResourceRef:
    parsed = parse_resource_ref(raw)
    if isinstance(parsed, ResourceRefParseFailure):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid resource ref: {raw!r}. Expected '<scheme>:<uuid>'.",
        )
    return parsed


@router.post("/action-snapshots/resolve")
def resolve_action_snapshots(
    request: ResourceActionSnapshotResolveRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ResourceActionSnapshotResolveResponse]:
    return Data(
        data=action_snapshots.resolve_action_snapshots(
            db, viewer_id=viewer.user_id, refs=[_parse_ref(raw) for raw in request.refs]
        ),
    )


@router.post("/locators/resolve")
def resolve_resource_locators(
    request: ResourceLocatorResolveRequest, viewer: ViewerDep, db: DbSession
) -> Data[ResourceLocatorResolveResponse]:
    return Data(
        data=ResourceLocatorResolveResponse(
            resolutions=locator_service.resolve_resource_locators(
                db, viewer_id=viewer.user_id, locators=request.locators
            )
        ),
    )


@router.post("/targets/search")
def search_resource_targets(
    request: ResourceTargetSearchRequest, viewer: ViewerDep, db: DbSession
) -> Data[ResourceTargetSearchResponse]:
    return Data(data=targets.search_targets(db, viewer_id=viewer.user_id, request=request))


@router.post("/openables/search")
def search_openable_resources(
    request: ResourceOpenableSearchRequest, response: Response, viewer: ViewerDep, db: DbSession
) -> Data[ResourceOpenableSearchResponse]:
    started_at = time.monotonic()
    result = openables.search_openable_resources(db, viewer_id=viewer.user_id, request=request)
    duration_ms = (time.monotonic() - started_at) * 1000
    response.headers.append("Server-Timing", f"nexus_openables;dur={duration_ms:.2f}")
    return Data(data=result)


@router.get("/{resource_ref}/surface")
def get_resource_surface(
    resource_ref: str, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ResourceSurfaceOut]:
    return Data(
        data=surfaces.get_surface(db, viewer_id=viewer.user_id, source=_parse_ref(resource_ref)),
    )


@router.post("/{resource_ref}/surface/commands")
def execute_resource_surface_command(
    resource_ref: str, request: ResourceSurfaceCommandRequest, viewer: ViewerDep, db: DbSession
) -> Data[ResourceSurfaceCommandOut]:
    return Data(
        data=surfaces.execute_surface_command(
            db, viewer_id=viewer.user_id, source=_parse_ref(resource_ref), request=request
        )
    )


@router.patch("/{resource_ref}/title")
def update_resource_title(
    resource_ref: str, request: ResourceTitleMutationRequest, viewer: ViewerDep, db: DbSession
) -> Data[ResourceTitleMutationOut]:
    return Data(
        data=mutations.update_title(
            db, viewer_id=viewer.user_id, ref=_parse_ref(resource_ref), request=request
        )
    )


@router.patch("/{resource_ref}/body")
def update_resource_body(
    resource_ref: str, request: ResourceBodyMutationRequest, viewer: ViewerDep, db: DbSession
) -> dict:
    return ok(
        mutations.update_body(
            db, viewer_id=viewer.user_id, ref=_parse_ref(resource_ref), request=request
        ),
        by_alias=True,
    )
