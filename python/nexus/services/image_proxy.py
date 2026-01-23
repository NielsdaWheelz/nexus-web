"""Image proxy service for secure external image fetching.

Provides SSRF-protected image proxying with:
- URL validation (scheme, port, userinfo)
- Hostname denylist (localhost, .local, .internal, etc.)
- DNS resolution validation (blocks private IPs)
- Limited redirects (max 1)
- Content validation (MIME type, magic bytes, Pillow decode)
- In-memory LRU cache with byte budget
- ETag/conditional GET support

Per PR-05 spec:
- Endpoint is authenticated-only
- Images are cached by normalized URL
- Max 10MB per image, 4096x4096 max dimensions
- 64 entry cache with 128MB byte budget
"""

import hashlib
import io
import socket
import warnings
from collections import OrderedDict
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv6Address, ip_address
from threading import Lock
from urllib.parse import urljoin, urlparse, urlunparse

import httpx
from PIL import Image

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

# =============================================================================
# Configuration Constants
# =============================================================================

# Max bytes for image (10 MB)
MAX_IMAGE_BYTES = 10 * 1024 * 1024

# Max decoded dimensions
MAX_IMAGE_DIMENSION = 4096

# HTTP timeout (seconds)
HTTP_TIMEOUT = 10.0

# Cache limits
CACHE_MAX_ENTRIES = 64
CACHE_MAX_BYTES = 128 * 1024 * 1024  # 128 MB

# Allowed schemes
ALLOWED_SCHEMES = frozenset({"http", "https"})

# Allowed ports
ALLOWED_PORTS = frozenset({80, 443, None})  # None = default port for scheme

# Hostname denylist (pre-DNS)
HOSTNAME_DENYLIST_EXACT = frozenset({"localhost"})
HOSTNAME_DENYLIST_SUFFIXES = (".local", ".internal", ".lan", ".home")

# Content-Type immediate rejection list (clearly non-image)
REJECTED_CONTENT_TYPES = frozenset(
    {
        "text/html",
        "text/plain",
        "text/xml",
        "application/json",
        "application/javascript",
        "image/svg+xml",
    }
)

# Magic byte patterns to reject (defense in depth)
REJECTED_MAGIC_PREFIXES = (
    b"<svg",
    b"<?xml",
    b"<html",
    b"<script",
    b"<!doctype",
)

# Redirect status codes
REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})

# User-Agent for outbound requests
USER_AGENT = "NexusImageProxy/1.0"


# =============================================================================
# Data Classes
# =============================================================================


@dataclass
class ImageResponse:
    """Response from image proxy fetch.

    Attributes:
        data: Image bytes (empty if not_modified)
        content_type: MIME type for the image
        etag: ETag for caching (quoted string)
        not_modified: True if client's If-None-Match matched
    """

    data: bytes
    content_type: str
    etag: str
    not_modified: bool = False


@dataclass
class CacheEntry:
    """Cache entry for an image."""

    data: bytes
    content_type: str
    etag: str


# =============================================================================
# LRU Cache with Byte Budget
# =============================================================================


class ImageCache:
    """Thread-safe LRU cache with entry and byte limits.

    Evicts LRU entries when either:
    - Entry count exceeds max_entries
    - Total bytes exceed max_bytes
    """

    def __init__(self, max_entries: int = CACHE_MAX_ENTRIES, max_bytes: int = CACHE_MAX_BYTES):
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self._total_bytes = 0
        self._lock = Lock()

    def get(self, key: str) -> CacheEntry | None:
        """Get entry from cache, moving it to end (most recently used)."""
        with self._lock:
            entry = self._cache.get(key)
            if entry is not None:
                # Move to end (most recently used)
                self._cache.move_to_end(key)
            return entry

    def put(self, key: str, entry: CacheEntry) -> None:
        """Add entry to cache, evicting LRU entries if needed."""
        entry_size = len(entry.data)

        with self._lock:
            # If key already exists, remove old entry first
            if key in self._cache:
                old_entry = self._cache.pop(key)
                self._total_bytes -= len(old_entry.data)

            # Evict until we have room (both entry count and byte budget)
            while self._cache and (
                len(self._cache) >= self.max_entries
                or self._total_bytes + entry_size > self.max_bytes
            ):
                _, evicted = self._cache.popitem(last=False)
                self._total_bytes -= len(evicted.data)

            # Add new entry
            self._cache[key] = entry
            self._total_bytes += entry_size

    def clear(self) -> None:
        """Clear all cache entries."""
        with self._lock:
            self._cache.clear()
            self._total_bytes = 0

    @property
    def size(self) -> int:
        """Current number of entries."""
        with self._lock:
            return len(self._cache)

    @property
    def total_bytes(self) -> int:
        """Current total bytes used."""
        with self._lock:
            return self._total_bytes


