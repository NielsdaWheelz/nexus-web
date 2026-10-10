"""Transcript requests. The static ``/media/transcript/...`` paths register before ``media``."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas import podcast as wire
from nexus.schemas.media import TranscriptRequestOut, TranscriptRequestRequest
from nexus.services.podcasts import transcription

router = APIRouter(tags=["media"])
ViewerDep = Annotated[Viewer, Depends(get_viewer)]


@router.post("/media/transcript/forecasts")
def forecast_podcast_transcripts(
    body: wire.PodcastEpisodeQueryTranscriptTarget, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastEpisodeQueryTranscriptForecastOut]:
    return Data(data=transcription.forecast(db, viewer.user_id, body))


@router.post("/media/transcript/request/batch")
def request_podcast_transcript_batch(
    body: wire.PodcastEpisodeQueryTranscriptRequest, viewer: ViewerDep, db: DbSession
) -> Data[wire.PodcastEpisodeQueryTranscriptRequestOut]:
    return Data(data=transcription.request_batch(db, viewer.user_id, body))


@router.post("/media/{media_id}/transcript/request")
def request_media_transcript(
    media_id: UUID,
    response: Response,
    viewer: ViewerDep,
    db: DbSession,
    body: Annotated[TranscriptRequestRequest | None, Body()] = None,
) -> Data[TranscriptRequestOut]:
    """202 when it enqueued work, else 200."""
    reason = (body or TranscriptRequestRequest()).reason
    result = transcription.request_transcript(db, viewer.user_id, media_id, reason=reason)
    response.status_code = 202 if result.request_enqueued else 200
    return Data(data=result)
