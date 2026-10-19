"""Resource-item routes: parse the ref, delegate, envelope the result.

The static paths are registered before ``/{resource_ref}…`` so the ref parameter does
not swallow them.
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.resource_items import (
    ResolveSourceTargetRequest,
    ResourceActionsOut,
    ResourceItemOut,
    SourceTargetOut,
)
from nexus.schemas.resource_search import (
    ResourceTargetSearchRequest,
    ResourceTargetSearchResponse,
)
from nexus.services.resource_graph.refs import require_ref
from nexus.services.resource_items import actions, evidence, items
from nexus.services.search import pickers

ViewerDep = Annotated[Viewer, Depends(get_viewer)]

router = APIRouter(prefix="/resource-items", tags=["resource-items"])


@router.post("/targets/search")
def search_resource_targets(
    request: ResourceTargetSearchRequest, viewer: ViewerDep, db: DbSession
) -> Data[ResourceTargetSearchResponse]:
    return Data(data=pickers.search_targets(db, viewer_id=viewer.user_id, request=request))


@router.post("/source-targets/resolve")
def resolve_source_target(
    request: ResolveSourceTargetRequest, viewer: ViewerDep, db: DbSession
) -> Data[SourceTargetOut]:
    return Data(
        data=evidence.resolve_source_target(db, viewer_id=viewer.user_id, target=request.target)
    )


@router.get("/{resource_ref}")
def get_resource_item(resource_ref: str, viewer: ViewerDep, db: DbSession) -> Data[ResourceItemOut]:
    """An invisible ref answers 200 with ``missing: true``."""
    ref = require_ref(resource_ref)
    return Data(data=items.resource_item_out(db, viewer_id=viewer.user_id, ref=ref))


@router.get("/{resource_ref}/actions")
def get_resource_actions(
    resource_ref: str, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ResourceActionsOut]:
    """The viewer's verbs on one ref now; an invisible ref has none."""
    ref = require_ref(resource_ref)
    return Data(data=actions.resource_actions(db, viewer_id=viewer.user_id, ref=ref))