# Global cache instance
_cache = ImageCache()


def get_cache() -> ImageCache:
    """Get the global image cache instance."""
    return _cache


def clear_cache() -> None:
    """Clear the global image cache. Useful for testing."""
    _cache.clear()


# =============================================================================
# URL Validation
# =============================================================================


def normalize_image_url(url: str) -> str:
    """Normalize URL for cache key and validation.

    - Lowercase scheme and host
    - Remove default ports (80 for http, 443 for https)
    - Strip fragment
    - Preserve query

    Args:
        url: The URL to normalize.

    Returns:
        Normalized URL string.
    """
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()

    # Remove default ports
    port = parsed.port
    if port == 80 and scheme == "http":
        port = None
    if port == 443 and scheme == "https":
        port = None

    # Build netloc
    if port is not None:
        netloc = f"{host}:{port}"
    else:
        netloc = host

    # Reconstruct without fragment
    return urlunparse((scheme, netloc, parsed.path, parsed.params, parsed.query, ""))


def validate_url(url: str) -> tuple[str, str, int | None]:
    """Validate URL for SSRF protection.

    Checks:
    - Scheme is http or https
    - No userinfo (user:pass@host)
    - Port is 80, 443, or default
    - Host is present

    Args:
        url: The URL to validate.

    Returns:
        Tuple of (normalized_url, hostname, port)

    Raises:
        ApiError: If URL is invalid or violates SSRF rules.
    """
    try:
        parsed = urlparse(url)
    except Exception as e:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid URL: {e}") from e

    # Check scheme
    scheme = parsed.scheme.lower()
    if scheme not in ALLOWED_SCHEMES:
        raise ApiError(
            ApiErrorCode.E_SSRF_BLOCKED,
            f"URL scheme must be http or https, got: {scheme}",
        )

    # Check for userinfo (user:pass@host)
    if parsed.username is not None or parsed.password is not None or "@" in (parsed.netloc or ""):
        raise ApiError(ApiErrorCode.E_SSRF_BLOCKED, "URL must not contain credentials")

    # Check host
    hostname = parsed.hostname
    if not hostname:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "URL must have a host")

    # Check port
    port = parsed.port
    if port is not None and port not in ALLOWED_PORTS:
        raise ApiError(
            ApiErrorCode.E_SSRF_BLOCKED,
            f"URL port must be 80 or 443, got: {port}",
        )

    normalized = normalize_image_url(url)
    return normalized, hostname, port


def check_hostname_denylist(hostname: str) -> None:
    """Check hostname against denylist (pre-DNS).

    Args:
        hostname: The hostname to check.

    Raises:
        ApiError: If hostname is in denylist.
    """
    hostname_lower = hostname.lower()

    if hostname_lower in HOSTNAME_DENYLIST_EXACT:
        raise ApiError(ApiErrorCode.E_SSRF_BLOCKED, "Request blocked for security reasons")

    for suffix in HOSTNAME_DENYLIST_SUFFIXES:
        if hostname_lower.endswith(suffix):
            raise ApiError(ApiErrorCode.E_SSRF_BLOCKED, "Request blocked for security reasons")


# =============================================================================
# DNS Resolution and IP Validation
# =============================================================================


