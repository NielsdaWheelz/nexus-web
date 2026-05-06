"""YouTube transcript provider boundary."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from nexus.config import get_settings, real_media_provider_fixtures_requested
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

    if real_media_provider_fixtures_requested():
        settings = get_settings()
        if settings.real_media_provider_fixtures:
            return _fetch_real_media_fixture(video_id, settings.real_media_fixture_dir)

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except Exception:
        logger.info("youtube_transcript_dependency_missing")
        return _failure(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value, "Transcription provider unavailable"
        )

    try:
        raw_segments = list(YouTubeTranscriptApi().fetch(video_id))
    except Exception as exc:
        class_name = exc.__class__.__name__
        if class_name in {
            "TranscriptsDisabled",
            "NoTranscriptFound",
            "VideoUnavailable",
            "CouldNotRetrieveTranscript",
            "RequestBlocked",
            "IpBlocked",
            "PoTokenRequired",
            "InvalidVideoId",
            "VideoUnplayable",
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

    segments: list[dict[str, Any]] = []
    for row in raw_segments:
        start_seconds = getattr(row, "start", None)
        duration_seconds = getattr(row, "duration", None)
        text_value = getattr(row, "text", None)
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
    segments.sort(key=lambda segment: int(segment["t_start_ms"]))

    return {
        "status": "completed",
        "segments": segments,
    }


def _fetch_real_media_fixture(video_id: str, fixture_dir: str | None) -> dict[str, Any]:
    if video_id != "drrP_Iss0gA":
        return _failure(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            f"No real-media YouTube transcript fixture for {video_id}",
        )
    if fixture_dir is None:
        return _failure(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            "REAL_MEDIA_FIXTURE_DIR is required for transcript fixtures",
        )

    path = Path(fixture_dir) / "nasa-picturing-earth-behind-scenes-captions.srt"
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        return _failure(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            f"YouTube transcript fixture unavailable: {exc}",
        )

    payload = content.encode("utf-8")
    if len(payload) != 9_805 or hashlib.sha256(payload).hexdigest() != (
        "f2be864a2e42f94e629245a4a46326258ecaaffa64868caf16b46e75b4f7d237"
    ):
        return _failure(
            ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
            "YouTube transcript fixture hash mismatch",
        )

    from nexus.services.rss_transcript_fetch import _parse_srt_transcript

    segments = _parse_srt_transcript(content)
    if not segments:
        return _failure(
            ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
            "YouTube transcript fixture had no segments",
        )
    return {
        "status": "completed",
        "segments": segments,
        "provider_fixture": {
            "path": str(path),
            "byte_length": len(payload),
            "sha256": "f2be864a2e42f94e629245a4a46326258ecaaffa64868caf16b46e75b4f7d237",
            "provider_video_id": video_id,
        },
    }


def _failure(error_code: str, error_message: str) -> dict[str, Any]:
    return {
        "status": "failed",
        "error_code": error_code,
        "error_message": error_message,
    }
