"""Activity capture, exclusions and personal history; the BFF injects ``deviceId`` and
``currentDeviceId`` from the device cookie."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from pydantic import AwareDatetime
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_repeatable_read_db
from nexus.errors import InvalidRequestError
from nexus.responses import Data
from nexus.schemas.consumption_activity import (
    ActivityExclusionIn,
    ActivityExclusionResultOut,
    ActivityModality,
    ActivityRecordIn,
    ActivitySessionPageOut,
    ConsumptionStatsOut,
    ExcludeActivityIn,
)
from nexus.services.consumption import activity, stats
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

router = APIRouter(tags=["consumption"])


def _media_id(raw: str) -> UUID:
    ref = parse_resource_ref(raw)
    if isinstance(ref, ResourceRefParseFailure) or ref.scheme != "media":
        raise InvalidRequestError(message="Invalid mediaRef")
    return ref.id


def _scope(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    end: Annotated[AwareDatetime, Query()],
    time_zone: Annotated[str, Query(alias="timeZone", min_length=1, max_length=100)],
    current_device_id: Annotated[str, Query(alias="currentDeviceId", min_length=1, max_length=200)],
    start: Annotated[AwareDatetime | None, Query()] = None,
    modality: Annotated[ActivityModality | None, Query()] = None,
    media_ref: Annotated[str | None, Query(alias="mediaRef", max_length=100)] = None,
    contributor_handle: Annotated[
        str | None, Query(alias="contributorHandle", max_length=200)
    ] = None,
    device_handle: Annotated[str | None, Query(alias="deviceHandle", max_length=100)] = None,
) -> stats.Scope:
    scope = stats.Scope(
        viewer_id=viewer.user_id,
        start=start,
        end=end,
        time_zone=time_zone,
        current_device_id=current_device_id,
        modality=modality,
        media_id=_media_id(media_ref) if media_ref else None,
    )
    return stats.resolve_scope(
        db, scope, contributor_handle=contributor_handle, device_handle=device_handle
    )


@router.post("/consumption/activity", status_code=204)
def post_activity(
    body: ActivityRecordIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Response:
    activity.record_batch(
        viewer.user_id,
        media_id=_media_id(body.media_ref),
        device_id=body.device_id,
        device_class=body.device_class,
        batch=body.batch,
    )
    return Response(status_code=204)


@router.post("/consumption/activity-exclusions")
def post_activity_exclusion(
    body: ActivityExclusionIn, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Data[ActivityExclusionResultOut]:
    if isinstance(body, ExcludeActivityIn):
        return Data(
            data=activity.exclude(viewer.user_id, command=body, media_id=_media_id(body.media_ref))
        )
    return Data(data=activity.restore(viewer.user_id, command=body))


@router.get("/consumption/sessions")
def get_sessions(
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    scope: Annotated[stats.Scope, Depends(_scope)],
    cursor: Annotated[str | None, Query(max_length=4000)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> Data[ActivitySessionPageOut]:
    return Data(data=stats.session_page(db, scope, cursor=cursor, limit=limit))


@router.get("/consumption/stats")
def get_stats(
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    scope: Annotated[stats.Scope, Depends(_scope)],
    bucket: Annotated[stats.Bucket, Query()],
) -> Data[ConsumptionStatsOut]:
    return Data(data=stats.consumption_stats(db, scope, bucket))