def is_private_ip(ip: IPv4Address | IPv6Address) -> bool:
    """Check if IP address is private/reserved.

    Blocks:
    - Loopback (127.0.0.0/8, ::1)
    - Private (10/8, 172.16/12, 192.168/16)
    - Link-local (169.254/16, fe80::/10)
    - Metadata endpoint (169.254.169.254)
    """
    # Use stdlib methods where available
    if ip.is_loopback:
        return True
    if ip.is_private:
        return True
    if ip.is_link_local:
        return True
    if ip.is_reserved:
        return True

    # Explicit check for metadata endpoint
    if isinstance(ip, IPv4Address) and str(ip) == "169.254.169.254":
        return True

    return False


def validate_dns_resolution(hostname: str) -> None:
    """Resolve hostname and validate all IPs are public.

    Args:
        hostname: The hostname to resolve.

    Raises:
        ApiError: If resolution fails or any IP is private.
    """
    try:
        # Resolve all addresses (IPv4 and IPv6)
        results = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except socket.gaierror as e:
        logger.warning("DNS resolution failed for %s: %s", hostname, e)
        raise ApiError(
            ApiErrorCode.E_IMAGE_FETCH_FAILED,
            "Failed to resolve hostname",
        ) from e

    if not results:
        raise ApiError(ApiErrorCode.E_IMAGE_FETCH_FAILED, "Failed to resolve hostname")

    # Check all resolved IPs
    for _family, _, _, _, sockaddr in results:
        ip_str = sockaddr[0]
        try:
            ip = ip_address(ip_str)
        except ValueError:
            continue

        if is_private_ip(ip):
            logger.warning("SSRF blocked: %s resolved to private IP %s", hostname, ip_str)
            raise ApiError(ApiErrorCode.E_SSRF_BLOCKED, "Request blocked for security reasons")


# =============================================================================
# Content Validation
# =============================================================================


def validate_content_type(content_type: str | None) -> bool:
    """Check if Content-Type should be immediately rejected.

    Returns True if we should proceed (acceptable or missing).
    Returns False (raises) if clearly non-image.
    """
    if not content_type:
        return True  # Missing is OK, we'll sniff

    ct_lower = content_type.lower().split(";")[0].strip()

    if ct_lower in REJECTED_CONTENT_TYPES:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, f"Invalid content type: {ct_lower}")

    return True


def sniff_magic_bytes(data: bytes) -> None:
    """Check first bytes for obviously non-image content.

    Defense in depth against SVG/XML disguised with wrong Content-Type.
    """
    if len(data) < 10:
        return

    # Strip leading whitespace
    stripped = data[:512].lstrip(b" \t\n\r")
    stripped_lower = stripped.lower()

    for prefix in REJECTED_MAGIC_PREFIXES:
        if stripped_lower.startswith(prefix):
            raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Content is not a valid image")


def validate_and_decode_image(data: bytes, upstream_content_type: str | None) -> str:
    """Validate image with Pillow and return appropriate content type.

    Args:
        data: Image bytes.
        upstream_content_type: Content-Type from upstream (may be unreliable).

    Returns:
        Valid image/* content type to use in response.

    Raises:
        ApiError: If image is invalid, too large, or a decompression bomb.
    """
    # Set Pillow's decompression bomb limit
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION

    # Treat decompression bomb warnings as errors
    warnings.filterwarnings("error", category=Image.DecompressionBombWarning)

    try:
        img = Image.open(io.BytesIO(data))
        # Verify integrity without fully decoding
        img.verify()

        # Re-open to check dimensions (verify() leaves image unusable)
        img = Image.open(io.BytesIO(data))
        width, height = img.size

        if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise ApiError(
                ApiErrorCode.E_IMAGE_TOO_LARGE,
                f"Image dimensions exceed limit: {width}x{height}",
            )

        # Get format for content type derivation
        img_format = (img.format or "").lower()

    except Image.DecompressionBombWarning as e:
        raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds dimension limits") from e
    except Image.DecompressionBombError as e:
        raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds dimension limits") from e
    except ApiError:
        raise
    except Exception as e:
        logger.warning("Image decode failed: %s", e)
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Content is not a valid image") from e

    # Determine content type
    # If upstream sent valid image/* (not svg), use it
    if upstream_content_type:
        ct_lower = upstream_content_type.lower().split(";")[0].strip()
        if ct_lower.startswith("image/") and ct_lower != "image/svg+xml":
            return ct_lower

    # Otherwise derive from Pillow format
    format_to_mime = {
        "png": "image/png",
        "jpeg": "image/jpeg",
        "jpg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "bmp": "image/bmp",
        "ico": "image/x-icon",
    }
    return format_to_mime.get(img_format, "application/octet-stream")


