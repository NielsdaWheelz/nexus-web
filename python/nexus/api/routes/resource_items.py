"""Resource-item routes: parse the ref, delegate, envelope the result.

The static paths are registered before ``/{resource_ref}…`` so the ref parameter does
not swallow them.
"""

from datetime import timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from nexus.api.search_operation import run_search_operation
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.reader_excerpts import ExcerptMode
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
from nexus.services.search.policy import FOREGROUND_SEARCH_SECONDS

ViewerDep = Annotated[Viewer, Depends(get_viewer)]

router = APIRouter(prefix="/resource-items", tags=["resource-items"])


@router.post("/targets/search")
async def search_resource_targets(
    request: ResourceTargetSearchRequest, viewer: ViewerDep, http_request: Request
) -> Data[ResourceTargetSearchResponse]:
    result = await run_search_operation(
        http_request,
        phase="picker",
        allowance=timedelta(seconds=FOREGROUND_SEARCH_SECONDS),
        read=lambda deadline: pickers.search_targets(
            viewer_id=viewer.user_id, request=request, deadline=deadline
        ),
    )
    return Data(data=result)


@router.post("/source-targets/resolve")
def resolve_source_target(
    request: ResolveSourceTargetRequest, viewer: ViewerDep, db: DbSession
) -> Data[SourceTargetOut]:
    return Data(
        data=evidence.resolve_source_target(
            db,
            viewer_id=viewer.user_id,
            target=request.target,
            reading_media_id=request.reading_media_id,
        )
    )


@router.get("/{resource_ref}")
def get_resource_item(
    resource_ref: str,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    excerpt_mode: ExcerptMode = "compact",
    reading_media_id: UUID | None = None,
    expected_capture_revision: str | None = None,
) -> Data[ResourceItemOut]:
    """An invisible ref answers 200 with ``missing: true``."""
    ref = require_ref(resource_ref)
    return Data(
        data=items.resource_item_out(
            db,
            viewer_id=viewer.user_id,
            ref=ref,
            excerpt_mode=excerpt_mode,
            reading_media_id=reading_media_id,
            expected_capture_revision=expected_capture_revision,
        )
    )


@router.get("/{resource_ref}/actions")
def get_resource_actions(
    resource_ref: str, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[ResourceActionsOut]:
    """The viewer's verbs on one ref now; an invisible ref has none."""
    ref = require_ref(resource_ref)
    return Data(data=actions.resource_actions(db, viewer_id=viewer.user_id, ref=ref))
