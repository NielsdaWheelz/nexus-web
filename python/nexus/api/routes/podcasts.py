"""Podcast subscription, refresh and episode routes."""

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
    PodcastRefreshAcceptedOut,
    PodcastRefreshManualScope,
    PodcastSubscribeRequest,
    PodcastSubscriptionSettingsPatchRequest,
)
from nexus.services.podcasts import episode_acquisition as podcast_episode_acquisition_service
from nexus.services.podcasts import episodes as podcast_episodes_service
from nexus.services.podcasts import refresh as podcast_refresh_service
from nexus.services.podcasts import subscriptions as podcast_subscription_service
from nexus.services.podcasts import subscriptions_query as podcast_subscriptions_query_service

router = APIRouter(tags=["podcasts"])

IdempotencyKey = Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=120)]


def _require_option(value: str, allowed: set[str], message: str) -> str:
    if value not in allowed:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, message)
    return value


@router.post("/podcasts/subscriptions")
def subscribe_to_podcast(
    body: PodcastSubscribeRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: IdempotencyKey,
) -> dict:
    """Subscribe the viewer and enqueue the first sync and history backfill."""
    return ok(
        podcast_subscription_service.subscribe_to_podcast(
            db, viewer.user_id, body, idempotency_key=idempotency_key
        ),
        by_alias=True,
    )


@router.post("/podcast-episodes/from-discovery")
def acquire_podcast_episode(
    body: PodcastEpisodeFromDiscoveryRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: IdempotencyKey,
) -> dict:
    """Acquire one discovered episode without subscribing to its show."""
    return ok(
        podcast_episode_acquisition_service.acquire_episode_from_discovery(
            db, viewer_id=viewer.user_id, body=body, idempotency_key=idempotency_key
        ),
        by_alias=True,
    )


@router.get("/podcasts/subscriptions")
def list_subscriptions(
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List the viewer's followed shows."""
    parsed = parse_collection_query(
        request.query_params.multi_items(),
        domain_keys=frozenset({"sort", "filter", "library_id"}),
    )
    sort = _require_option(
        parsed.parameters.get("sort", "recent_episode"),
        {"recent_episode", "unplayed_count", "alpha"},
        "Invalid podcast subscriptions sort option",
    )
    filter_value = _require_option(
        parsed.parameters.get("filter", "all"),
        {"all", "has_new", "not_in_library"},
        "Invalid podcast subscriptions filter option",
    )
    library_value = parsed.parameters.get("library_id")
    try:
        library_id = UUID(library_value) if library_value is not None else None
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid podcast library scope"
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


@router.get("/podcasts/subscriptions/{podcast_id}")
def get_subscription_status(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Read viewer-visible sync status for one podcast subscription."""
    return ok(podcast_subscription_service.get_subscription_status(db, viewer.user_id, podcast_id))


@router.post("/podcasts/subscriptions/{podcast_id}/backfill/retry")
def retry_subscription_backfill(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: IdempotencyKey,
) -> dict:
    """Restart only a persistently failed historical backfill."""
    return ok(
        podcast_subscription_service.retry_subscription_backfill(
            db, viewer.user_id, podcast_id, idempotency_key=idempotency_key
        ),
        by_alias=True,
    )


@router.patch("/podcasts/subscriptions/{podcast_id}/settings")
def patch_subscription_settings(
    podcast_id: UUID,
    body: PodcastSubscriptionSettingsPatchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Patch per-subscription playback settings for the authenticated viewer."""
    return ok(
        podcast_subscription_service.update_subscription_settings_for_viewer(
            db, viewer.user_id, podcast_id, body
        ),
        by_alias=True,
    )


@router.post("/podcasts/refresh", status_code=202)
def refresh_podcasts(
    body: PodcastRefreshManualScope,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    """Enqueue one sync per in-scope subscription; the panes observe the rows."""
    requested_count = podcast_refresh_service.enqueue_manual_refresh(
        db, viewer_id=viewer.user_id, scope=body
    )
    return JSONResponse(
        status_code=202,
        content=ok(PodcastRefreshAcceptedOut(requested_count=requested_count), by_alias=True),
    )


@router.delete("/podcasts/subscriptions/{podcast_id}")
def unsubscribe_from_podcast(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    idempotency_key: IdempotencyKey,
) -> dict:
    """Unsubscribe the viewer and remove the placements they own."""
    return ok(
        podcast_subscription_service.unsubscribe_from_podcast(
            db, viewer.user_id, podcast_id, idempotency_key=idempotency_key
        ),
        by_alias=True,
    )


@router.get("/podcasts/{podcast_id}")
def get_podcast_detail(
    podcast_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Get podcast detail, even if the viewer is not actively subscribed."""
    return ok(
        podcast_subscriptions_query_service.get_podcast_detail_for_viewer(
            db, viewer.user_id, podcast_id
        )
    )


@router.get("/podcasts/{podcast_id}/episodes")
def list_podcast_episodes(
    podcast_id: UUID,
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_repeatable_read_db)],
) -> dict:
    """List viewer-visible episodes for one podcast."""
    parsed = parse_collection_query(
        request.query_params.multi_items(), domain_keys=frozenset({"state", "sort"})
    )
    state = _require_option(
        parsed.parameters.get("state", "all"),
        {"all", "unplayed", "in_progress", "played"},
        "Invalid podcast episode state",
    )
    sort = _require_option(
        parsed.parameters.get("sort", "newest"),
        {"newest", "oldest", "duration_asc", "duration_desc"},
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
    """Mark every episode in the named state finished."""
    return ok(
        podcast_episodes_service.mark_episode_selection_played(
            db, viewer_id=viewer.user_id, podcast_id=podcast_id, selection=body
        ),
        by_alias=True,
    )
