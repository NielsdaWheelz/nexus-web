"""The one SSRF-safe streaming GET for untrusted URLs.

Article pages, feeds, chapter JSON, transcript sidecars, remote PDF/EPUB files,
proxied images and the Gutenberg catalog leave the process through ``safe_stream``.
Every hop passes the URL policy and resolves once; every answer must be public, and the
connection dials only those addresses (the URL keeps the hostname, which the Host header,
TLS and cookies use), so nothing resolves twice. Every socket read, write and handshake
ends by one overall deadline, and the body's wire and decoded bytes each stay under the
byte cap. Failures are classified where the response is seen.
"""

from __future__ import annotations

import re
import socket
import ssl
import zlib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from ipaddress import ip_address
from time import monotonic
from typing import Literal
from urllib.parse import urljoin

import httpcore
import httpx

from nexus.errors import ApiError, ApiErrorCode, InvalidRequestError
from nexus.services.url_normalize import is_public_ip, validate_requested_url

_REDIRECT_STATUS = frozenset({301, 302, 303, 307, 308})
_CHUNK_BYTES = 64 * 1024
_DEFAULT_HEADERS = {
    "User-Agent": "nexus-podcast-client/1.0",
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate",
}
_INFLATED = frozenset({"gzip", "x-gzip", "deflate"})
_SSL_CONTEXT = httpx.create_ssl_context(trust_env=False)
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")

type SafeFetchReason = Literal[
    "Blocked", "Gone", "Denied", "Status", "Timeout", "Network", "TooLarge", "Type"
]


class SafeFetchFailed(Exception):
    """One transport-neutral egress failure."""

    def __init__(self, reason: SafeFetchReason, message: str) -> None:
        super().__init__(message)
        self.reason: SafeFetchReason = reason
        self.message = message


class SafeFetchNotFound(ApiError):
    """The public target is gone (HTTP 404/410)."""

    def __init__(self) -> None:
        super().__init__(ApiErrorCode.E_SOURCE_GONE, "Upstream target no longer exists")


@dataclass(frozen=True, slots=True)
class SafeStreamHeaders:
    final_url: str
    content_type: str  # media type only, lowercased
    raw_content_type: str
    encoding: str  # the declared charset when Python knows it, else utf-8


@dataclass(frozen=True, slots=True)
class SafeFetchResult:
    final_url: str
    content_type: str
    content: bytes
    text: str


def safe_stream(
    url: str,
    *,
    max_bytes: int,
    timeout_s: float,
    sink: Callable[[bytes], None],
    headers: Mapping[str, str] | None = None,
    max_redirects: int = 3,
    allowed_ports: frozenset[int] | None = None,
    media_types: frozenset[str] | None = None,
) -> SafeStreamHeaders:
    """Stream one bounded response body into ``sink``, vetting and pinning every hop."""
    deadline = monotonic() + timeout_s
    cookies = httpx.Cookies()  # a cookie set on one hop goes to the later hops it is scoped to
    current = url
    for _hop in range(max_redirects + 1):
        target, addresses = _vetted_target(current, allowed_ports)
        request = httpx.Request("GET", target, headers={**_DEFAULT_HEADERS, **(headers or {})})
        cookies.set_cookie_header(request)
        try:
            # One pool per hop: its connections reach only this hop's vetted addresses.
            with (
                httpcore.ConnectionPool(
                    ssl_context=_SSL_CONTEXT, network_backend=_Pinned(addresses, deadline)
                ) as pool,
                pool.stream(
                    "GET",
                    httpcore.URL(
                        scheme=target.raw_scheme,
                        host=target.raw_host,
                        port=target.port,
                        target=target.raw_path,
                    ),
                    headers=request.headers.raw,
                ) as raw,
            ):
                response = httpx.Response(raw.status, headers=raw.headers, request=request)
                cookies.extract_cookies(response)
                status = response.status_code
                if status in _REDIRECT_STATUS:
                    location = response.headers.get("location")
                    if not location:
                        raise SafeFetchFailed("Status", "Redirect without a Location header")
                    current = urljoin(str(target), location)
                    continue
                if status in {404, 410}:
                    raise SafeFetchFailed("Gone", f"Upstream target no longer exists ({status})")
                if status in {401, 403}:
                    raise SafeFetchFailed("Denied", f"Upstream denied access ({status})")
                if not 200 <= status < 300:
                    raise SafeFetchFailed("Status", f"Upstream returned status {status}")
                raw_type = response.headers.get("content-type", "")
                media_type = raw_type.split(";")[0].strip().lower()
                if media_types is not None and media_type not in media_types:
                    raise SafeFetchFailed("Type", f"Unexpected content type: {media_type}")
                # gzip and zlib bodies inflate at most one byte past the cap per read; any other
                # coding passes through as sent.
                coding = response.headers.get("content-encoding", "").strip().lower()
                inflate = zlib.decompressobj(zlib.MAX_WBITS | 32) if coding in _INFLATED else None
                wire = 0
                received = 0
                pending = bytearray()
                for read in raw.iter_stream():
                    wire += len(read)
                    body = inflate.decompress(read, max_bytes - received + 1) if inflate else read
                    received += len(body)
                    if wire > max_bytes or received > max_bytes:
                        raise SafeFetchFailed("TooLarge", f"Response exceeded {max_bytes} bytes")
                    pending += body
                    if len(pending) >= _CHUNK_BYTES:
                        sink(bytes(pending))
                        pending.clear()
                if pending:
                    sink(bytes(pending))
                return SafeStreamHeaders(
                    final_url=str(target),
                    content_type=media_type,
                    raw_content_type=raw_type,
                    encoding=response.encoding or "utf-8",
                )
        except httpcore.TimeoutException as exc:
            raise SafeFetchFailed("Timeout", "Fetch timed out") from exc
        except (httpcore.NetworkError, httpcore.ProtocolError, zlib.error) as exc:
            raise SafeFetchFailed("Network", f"Fetch failed: {exc}") from exc
    raise SafeFetchFailed("Status", "Too many redirects")