# =============================================================================
# HTTP Fetching
# =============================================================================


def _create_http_client() -> httpx.Client:
    """Create an httpx client with security settings."""
    return httpx.Client(
        timeout=HTTP_TIMEOUT,
        follow_redirects=False,  # We handle redirects manually
        trust_env=False,  # CRITICAL: ignore env proxies
    )


def _fetch_url(url: str, client: httpx.Client) -> tuple[bytes, str | None]:
    """Fetch URL with streaming and size limit.

    Returns:
        Tuple of (bytes, content_type)

    Raises:
        ApiError: On fetch failure, timeout, or size limit.
    """
    try:
        with client.stream(
            "GET", url, headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*;q=0.8"}
        ) as response:
            # Check for error status
            if response.status_code >= 400:
                raise ApiError(
                    ApiErrorCode.E_IMAGE_FETCH_FAILED,
                    f"Upstream returned status {response.status_code}",
                )

            content_type = response.headers.get("content-type")

            # Stream and enforce size limit
            chunks = []
            total_bytes = 0

            for chunk in response.iter_bytes(chunk_size=8192):
                total_bytes += len(chunk)
                if total_bytes > MAX_IMAGE_BYTES:
                    raise ApiError(
                        ApiErrorCode.E_IMAGE_TOO_LARGE,
                        f"Image exceeds maximum size of {MAX_IMAGE_BYTES // (1024 * 1024)} MB",
                    )
                chunks.append(chunk)

            return b"".join(chunks), content_type

    except httpx.TimeoutException as e:
        raise ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "Image fetch timed out") from e
    except httpx.RequestError as e:
        raise ApiError(ApiErrorCode.E_IMAGE_FETCH_FAILED, f"Failed to fetch image: {e}") from e
    except ApiError:
        raise
    except Exception as e:
        raise ApiError(ApiErrorCode.E_IMAGE_FETCH_FAILED, f"Failed to fetch image: {e}") from e


def fetch_with_redirect(
    url: str,
    hostname: str,
    client: httpx.Client,
) -> tuple[bytes, str | None]:
    """Fetch URL with up to 1 redirect, validating each hop.

    Args:
        url: The URL to fetch.
        hostname: The validated hostname.
        client: HTTP client to use.

    Returns:
        Tuple of (bytes, content_type)

    Raises:
        ApiError: On fetch failure or redirect violation.
    """
    try:
        # First request (no redirect following)
        response = client.get(
            url,
            headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*;q=0.8"},
            follow_redirects=False,
        )

        # Check for redirect
        if response.status_code in REDIRECT_STATUS_CODES:
            location = response.headers.get("location")
            if not location:
                raise ApiError(
                    ApiErrorCode.E_IMAGE_FETCH_FAILED,
                    "Redirect without Location header",
                )

            # Compute absolute redirect URL
            redirect_url = urljoin(url, location)

            # Validate redirect URL (full SSRF checks)
            _, redirect_hostname, _ = validate_url(redirect_url)
            check_hostname_denylist(redirect_hostname)
            validate_dns_resolution(redirect_hostname)

            # Second request
            response = client.get(
                redirect_url,
                headers={"User-Agent": USER_AGENT, "Accept": "image/*,*/*;q=0.8"},
                follow_redirects=False,
            )

            # If second response is also a redirect, reject
            if response.status_code in REDIRECT_STATUS_CODES:
                raise ApiError(
                    ApiErrorCode.E_IMAGE_FETCH_FAILED,
                    "Too many redirects (max 1 allowed)",
                )

        # Check for error status
        if response.status_code >= 400:
            raise ApiError(
                ApiErrorCode.E_IMAGE_FETCH_FAILED,
                f"Upstream returned status {response.status_code}",
            )

        content_type = response.headers.get("content-type")
        data = response.content

        # Enforce size limit
        if len(data) > MAX_IMAGE_BYTES:
            raise ApiError(
                ApiErrorCode.E_IMAGE_TOO_LARGE,
                f"Image exceeds maximum size of {MAX_IMAGE_BYTES // (1024 * 1024)} MB",
            )

        return data, content_type

    except httpx.TimeoutException as e:
        raise ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "Image fetch timed out") from e
    except httpx.RequestError as e:
        raise ApiError(ApiErrorCode.E_IMAGE_FETCH_FAILED, f"Failed to fetch image: {e}") from e
    except ApiError:
        raise
    except Exception as e:
        raise ApiError(ApiErrorCode.E_IMAGE_FETCH_FAILED, f"Failed to fetch image: {e}") from e


