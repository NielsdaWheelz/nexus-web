"""Walknotes routes: voice note transcription for walk-mode waypoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile
from sqlalchemy.orm import Session

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_db
from nexus.errors import ApiError, ApiErrorCode
from nexus.responses import success_response
from nexus.services.billing_entitlements import get_effective_entitlements
from nexus.services.podcasts.deepgram_adapter import get_deepgram_client

router = APIRouter(tags=["walknotes"])

_MAX_AUDIO_BYTES = 10 * 1024 * 1024  # 10 MB


@router.post("/walknotes/transcribe-audio")
async def transcribe_walknote_audio(
    audio: Annotated[UploadFile, File()],
    content_type: Annotated[str, Form()],
    max_duration_seconds: Annotated[float, Form()],
    viewer: Annotated[Viewer, Depends(get_viewer)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Transcribe a voice note audio blob via Deepgram.

    Entitlement-gated: requires can_transcribe. Rejects audio bodies over 10 MB.
    Returns {transcript, duration_ms} on success or a typed ApiError.
    """
    entitlements = get_effective_entitlements(db, viewer.user_id)
    if not entitlements.can_transcribe:
        raise ApiError(
            ApiErrorCode.E_PODCAST_QUOTA_EXCEEDED,
            "Transcription entitlement required for voice notes.",
        )

    audio_bytes = await audio.read()
    if len(audio_bytes) > _MAX_AUDIO_BYTES:
        raise ApiError(
            ApiErrorCode.E_FILE_TOO_LARGE,
            f"Audio body exceeds the 10 MB limit ({len(audio_bytes)} bytes received).",
        )

    result = get_deepgram_client().transcribe_raw_audio(audio_bytes, content_type)

    if result.status != "completed":
        raise ApiError(
            ApiErrorCode[result.error_code]
            if result.error_code
            else ApiErrorCode.E_TRANSCRIPTION_FAILED,
            result.error_message or "Transcription failed",
        )

    transcript = " ".join(seg["text"] for seg in result.segments)
    duration_ms: int | None = result.segments[-1]["t_end_ms"] if result.segments else None

    return success_response({"transcript": transcript, "duration_ms": duration_ms})
