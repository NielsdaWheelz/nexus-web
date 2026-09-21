"""Trusted activity-ingress and personal-history port for the server-side BFF."""

from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query, Response
from pydantic import AwareDatetime
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_repeatable_read_db
from nexus.errors import InvalidRequestError
from nexus.responses import ok
from nexus.schemas.consumption_activity import (
    ActivityExclusionIn,
    ActivityRecordIn,
    ExcludeActivityIn,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.consumption import stats_read
from nexus.services.consumption.activity_stats import (
    ActivityBucket,
    ActivityQuery,
    resolve_device_handle,
)
from nexus.services.contributor_taxonomy import try_parse_contributor_handle
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

router = APIRouter(tags=["consumption"])


def _media_id(raw: str) -> UUID:
    ref = parse_resource_ref(raw)
    if isinstance(ref, ResourceRefParseFailure) or ref.scheme != "media":
        raise InvalidRequestError(message="Invalid mediaRef")
    return ref.id


def _scoped_query(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    end: Annotated[AwareDatetime, Query()],
    time_zone: Annotated[str, Query(alias="timeZone", min_length=1, max_length=100)],
    current_device_id: Annotated[str, Query(alias="currentDeviceId", min_length=1, max_length=200)],
    start: Annotated[AwareDatetime | None, Query()] = None,
    modality: Annotated[Literal["Reading", "Listening", "Viewing"] | None, Query()] = None,
    media_ref: Annotated[str | None, Query(alias="mediaRef", max_length=100)] = None,
    contributor_handle: Annotated[
        str | None, Query(alias="contributorHandle", max_length=200)
    ] = None,
    device_handle: Annotated[str | None, Query(alias="deviceHandle", max_length=100)] = None,
) -> tuple[ActivityQuery, str]:
    """The filter scope both history reads share, resolved against this viewer."""
    if start is not None and start >= end:
        raise InvalidRequestError(message="Invalid Consumption range")
    try:
        ZoneInfo(time_zone)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise InvalidRequestError(message="Invalid timeZone") from exc
    parsed_contributor = (
        try_parse_contributor_handle(contributor_handle) if contributor_handle else None
    )
    if contributor_handle and parsed_contributor is None:
        raise InvalidRequestError(message="Invalid contributorHandle")
    return ActivityQuery(
        start=start,
        end=end,
        time_zone=time_zone,
        modality=modality,
        media_id=_media_id(media_ref) if media_ref else None,
        contributor_handle=str(parsed_contributor) if parsed_contributor else None,
        device_id=resolve_device_handle(db, viewer_id=viewer.user_id, raw=device_handle),
    ), current_device_id


@router.post("/consumption/activity", status_code=204)
def post_activity(
    body: ActivityRecordIn,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Response:
    """Persist one BFF-injected device-scoped activity batch."""
    consumption_service.record_activity_batch(
        viewer.user_id,
        media_id=_media_id(body.media_ref),
        device_id=body.device_id,
        device_class=body.device_class,
        batch=body.batch,
    )
    return Response(status_code=204)


@router.post("/consumption/activity-exclusions")
def post_activity_exclusion(
    body: ActivityExclusionIn,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    """Exclude one exact observed session or restore its exclusion."""
    result = (
        consumption_service.exclude_activity(
            viewer.user_id, command=body, media_id=_media_id(body.media_ref)
        )
        if isinstance(body, ExcludeActivityIn)
        else consumption_service.restore_activity_exclusion(viewer.user_id, command=body)
    )
    return ok(result, by_alias=True)


@router.get("/consumption/sessions")
def get_sessions(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    scoped: Annotated[tuple[ActivityQuery, str], Depends(_scoped_query)],
    cursor: Annotated[str | None, Query(max_length=4000)] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict:
    query, current_device_id = scoped
    return ok(
        stats_read.activity_sessions(
            db,
            viewer_id=viewer.user_id,
            query=query,
            cursor=cursor,
            limit=limit,
            current_device_id=current_device_id,
        ),
        by_alias=True,
    )


@router.get("/consumption/stats")
def get_stats(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    scoped: Annotated[tuple[ActivityQuery, str], Depends(_scoped_query)],
    bucket: Annotated[ActivityBucket, Query()],
) -> dict:
    query, current_device_id = scoped
    return ok(
        stats_read.consumption_stats(
            db,
            viewer_id=viewer.user_id,
            query=query,
            bucket=bucket,
            current_device_id=current_device_id,
        ),
        by_alias=True,
    )
