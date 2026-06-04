"""Podcast discovery and subscription routes."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.podcast import (
    PodcastEnsureRequest,
    PodcastOpmlImportRequest,
    PodcastSubscribeRequest,
    PodcastSubscriptionSettingsPatchRequest,
)
from nexus.services import library_entries
from nexus.services.podcasts import discovery as podcast_discovery_service
from nexus.services.podcasts import episodes as podcast_episodes_service
from nexus.services.podcasts import identity as podcast_identity_service
from nexus.services.podcasts import poll as podcast_sync_service
from nexus.services.podcasts import subscriptions as podcast_subscription_service
from nexus.services.podcasts import subscriptions_query as podcast_subscriptions_query_service

router = APIRouter(tags=["podcasts"])


@router.get("/podcasts/discover")
def discover_podcasts(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    q: str = Query(min_length=1),
    limit: int = Query(default=10, ge=1, le=50),
) -> dict:
    """Discover podcasts globally (not library-scoped)."""
    _ = viewer
    rows = podcast_discovery_service.discover_podcasts(db, q, limit=limit)
    return ok(rows)


@router.post("/podcasts/ensure")
def ensure_podcast(
    body: PodcastEnsureRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Ensure one discovered podcast exists locally and return its local id."""
    _ = viewer
    out = podcast_identity_service.ensure_podcast(db, body)
    return ok(out)


@router.post("/podcasts/subscriptions")
def subscribe_to_podcast(
    body: PodcastSubscribeRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Subscribe viewer and enqueue async data-plane podcast sync."""
    out = podcast_subscription_service.subscribe_to_podcast(db, viewer.user_id, body)
    return ok(out)


@router.get("/podcasts/subscriptions")
def list_subscriptions(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
    sort: Annotated[
        Literal["recent_episode", "unplayed_count", "alpha"],
        Query(),
    ] = "recent_episode",
    q: Annotated[str | None, Query()] = None,
    filter: Annotated[
        Literal["all", "has_new", "not_in_library"],
        Query(),
    ] = "all",
    library_id: Annotated[UUID | None, Query()] = None,
) -> dict:
    """List active podcast subscriptions for the viewer."""
    rows = podcast_subscriptions_query_service.list_subscriptions(
        db,
        viewer.user_id,
        limit=limit,
        offset=offset,
        sort=sort,
        q=q,
        filter=filter,
        library_id=library_id,
    )
    return ok(rows)


@router.post("/podcasts/import/opml")
def import_subscriptions_from_opml(
    body: PodcastOpmlImportRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Import podcast subscriptions from a JSON OPML payload."""
    out = podcast_subscription_service.import_subscriptions_from_opml(
        db,
        viewer.user_id,
        opml_xml=body.opml,
        default_library_ids=body.default_library_ids,
        per_feed_library_ids=body.per_feed_library_ids,
    )
    return ok(out)


@router.get("/podcasts/export/opml")
def export_subscriptions_as_opml(
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Export active podcast subscriptions as an OPML file download."""
    opml_bytes = podcast_subscription_service.export_subscriptions_as_opml(db, viewer.user_id)
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
    out = podcast_subscription_service.get_subscription_status(db, viewer.user_id, podcast_id)
    return ok(out)


@router.get("/podcasts/{podcast_id}/libraries")
def get_podcast_libraries(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    rows = library_entries.list_item_libraries(
        db, viewer_id=viewer.user_id, target=library_entries.podcast_target(podcast_id)
    )
    return ok(rows)


@router.patch("/podcasts/subscriptions/{podcast_id}/settings")
def patch_subscription_settings(
    podcast_id: UUID,
    body: PodcastSubscriptionSettingsPatchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Patch per-subscription playback settings for the authenticated viewer."""
    out = podcast_subscription_service.update_subscription_settings_for_viewer(
        db,
        viewer_id=viewer.user_id,
        podcast_id=podcast_id,
        body=body,
    )
    return ok(out)


@router.post("/podcasts/subscriptions/{podcast_id}/sync", status_code=202)
def refresh_subscription_sync(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Queue a manual subscription sync refresh for the viewer."""
    out = podcast_sync_service.refresh_subscription_sync_for_viewer(
        db,
        viewer_id=viewer.user_id,
        podcast_id=podcast_id,
    )
    return JSONResponse(status_code=202, content=ok(out))


@router.delete("/podcasts/subscriptions/{podcast_id}")
def unsubscribe_from_podcast(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Unsubscribe viewer and remove removable podcast library entries."""
    out = podcast_subscription_service.unsubscribe_from_podcast(
        db,
        viewer.user_id,
        podcast_id,
    )
    return ok(out)


@router.get("/podcasts/{podcast_id}")
def get_podcast_detail(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get podcast detail, even if the viewer is not actively subscribed."""
    out = podcast_subscriptions_query_service.get_podcast_detail_for_viewer(
        db, viewer.user_id, podcast_id
    )
    return ok(out)


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
    """List viewer-visible episodes for one podcast."""
    rows = podcast_episodes_service.list_podcast_episodes_for_viewer(
        db,
        viewer.user_id,
        podcast_id,
        limit=limit,
        offset=offset,
        state=state,
        sort=sort,
        q=q,
    )
    return ok(rows)
