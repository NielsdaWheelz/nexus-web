"""Podcast routes: follow, list, detail, episodes, settings, refresh, backlog retry."""

from collections.abc import Mapping
from typing import Annotated, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas import podcast as wire
from nexus.schemas.collection_page import CollectionPage, parse_collection_query
from nexus.services.podcasts import episode_acquisition, episodes, subscriptions, sync
from nexus.services.podcasts import subscriptions_query as queries

router = APIRouter(tags=["podcasts"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


def _option[T: str](
    parameters: Mapping[str, str], name: str, default: T, allowed: tuple[T, ...]
) -> T:
    """The one query-option validator; services trust their Literal arguments."""
    value = parameters.get(name, default)
    if value not in allowed:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid podcast {name}")
    return cast(T, value)


@router.post("/podcasts/subscriptions")
def subscribe_to_podcast(
    body: wire.PodcastSubscribeRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastSubscribeOut]:
    return Data(data=subscriptions.subscribe(db, viewer.user_id, body))


@router.post("/podcast-episodes/from-discovery")
def acquire_podcast_episode(
    body: wire.PodcastEpisodeFromDiscoveryRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastEpisodeFromDiscoveryOut]:
    return Data(data=episode_acquisition.acquire_episode(db, viewer.user_id, body))


@router.get("/podcasts/subscriptions")
def list_subscriptions(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionPage[wire.PodcastSubscriptionListItemOut]]:
    query = parse_collection_query(
        request.query_params.multi_items(), domain_keys=frozenset({"sort", "filter", "library_id"})
    )
    library = query.parameters.get("library_id")
    try:
        library_id = None if library is None else UUID(library)
    except ValueError as exc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Invalid podcast library"
        ) from exc
    return Data(
        data=queries.list_subscriptions(
            db,
            viewer.user_id,
            limit=query.limit,
            cursor=query.cursor,
            revision=query.collection_revision,
            sort=_option(
                query.parameters,
                "sort",
                "recent_episode",
                ("recent_episode", "unplayed_count", "alpha"),
            ),
            filter=_option(query.parameters, "filter", "all", ("all", "has_new", "not_in_library")),
            library_id=library_id,
        )
    )


@router.get("/podcasts/subscriptions/{podcast_id}")
def get_subscription_status(
    podcast_id: UUID, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastSubscriptionStatusOut]:
    return Data(data=subscriptions.get_status(db, viewer.user_id, podcast_id))


@router.post("/podcasts/subscriptions/{podcast_id}/backfill/retry")
def retry_subscription_backfill(
    podcast_id: UUID, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastBackfillRetryOut]:
    return Data(data=subscriptions.retry_backfill(db, viewer.user_id, podcast_id))


@router.patch("/podcasts/subscriptions/{podcast_id}/settings")
def patch_subscription_settings(
    podcast_id: UUID,
    body: wire.PodcastSubscriptionSettingsPatchRequest,
    viewer: ViewerDep,
    db: DbSession,
) -> Data[wire.PodcastSubscriptionStatusOut]:
    return Data(data=subscriptions.patch_settings(db, viewer.user_id, podcast_id, body))


@router.delete("/podcasts/subscriptions/{podcast_id}")
def unsubscribe_from_podcast(
    podcast_id: UUID, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastUnsubscribeOut]:
    return Data(data=subscriptions.unsubscribe(db, viewer.user_id, podcast_id))


@router.post("/podcasts/refresh", status_code=202)
def refresh_podcasts(
    body: wire.PodcastRefreshManualScope, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastRefreshAcceptedOut]:
    count = sync.refresh(db, viewer.user_id, body)
    return Data(data=wire.PodcastRefreshAcceptedOut(requested_count=count))


@router.get("/podcasts/{podcast_id}")
def get_podcast_detail(
    podcast_id: UUID, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastDetailOut]:
    return Data(data=queries.get_podcast_detail(db, viewer.user_id, podcast_id))


@router.get("/podcasts/{podcast_id}/episodes")
def list_podcast_episodes(
    podcast_id: UUID, request: Request, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[CollectionPage[wire.PodcastEpisodeListItemOut]]:
    query = parse_collection_query(
        request.query_params.multi_items(), domain_keys=frozenset({"state", "sort"})
    )
    return Data(
        data=episodes.list_episodes(
            db,
            viewer.user_id,
            podcast_id,
            limit=query.limit,
            cursor=query.cursor,
            revision=query.collection_revision,
            state=_option(
                query.parameters, "state", "all", ("all", "unplayed", "in_progress", "played")
            ),
            sort=_option(
                query.parameters,
                "sort",
                "newest",
                ("newest", "oldest", "duration_asc", "duration_desc"),
            ),
        )
    )


@router.post("/podcasts/{podcast_id}/episodes/mark-played")
def mark_podcast_episode_selection_played(
    podcast_id: UUID, body: wire.PodcastEpisodeSelection, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastEpisodeMarkPlayedOut]:
    return Data(data=episodes.mark_played(db, viewer.user_id, podcast_id, body.state))
