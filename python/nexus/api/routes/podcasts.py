"""Podcast discovery and subscription routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiErrorCode, ForbiddenError
from nexus.responses import success_response
from nexus.schemas.podcast import PodcastPlanUpdateRequest, PodcastSubscribeRequest
from nexus.services import podcasts as podcast_service

router = APIRouter()


@router.get("/podcasts/discover")
def discover_podcasts(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    q: str = Query(min_length=1),
    limit: int = Query(default=10, ge=1, le=50),
) -> dict:
    """Discover podcasts globally (not library-scoped)."""
    _ = viewer
    rows = podcast_service.discover_podcasts(q, limit=limit)
    return success_response([row.model_dump(mode="json") for row in rows])


@router.post("/podcasts/subscriptions")
def subscribe_to_podcast(
    body: PodcastSubscribeRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Subscribe viewer and enqueue async data-plane podcast sync."""
    out = podcast_service.subscribe_to_podcast(db, viewer.user_id, body)
    return success_response(out.model_dump(mode="json"))


@router.get("/podcasts/subscriptions")
def list_subscriptions(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """List active podcast subscriptions for the viewer."""
    rows = podcast_service.list_subscriptions(db, viewer.user_id, limit=limit, offset=offset)
    return success_response([row.model_dump(mode="json") for row in rows])


@router.get("/podcasts/subscriptions/{podcast_id}")
def get_subscription_status(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Read viewer-visible sync status for one podcast subscription."""
    out = podcast_service.get_subscription_status(db, viewer.user_id, podcast_id)
    return success_response(out.model_dump(mode="json"))


@router.post("/podcasts/subscriptions/{podcast_id}/sync", status_code=202)
def refresh_subscription_sync(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> JSONResponse:
    """Queue a manual subscription sync refresh for the viewer."""
    out = podcast_service.refresh_subscription_sync_for_viewer(
        db,
        viewer_id=viewer.user_id,
        podcast_id=podcast_id,
    )
    return JSONResponse(status_code=202, content=success_response(out.model_dump(mode="json")))


@router.delete("/podcasts/subscriptions/{podcast_id}")
def unsubscribe_from_podcast(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    mode: int = Query(default=1, ge=1, le=3),
) -> dict:
    """Unsubscribe viewer from a podcast with constitution retention mode."""
    out = podcast_service.unsubscribe_from_podcast(
        db,
        viewer.user_id,
        podcast_id,
        mode=mode,
    )
    return success_response(out.model_dump(mode="json"))


@router.get("/podcasts/plan")
def get_podcast_plan_snapshot(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Read the viewer's effective podcast plan and today's quota usage."""
    out = podcast_service.get_user_plan_snapshot(db, viewer.user_id)
    return success_response(out.model_dump(mode="json"))


@router.put("/podcasts/plan")
def update_self_podcast_plan(
    body: PodcastPlanUpdateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Public plan writes are disabled; entitlement updates are internal-only."""
    _ = body, viewer, db
    raise ForbiddenError(
        ApiErrorCode.E_FORBIDDEN,
        "Podcast plan changes are managed by internal billing controls.",
    )


@router.get("/podcasts/{podcast_id}")
def get_podcast_detail(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get podcast detail for the viewer's active subscription."""
    out = podcast_service.get_podcast_detail_for_viewer(db, viewer.user_id, podcast_id)
    return success_response(out.model_dump(mode="json"))


@router.get("/podcasts/{podcast_id}/episodes")
def list_podcast_episodes(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    """List viewer-visible episodes for one subscribed podcast."""
    rows = podcast_service.list_podcast_episodes_for_viewer(
        db,
        viewer.user_id,
        podcast_id,
        limit=limit,
        offset=offset,
    )
    return success_response([row.model_dump(mode="json") for row in rows])
