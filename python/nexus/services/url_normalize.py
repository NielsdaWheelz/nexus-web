"""The one public-HTTP URL policy for ingest.

``validate_requested_url`` is the raising gate every user- or feed-supplied URL
passes: http/https, at most ``MAX_URL_LENGTH`` characters, no userinfo, a host
that is neither a denylisted internal name nor a private/reserved IP literal.
``normalize_url_for_display`` is the canonical form stored on media and attempts,
and ``parse_identity_url`` is the shared decomposition the provider classifiers
(YouTube, X) match against.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.net.egress_policy import (
    HOSTNAME_DENYLIST_EXACT,
    HOSTNAME_DENYLIST_SUFFIXES,
    is_private_ip,
)

MAX_URL_LENGTH = 2048
ALLOWED_SCHEMES = frozenset({"http", "https"})


@dataclass(frozen=True, slots=True)
class ParsedIdentityUrl:
    host: str
    path_segments: tuple[str, ...]
    query: str


def validate_requested_url(url: str) -> None:
    """Raise ``InvalidRequestError`` unless the URL is an absolute public http(s) URL."""
    if len(url) > MAX_URL_LENGTH:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"URL exceeds maximum length of {MAX_URL_LENGTH} characters",
        )
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid URL scheme '{parsed.scheme}'. Only http and https are allowed.",
        )
    if parsed.username or parsed.password:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URLs with credentials (user:pass@host) are not allowed",
        )
    if not parsed.hostname:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL must have a valid hostname",
        )
    if _is_blocked_hostname(parsed.hostname):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"URL hostname '{parsed.hostname}' is not allowed",
        )
    if not parsed.netloc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL must be an absolute URL with scheme and host",
        )


def normalize_url_for_display(url: str) -> str:
    """Lowercase scheme and host, drop the default port and the fragment."""
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname.lower() if parsed.hostname else ""
    port = parsed.port
    default_port = 80 if scheme == "http" else 443
    netloc = f"{hostname}:{port}" if port and port != default_port else hostname
    return urlunparse((scheme, netloc, parsed.path or "/", parsed.params, parsed.query, ""))


def normalize_host(hostname: str | None) -> str:
    """Lowercase, strip trailing dots, and drop a leading ``www.``."""
    if hostname is None:
        return ""
    host = hostname.strip().lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def parse_identity_url(url: str) -> ParsedIdentityUrl:
    """Decompose a URL into the parts a provider classifier matches on."""
    parsed = urlparse(url)
    return ParsedIdentityUrl(
        host=normalize_host(parsed.hostname),
        path_segments=tuple(segment for segment in parsed.path.split("/") if segment),
        query=parsed.query,
    )


def _is_blocked_hostname(hostname: str) -> bool:
    lowered = hostname.lower()
    if lowered in HOSTNAME_DENYLIST_EXACT or lowered.endswith(HOSTNAME_DENYLIST_SUFFIXES):
        return True
    try:
        return is_private_ip(ipaddress.ip_address(hostname))
    except ValueError:
        return False
