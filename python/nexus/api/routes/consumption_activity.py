"""Activity capture, session exclusions and personal history. "This device" is the one the bff
names (``X-Nexus-Device``, I13); no body or query names the caller's device."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response

from nexus.api.deps import DeviceId
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.consumption_activity import (
    ActivityModality,
    ActivityRecordIn,
    ActivitySessionPageOut,
    ConsumptionDate,
    ConsumptionStatsOut,
    ExcludeSessionIn,
)
from nexus.services.consumption import activity, stats

router = APIRouter(tags=["consumption"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


def _scope(
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    end: Annotated[ConsumptionDate, Query()],
    time_zone: Annotated[str, Query(min_length=1, max_length=100)],
    current_device_id: DeviceId,
    start: Annotated[ConsumptionDate | None, Query()] = None,
    modality: Annotated[ActivityModality | None, Query()] = None,
    media_id: Annotated[UUID | None, Query()] = None,
    contributor_handle: Annotated[str | None, Query(max_length=200)] = None,
    device_id: Annotated[str | None, Query(max_length=200)] = None,
) -> stats.Scope:
    return stats.resolve_scope(
        db,
        viewer_id=viewer.user_id,
        start=start,
        end=end,
        time_zone=time_zone,
        current_device_id=current_device_id,
        modality=modality,
        media_id=media_id,
        contributor_handle=contributor_handle,
        device_id=device_id,
    )


@router.post("/consumption/activity", status_code=204)
def post_activity(body: ActivityRecordIn, device_id: DeviceId, viewer: ViewerDep) -> Response:
    activity.record(viewer.user_id, device_id, body)
    return Response(status_code=204)


@router.put("/consumption/exclusions/{exclusion_id}", status_code=204)
def exclude_session(exclusion_id: UUID, body: ExcludeSessionIn, viewer: ViewerDep) -> Response:
    activity.exclude(viewer.user_id, exclusion_id, body)
    return Response(status_code=204)


@router.delete("/consumption/exclusions/{exclusion_id}", status_code=204)
def restore_session(exclusion_id: UUID, viewer: ViewerDep) -> Response:
    activity.restore(viewer.user_id, exclusion_id)
    return Response(status_code=204)


@router.get("/consumption/stats")
def get_stats(
    db: RepeatableReadDbSession,
    scope: Annotated[stats.Scope, Depends(_scope)],
    bucket: Annotated[stats.Bucket, Query()],
) -> Data[ConsumptionStatsOut]:
    return Data(data=stats.consumption_stats(db, scope, bucket))


@router.get("/consumption/sessions")
def get_sessions(
    db: RepeatableReadDbSession,
    scope: Annotated[stats.Scope, Depends(_scope)],
    cursor: Annotated[str | None, Query(max_length=4000)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> Data[ActivitySessionPageOut]:
    return Data(data=stats.session_page(db, scope, cursor=cursor, limit=limit))
