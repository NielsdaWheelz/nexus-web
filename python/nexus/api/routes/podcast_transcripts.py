"""Media transcript routes and Podcast episode batch admission.

Transport only. The batch and forecast paths own static `/media/transcript/...`
prefixes, so this router is registered before the `media` router.
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import DbSession
from nexus.responses import Data
from nexus.schemas.media import TranscriptRequestOut, TranscriptRequestRequest
from nexus.schemas.podcast import (
    PodcastEpisodeQueryTranscriptForecastOut,
    PodcastEpisodeQueryTranscriptRequest,
    PodcastEpisodeQueryTranscriptRequestOut,
    PodcastEpisodeQueryTranscriptTarget,
)
from nexus.services.podcasts import transcription as transcription_service

router = APIRouter(tags=["media"])


@router.post("/media/transcript/request/batch")
def request_podcast_transcript_batch(
    body: PodcastEpisodeQueryTranscriptRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[PodcastEpisodeQueryTranscriptRequestOut]:
    """Admit one fingerprinted Podcast episode-query transcript request."""
    return Data(
        data=transcription_service.request_podcast_episode_query_transcripts(
            db=db,
            viewer_id=viewer.user_id,
            target=body.target,
            expected_fingerprint=body.selection_fingerprint,
        )
    )


@router.post("/media/transcript/forecasts")
def forecast_podcast_transcripts(
    body: PodcastEpisodeQueryTranscriptTarget,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
) -> Data[PodcastEpisodeQueryTranscriptForecastOut]:
    """Forecast one server-resolved Podcast episode-query transcript request."""
    return Data(
        data=transcription_service.forecast_podcast_episode_query_transcripts(
            db=db, viewer_id=viewer.user_id, target=body
        )
    )


@router.post("/media/{media_id}/transcript/request")
def request_media_transcript(
    media_id: UUID,
    response: Response,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: DbSession,
    body: Annotated[TranscriptRequestRequest | None, Body()] = None,
) -> Data[TranscriptRequestOut]:
    """Admit an explicit transcript request for supported Media; 202 iff it enqueued work."""
    transcript_request = body if body is not None else TranscriptRequestRequest()
    result = transcription_service.request_media_transcript_for_viewer(
        db,
        viewer.user_id,
        media_id,
        reason=transcript_request.reason,
    )
    response.status_code = 202 if result.request_enqueued else 200
    return Data(data=result)
