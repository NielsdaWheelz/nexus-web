"""Deepgram transcription provider behind a port."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import httpx

from nexus.config import get_settings
from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.url_normalize import validate_requested_url

logger = get_logger(__name__)

_DEEPGRAM_LISTEN_PATH = "/v1/listen"

# Real-media crew-4 transcript fixture size. The same fixture file
# (nasa-hwhap-crew4-transcript.txt) is also size-checked in
# nexus/services/rss_transcript_fetch.py; keep these two in sync if the
# fixture content changes.
_CREW4_FIXTURE_BYTES = 753

TerminalTranscriptionErrorCode = Literal[
    "E_TRANSCRIPT_UNAVAILABLE",
    "E_TRANSCRIPTION_FAILED",
    "E_TRANSCRIPTION_TIMEOUT",
]


@dataclass(frozen=True)
class TranscriptionResult:
    """Provider-owned result for a single podcast transcription attempt."""

    status: Literal["completed", "failed"]
    segments: list[dict[str, Any]] = field(default_factory=list)
    error_code: TerminalTranscriptionErrorCode | None = None
    error_message: str | None = None
    diagnostic_error_code: Literal["E_DIARIZATION_FAILED"] | None = None
    provider_fixture: dict[str, Any] | None = None


class DeepgramClient:
    """Thin client for Deepgram listen transcription with diarization fallback."""

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str,
        model: str,
        timeout_seconds: float,
        use_fixtures: bool,
        fixture_dir: str | None,
    ):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.use_fixtures = use_fixtures
        self.fixture_dir = fixture_dir

    def transcribe(self, audio_url: str | None) -> TranscriptionResult:
        normalized_audio_url = str(audio_url or "").strip()
        if not normalized_audio_url:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
                "Transcript unavailable",
            )

        try:
            validate_requested_url(normalized_audio_url)
        except InvalidRequestError:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
                "Transcript unavailable",
            )

        if self.use_fixtures:
            return self._transcribe_real_media_fixture(normalized_audio_url)

        if not self.api_key:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
                "Transcription provider credentials are not configured",
            )

        diarized_result = self._transcribe_with_deepgram(normalized_audio_url, diarize=True)
        if diarized_result.status == "completed":
            return TranscriptionResult(
                status="completed",
                segments=diarized_result.segments,
                diagnostic_error_code=None,
            )

        fallback_result = self._transcribe_with_deepgram(normalized_audio_url, diarize=False)
        if fallback_result.status == "completed":
            return TranscriptionResult(
                status="completed",
                segments=fallback_result.segments,
                diagnostic_error_code=ApiErrorCode.E_DIARIZATION_FAILED.value,
            )

        return fallback_result

    def transcribe_raw_audio(self, audio_bytes: bytes, content_type: str) -> TranscriptionResult:
        """Transcribe raw audio bytes via Deepgram /v1/listen.

        Posts the bytes directly as the request body with the given Content-Type.
        Uses the same params as the non-diarized URL path (no diarization for short
        clips). No fixture path — callers must mock the adapter in tests.
        """
        if not self.api_key:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
                "Transcription provider credentials are not configured",
            )

        request_url = f"{self.base_url.rstrip('/')}{_DEEPGRAM_LISTEN_PATH}"
        try:
            response = httpx.post(
                request_url,
                headers={
                    "Authorization": f"Token {self.api_key}",
                    "Content-Type": content_type,
                },
                params={
                    "model": self.model,
                    "smart_format": "true",
                    "punctuate": "true",
                    "language": "en",
                },
                content=audio_bytes,
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.TimeoutException:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value,
                "Transcription timed out",
            )
        except httpx.HTTPStatusError as exc:
            code = (
                ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value
                if exc.response.status_code in {408, 504}
                else ApiErrorCode.E_TRANSCRIPTION_FAILED.value
            )
            logger.warning(
                "walknote_transcription_provider_http_error",
                content_type=content_type,
                byte_count=len(audio_bytes),
                status_code=exc.response.status_code,
            )
            return _transcription_failure_result(code, "Transcription failed")
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "walknote_transcription_provider_request_failed",
                content_type=content_type,
                byte_count=len(audio_bytes),
                error=str(exc),
            )
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
                "Transcription failed",
            )

        segments = _extract_deepgram_segments(payload)
        if not segments:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
                "Transcript unavailable",
            )

        return TranscriptionResult(status="completed", segments=segments)

    def _transcribe_real_media_fixture(self, audio_url: str) -> TranscriptionResult:
        expected_url = "https://www.nasa.gov/wp-content/uploads/2023/07/ep239_crew-4.mp3"
        if audio_url != expected_url:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
                f"No real-media podcast transcript fixture for {audio_url}",
            )
        if self.fixture_dir is None:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
                "REAL_MEDIA_FIXTURE_DIR is required for podcast transcript fixtures",
            )

        path = Path(self.fixture_dir) / "nasa-hwhap-crew4-transcript.txt"
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
                f"Podcast transcript fixture unavailable: {exc}",
            )

        payload = content.encode("utf-8")
        if len(payload) != _CREW4_FIXTURE_BYTES:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
                "Podcast transcript fixture size mismatch",
            )

        from nexus.services.rss_transcript_fetch import parse_plain_text_transcript

        segments = parse_plain_text_transcript(content, episode_duration_ms=753_000)
        if not segments:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
                "Podcast transcript fixture had no segments",
            )
        return TranscriptionResult(
            status="completed",
            segments=segments,
            provider_fixture={
                "path": str(path),
                "byte_length": len(payload),
                "audio_url": audio_url,
            },
        )

    def _transcribe_with_deepgram(self, audio_url: str, *, diarize: bool) -> TranscriptionResult:
        request_url = f"{self.base_url.rstrip('/')}{_DEEPGRAM_LISTEN_PATH}"
        diarize_str = "true" if diarize else "false"
        try:
            response = httpx.post(
                request_url,
                headers={
                    "Authorization": f"Token {self.api_key}",
                    "Content-Type": "application/json",
                },
                params={
                    "model": self.model,
                    "diarize": diarize_str,
                    "utterances": "true",
                    "smart_format": "true",
                    "punctuate": "true",
                    "language": "en",
                },
                json={"url": audio_url},
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.TimeoutException:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value,
                "Transcription timed out",
            )
        except httpx.HTTPStatusError as exc:
            code = (
                ApiErrorCode.E_TRANSCRIPTION_TIMEOUT.value
                if exc.response.status_code in {408, 504}
                else ApiErrorCode.E_TRANSCRIPTION_FAILED.value
            )
            logger.warning(
                "podcast_transcription_provider_http_error",
                audio_url=audio_url,
                diarize=diarize,
                status_code=exc.response.status_code,
            )
            return _transcription_failure_result(code, "Transcription failed")
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning(
                "podcast_transcription_provider_request_failed",
                audio_url=audio_url,
                diarize=diarize,
                error=str(exc),
            )
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPTION_FAILED.value,
                "Transcription failed",
            )

        segments = _extract_deepgram_segments(payload)
        if not segments:
            return _transcription_failure_result(
                ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
                "Transcript unavailable",
            )

        return TranscriptionResult(status="completed", segments=segments)


def get_deepgram_client() -> DeepgramClient:
    s = get_settings()
    return DeepgramClient(
        api_key=s.deepgram_api_key,
        base_url=s.deepgram_base_url,
        model=s.deepgram_model,
        timeout_seconds=s.podcast_transcription_timeout_seconds,
        use_fixtures=s.real_media_provider_fixtures,
        fixture_dir=s.real_media_fixture_dir,
    )


def _transcription_failure_result(
    error_code: TerminalTranscriptionErrorCode, error_message: str
) -> TranscriptionResult:
    return TranscriptionResult(
        status="failed",
        error_code=error_code,
        error_message=error_message,
    )


def _extract_deepgram_segments(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    results = payload.get("results")
    if not isinstance(results, dict):
        return []

    utterances = results.get("utterances")
    if isinstance(utterances, list):
        segments: list[dict[str, Any]] = []
        for utterance in utterances:
            if not isinstance(utterance, dict):
                continue
            transcript = str(utterance.get("transcript") or "").strip()
            if not transcript:
                continue
            t_start_ms = _seconds_to_ms(utterance.get("start"))
            t_end_ms = _seconds_to_ms(utterance.get("end"))
            if t_start_ms is None or t_end_ms is None:
                continue
            speaker_value = utterance.get("speaker")
            speaker_label = str(speaker_value).strip() if speaker_value is not None else None
            if speaker_label == "":
                speaker_label = None
            segments.append(
                {
                    "text": transcript,
                    "t_start_ms": t_start_ms,
                    "t_end_ms": t_end_ms,
                    "speaker_label": speaker_label,
                }
            )
        if segments:
            return segments

    channels = results.get("channels")
    if not isinstance(channels, list) or not channels:
        return []
    first_channel = channels[0]
    if not isinstance(first_channel, dict):
        return []
    alternatives = first_channel.get("alternatives")
    if not isinstance(alternatives, list) or not alternatives:
        return []
    first_alt = alternatives[0]
    if not isinstance(first_alt, dict):
        return []

    transcript = str(first_alt.get("transcript") or "").strip()
    duration_seconds = None
    metadata = payload.get("metadata")
    if isinstance(metadata, dict):
        duration_seconds = metadata.get("duration")
    duration_ms = _seconds_to_ms(duration_seconds)
    if duration_ms is None:
        words = first_alt.get("words")
        duration_ms = _word_range_end_ms(words)
    if not transcript or duration_ms is None:
        return []

    return [
        {
            "text": transcript,
            "t_start_ms": 0,
            "t_end_ms": duration_ms,
            "speaker_label": None,
        }
    ]


def _seconds_to_ms(raw_value: Any) -> int | None:
    if raw_value is None:
        return None
    try:
        seconds = float(raw_value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(seconds):
        return None
    if seconds < 0:
        return None
    return int(round(seconds * 1000))


def _word_range_end_ms(raw_words: Any) -> int | None:
    if not isinstance(raw_words, list) or not raw_words:
        return None
    max_end_ms: int | None = None
    for word in raw_words:
        if not isinstance(word, dict):
            continue
        end_ms = _seconds_to_ms(word.get("end"))
        if end_ms is None:
            continue
        if max_end_ms is None or end_ms > max_end_ms:
            max_end_ms = end_ms
    return max_end_ms
