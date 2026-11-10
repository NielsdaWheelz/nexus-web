"""Podcast-specific directory episode resolution and playback defaults."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession, RepeatableReadDbSession
from nexus.responses import Data
from nexus.schemas import podcast as wire
from nexus.services.podcasts import catalog, settings

router = APIRouter(tags=["podcasts"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/podcast-episodes/resolve")
def resolve_podcast_episode(
    body: wire.PodcastResolveRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastEpisodeResolveOut]:
    return Data(data=catalog.resolve_episode(db, viewer.user_id, body))


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
