"""Podcast transcript routes: admit/forecast transcript generation for episodes.

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
    TranscriptForecastBatchRequest,
    TranscriptRequestBatchRequest,
    TranscriptRequestRequest,
)
from nexus.services.podcasts import transcription as podcast_transcript_service

router = APIRouter(tags=["media"])


@router.post("/media/transcript/request/batch")
def request_podcast_transcript_batch(
    body: TranscriptRequestBatchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Admit transcript requests for multiple podcast episodes sequentially."""
    result = podcast_transcript_service.request_podcast_transcripts_batch_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        media_ids=body.media_ids,
        reason=body.reason,
    )
    return ok(result)


@router.post("/media/transcript/forecasts")
def forecast_podcast_transcripts(
    body: TranscriptForecastBatchRequest,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Return dry-run transcript forecasts for many visible podcast episodes."""
    result = podcast_transcript_service.forecast_podcast_transcripts_for_viewer(
        db=db,
        viewer_id=viewer.user_id,
        requests=[(item.media_id, item.reason) for item in body.requests],
    )
    return ok(result)


@router.post("/media/{media_id}/transcript/request")
def request_podcast_transcript(
    media_id: UUID,
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
    body: Annotated[TranscriptRequestRequest | None, Body()] = None,
) -> Response:
    """Admit (or forecast) an explicit transcript request for a podcast episode."""
    transcript_request = body if body is not None else TranscriptRequestRequest()
    result = podcast_transcript_service.request_podcast_transcript_for_viewer(
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
