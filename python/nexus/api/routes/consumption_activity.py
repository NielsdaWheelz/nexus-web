"""Activity exclusions and personal history; "this device" is the one the bff names
(``X-Nexus-Device``). Capture lives with the player routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from nexus.api.deps import DeviceId
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.errors import InvalidRequestError
from nexus.responses import Data
from nexus.schemas.consumption import ActivityModality
from nexus.schemas.consumption_activity import (
    ActivityExclusionIn,
    ActivityExclusionResultOut,
    ActivitySessionPageOut,
    ConsumptionDate,
    ConsumptionStatsOut,
    ExcludeActivityIn,
)
from nexus.services.consumption import exclusions, stats
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

router = APIRouter(tags=["consumption"])


def _media_id(raw: str) -> UUID:
    ref = parse_resource_ref(raw)
    if isinstance(ref, ResourceRefParseFailure) or ref.scheme != "media":
        raise InvalidRequestError(message="Invalid media_ref")
    return ref.id


def _scope(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: RepeatableReadDbSession,
    end: Annotated[ConsumptionDate, Query()],
    time_zone: Annotated[str, Query(min_length=1, max_length=100)],
    current_device_id: DeviceId,
    start: Annotated[ConsumptionDate | None, Query()] = None,
    modality: Annotated[ActivityModality | None, Query()] = None,
    media_ref: Annotated[str | None, Query(max_length=100)] = None,
    contributor_handle: Annotated[str | None, Query(max_length=200)] = None,
    device_handle: Annotated[str | None, Query(max_length=100)] = None,
) -> stats.Scope:
    return stats.resolve_scope(
        db,
        viewer_id=viewer.user_id,
        start=start,
        end=end,
        time_zone=time_zone,
        current_device_id=current_device_id,
        modality=modality,
        media_id=_media_id(media_ref) if media_ref else None,
        contributor_handle=contributor_handle,
        device_handle=device_handle,
    )


@router.post("/consumption/activity-exclusions")
def post_activity_exclusion(
    body: ActivityExclusionIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Data[ActivityExclusionResultOut]:
    if isinstance(body, ExcludeActivityIn):
        return Data(
            data=exclusions.exclude(
                viewer.user_id, command=body, media_id=_media_id(body.media_ref)
            )
        )
    return Data(data=exclusions.restore(viewer.user_id, command=body))


@router.get("/consumption/sessions")
def get_sessions(
    db: RepeatableReadDbSession,
    scope: Annotated[stats.Scope, Depends(_scope)],
    cursor: Annotated[str | None, Query(max_length=4000)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> Data[ActivitySessionPageOut]:
    return Data(data=stats.session_page(db, scope, cursor=cursor, limit=limit))


@router.get("/consumption/stats")
def get_stats(
    db: RepeatableReadDbSession,
    scope: Annotated[stats.Scope, Depends(_scope)],
    bucket: Annotated[stats.Bucket, Query()],
) -> Data[ConsumptionStatsOut]:
    return Data(data=stats.consumption_stats(db, scope, bucket))
