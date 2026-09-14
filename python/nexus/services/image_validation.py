"""SSRF-safe image fetch + validation core (URL/DNS/redirect/decode), shared by proxy and ingestion."""

import io
import socket
import warnings
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv6Address, ip_address
from typing import TYPE_CHECKING
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

if TYPE_CHECKING:
    from nexus.config import ImageDecoderLimits

logger = get_logger(__name__)


class ImageHttpError(ApiError):
    """Retain upstream status for ingest policy without changing the API envelope."""

    def __init__(self, upstream_status: int) -> None:
        self.upstream_status = upstream_status
        super().__init__(
            ApiErrorCode.E_IMAGE_FETCH_FAILED, f"Upstream returned status {upstream_status}"
        )


# =============================================================================
# Configuration Constants
# =============================================================================

# Max bytes for image (10 MB)
MAX_IMAGE_BYTES = 10 * 1024 * 1024

# Max decoded dimensions
MAX_IMAGE_DIMENSION = 4096
IMAGE_FORMAT_MIME_TYPES = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "ico": "image/x-icon",
    "avif": "image/avif",
}

# HTTP timeout (seconds)
HTTP_TIMEOUT = 10.0

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
    parsed = urlparse(url)

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


def read_exif_orientation(data: memoryview) -> int:
    """Read the one inline IFD0 scalar; never allocate unselected tag values."""
    if data[:6] == b"Exif\x00\x00":
        data = data[6:]
    if data[:4] == b"II*\x00":
        order = "little"
    elif data[:4] == b"MM\x00*":
        order = "big"
    else:
        raise ValueError("Invalid EXIF byte order or TIFF version")
    offset = int.from_bytes(data[4:8], order)
    if offset < 8 or offset + 2 > len(data):
        raise ValueError("Invalid EXIF directory offset")
    count = int.from_bytes(data[offset : offset + 2], order)
    if offset + 2 + count * 12 + 4 > len(data):
        raise ValueError("Incomplete EXIF directory")
    orientation = None
    for at in range(offset + 2, offset + 2 + count * 12, 12):
        if int.from_bytes(data[at : at + 2], order) != 274:
            continue
        if (
            orientation is not None
            or int.from_bytes(data[at + 2 : at + 4], order) != 3
            or int.from_bytes(data[at + 4 : at + 8], order) != 1
        ):
            raise ValueError("Invalid EXIF orientation scalar")
        orientation = int.from_bytes(data[at + 8 : at + 10], order)
        if orientation not in range(1, 9):
            raise ValueError("Invalid EXIF orientation value")
    return orientation if orientation is not None else 1


def prepare_image_validation_bytes(data: bytes) -> tuple[bytes, int]:
    """Keep serving bytes; exclude unused JPEG APP metadata from validation."""
    view = memoryview(data)
    orientation = 1
    found_exif = False
    if data.startswith(b"\xff\xd8"):
        offset = 2
        copied_through = 0
        validation = bytearray()
        while offset < len(data):
            start = offset
            if data[offset] != 0xFF:
                raise ValueError("Invalid JPEG marker")
            while offset < len(data) and data[offset] == 0xFF:
                offset += 1
            if offset == len(data):
                raise ValueError("Incomplete JPEG marker")
            marker = data[offset]
            offset += 1
            if marker in (0xDA, 0xD9):
                break
            if marker == 0x01 or 0xD0 <= marker <= 0xD7:
                continue
            length = int.from_bytes(view[offset : offset + 2], "big")
            end = offset + length
            if length < 2 or end > len(data):
                raise ValueError("Invalid JPEG segment length")
            if marker == 0xE1 and view[offset + 2 : offset + 8] == b"Exif\x00\x00":
                if found_exif:
                    raise ValueError("Duplicate JPEG EXIF profile")
                found_exif = True
                orientation = read_exif_orientation(view[offset + 2 : end])
            if 0xE0 <= marker <= 0xEF:
                # EXIF DPI and MPF auto-promotion both parse unselected IFD
                # values. Neither application segment is needed for geometry.
                validation.extend(view[copied_through:start])
                copied_through = end
            offset = end
        if copied_through:
            validation.extend(view[copied_through:])
            return bytes(validation), orientation
    elif data.startswith(b"\x89PNG\r\n\x1a\n"):
        offset = 8
        image_data = False
        while offset + 12 <= len(data):
            length = int.from_bytes(view[offset : offset + 4], "big")
            end = offset + length + 12
            if end > len(data):
                raise ValueError("Invalid PNG chunk length")
            kind = view[offset + 4 : offset + 8]
            if kind == b"eXIf":
                # PNG third edition table7: one eXIf, before the first IDAT.
                if found_exif or image_data:
                    raise ValueError("Duplicate or misplaced PNG EXIF profile")
                found_exif = True
                orientation = read_exif_orientation(view[offset + 8 : end - 4])
            elif kind == b"IDAT":
                image_data = True
            elif kind == b"IEND":
                break
            offset = end
    return data, orientation


