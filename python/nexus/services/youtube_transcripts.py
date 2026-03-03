"""YouTube transcript provider boundary."""

from __future__ import annotations

from typing import Any

from nexus.errors import ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)


def fetch_youtube_transcript(provider_video_id: str) -> dict[str, Any]:
    """Fetch transcript segments for a YouTube video ID.

    This boundary is intentionally tolerant: provider failures map to stable
    error outcomes and never raise raw provider exceptions into ingest flows.
    """
    video_id = str(provider_video_id or "").strip()
    if not video_id:
        return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except Exception:
        logger.info("youtube_transcript_dependency_missing")
        return _failure(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value, "Transcription provider unavailable"
        )

    try:
        raw_segments = YouTubeTranscriptApi.get_transcript(video_id)
    except Exception as exc:
        class_name = exc.__class__.__name__
        if class_name in {
            "TranscriptsDisabled",
            "NoTranscriptFound",
            "VideoUnavailable",
            "CouldNotRetrieveTranscript",
        }:
            return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")
        if "Timeout" in class_name or "TimedOut" in class_name:
            return _failure(ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value, "Transcription timed out")

        logger.warning(
            "youtube_transcript_provider_error",
            provider_video_id=video_id,
            error_class=class_name,
        )
        return _failure(ApiErrorCode.E_TRANSCRIPTION_FAILED.value, "Transcription failed")

    if not isinstance(raw_segments, list):
        return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")

    segments: list[dict[str, Any]] = []
    for row in raw_segments:
        if not isinstance(row, dict):
            continue
        start_seconds = row.get("start")
        duration_seconds = row.get("duration")
        text_value = row.get("text")
        if start_seconds is None or duration_seconds is None:
            continue
        try:
            start_ms = int(round(float(start_seconds) * 1000))
            duration_ms = int(round(float(duration_seconds) * 1000))
        except (TypeError, ValueError):
            continue
        end_ms = start_ms + duration_ms
        if start_ms < 0 or end_ms <= start_ms:
            continue
        segments.append(
            {
                "t_start_ms": start_ms,
                "t_end_ms": end_ms,
                "text": str(text_value or ""),
                "speaker_label": None,
            }
        )

    if not segments:
        return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")

    return {
        "status": "completed",
        "segments": segments,
    }


def _failure(error_code: str, error_message: str) -> dict[str, Any]:
    return {
        "status": "failed",
        "error_code": error_code,
        "error_message": error_message,
    }
