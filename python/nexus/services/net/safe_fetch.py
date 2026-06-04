"""The single SSRF-safe egress for feed-controlled URLs.

RSS feed pages, Podcasting 2.0 chapter JSON, and transcript sidecars are all fetched
from arbitrary feed-controlled URLs, so SSRF defense belongs here, once, not at each
call site. `safe_get` enforces:

- an https/http scheme allow-list with no userinfo (via `validate_requested_url`);
- DNS resolution with loopback/private/link-local/metadata-IP rejection, re-checked on
  every redirect hop (via `image_validation.validate_dns_resolution`);
- at most `_MAX_REDIRECTS` redirects, each re-validated;
- a STREAMED body read that aborts the moment it passes `max_bytes` (the existing image
  and transcript fetchers buffer then check — this caps DoS before buffering).

First-party provider APIs (Podcast Index) are NOT fetched through here — they are trusted
and use `net/http_retry.py`. Residual hardening not yet implemented: pin-to-resolved-IP
(a custom httpx transport closing the DNS-rebinding TOCTOU between the resolution check
and httpx's own connect-time resolution); deferred to avoid risking the HTTPS feed path
without dedicated tests.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services.image_validation import validate_dns_resolution
from nexus.services.url_normalize import validate_requested_url

_MAX_REDIRECTS = 3
_USER_AGENT = "nexus-podcast-client/1.0"
_REDIRECT_STATUS = {301, 302, 303, 307, 308}


@dataclass(frozen=True)
class SafeFetchResult:
    final_url: str
    content_type: str
    content: bytes
    text: str


def _reject_unless_public(url: str) -> None:
    try:
        validate_requested_url(url)
    except InvalidRequestError as exc:
        raise ApiError(ApiErrorCode.E_SSRF_BLOCKED, exc.message) from exc
    validate_dns_resolution(urlparse(url).hostname or "")


def safe_get(
    url: str,
    *,
    max_bytes: int,
    timeout_s: float,
) -> SafeFetchResult:
    """Fetch a feed-controlled URL or raise a typed E_SSRF_BLOCKED / E_SOURCE_* error."""
    current_url = url
    with httpx.Client(timeout=timeout_s, trust_env=False, follow_redirects=False) as client:
        for _ in range(_MAX_REDIRECTS + 1):
            _reject_unless_public(current_url)
            try:
                with client.stream(
                    "GET", current_url, headers={"User-Agent": _USER_AGENT}
                ) as response:
                    if response.status_code in _REDIRECT_STATUS:
                        location = response.headers.get("location")
                        if not location:
                            raise ApiError(
                                ApiErrorCode.E_SOURCE_FETCH_FAILED,
                                "Redirect without a Location header",
                            )
                        current_url = urljoin(str(response.url), location)
                        continue
                    if response.status_code >= 400:
                        raise ApiError(
                            ApiErrorCode.E_SOURCE_FETCH_FAILED,
                            f"Upstream returned status {response.status_code}",
                        )
                    content_type = (
                        (response.headers.get("content-type") or "").split(";")[0].strip().lower()
                    )
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > max_bytes:
                            raise ApiError(
                                ApiErrorCode.E_SOURCE_TOO_LARGE,
                                f"Response exceeded {max_bytes} bytes",
                            )
                    raw = bytes(body)
                    return SafeFetchResult(
                        final_url=str(response.url),
                        content_type=content_type,
                        content=raw,
                        text=raw.decode(response.encoding or "utf-8", errors="replace"),
                    )
            except httpx.TimeoutException as exc:
                raise ApiError(ApiErrorCode.E_SOURCE_FETCH_FAILED, "Fetch timed out") from exc
            except httpx.HTTPError as exc:
                raise ApiError(ApiErrorCode.E_SOURCE_FETCH_FAILED, f"Fetch failed: {exc}") from exc
    raise ApiError(ApiErrorCode.E_SOURCE_FETCH_FAILED, "Too many redirects")
