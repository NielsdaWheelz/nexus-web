"""URL validation and normalization utilities for web article ingestion.

This module provides URL validation and normalization functions per s2_pr03.md spec:
- validate_requested_url(): Strict validation, raises InvalidRequestError on failure
- normalize_url_for_display(): Returns normalized URL for canonical_source_url

Key behaviors:
- Scheme must be http or https
- Length must be ≤ 2048 characters
- Host must be present and non-empty
- Userinfo (user:pass@host) is forbidden
- Localhost/private addresses are rejected (127.0.0.1, ::1, localhost, *.local)
  - Exception: In NEXUS_ENV=test, localhost/127.0.0.1 are allowed for fixture servers
- Fragment (#...) is stripped during normalization
- Scheme and host are lowercased during normalization
"""

import ipaddress
import os
import re
from urllib.parse import urlparse, urlunparse

from nexus.errors import ApiErrorCode, InvalidRequestError

# Maximum URL length per spec
MAX_URL_LENGTH = 2048

# Allowed schemes
ALLOWED_SCHEMES = {"http", "https"}

# Hostnames to block (case-insensitive)
BLOCKED_HOSTNAMES = {
    "localhost",
}

# Hostname patterns to block
BLOCKED_HOSTNAME_PATTERNS = [
    re.compile(r".*\.local$", re.IGNORECASE),  # *.local
]

# Private IP ranges to block
PRIVATE_IP_RANGES = [
    ipaddress.ip_network("127.0.0.0/8"),  # Loopback
    ipaddress.ip_network("10.0.0.0/8"),  # Private class A
    ipaddress.ip_network("172.16.0.0/12"),  # Private class B
    ipaddress.ip_network("192.168.0.0/16"),  # Private class C
    ipaddress.ip_network("169.254.0.0/16"),  # Link-local
    ipaddress.ip_network("::1/128"),  # IPv6 loopback
    ipaddress.ip_network("fe80::/10"),  # IPv6 link-local
    ipaddress.ip_network("fc00::/7"),  # IPv6 unique local
]


def _is_test_environment() -> bool:
    """Check if running in test environment.

    In test environment, localhost/127.0.0.1 are allowed for fixture servers.
    """
    return os.environ.get("NEXUS_ENV", "").lower() == "test"


def _is_private_ip(hostname: str) -> bool:
    """Check if hostname is a private/local IP address.

    Args:
        hostname: The hostname to check.

    Returns:
        True if the hostname is a private/local IP, False otherwise.
    """
    try:
        ip = ipaddress.ip_address(hostname)
        for network in PRIVATE_IP_RANGES:
            if ip in network:
                return True
        return False
    except ValueError:
        # Not an IP address
        return False


def _is_blocked_hostname(hostname: str) -> bool:
    """Check if hostname is blocked.

    In test environment (NEXUS_ENV=test), localhost and 127.0.0.1 are allowed
    to enable testing with local fixture servers.

    Args:
        hostname: The hostname to check (will be lowercased).

    Returns:
        True if the hostname is blocked, False otherwise.
    """
    hostname_lower = hostname.lower()

    # In test environment, allow localhost and 127.0.0.1 for fixture servers
    if _is_test_environment():
        if hostname_lower == "localhost" or hostname_lower == "127.0.0.1":
            return False

    # Check exact matches
    if hostname_lower in BLOCKED_HOSTNAMES:
        return True

    # Check patterns
    for pattern in BLOCKED_HOSTNAME_PATTERNS:
        if pattern.match(hostname_lower):
            return True

    # Check if it's a private IP
    if _is_private_ip(hostname):
        return True

    return False


def validate_requested_url(url: str) -> None:
    """Validate a URL for web article ingestion.

    Strict validation that raises InvalidRequestError on any validation failure.

    Args:
        url: The URL to validate.

    Raises:
        InvalidRequestError: If validation fails with details about the failure.
    """
    # Check length
    if len(url) > MAX_URL_LENGTH:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"URL exceeds maximum length of {MAX_URL_LENGTH} characters",
        )

    # Parse URL
    try:
        parsed = urlparse(url)
    except Exception as e:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid URL format: {e}",
        ) from e

    # Check scheme
    scheme = parsed.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"Invalid URL scheme '{parsed.scheme}'. Only http and https are allowed.",
        )

    # Check for userinfo (credentials in URL)
    if parsed.username or parsed.password:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URLs with credentials (user:pass@host) are not allowed",
        )

    # Check host exists
    if not parsed.hostname:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL must have a valid hostname",
        )

    # Check for blocked hostnames
    if _is_blocked_hostname(parsed.hostname):
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            f"URL hostname '{parsed.hostname}' is not allowed",
        )

    # Verify it's an absolute URL (has both scheme and netloc)
    if not parsed.scheme or not parsed.netloc:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "URL must be an absolute URL with scheme and host",
        )


def normalize_url_for_display(url: str) -> str:
    """Normalize a URL for display and canonical_source_url storage.

    Normalization rules:
    - Lowercase scheme
    - Lowercase host
    - Strip fragment (#...)
    - Preserve path, query params, port

    This function assumes the URL has already been validated.
    It does NOT follow redirects or modify query params.

    Args:
        url: The URL to normalize.

    Returns:
        The normalized URL string.
    """
    parsed = urlparse(url)

    # Lowercase scheme and netloc (includes host and optional port)
    # We need to handle the port separately from the hostname
    scheme = parsed.scheme.lower()

    # Build normalized netloc
    hostname = parsed.hostname.lower() if parsed.hostname else ""
    port = parsed.port

    if port:
        # Include port only if it's non-standard
        if (scheme == "http" and port != 80) or (scheme == "https" and port != 443):
            netloc = f"{hostname}:{port}"
        else:
            netloc = hostname
    else:
        netloc = hostname

    # Reconstruct URL without fragment
    # urlunparse takes (scheme, netloc, path, params, query, fragment)
    normalized = urlunparse(
        (
            scheme,
            netloc,
            parsed.path or "/",  # Empty path becomes /
            parsed.params,
            parsed.query,
            "",  # Empty fragment - stripped
        )
    )

    return normalized
