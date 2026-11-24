"""Activity capture, session exclusions and personal history. "This device" is the one the bff
names (``X-Nexus-Device``, I13); no body or query names the caller's device."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from nexus.api.deps import DeviceId
from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas.collection_index import CollectionIndex, parse_index_query
from nexus.schemas.consumption_activity import (
    ActivityRecordIn,
    ExcludeSessionIn,
    RecordOut,
    SittingOut,
    WorkRecordOut,
)
from nexus.services.consumption import activity, stats

router = APIRouter(tags=["consumption"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


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


@router.get("/consumption/record")
def get_record(db: RepeatableReadDbSession, viewer: ViewerDep) -> Data[RecordOut]:
    return Data(data=stats.read_record(db, viewer.user_id))


@router.get("/consumption/works/{media_id}")
def get_work(media_id: UUID, db: RepeatableReadDbSession, viewer: ViewerDep) -> Data[WorkRecordOut]:
    return Data(data=stats.read_work(db, viewer.user_id, media_id))


@router.get("/consumption/sittings")
def get_sittings(
    db: RepeatableReadDbSession,
    viewer: ViewerDep,
    request: Request,
) -> Data[CollectionIndex[SittingOut]]:
    parse_index_query(request.query_params.multi_items(), domain_keys=set())
    return Data(data=stats.sitting_index(db, viewer.user_id))
