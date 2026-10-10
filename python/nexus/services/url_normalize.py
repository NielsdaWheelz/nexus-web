"""The public-URL policy: which URLs and addresses ingest may reach, and their stored form.

``validate_requested_url`` gates every user- or feed-supplied URL; ``is_public_ip``
is the predicate the egress applies to every resolved address;
``normalize_url_for_display`` is the stored form; ``parse_identity_url`` is the
decomposition the provider classifiers (YouTube, X) match on.
"""

from __future__ import annotations

from dataclasses import dataclass
from ipaddress import IPv4Address, IPv6Address, ip_address, ip_network
from urllib.parse import urlparse, urlunparse

from nexus.errors import ApiErrorCode, InvalidRequestError

MAX_URL_LENGTH = 2048
_DENIED_HOSTS = frozenset({"localhost"})
_DENIED_HOST_SUFFIXES = (".local", ".internal", ".lan", ".home")
# IANA special-purpose blocks plus Azure's host endpoint, as data: ``is_global`` moves
# between Python patch releases. An IPv6 address must also be global unicast.
_DENIED_NETWORKS = tuple(
    ip_network(network)
    for network in (
        "0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12"
        " 168.63.129.16/32 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16"
        " 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4 ::/128"
        " ::1/128 ::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 100::/64 2001::/23 2001:db8::/32"
        " 2002::/16 3fff::/20 fc00::/7 fe80::/10 ff00::/8"
    ).split()
)
_GLOBAL_UNICAST_V6 = ip_network("2000::/3")


@dataclass(frozen=True, slots=True)
class ParsedIdentityUrl:
    host: str
    path_segments: tuple[str, ...]
    query: str


def is_public_ip(ip: IPv4Address | IPv6Address) -> bool:
    """Whether an untrusted fetch may connect to this address."""
    if ip.version == 6 and ip not in _GLOBAL_UNICAST_V6:
        return False
    return not any(ip in net for net in _DENIED_NETWORKS if net.version == ip.version)


def validate_requested_url(url: str) -> None:
    """Raise ``InvalidRequestError`` unless the URL is an absolute public http(s) URL."""
    if len(url) > MAX_URL_LENGTH:
        raise _invalid(f"URL exceeds maximum length of {MAX_URL_LENGTH} characters")
    parsed = urlparse(url)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise _invalid(f"Invalid URL scheme '{parsed.scheme}'. Only http and https are allowed.")
    if parsed.username or parsed.password:
        raise _invalid("URLs with credentials (user:pass@host) are not allowed")
    host = parsed.hostname
    if not host:
        raise _invalid("URL must have a valid hostname")
    if host in _DENIED_HOSTS or host.endswith(_DENIED_HOST_SUFFIXES) or not _public_literal(host):
        raise _invalid(f"URL hostname '{host}' is not allowed")


def normalize_url_for_display(url: str) -> str:
    """Lowercase scheme and host, drop the default port and the fragment."""
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower() if parsed.hostname else ""
    port = parsed.port
    netloc = f"{host}:{port}" if port and port != (80 if scheme == "http" else 443) else host
    return urlunparse((scheme, netloc, parsed.path or "/", parsed.params, parsed.query, ""))


def parse_identity_url(url: str) -> ParsedIdentityUrl:
    """Host without ``www.`` or a trailing dot, non-empty path segments, and the query."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    return ParsedIdentityUrl(
        host=host.removeprefix("www."),
        path_segments=tuple(segment for segment in parsed.path.split("/") if segment),
        query=parsed.query,
    )


def _public_literal(host: str) -> bool:
    """A host that is not an IP literal passes; DNS answers are vetted at fetch time."""
    try:
        return is_public_ip(ip_address(host))
    except ValueError:
        return True


def _invalid(message: str) -> InvalidRequestError:
    return InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, message)
