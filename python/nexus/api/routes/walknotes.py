"""Walknotes route: voice-note transcription for walk-mode waypoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile
from starlette.concurrency import run_in_threadpool

from nexus.auth.middleware import Viewer, get_viewer
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.services.podcasts.deepgram_adapter import get_deepgram_client

router = APIRouter(tags=["walknotes"])

_MAX_AUDIO_BYTES = 10 * 1024 * 1024


@router.post("/walknotes/transcribe-audio")
async def transcribe_walknote_audio(
    audio: Annotated[UploadFile, File()],
    content_type: Annotated[str, Form()],
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    """10 MB-bounded Deepgram transcription."""
    audio_bytes = await audio.read()
    if len(audio_bytes) > _MAX_AUDIO_BYTES:
        raise ApiError(
            ApiErrorCode.E_FILE_TOO_LARGE,
            f"Audio body exceeds the 10 MB limit ({len(audio_bytes)} bytes received).",
        )

    result = await run_in_threadpool(
        get_deepgram_client().transcribe_raw_audio, audio_bytes, content_type
    )
    if result.status != "completed":
        raise ApiError(
            ApiErrorCode[result.error_code]
            if result.error_code
            else ApiErrorCode.E_TRANSCRIPTION_FAILED,
            result.error_message or "Transcription failed",
        )

    return success_response(
        {
            "transcript": " ".join(seg["text"] for seg in result.segments),
            "duration_ms": result.segments[-1]["t_end_ms"] if result.segments else None,
        }
    )
