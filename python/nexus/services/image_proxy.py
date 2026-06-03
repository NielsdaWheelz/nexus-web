"""Image proxy service: in-memory LRU cache + ETag/conditional-GET over the validation core.

Owns only the proxy-specific concerns:
- In-memory LRU cache with byte budget, keyed by normalized URL
- ETag computation and conditional-GET (If-None-Match) handling

SSRF/redirect/decode validation lives in nexus.services.image_validation.

Current endpoint contract:
- Endpoint is authenticated-only
- Images are cached by normalized URL
- 64 entry cache with 128MB byte budget
"""

import hashlib
from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock

from nexus.logging import get_logger
from nexus.services.image_validation import (
    check_hostname_denylist,
    create_http_client,
    fetch_validated_image,
    validate_url,
)

logger = get_logger(__name__)

# =============================================================================
# Configuration Constants
# =============================================================================

# Cache limits
CACHE_MAX_ENTRIES = 64
CACHE_MAX_BYTES = 128 * 1024 * 1024  # 128 MB


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
    normalized_url, hostname, _ = validate_url(url)
    check_hostname_denylist(hostname)
    cache = get_cache()
    cached = cache.get(normalized_url)
    if cached:
        if if_none_match and etags_match(if_none_match, cached.etag):
            return ImageResponse(
                data=b"",
                content_type=cached.content_type,
                etag=cached.etag,
                not_modified=True,
            )
        return ImageResponse(
            data=cached.data,
            content_type=cached.content_type,
            etag=cached.etag,
        )
    with create_http_client() as client:
        validated = fetch_validated_image(url, client)
    etag = compute_etag(validated.data)
    cache.put(
        normalized_url,
        CacheEntry(data=validated.data, content_type=validated.content_type, etag=etag),
    )
    if if_none_match and etags_match(if_none_match, etag):
        return ImageResponse(
            data=b"",
            content_type=validated.content_type,
            etag=etag,
            not_modified=True,
        )
    return ImageResponse(
        data=validated.data,
        content_type=validated.content_type,
        etag=etag,
    )