def validate_and_decode_image(data: bytes) -> tuple[str, int, int]:
    """Validate image with Pillow and return content type plus decoded dimensions.

    Args:
        data: Image bytes.

    Returns:
        Tuple of (content_type, width, height): the valid image/* content type to
        use in the response and the decoded pixel dimensions.

    Raises:
        ApiError: If image is invalid, too large, or a decompression bomb.
    """
    from PIL import Image

    # Set Pillow's decompression bomb limit
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION

    # Treat decompression bomb warnings as errors
    warnings.filterwarnings("error", category=Image.DecompressionBombWarning)

    try:
        validation_data, orientation = prepare_image_validation_bytes(data)
        with Image.open(io.BytesIO(validation_data)) as img:
            width, height = img.size
            img_format = (img.format or "").lower()
            if img_format not in ("jpeg", "png") and (exif := img.info.get("exif")):
                orientation = read_exif_orientation(memoryview(exif))
            # Opening PNGs can expand metadata. Verify this same image without
            # retaining a second expanded copy or decoding its pixels.
            img.verify()
        if orientation in (5, 6, 7, 8):
            width, height = height, width

        if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise ApiError(
                ApiErrorCode.E_IMAGE_TOO_LARGE,
                f"Image dimensions exceed limit: {width}x{height}",
            )

    except Image.DecompressionBombWarning as e:
        raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds dimension limits") from e
    except Image.DecompressionBombError as e:
        raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds dimension limits") from e
    except ApiError:
        raise
    except (OSError, ValueError, SyntaxError) as e:
        logger.warning("Image decode failed: %s", e)
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Content is not a valid image") from e

    content_type = IMAGE_FORMAT_MIME_TYPES.get(img_format)
    if content_type is None:
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Image format is not supported")
    return content_type, width, height


# =============================================================================
# HTTP Fetching
# =============================================================================


def create_http_client() -> httpx.Client:
    """Create an httpx client with security settings."""
    return httpx.Client(
        timeout=HTTP_TIMEOUT,
        follow_redirects=False,  # We handle redirects manually
        trust_env=False,  # CRITICAL: ignore env proxies
    )


@dataclass(frozen=True)
class _ImageResponseBody:
    data: bytes
    content_type: str | None


@dataclass(frozen=True)
class _ImageRedirect:
    location: str


