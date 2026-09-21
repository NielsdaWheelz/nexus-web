"""Deepgram transcription provider behind a narrow port."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.url_normalize import validate_requested_url

logger = get_logger(__name__)

_LISTEN_PATH = "/v1/listen"

TerminalTranscriptionErrorCode = Literal[
    "E_TRANSCRIPT_UNAVAILABLE",
    "E_TRANSCRIPTION_FAILED",
    "E_TRANSCRIPTION_TIMEOUT",
]


@dataclass(frozen=True)
class TranscriptionResult:
    """Provider-owned result for a single transcription attempt."""

    status: Literal["completed", "failed"]
    segments: list[dict[str, Any]] = field(default_factory=list)
    error_code: TerminalTranscriptionErrorCode | None = None
    error_message: str | None = None
    diagnostic_error_code: Literal["E_DIARIZATION_FAILED"] | None = None


class DeepgramClient:
    """Deepgram listen transcription with a non-diarized fallback."""

    def __init__(self, *, api_key: str | None, base_url: str, model: str, timeout_seconds: float):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.timeout_seconds = timeout_seconds

    def transcribe(self, audio_url: str | None) -> TranscriptionResult:
        """Transcribe a remote audio URL, retrying once without diarization."""
        normalized_audio_url = str(audio_url or "").strip()
        try:
            validate_requested_url(normalized_audio_url)
        except InvalidRequestError:
            return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")
        self._require_credentials()

        diarized = self._listen(
            params={"diarize": "true", "utterances": "true"},
            json_body={"url": normalized_audio_url},
        )
        if diarized.status == "completed":
            return diarized
        fallback = self._listen(
            params={"diarize": "false", "utterances": "true"},
            json_body={"url": normalized_audio_url},
        )
        if fallback.status == "completed":
            return TranscriptionResult(
                status="completed",
                segments=fallback.segments,
                diagnostic_error_code=ApiErrorCode.E_DIARIZATION_FAILED.value,
            )
        return fallback

    def transcribe_raw_audio(self, audio_bytes: bytes, content_type: str) -> TranscriptionResult:
        """Transcribe raw audio bytes posted directly as the request body."""
        self._require_credentials()
        return self._listen(params={}, content=audio_bytes, content_type=content_type)

    def _require_credentials(self) -> None:
        if not self.api_key:
            raise RuntimeError("Transcription provider credentials are not configured")

    def _listen(
        self,
        *,
        params: dict[str, str],
        json_body: dict[str, str] | None = None,
        content: bytes | None = None,
        content_type: str = "application/json",
    ) -> TranscriptionResult:
        try:
            response = httpx.post(
                f"{self.base_url.rstrip('/')}{_LISTEN_PATH}",
                headers={
                    "Authorization": f"Token {self.api_key}",
                    "Content-Type": content_type,
                },
                params={
                    "model": self.model,
                    "smart_format": "true",
                    "punctuate": "true",
                    "language": "en",
                    **params,
                },
                json=json_body,
                content=content,
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.TimeoutException:
            return _failure(ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value, "Transcription timed out")
        except httpx.HTTPStatusError as exc:
            logger.warning("deepgram_provider_http_error", status_code=exc.response.status_code)
            return _failure(
                ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value
                if exc.response.status_code in {408, 504}
                else ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
                "Transcription failed",
            )
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("deepgram_provider_request_failed", error=str(exc))
            return _failure(ApiErrorCode.E_TRANSCRIPTION_FAILED.value, "Transcription failed")

        segments = _extract_segments(payload)
        if not segments:
            return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")
        return TranscriptionResult(status="completed", segments=segments)


def get_deepgram_client() -> DeepgramClient:
    settings = get_settings()
    return DeepgramClient(
        api_key=settings.deepgram_api_key,
        base_url=settings.deepgram_base_url,
        model=settings.deepgram_model,
        timeout_seconds=settings.podcast_transcription_timeout_seconds,
    )


def _failure(error_code: TerminalTranscriptionErrorCode, error_message: str) -> TranscriptionResult:
    return TranscriptionResult(status="failed", error_code=error_code, error_message=error_message)


def _extract_segments(payload: Any) -> list[dict[str, Any]]:
    """Prefer diarized utterances, else the first channel's whole transcript."""
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, dict):
        raise ValueError("Deepgram response is missing results")

    segments: list[dict[str, Any]] = []
    for utterance in results.get("utterances") or []:
        if not isinstance(utterance, dict):
            continue
        transcript = str(utterance.get("transcript") or "").strip()
        t_start_ms = _seconds_to_ms(utterance.get("start"))
        t_end_ms = _seconds_to_ms(utterance.get("end"))
        if not transcript or t_start_ms is None or t_end_ms is None:
            continue
        speaker = utterance.get("speaker")
        segments.append(
            {
                "text": transcript,
                "t_start_ms": t_start_ms,
                "t_end_ms": t_end_ms,
                "speaker_label": (str(speaker).strip() or None) if speaker is not None else None,
            }
        )
    if segments:
        return segments

    alternatives = _first_dict(_first_dict(results.get("channels")).get("alternatives"))
    transcript = str(alternatives.get("transcript") or "").strip()
    metadata = payload.get("metadata")
    duration_ms = _seconds_to_ms(metadata.get("duration") if isinstance(metadata, dict) else None)
    if duration_ms is None:
        duration_ms = max(
            (
                end_ms
                for word in alternatives.get("words") or []
                if isinstance(word, dict)
                and (end_ms := _seconds_to_ms(word.get("end"))) is not None
            ),
            default=None,
        )
    if not transcript or duration_ms is None:
        return []
    return [{"text": transcript, "t_start_ms": 0, "t_end_ms": duration_ms, "speaker_label": None}]


def _first_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return {}


def _seconds_to_ms(raw_value: Any) -> int | None:
    try:
        seconds = float(raw_value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return int(round(seconds * 1000))
