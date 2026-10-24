"""Podcast catalog, scoped stopping, independent playback defaults and episode commands."""

from collections.abc import Mapping
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.responses import Data
from nexus.schemas import podcast as wire
from nexus.schemas.collection_page import CollectionPage, parse_collection_query
from nexus.schemas.consumption import ConsumptionData
from nexus.services.consumption import observation
from nexus.services.podcasts import episode_acquisition, episodes, settings, subscriptions, sync
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


@router.post("/podcast-episodes/from-discovery")
def acquire_podcast_episode(
    body: wire.PodcastEpisodeFromDiscoveryRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastEpisodeFromDiscoveryOut]:
    return Data(data=episode_acquisition.acquire_episode(db, viewer.user_id, body))


@router.get("/podcasts")
def list_podcasts(
    request: Request, viewer: ViewerDep, db: RepeatableReadDbSession, response: Response
) -> ConsumptionData[CollectionPage[wire.PodcastListItemOut]]:
    response.headers["Cache-Control"] = "private, no-store"
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
    data = queries.list_podcasts(
        db,
        viewer.user_id,
        limit=query.limit,
        cursor=query.cursor,
        sort=_option(
            query.parameters,
            "sort",
            "recent_episode",
            ("recent_episode", "unplayed_count", "alpha"),
        ),
        filter=_option(query.parameters, "filter", "all", ("all", "has_new", "not_in_library")),
        library_id=library_id,
    )
    return observation.stamp(db, viewer.user_id, data, [])


@router.post("/podcasts/action-facts/resolve")
def resolve_podcast_action_facts(
    body: wire.PodcastActionFactsResolveRequest, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[wire.PodcastActionFactsOut]:
    return Data(data=queries.action_facts(db, viewer_id=viewer.user_id, targets=body.targets))


@router.get("/podcasts/{podcast_id}/removal-preview")
def podcast_removal_preview(
    podcast_id: UUID,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    scope: Literal["all", "library"] = Query(...),
    episodes: Literal["keep", "remove"] = Query(...),
    library_id: UUID | None = None,
) -> Data[wire.PodcastRemovalPreviewOut]:
    return Data(
        data=subscriptions.removal_preview(
            db, viewer.user_id, podcast_id, scope=scope, episodes=episodes, library_id=library_id
        )
    )


@router.post("/podcasts/{podcast_id}/stop")
def stop_podcast(
    podcast_id: UUID, body: wire.PodcastStopRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastStopOut]:
    return Data(data=subscriptions.stop(db, viewer.user_id, podcast_id, body))


@router.get("/podcasts/{podcast_id}/settings")
def get_podcast_settings(
    podcast_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession
) -> Data[wire.PodcastPlaybackSettingsOut]:
    return Data(data=settings.get_settings(db, viewer.user_id, podcast_id))


@router.put("/podcasts/{podcast_id}/settings")
def put_podcast_settings(
    podcast_id: UUID, body: wire.PodcastPlaybackSettingsRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastPlaybackSettingsOut]:
    return Data(data=settings.put_settings(db, viewer.user_id, podcast_id, body))


@router.post("/podcasts/refresh", status_code=202)
def refresh_podcasts(
    body: wire.PodcastRefreshManualScope, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastRefreshAcceptedOut]:
    count = sync.refresh(db, viewer.user_id, body)
    return Data(data=wire.PodcastRefreshAcceptedOut(requested_count=count))


@router.get("/podcasts/{podcast_id}")
def get_podcast_detail(
    podcast_id: UUID, viewer: ViewerDep, db: RepeatableReadDbSession, response: Response
) -> ConsumptionData[wire.PodcastDetailOut]:
    response.headers["Cache-Control"] = "private, no-store"
    return observation.stamp(
        db, viewer.user_id, queries.get_podcast_detail(db, viewer.user_id, podcast_id), []
    )


@router.get("/podcasts/{podcast_id}/episodes")
def list_podcast_episodes(
    podcast_id: UUID,
    request: Request,
    viewer: ViewerDep,
    db: RepeatableReadDbSession,
    response: Response,
) -> ConsumptionData[CollectionPage[wire.PodcastEpisodeListItemOut]]:
    response.headers["Cache-Control"] = "private, no-store"
    query = parse_collection_query(
        request.query_params.multi_items(), domain_keys=frozenset({"state", "sort"})
    )
    data = episodes.list_episodes(
        db,
        viewer.user_id,
        podcast_id,
        limit=query.limit,
        cursor=query.cursor,
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
    return observation.stamp(
        db, viewer.user_id, data, [row.media_summary.media_id for row in data.items]
    )
