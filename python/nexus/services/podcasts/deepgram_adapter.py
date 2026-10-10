"""Deepgram: transcribe a remote audio url, diarized when it can be."""

import math
from typing import Any

import httpx

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.logging import get_logger
from nexus.services.url_normalize import validate_requested_url

logger = get_logger(__name__)


class DeepgramClient:
    def __init__(self, *, api_key: str | None, base_url: str, model: str, timeout_seconds: float):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds

    def transcribe(
        self, audio_url: str | None, language: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        """Segments plus a diagnostic code (diarization fell back); a terminal failure
        raises E_TRANSCRIPT_UNAVAILABLE, E_TRANSCRIPTION_FAILED or E_TRANSCRIPTION_TIMEOUT."""
        url = (audio_url or "").strip()
        try:
            validate_requested_url(url)
        except InvalidRequestError as exc:
            raise ApiError(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE, "Transcript unavailable") from exc
        if not self.api_key:
            raise RuntimeError("Transcription provider credentials are not configured")
        # Deepgram takes the primary subtag; an episode of unknown language stays English.
        language = (language or "en").split("-")[0]
        try:
            return self._listen(url, language, diarize=True), None
        except ApiError:
            undiarized = self._listen(url, language, diarize=False)
            return undiarized, ApiErrorCode.E_DIARIZATION_FAILED.value

    def _listen(self, url: str, language: str, *, diarize: bool) -> list[dict[str, Any]]:
        try:
            response = httpx.post(
                f"{self.base_url}/v1/listen",
                headers={"Authorization": f"Token {self.api_key}"},
                params={
                    "model": self.model,
                    "smart_format": "true",
                    "punctuate": "true",
                    "language": language,
                    "diarize": str(diarize).lower(),
                    "utterances": "true",
                },
                json={"url": url},
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            segments = _segments(response.json())
        except httpx.TimeoutException as exc:
            raise ApiError(ApiErrorCode.E_TRANSCRIPTION_TIMEOUT, "Transcription timed out") from exc
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            logger.warning("deepgram_provider_http_error", status_code=status)
            timeout = status in (408, 504)
            code = ApiErrorCode.E_TRANSCRIPTION_TIMEOUT if timeout else None
            raise ApiError(
                code or ApiErrorCode.E_TRANSCRIPTION_FAILED, "Transcription failed"
            ) from exc
        except (httpx.HTTPError, ValueError, LookupError, TypeError, AttributeError) as exc:
            logger.warning("deepgram_provider_request_failed", error=str(exc))
            raise ApiError(ApiErrorCode.E_TRANSCRIPTION_FAILED, "Transcription failed") from exc
        if not segments:
            raise ApiError(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE, "Transcript unavailable")
        return segments


def _segments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Utterances, else the first channel's whole transcript; a malformed shape raises."""
    results = payload["results"]
    segments = []
    for utterance in results.get("utterances") or []:
        words = str(utterance.get("transcript") or "").strip()
        start = _ms(utterance.get("start"))
        end = _ms(utterance.get("end"))
        if words and start is not None and end is not None:
            speaker = utterance.get("speaker")
            segments.append(
                {
                    "text": words,
                    "t_start_ms": start,
                    "t_end_ms": end,
                    "speaker_label": None if speaker is None else str(speaker).strip() or None,
                }
            )
    if segments:
        return segments
    alternative = ((results.get("channels") or [{}])[0].get("alternatives") or [{}])[0]
    words = str(alternative.get("transcript") or "").strip()
    duration = _ms((payload.get("metadata") or {}).get("duration"))
    if duration is None:
        ends = [_ms(word.get("end")) for word in alternative.get("words") or []]
        duration = max((end for end in ends if end is not None), default=None)
    if not words or duration is None:
        return []
    return [{"text": words, "t_start_ms": 0, "t_end_ms": duration, "speaker_label": None}]


def _ms(seconds: Any) -> int | None:
    try:
        value = float(seconds) * 1000
    except (TypeError, ValueError, OverflowError):
        return None
    return round(value) if math.isfinite(value) and value >= 0 else None


def get_deepgram_client() -> DeepgramClient:
    settings = get_settings()
    return DeepgramClient(
        api_key=settings.deepgram_api_key,
        base_url=settings.deepgram_base_url,
        model=settings.deepgram_model,
        timeout_seconds=settings.podcast_transcription_timeout_seconds,
    )
