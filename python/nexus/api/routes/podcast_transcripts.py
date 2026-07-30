"""Media transcript routes and Podcast episode batch admission.

Transport-only: validate input, call the transcription service, return the
envelope. The batch/forecast paths own static `/media/transcript/...` prefixes,
so this router must be registered before the `media` router (see create_api_router).
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse, Response
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.responses import ok
from nexus.schemas.media import (
    TranscriptRequestRequest,
)
from nexus.schemas.podcast import (
    PodcastEpisodeQueryTranscriptRequest,
    PodcastEpisodeQueryTranscriptTarget,
)
from nexus.services.podcasts import transcription as transcription_service

router = APIRouter(tags=["media"])


@router.post("/media/transcript/request/batch")
def request_podcast_transcript_batch(
    body: PodcastEpisodeQueryTranscriptRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Admit one fingerprinted Podcast episode-query transcript request."""
    result = transcription_service.request_podcast_episode_query_transcripts(
        db=db,
        viewer_id=viewer.user_id,
        target=body.target,
        expected_fingerprint=body.selection_fingerprint,
    )
    return ok(result, by_alias=True)


@router.post("/media/transcript/forecasts")
def forecast_podcast_transcripts(
    body: PodcastEpisodeQueryTranscriptTarget,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Forecast one server-resolved Podcast episode-query transcript request."""
    result = transcription_service.forecast_podcast_episode_query_transcripts(
        db=db,
        viewer_id=viewer.user_id,
        target=body,
    )
    return ok(result, by_alias=True)


@router.post("/media/{media_id}/transcript/request")
def request_media_transcript(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    body: Annotated[TranscriptRequestRequest | None, Body()] = None,
) -> Response:
    """Admit or forecast an explicit transcript request for supported Media."""
    transcript_request = body if body is not None else TranscriptRequestRequest()
    result = transcription_service.request_media_transcript_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_id=media_id,
        reason=transcript_request.reason,
        dry_run=transcript_request.dry_run,
    )
    return JSONResponse(
        status_code=202 if result.request_enqueued else 200,
        content=ok(result),
    )
