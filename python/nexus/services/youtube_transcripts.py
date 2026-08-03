"""YouTube transcript provider boundary."""

from __future__ import annotations

from typing import Any

from requests import Session
from youtube_transcript_api.proxies import ProxyConfig, RequestsProxyConfigDict

from nexus.config import get_settings
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)


class _TranscriptProxyConfig(ProxyConfig):
    def __init__(self, proxy_url: str, *, retries_when_blocked: int) -> None:
        self._proxy_url = proxy_url
        self._retries_when_blocked = retries_when_blocked

    def to_requests_dict(self) -> RequestsProxyConfigDict:
        return {"http": self._proxy_url, "https": self._proxy_url}

    @property
    def prevent_keeping_connections_alive(self) -> bool:
        return self._retries_when_blocked > 0

    @property
    def retries_when_blocked(self) -> int:
        return self._retries_when_blocked


class _TimeoutSession(Session):
    def __init__(self, timeout_seconds: float) -> None:
        super().__init__()
        self._timeout_seconds = timeout_seconds

    def request(
        self,
        method: str | bytes,
        url: str | bytes,
        params: Any = None,
        data: Any = None,
        headers: Any = None,
        cookies: Any = None,
        files: Any = None,
        auth: Any = None,
        timeout: Any = None,
        allow_redirects: bool = True,
        proxies: Any = None,
        hooks: Any = None,
        stream: Any = None,
        verify: Any = None,
        cert: Any = None,
        json: Any = None,
    ) -> Any:
        return super().request(
            method,
            url,
            params=params,
            data=data,
            headers=headers,
            cookies=cookies,
            files=files,
            auth=auth,
            timeout=self._timeout_seconds if timeout is None else timeout,
            allow_redirects=allow_redirects,
            proxies=proxies,
            hooks=hooks,
            stream=stream,
            verify=verify,
            cert=cert,
            json=json,
        )


def fetch_youtube_transcript(provider_video_id: str) -> dict[str, Any]:
    """Fetch one closed transcript result; unexpected dependency faults raise."""
    video_id = str(provider_video_id or "").strip()
    if not video_id:
        return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")

    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError as exc:
        raise RuntimeError("YouTube transcript dependency is unavailable") from exc

    settings = get_settings()
    try:
        proxy_config = _proxy_config_from_settings(settings)
        raw_segments = list(
            YouTubeTranscriptApi(
                http_client=_TimeoutSession(settings.youtube_transcript_timeout_seconds),
                proxy_config=proxy_config,
            ).fetch(video_id)
        )
    except Exception as exc:  # justify-ignore-error: dispatch on exc class name to avoid coupling to YouTubeTranscriptApi internals
        class_name = exc.__class__.__name__
        if class_name in {
            "TranscriptsDisabled",
            "NoTranscriptFound",
            "VideoUnavailable",
            "InvalidVideoId",
            "VideoUnplayable",
        }:
            return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")
        logger.warning(
            "youtube_transcript_provider_error",
            provider_video_id=video_id,
            error_class=class_name,
        )
        raise

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

    if raw_segments and not segments:
        # justify-defect: a non-empty owned provider response with no valid
        # rows is malformed protocol, not confirmed transcript absence.
        raise RuntimeError("YouTube transcript provider returned malformed segments")
    if not segments:
        return _failure(ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value, "Transcript unavailable")
    segments.sort(key=lambda segment: int(segment["t_start_ms"]))

    return {
        "status": "completed",
        "segments": segments,
    }


def _proxy_config_from_settings(settings: Any) -> _TranscriptProxyConfig | None:
    proxy_url = str(settings.youtube_transcript_proxy_url or "").strip()
    if not proxy_url:
        return None
    return _TranscriptProxyConfig(
        proxy_url,
        retries_when_blocked=int(settings.youtube_transcript_proxy_retries_when_blocked),
    )


def _failure(error_code: str, error_message: str) -> dict[str, Any]:
    return {
        "status": "failed",
        "error_code": error_code,
        "error_message": error_message,
    }