def _fetch_image_hop(url: str, client: httpx.Client) -> _ImageResponseBody | _ImageRedirect:
    """Fetch one hop, returning its bounded body or the redirect it declares."""
    with client.stream(
        "GET",
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "image/*,*/*;q=0.8",
            "Accept-Encoding": "identity",
        },
        follow_redirects=False,
    ) as response:
        if response.status_code in REDIRECT_STATUS_CODES:
            location = response.headers.get("location")
            if not location:
                raise ApiError(
                    ApiErrorCode.E_IMAGE_FETCH_FAILED,
                    "Redirect without Location header",
                )
            # Closing the context discards the unread redirect body.
            return _ImageRedirect(location)
        if response.status_code >= 400:
            raise ImageHttpError(response.status_code)
        if response.headers.get("content-encoding", "identity").strip().lower() != "identity":
            raise ApiError(
                ApiErrorCode.E_IMAGE_FETCH_FAILED,
                "Image origin did not honor identity transfer encoding",
            )
        advertised = response.headers.get("content-length")
        if advertised is not None:
            try:
                advertised_bytes = int(advertised)
                if advertised_bytes < 0:
                    raise ValueError("negative content length")
            except ValueError as exc:
                raise ApiError(
                    ApiErrorCode.E_IMAGE_FETCH_FAILED,
                    "Image origin returned an invalid Content-Length",
                ) from exc
            if advertised_bytes > MAX_IMAGE_BYTES:
                raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds maximum size")
        content_type = response.headers.get("content-type")
        validate_content_type(content_type)
        with io.BytesIO() as body:
            for chunk in response.iter_raw(chunk_size=64 * 1024):
                if body.tell() + len(chunk) > MAX_IMAGE_BYTES:
                    raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds maximum size")
                body.write(chunk)
            return _ImageResponseBody(body.getvalue(), content_type)


def fetch_with_redirect(url: str, client: httpx.Client) -> tuple[bytes, str | None]:
    """Fetch URL with up to 1 redirect, validating each hop.

    The caller has already validated the first URL's hostname; this owner
    re-validates the hostname of any redirect it follows.

    Returns:
        Tuple of (bytes, content_type)

    Raises:
        ApiError: On fetch failure or redirect violation.
    """
    try:
        hop = _fetch_image_hop(url, client)
        if isinstance(hop, _ImageResponseBody):
            return hop.data, hop.content_type
        redirect_url = urljoin(url, hop.location)
        _, redirect_hostname, _ = validate_url(redirect_url)
        check_hostname_denylist(redirect_hostname)
        validate_dns_resolution(redirect_hostname)
        redirected = _fetch_image_hop(redirect_url, client)
        if isinstance(redirected, _ImageRedirect):
            raise ApiError(
                ApiErrorCode.E_IMAGE_FETCH_FAILED,
                "Too many redirects (max 1 allowed)",
            )
        return redirected.data, redirected.content_type

    except httpx.TimeoutException as e:
        raise ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "Image fetch timed out") from e
    except httpx.RequestError as e:
        raise ApiError(ApiErrorCode.E_IMAGE_FETCH_FAILED, f"Failed to fetch image: {e}") from e
    except ApiError:
        raise
    except httpx.HTTPError as e:
        raise ApiError(ApiErrorCode.E_IMAGE_FETCH_FAILED, f"Failed to fetch image: {e}") from e


# =============================================================================
# Validated Fetch Orchestrator
# =============================================================================


@dataclass(frozen=True)
class ValidatedImage:
    data: bytes
    content_type: str
    width: int
    height: int


def fetch_validated_image(
    url: str, client: httpx.Client, *, decoder_limits: "ImageDecoderLimits | None" = None
) -> ValidatedImage:
    """Validate a URL (SSRF), fetch with bounded redirects, and decode + size/magic checks."""
    _, hostname, _ = validate_url(url)
    check_hostname_denylist(hostname)
    validate_dns_resolution(hostname)
    data, _upstream_content_type = fetch_with_redirect(url, client)
    sniff_magic_bytes(data)
    if decoder_limits is None:
        # Ingestion already owns its bounded background child.
        content_type, width, height = validate_and_decode_image(data)
    else:
        from nexus.services.image_decoder import decode_image

        content_type, width, height = decode_image(data, decoder_limits)
    return ValidatedImage(
        data=data,
        content_type=content_type,
        width=width,
        height=height,
    )