# =============================================================================
# ETag Handling
# =============================================================================


def compute_etag(data: bytes) -> str:
    """Compute ETag from image data as quoted SHA256."""
    hash_hex = hashlib.sha256(data).hexdigest()
    return f'"{hash_hex}"'


def etags_match(if_none_match: str, cached_etag: str) -> bool:
    """Check if If-None-Match header matches cached ETag.

    Handles:
    - Comma-separated values
    - W/ prefix (weak validator)
    - Quoted strings
    - Wildcard (*)
    """
    cached_unquoted = cached_etag.strip('"')

    for tag in if_none_match.split(","):
        tag = tag.strip()

        # Handle weak validator prefix
        if tag.startswith("W/"):
            tag = tag[2:]

        # Strip quotes
        tag = tag.strip('"')

        # Check match
        if tag == cached_unquoted or tag == "*":
            return True

    return False


# =============================================================================
# Rate Limiting Hook (No-op in v1)
# =============================================================================


def check_image_proxy_quota(viewer_id: str | None, bytes_fetched: int) -> None:
    """Hook for rate limiting. No-op in v1.

    Future: implement per-user quotas.
    """
    pass


# =============================================================================
# Main Entrypoint
# =============================================================================


def fetch_image(url: str, if_none_match: str | None = None) -> ImageResponse:
    """Fetch an image with full SSRF protection and caching.

    This is the main entrypoint for the image proxy.

    Args:
        url: The image URL to fetch.
        if_none_match: Optional If-None-Match header value for conditional GET.

    Returns:
        ImageResponse with image data and metadata.

    Raises:
        ApiError: On SSRF violation, fetch failure, or invalid content.
    """
    # Step 1: Validate URL
    normalized_url, hostname, port = validate_url(url)

    # Step 2: Check hostname denylist
    check_hostname_denylist(hostname)

    # Step 3: Check cache
    cache = get_cache()
    cached = cache.get(normalized_url)

    if cached:
        # Check conditional GET
        if if_none_match and etags_match(if_none_match, cached.etag):
            return ImageResponse(
                data=b"",
                content_type=cached.content_type,
                etag=cached.etag,
                not_modified=True,
            )

        # Return cached response
        return ImageResponse(
            data=cached.data,
            content_type=cached.content_type,
            etag=cached.etag,
        )

    # Step 4: Validate DNS resolution (blocks private IPs)
    validate_dns_resolution(hostname)

    # Step 5: Fetch image
    with _create_http_client() as client:
        data, upstream_content_type = fetch_with_redirect(url, hostname, client)

    # Step 6: Validate content type (immediate rejection)
    validate_content_type(upstream_content_type)

    # Step 7: Sniff magic bytes
    sniff_magic_bytes(data)

    # Step 8: Validate and decode with Pillow
    content_type = validate_and_decode_image(data, upstream_content_type)

    # Step 9: Compute ETag
    etag = compute_etag(data)

    # Step 10: Store in cache
    cache.put(normalized_url, CacheEntry(data=data, content_type=content_type, etag=etag))

    # Step 11: Rate limiting hook (no-op in v1)
    check_image_proxy_quota(None, len(data))

    # Step 12: Check conditional GET against new ETag
    if if_none_match and etags_match(if_none_match, etag):
        return ImageResponse(
            data=b"",
            content_type=content_type,
            etag=etag,
            not_modified=True,
        )

    return ImageResponse(
        data=data,
        content_type=content_type,
        etag=etag,
    )
