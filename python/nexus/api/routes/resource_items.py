"""Resource-item routes: parse the ref, delegate, envelope the result.

The static paths are registered before ``/{resource_ref}…`` so the ref parameter does
not swallow them.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas.resource_items import (
    ResourceActionsOut,
    ResourceBodyMutationOut,
    ResourceBodyMutationRequest,
    ResourceItemOut,
    ResourceSurfaceCommandOut,
    ResourceSurfaceCommandRequest,
    ResourceSurfaceOut,
    ResourceTitleMutationOut,
    ResourceTitleMutationRequest,
)
from nexus.schemas.resource_search import (
    ResourceOpenableSearchRequest,
    ResourceOpenableSearchResponse,
    ResourceTargetSearchRequest,
    ResourceTargetSearchResponse,
)
from nexus.services.resource_graph.refs import (
    ResourceRef,
    ResourceRefParseFailure,
    parse_resource_ref,
)
from nexus.services.resource_items import actions, items, mutations, surfaces
from nexus.services.search import pickers

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


@router.post("/targets/search")
def search_resource_targets(
    request: ResourceTargetSearchRequest, viewer: ViewerDep, db: DbSession
) -> Data[ResourceTargetSearchResponse]:
    return Data(data=pickers.search_targets(db, viewer_id=viewer.user_id, request=request))


@router.post("/openables/search")
def search_openable_resources(
    request: ResourceOpenableSearchRequest, viewer: ViewerDep, db: DbSession
) -> Data[ResourceOpenableSearchResponse]:
    return Data(data=pickers.search_openables(db, viewer_id=viewer.user_id, request=request))


@router.get("/{resource_ref}")
def get_resource_item(resource_ref: str, viewer: ViewerDep, db: DbSession) -> Data[ResourceItemOut]:
    """An invisible ref answers 200 with ``missing: true``."""
    ref = _parse_ref(resource_ref)
    return Data(data=items.resource_item_out(db, viewer_id=viewer.user_id, ref=ref))


@router.get("/{resource_ref}/actions")
def get_resource_actions(
    resource_ref: str, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ResourceActionsOut]:
    """The viewer's verbs on one ref now; an invisible ref has none."""
    ref = _parse_ref(resource_ref)
    return Data(data=actions.resource_actions(db, viewer_id=viewer.user_id, ref=ref))


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
) -> Data[ResourceBodyMutationOut]:
    return Data(
        data=mutations.update_body(
            db, viewer_id=viewer.user_id, ref=_parse_ref(resource_ref), request=request
        ),
    )
