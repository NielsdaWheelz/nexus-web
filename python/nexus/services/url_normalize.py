"""URL validation and normalization utilities for web article ingestion.

This module provides URL validation and normalization functions:
- validate_requested_url(): Strict validation, raises InvalidRequestError on failure
- normalize_url_for_display(): Returns normalized URL for canonical_source_url

Key behaviors:
- Scheme must be http or https
- Length must be ≤ 2048 characters
- Host must be present and non-empty
- Userinfo (user:pass@host) is forbidden
- Localhost, internal-network suffixes, and private/reserved IPs are rejected
- Fragment (#...) is stripped during normalization
- Scheme and host are lowercased during normalization
"""

import ipaddress
from urllib.parse import urlparse, urlunparse

from nexus.errors import ApiErrorCode, InvalidRequestError
from nexus.services.net.egress_policy import (
    HOSTNAME_DENYLIST_EXACT,
    HOSTNAME_DENYLIST_SUFFIXES,
    is_private_ip,
)

MAX_URL_LENGTH = 2048

# Allowed schemes
ALLOWED_SCHEMES = {"http", "https"}


def _is_blocked_hostname(hostname: str) -> bool:
    """Reject localhost, internal-network suffixes, and private/reserved IP literals."""
    hostname_lower = hostname.lower()
    if hostname_lower in HOSTNAME_DENYLIST_EXACT:
        return True
    if hostname_lower.endswith(HOSTNAME_DENYLIST_SUFFIXES):
        return True
    try:
        return is_private_ip(ipaddress.ip_address(hostname))
    except ValueError:
        return False


def normalize_host(hostname: str | None) -> str:
    """Lowercase, strip trailing dots, and drop leading 'www.' from a URL host."""
    if hostname is None:
        return ""
    host = hostname.strip().lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    return host


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

    parsed = urlparse(url)

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
