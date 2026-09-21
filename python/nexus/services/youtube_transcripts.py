"""YouTube caption provider boundary."""

from __future__ import annotations

from typing import Any

from requests import Session
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api.proxies import ProxyConfig, RequestsProxyConfigDict

from nexus.config import get_settings
from nexus.errors import ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

_ABSENT_TRANSCRIPT_ERRORS = {
    "TranscriptsDisabled",
    "NoTranscriptFound",
    "VideoUnavailable",
    "InvalidVideoId",
    "VideoUnplayable",
}


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
    """A requests session that applies one default timeout to every call."""

    def __init__(self, timeout_seconds: float) -> None:
        super().__init__()
        self._timeout_seconds = timeout_seconds

    def request(  # noqa: PLR0913 - mirrors requests.Session.request exactly
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
        return _unavailable()

    settings = get_settings()
    proxy_url = str(settings.youtube_transcript_proxy_url or "").strip()
    proxy_config = (
        _TranscriptProxyConfig(
            proxy_url,
            retries_when_blocked=int(settings.youtube_transcript_proxy_retries_when_blocked),
        )
        if proxy_url
        else None
    )
    try:
        raw_segments = list(
            YouTubeTranscriptApi(
                http_client=_TimeoutSession(settings.youtube_transcript_timeout_seconds),
                proxy_config=proxy_config,
            ).fetch(video_id)
        )
    # justify-ignore-error: dispatch on the exception class name so this boundary
    # is not coupled to youtube_transcript_api internals.
    except Exception as exc:
        if exc.__class__.__name__ in _ABSENT_TRANSCRIPT_ERRORS:
            return _unavailable()
        logger.warning(
            "youtube_transcript_provider_error",
            provider_video_id=video_id,
            error_class=exc.__class__.__name__,
        )
        raise

    segments: list[dict[str, Any]] = []
    for row in raw_segments:
        start_ms, end_ms = _segment_bounds(row)
        if start_ms is None or end_ms is None:
            continue
        segments.append(
            {
                "t_start_ms": start_ms,
                "t_end_ms": end_ms,
                "text": str(getattr(row, "text", None) or ""),
                "speaker_label": None,
            }
        )
    if raw_segments and not segments:
        raise RuntimeError("YouTube transcript provider returned malformed segments")
    if not segments:
        return _unavailable()
    segments.sort(key=lambda segment: int(segment["t_start_ms"]))
    return {"status": "completed", "segments": segments}


def _segment_bounds(row: object) -> tuple[int, int] | tuple[None, None]:
    start = getattr(row, "start", None)
    duration = getattr(row, "duration", None)
    if start is None or duration is None:
        return None, None
    try:
        start_ms = round(float(start) * 1000)
        end_ms = start_ms + round(float(duration) * 1000)
    except (TypeError, ValueError):
        return None, None
    if start_ms < 0 or end_ms <= start_ms:
        return None, None
    return start_ms, end_ms


def _unavailable() -> dict[str, Any]:
    return {
        "status": "failed",
        "error_code": ApiErrorCode.E_TRANSCRIPT_UNAVAILABLE.value,
        "error_message": "Transcript unavailable",
    }
