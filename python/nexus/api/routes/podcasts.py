"""Podcast discovery and subscription routes."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from nexus.api.deps import get_db
from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiErrorCode, ForbiddenError, InvalidRequestError
from nexus.responses import success_response
from nexus.schemas.podcast import (
    PodcastPlanUpdateRequest,
    PodcastSubscribeRequest,
    PodcastSubscriptionCategoryCreateRequest,
    PodcastSubscriptionCategoryOrderRequest,
    PodcastSubscriptionCategoryPatchRequest,
    PodcastSubscriptionSettingsPatchRequest,
)
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
    sort: Literal["recent_episode", "unplayed_count", "alpha"] = Query(default="recent_episode"),
    category_id: str | None = Query(default=None),
) -> dict:
    """List active podcast subscriptions for the viewer."""
    category_filter_id: UUID | None = None
    uncategorized_only = False
    if category_id is not None:
        normalized_category_id = category_id.strip()
        if (
            normalized_category_id
            == podcast_service.PODCAST_SUBSCRIPTION_UNCATEGORIZED_FILTER_TOKEN
        ):
            uncategorized_only = True
        elif normalized_category_id:
            try:
                category_filter_id = UUID(normalized_category_id)
            except ValueError as exc:
                raise InvalidRequestError(
                    ApiErrorCode.E_INVALID_REQUEST,
                    "category_id must be a UUID or 'null'",
                ) from exc
        else:
            raise InvalidRequestError(
                ApiErrorCode.E_INVALID_REQUEST,
                "category_id must be a UUID or 'null'",
            )
    rows = podcast_service.list_subscriptions(
        db,
        viewer.user_id,
        limit=limit,
        offset=offset,
        sort=sort,
        category_id=category_filter_id,
        uncategorized_only=uncategorized_only,
    )
    return success_response([row.model_dump(mode="json") for row in rows])


@router.get("/podcasts/categories")
def list_subscription_categories(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = podcast_service.list_subscription_categories(db, viewer.user_id)
    return success_response([row.model_dump(mode="json") for row in rows])


@router.post("/podcasts/categories")
def create_subscription_category(
    body: PodcastSubscriptionCategoryCreateRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    out = podcast_service.create_subscription_category(db, viewer.user_id, body)
    return success_response(out.model_dump(mode="json"))


@router.patch("/podcasts/categories/{category_id}")
def patch_subscription_category(
    category_id: UUID,
    body: PodcastSubscriptionCategoryPatchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    out = podcast_service.update_subscription_category(
        db,
        viewer.user_id,
        category_id=category_id,
        body=body,
    )
    return success_response(out.model_dump(mode="json"))


@router.delete("/podcasts/categories/{category_id}")
def delete_subscription_category(
    category_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    podcast_service.delete_subscription_category(db, viewer.user_id, category_id)
    return success_response({"category_id": str(category_id), "deleted": True})


@router.put("/podcasts/categories/order")
def reorder_subscription_categories(
    body: PodcastSubscriptionCategoryOrderRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = podcast_service.reorder_subscription_categories(db, viewer.user_id, body)
    return success_response([row.model_dump(mode="json") for row in rows])


@router.post("/podcasts/import/opml")
def import_subscriptions_from_opml(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    file: Annotated[UploadFile, File(...)],
) -> dict:
    """Import podcast subscriptions from an uploaded OPML file."""
    payload = file.file.read()
    out = podcast_service.import_subscriptions_from_opml(
        db,
        viewer.user_id,
        file_name=file.filename,
        content_type=file.content_type,
        payload=payload,
    )
    return success_response(out.model_dump(mode="json"))


@router.get("/podcasts/export/opml")
def export_subscriptions_as_opml(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Export active podcast subscriptions as an OPML file download."""
    opml_bytes = podcast_service.export_subscriptions_as_opml(db, viewer.user_id)
    return Response(
        content=opml_bytes,
        media_type="application/xml",
        headers={"Content-Disposition": 'attachment; filename="nexus-podcasts.opml"'},
    )


@router.get("/podcasts/subscriptions/{podcast_id}")
def get_subscription_status(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Read viewer-visible sync status for one podcast subscription."""
    out = podcast_service.get_subscription_status(db, viewer.user_id, podcast_id)
    return success_response(out.model_dump(mode="json"))


@router.patch("/podcasts/subscriptions/{podcast_id}/settings")
def patch_subscription_settings(
    podcast_id: UUID,
    body: PodcastSubscriptionSettingsPatchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Patch per-subscription playback settings for the authenticated viewer."""
    out = podcast_service.update_subscription_settings_for_viewer(
        db,
        viewer_id=viewer.user_id,
        podcast_id=podcast_id,
        body=body,
    )
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
    state: Literal["all", "unplayed", "in_progress", "played"] = Query(default="all"),
    sort: Literal["newest", "oldest", "duration_asc", "duration_desc"] = Query(default="newest"),
    q: str | None = Query(default=None),
) -> dict:
    """List viewer-visible episodes for one subscribed podcast."""
    rows = podcast_service.list_podcast_episodes_for_viewer(
        db,
        viewer.user_id,
        podcast_id,
        limit=limit,
        offset=offset,
        state=state,
        sort=sort,
        q=q,
    )
    return success_response([row.model_dump(mode="json") for row in rows])