def source_fetch_error(exc: SafeFetchFailed) -> ApiError:
    """Map one egress failure into the source-ingest vocabulary; the code decides terminality."""
    if exc.reason == "Gone":
        return SafeFetchNotFound()
    code = {
        "Blocked": ApiErrorCode.E_SSRF_BLOCKED,
        "Denied": ApiErrorCode.E_SOURCE_ACCESS_DENIED,
        "TooLarge": ApiErrorCode.E_SOURCE_TOO_LARGE,
        "Type": ApiErrorCode.E_INVALID_CONTENT_TYPE,
        "Timeout": ApiErrorCode.E_INGEST_TIMEOUT,
    }.get(exc.reason, ApiErrorCode.E_SOURCE_FETCH_FAILED)
    return ApiError(code, exc.message)


def safe_get(url: str, *, max_bytes: int, timeout_s: float) -> SafeFetchResult:
    """Fetch an untrusted URL into memory, or raise its typed source error."""
    body = bytearray()
    try:
        headers = safe_stream(url, max_bytes=max_bytes, timeout_s=timeout_s, sink=body.extend)
    except SafeFetchFailed as exc:
        raise source_fetch_error(exc) from exc
    content = bytes(body)
    return SafeFetchResult(
        final_url=headers.final_url,
        content_type=headers.content_type,
        content=content,
        text=content.decode(headers.encoding, errors="replace"),
    )


def _vetted_target(url: str, allowed_ports: frozenset[int] | None) -> tuple[httpx.URL, list[str]]:
    """Apply the URL policy, resolve once, and return the URL with every address, all public."""
    try:
        validate_requested_url(url)
        if _CONTROL_CHARACTERS.search(url):
            raise SafeFetchFailed("Blocked", "URL contains control characters")
        target = httpx.URL(url).copy_with(fragment=None)
    except InvalidRequestError as exc:
        raise SafeFetchFailed("Blocked", exc.message) from exc
    except httpx.InvalidURL as exc:
        raise SafeFetchFailed("Blocked", f"Invalid URL: {exc}") from exc
    if allowed_ports is not None and target.port is not None and target.port not in allowed_ports:
        raise SafeFetchFailed("Blocked", f"URL port is not allowed: {target.port}")
    host = target.raw_host.decode("ascii")
    try:
        answers = socket.getaddrinfo(host, target.port or 0, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise SafeFetchFailed("Network", "Failed to resolve hostname") from exc
    addresses = [str(answer[4][0]).split("%")[0] for answer in answers]  # no zone id
    if not addresses:
        raise SafeFetchFailed("Network", "Failed to resolve hostname")
    if not all(is_public_ip(ip_address(address)) for address in addresses):
        raise SafeFetchFailed("Blocked", "Request blocked for security reasons")
    return target, addresses


class _Pinned(httpcore.SyncBackend):
    """Connects only to one hop's vetted addresses, under the call deadline."""

    def __init__(self, addresses: list[str], deadline: float) -> None:
        self.addresses = addresses
        self.deadline = deadline

    def connect_tcp(
        self, host: str, port: int, *_args: object, **_kwargs: object
    ) -> httpcore.NetworkStream:
        """Dial the addresses in order (never ``host``), moving on only when one cannot be
        connected; each spends at most its share of the time left."""
        for index, address in enumerate(self.addresses):
            share = (self.deadline - monotonic()) / (len(self.addresses) - index)
            try:
                stream = super().connect_tcp(address, port, max(share, 0.001))
                return _Bounded(stream, self.deadline)
            except (httpcore.ConnectError, httpcore.ConnectTimeout):
                if index == len(self.addresses) - 1:
                    raise
        raise AssertionError("a vetted host always has an address")


class _Bounded(httpcore.NetworkStream):
    """A connection whose every read, write and TLS handshake ends by the deadline, so a drip
    of headers, chunk framing or empty compressed blocks cannot outlive it."""

    def __init__(self, stream: httpcore.NetworkStream, deadline: float) -> None:
        self.stream = stream
        self.deadline = deadline

    def read(self, max_bytes: int, timeout: float | None = None) -> bytes:
        return self.stream.read(max_bytes, self._left())

    def write(self, buffer: bytes, timeout: float | None = None) -> None:
        self.stream.write(buffer, self._left())

    def close(self) -> None:
        self.stream.close()

    def start_tls(
        self,
        ssl_context: ssl.SSLContext,
        server_hostname: str | None = None,
        timeout: float | None = None,
    ) -> httpcore.NetworkStream:
        tls = self.stream.start_tls(ssl_context, server_hostname, self._left())
        return _Bounded(tls, self.deadline)

    def _left(self) -> float:
        left = self.deadline - monotonic()
        if left <= 0:
            raise httpcore.TimeoutException("Fetch timed out")
        return left
