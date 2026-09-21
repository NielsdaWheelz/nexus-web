"""The one SSRF-safe streaming GET for untrusted URLs.

Feed pages, chapter JSON, transcript sidecars, remote PDF/EPUB downloads and
proxied images all leave the process through ``safe_stream``. Every hop re-runs
the public-URL policy and re-resolves DNS, rejecting any loopback, private,
link-local or reserved address; redirects are bounded and the body is streamed
into the caller's sink under a hard byte cap, so nothing is buffered past it.

Failures surface as one transport-neutral ``SafeFetchFailed`` that each caller
maps into its own error vocabulary; ``safe_get`` is the source-ingest mapping.
"""

from __future__ import annotations

import socket
from collections.abc import Callable
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Literal
from urllib.parse import urljoin, urlparse

import httpx

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services.net.egress_policy import is_private_ip
from nexus.services.url_normalize import validate_requested_url

_REDIRECT_STATUS = frozenset({301, 302, 303, 307, 308})
_CHUNK_BYTES = 64 * 1024
_USER_AGENT = "nexus-podcast-client/1.0"

type SafeFetchReason = Literal[
    "Blocked", "NotFound", "Status", "Timeout", "Network", "TooLarge", "Encoding"
]


class SafeFetchFailed(Exception):
    """One transport-neutral egress failure."""

    def __init__(self, reason: SafeFetchReason, message: str) -> None:
        super().__init__(message)
        self.reason: SafeFetchReason = reason
        self.message = message


class SafeFetchNotFound(ApiError):
    """The public target is explicitly gone (HTTP 404/410)."""

    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_SOURCE_FETCH_FAILED, "Upstream target no longer exists")


@dataclass(frozen=True, slots=True)
class SafeStreamHeaders:
    final_url: str
    content_type: str
    encoding: str | None


@dataclass(frozen=True, slots=True)
class SafeFetchResult:
    final_url: str
    content_type: str
    content: bytes
    text: str


def require_public_target(url: str, allowed_ports: frozenset[int] | None = None) -> None:
    """Run the pre-DNS policy and re-resolve the host, rejecting private addresses."""
    try:
        validate_requested_url(url)
        port = urlparse(url).port
    except InvalidRequestError as exc:
        raise SafeFetchFailed("Blocked", exc.message) from exc
    except ValueError as exc:
        raise SafeFetchFailed("Blocked", "URL has an invalid port") from exc
    if allowed_ports is not None and port is not None and port not in allowed_ports:
        raise SafeFetchFailed("Blocked", f"URL port is not allowed: {port}")
    hostname = urlparse(url).hostname or ""
    try:
        resolved = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise SafeFetchFailed("Network", "Failed to resolve hostname") from exc
    if not resolved:
        raise SafeFetchFailed("Network", "Failed to resolve hostname")
    for *_address, sockaddr in resolved:
        try:
            ip = ip_address(str(sockaddr[0]))
        except ValueError:
            continue
        if is_private_ip(ip):
            raise SafeFetchFailed("Blocked", "Request blocked for security reasons")


def safe_stream(
    url: str,
    *,
    max_bytes: int,
    timeout_s: float,
    sink: Callable[[bytes], None],
    accept: str = "*/*",
    max_redirects: int = 3,
    identity_encoding: bool = False,
    allowed_ports: frozenset[int] | None = None,
    client: httpx.Client | None = None,
    proxy: str | None = None,
) -> SafeStreamHeaders:
    """Stream one bounded response body into ``sink``, revalidating every hop."""
    headers = {"User-Agent": _USER_AGENT, "Accept": accept}
    if identity_encoding:
        # HTTP decompression can allocate past the byte cap before the first
        # chunk is yielded, so the image lane accepts only an identity body.
        headers["Accept-Encoding"] = "identity"
    http = client or httpx.Client(
        timeout=timeout_s, trust_env=False, follow_redirects=False, proxy=proxy
    )
    try:
        current_url = url
        for _hop in range(max_redirects + 1):
            require_public_target(current_url, allowed_ports)
            try:
                with http.stream(
                    "GET", current_url, headers=headers, timeout=timeout_s, follow_redirects=False
                ) as response:
                    if response.status_code in _REDIRECT_STATUS:
                        location = response.headers.get("location")
                        if not location:
                            raise SafeFetchFailed("Status", "Redirect without a Location header")
                        current_url = urljoin(str(response.url), location)
                        continue
                    if response.status_code in {404, 410}:
                        raise SafeFetchFailed("NotFound", "Upstream target no longer exists")
                    if response.status_code >= 400:
                        raise SafeFetchFailed(
                            "Status", f"Upstream returned status {response.status_code}"
                        )
                    if identity_encoding and (
                        response.headers.get("content-encoding") or ""
                    ).strip().lower() not in {"", "identity"}:
                        raise SafeFetchFailed(
                            "Encoding", "Response content encoding must be identity"
                        )
                    chunks = (
                        response.iter_raw(chunk_size=_CHUNK_BYTES)
                        if identity_encoding
                        else response.iter_bytes(chunk_size=_CHUNK_BYTES)
                    )
                    received = 0
                    for chunk in chunks:
                        received += len(chunk)
                        if received > max_bytes:
                            raise SafeFetchFailed(
                                "TooLarge", f"Response exceeded {max_bytes} bytes"
                            )
                        sink(chunk)
                    return SafeStreamHeaders(
                        final_url=str(response.url),
                        content_type=(response.headers.get("content-type") or "")
                        .split(";")[0]
                        .strip()
                        .lower(),
                        encoding=response.encoding,
                    )
            except httpx.TimeoutException as exc:
                raise SafeFetchFailed("Timeout", "Fetch timed out") from exc
            except httpx.HTTPError as exc:
                raise SafeFetchFailed("Network", f"Fetch failed: {exc}") from exc
        raise SafeFetchFailed("Status", "Too many redirects")
    finally:
        if client is None:
            http.close()


def source_fetch_error(exc: SafeFetchFailed) -> ApiError:
    """Map one egress failure into the source-ingest error vocabulary."""
    if exc.reason == "NotFound":
        return SafeFetchNotFound()
    if exc.reason == "Blocked":
        return ApiError(ApiErrorCode.E_SSRF_BLOCKED, exc.message)
    if exc.reason == "TooLarge":
        return ApiError(ApiErrorCode.E_SOURCE_TOO_LARGE, exc.message)
    return ApiError(ApiErrorCode.E_SOURCE_FETCH_FAILED, exc.message)


def safe_get(url: str, *, max_bytes: int, timeout_s: float) -> SafeFetchResult:
    """Fetch a feed-controlled URL into memory, or raise a typed source error."""
    body = bytearray()
    try:
        headers = safe_stream(
            url,
            max_bytes=max_bytes,
            timeout_s=timeout_s,
            sink=body.extend,
            proxy=get_settings().outbound_http_proxy_url,
        )
    except SafeFetchFailed as exc:
        raise source_fetch_error(exc) from exc
    content = bytes(body)
    return SafeFetchResult(
        final_url=headers.final_url,
        content_type=headers.content_type,
        content=content,
        text=content.decode(headers.encoding or "utf-8", errors="replace"),
    )
