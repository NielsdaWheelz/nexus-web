"""Trusted activity-ingress port for the server-side BFF."""

from datetime import datetime
from typing import Annotated
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_repeatable_read_db
from nexus.errors import InvalidRequestError
from nexus.responses import ok
from nexus.schemas.consumption_activity import ActivityRecordIn
from nexus.services.consumption import _activity_stats
from nexus.services.consumption import service as consumption_service
from nexus.services.contributor_taxonomy import try_parse_contributor_handle
from nexus.services.resource_graph.refs import ResourceRefParseFailure, parse_resource_ref

router = APIRouter(tags=["consumption"])


@router.post("/consumption/activity", status_code=204)
def post_activity(
    body: ActivityRecordIn,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Response:
    """Persist one BFF-injected device-scoped activity batch."""
    consumption_service.record_activity_batch(
        viewer.user_id,
        client_mutation_id=body.client_mutation_id,
        media_id=body.media_id,
        device_id=body.device_id,
        device_class=body.device_class,
        batch=body.batch,
    )
    return Response(status_code=204)


def _activity_query(
    request: Request,
    db: Session,
    viewer_id: UUID,
    *,
    allowed_extra: set[str],
) -> tuple[_activity_stats.ActivityQuery, str]:
    allowed = {
        "start",
        "end",
        "timeZone",
        "modality",
        "mediaRef",
        "contributorHandle",
        "deviceHandle",
        "currentDeviceId",
    } | allowed_extra
    extras = sorted(set(request.query_params) - allowed)
    if extras:
        raise InvalidRequestError(
            message=f"Unsupported Consumption query params: {', '.join(extras)}"
        )
    duplicated = sorted(key for key in allowed if len(request.query_params.getlist(key)) > 1)
    if duplicated:
        raise InvalidRequestError(
            message=f"Duplicate Consumption query params: {', '.join(duplicated)}"
        )
    current_device_id = request.query_params.get("currentDeviceId")
    if current_device_id is None or not 1 <= len(current_device_id.encode("utf-8")) <= 200:
        raise InvalidRequestError(message="Missing currentDeviceId")
    try:
        end = datetime.fromisoformat(request.query_params["end"])
        start = (
            datetime.fromisoformat(request.query_params["start"])
            if "start" in request.query_params
            else None
        )
    except (KeyError, ValueError) as exc:
        raise InvalidRequestError(message="Invalid Consumption range") from exc
    if end.tzinfo is None or (start is not None and (start.tzinfo is None or start >= end)):
        raise InvalidRequestError(message="Invalid Consumption range")
    time_zone = request.query_params.get("timeZone")
    if time_zone is None or not 1 <= len(time_zone) <= 100:
        raise InvalidRequestError(message="Invalid timeZone")
    try:
        ZoneInfo(time_zone)
    except ZoneInfoNotFoundError as exc:
        raise InvalidRequestError(message="Invalid timeZone") from exc
    media = request.query_params.get("mediaRef")
    media_id: UUID | None = None
    if media:
        ref = parse_resource_ref(media)
        if isinstance(ref, ResourceRefParseFailure) or ref.scheme != "media":
            raise InvalidRequestError(message="Invalid mediaRef")
        media_id = ref.id
    modality = request.query_params.get("modality")
    if modality not in (None, "Reading", "Listening", "Viewing"):
        raise InvalidRequestError(message="Invalid modality")
    contributor_handle = request.query_params.get("contributorHandle")
    if contributor_handle is not None:
        parsed_contributor_handle = try_parse_contributor_handle(contributor_handle)
        if parsed_contributor_handle is None:
            raise InvalidRequestError(message="Invalid contributorHandle")
        contributor_handle = str(parsed_contributor_handle)
    return _activity_stats.ActivityQuery(
        start=start,
        end=end,
        time_zone=time_zone,
        modality=modality,
        media_id=media_id,
        contributor_handle=contributor_handle,
        device_id=_activity_stats.resolve_device_handle(
            db, viewer_id=viewer_id, raw=request.query_params.get("deviceHandle")
        ),
    ), current_device_id


@router.get("/consumption/sessions")
def get_sessions(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict:
    query, current_device_id = _activity_query(
        request,
        db,
        viewer.user_id,
        allowed_extra={"cursor", "limit"},
    )
    page = consumption_service.get_activity_sessions(
        db,
        viewer_id=viewer.user_id,
        query=query,
        cursor=request.query_params.get("cursor"),
        limit=limit,
        current_device_id=current_device_id,
    )
    return ok(page, by_alias=True)


@router.get("/consumption/stats")
def get_stats(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    query, current_device_id = _activity_query(
        request,
        db,
        viewer.user_id,
        allowed_extra={"bucket"},
    )
    bucket = request.query_params.get("bucket")
    if bucket not in {"Hour", "Day", "Week", "Month", "Year"}:
        raise InvalidRequestError(message="Invalid bucket")
    stats = consumption_service.get_activity_stats(
        db,
        viewer_id=viewer.user_id,
        query=query,
        bucket=bucket,
        current_device_id=current_device_id,
    )
    return ok(stats, by_alias=True)
