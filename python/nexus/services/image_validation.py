"""SSRF-safe image fetch and decode, shared by the image proxy and plate ingestion."""

from __future__ import annotations

import io
import warnings
from contextlib import closing
from dataclasses import dataclass

import httpx
from PIL import Image

from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.net.safe_fetch import SafeFetchFailed, safe_stream

logger = get_logger(__name__)

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_DIMENSION = 4096
HTTP_TIMEOUT = 10.0

_ALLOWED_PORTS = frozenset({80, 443})
_REJECTED_CONTENT_TYPES = frozenset(
    {
        "text/html",
        "text/plain",
        "text/xml",
        "application/json",
        "application/javascript",
        "image/svg+xml",
    }
)
_REJECTED_MAGIC_PREFIXES = (b"<svg", b"<?xml", b"<html", b"<script", b"<!doctype")
_FORMAT_CONTENT_TYPES = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "gif": "image/gif",
    "webp": "image/webp",
    "bmp": "image/bmp",
    "ico": "image/x-icon",
}
_SSL_CONTEXT = httpx.create_ssl_context(trust_env=False)

Image.MAX_IMAGE_PIXELS = MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION
warnings.filterwarnings("error", category=Image.DecompressionBombWarning)


@dataclass(frozen=True, slots=True)
class ValidatedImage:
    data: bytes
    content_type: str
    width: int
    height: int


def create_http_client() -> httpx.Client:
    """One image-fetch client: shared trust store, no environment proxies."""
    return httpx.Client(
        verify=_SSL_CONTEXT,
        timeout=HTTP_TIMEOUT,
        follow_redirects=False,
        trust_env=False,
    )


def fetch_validated_image(url: str, client: httpx.Client) -> ValidatedImage:
    """Fetch one external image behind the SSRF boundary and decode it.

    The port allowlist is part of the per-hop policy, so a redirect can no more
    reach an unusual port than the requested URL can.
    """
    body = bytearray()
    try:
        headers = safe_stream(
            url,
            max_bytes=MAX_IMAGE_BYTES,
            timeout_s=HTTP_TIMEOUT,
            sink=body.extend,
            accept="image/*,*/*;q=0.8",
            max_redirects=1,
            identity_encoding=True,
            allowed_ports=_ALLOWED_PORTS,
            client=client,
        )
    except SafeFetchFailed as exc:
        raise _image_error(exc) from exc
    if headers.content_type in _REJECTED_CONTENT_TYPES:
        raise ApiError(
            ApiErrorCode.E_INVALID_REQUEST, f"Invalid content type: {headers.content_type}"
        )
    data = bytes(body)
    _reject_markup(data)
    content_type, width, height = _decode_image(data, headers.content_type)
    return ValidatedImage(data=data, content_type=content_type, width=width, height=height)


def _reject_markup(data: bytes) -> None:
    """Defense in depth against SVG/XML/HTML served with an image content type."""
    if len(data) < 10:
        return
    stripped = data[:512].lstrip(b" \t\n\r").lower()
    if stripped.startswith(_REJECTED_MAGIC_PREFIXES):
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Content is not a valid image")


def _decode_image(data: bytes, upstream_content_type: str) -> tuple[str, int, int]:
    """Decode with Pillow under the dimension and decompression-bomb limits."""
    try:
        # Read metadata before verify() invalidates the decoder; reopening would
        # briefly hold two native decoders for the same image.
        with io.BytesIO(data) as body, closing(Image.open(body)) as img:
            width, height = img.size
            img_format = (img.format or "").lower()
            img.verify()
        if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise ApiError(
                ApiErrorCode.E_IMAGE_TOO_LARGE,
                f"Image dimensions exceed limit: {width}x{height}",
            )
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise ApiError(ApiErrorCode.E_IMAGE_TOO_LARGE, "Image exceeds dimension limits") from exc
    except ApiError:
        raise
    except (OSError, SyntaxError) as exc:
        logger.warning("image_decode_failed", error=str(exc))
        raise ApiError(ApiErrorCode.E_INVALID_REQUEST, "Content is not a valid image") from exc

    if upstream_content_type.startswith("image/") and upstream_content_type != "image/svg+xml":
        return upstream_content_type, width, height
    return _FORMAT_CONTENT_TYPES.get(img_format, "application/octet-stream"), width, height


def _image_error(exc: SafeFetchFailed) -> ApiError:
    if exc.reason == "Blocked":
        return ApiError(ApiErrorCode.E_SSRF_BLOCKED, "Request blocked for security reasons")
    if exc.reason == "TooLarge":
        return ApiError(
            ApiErrorCode.E_IMAGE_TOO_LARGE,
            f"Image exceeds maximum size of {MAX_IMAGE_BYTES // (1024 * 1024)} MB",
        )
    if exc.reason == "Timeout":
        return ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "Image fetch timed out")
    if exc.reason == "Encoding":
        return ApiError(ApiErrorCode.E_INVALID_REQUEST, "Image content encoding must be identity")
    return ApiError(ApiErrorCode.E_IMAGE_FETCH_FAILED, f"Failed to fetch image: {exc.message}")
