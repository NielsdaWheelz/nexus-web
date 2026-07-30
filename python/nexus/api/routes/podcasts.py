"""Podcast subscription and episode routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db, get_repeatable_read_db
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import ok
from nexus.schemas.collection_page import parse_collection_query
from nexus.schemas.podcast import (
    PodcastEpisodeFromDiscoveryRequest,
    PodcastEpisodeSelection,
    PodcastOpmlImportRequest,
    PodcastSubscribeRequest,
    PodcastSubscriptionSettingsPatchRequest,
)
from nexus.services import library_entries
from nexus.services.podcasts import episode_acquisition as podcast_episode_acquisition_service
from nexus.services.podcasts import episodes as podcast_episodes_service
from nexus.services.podcasts import poll as podcast_sync_service
from nexus.services.podcasts import subscriptions as podcast_subscription_service
from nexus.services.podcasts import subscriptions_query as podcast_subscriptions_query_service

router = APIRouter(tags=["podcasts"])


@router.post("/podcasts/subscriptions")
def subscribe_to_podcast(
    body: PodcastSubscribeRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
) -> dict:
    """Subscribe viewer and enqueue async data-plane podcast sync."""
    out = podcast_subscription_service.subscribe_to_podcast(
        db,
        viewer.user_id,
        body,
        idempotency_key=idempotency_key,
    )
    return ok(out, by_alias=True)


@router.post("/podcast-episodes/from-discovery")
def acquire_podcast_episode(
    body: PodcastEpisodeFromDiscoveryRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
) -> dict:
    out = podcast_episode_acquisition_service.acquire_episode_from_discovery(
        db,
        viewer_id=viewer.user_id,
        body=body,
        idempotency_key=idempotency_key,
    )
    return ok(out, by_alias=True)


@router.get("/podcasts/subscriptions")
def list_subscriptions(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List active podcast subscriptions for the viewer."""
    parsed = parse_collection_query(
        request.query_params.multi_items(),
        domain_keys=frozenset({"sort", "filter", "library_id"}),
    )
    sort = parsed.parameters.get("sort", "recent_episode")
    filter_value = parsed.parameters.get("filter", "all")
    if sort not in {"recent_episode", "unplayed_count", "alpha"}:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast subscriptions sort option",
        )
    if filter_value not in {"all", "has_new", "not_in_library"}:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast subscriptions filter option",
        )
    library_value = parsed.parameters.get("library_id")
    try:
        library_id = UUID(library_value) if library_value is not None else None
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast library scope",
        ) from exc
    page = podcast_subscriptions_query_service.list_subscriptions(
        db,
        viewer.user_id,
        limit=parsed.limit,
        cursor=parsed.cursor,
        collection_revision=parsed.collection_revision,
        sort=sort,  # type: ignore[arg-type]
        filter=filter_value,  # type: ignore[arg-type]
        library_id=library_id,
    )
    return ok(page, by_alias=True)


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


@router.post("/podcasts/subscriptions/{podcast_id}/backfill/retry")
def retry_subscription_backfill(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
) -> dict:
    """Restart only a persistently failed historical backfill."""
    out = podcast_subscription_service.retry_subscription_backfill(
        db,
        viewer.user_id,
        podcast_id,
        idempotency_key=idempotency_key,
    )
    return ok(out, by_alias=True)


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
    return ok(out, by_alias=True)


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
    return JSONResponse(status_code=202, content=ok(out, by_alias=True))


@router.delete("/podcasts/subscriptions/{podcast_id}")
def unsubscribe_from_podcast(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=200)],
) -> dict:
    """Unsubscribe viewer and remove removable podcast library entries."""
    out = podcast_subscription_service.unsubscribe_from_podcast(
        db,
        viewer.user_id,
        podcast_id,
        idempotency_key=idempotency_key,
    )
    return ok(out, by_alias=True)


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
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List viewer-visible episodes for one podcast."""
    parsed = parse_collection_query(
        request.query_params.multi_items(),
        domain_keys=frozenset({"state", "sort"}),
    )
    state = parsed.parameters.get("state", "all")
    sort = parsed.parameters.get("sort", "newest")
    if state not in {"all", "unplayed", "in_progress", "played"}:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast episode state",
        )
    if sort not in {"newest", "oldest", "duration_asc", "duration_desc"}:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Invalid podcast episode sort option",
        )
    page = podcast_episodes_service.list_podcast_episodes_for_viewer(
        db,
        viewer.user_id,
        podcast_id,
        limit=parsed.limit,
        cursor=parsed.cursor,
        collection_revision=parsed.collection_revision,
        state=state,  # type: ignore[arg-type]
        sort=sort,  # type: ignore[arg-type]
    )
    return ok(page, by_alias=True)


@router.post("/podcasts/{podcast_id}/episodes/mark-played")
def mark_podcast_episode_selection_played(
    podcast_id: UUID,
    body: PodcastEpisodeSelection,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    result = podcast_episodes_service.mark_episode_selection_played(
        db,
        viewer_id=viewer.user_id,
        podcast_id=podcast_id,
        selection=body,
    )
    return ok(result, by_alias=True)
