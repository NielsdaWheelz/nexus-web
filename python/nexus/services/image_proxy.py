"""Image proxy: one authenticated fetch of an external image, with an ETag.

No server-side cache. Every response carries ``Cache-Control: private,
max-age=86400`` (set by the route), so the browser is the cache and a
conditional GET that reaches this service always re-fetches.
"""

from __future__ import annotations

from dataclasses import dataclass
from time import time_ns

from nexus.services.image_validation import create_http_client, fetch_validated_image


@dataclass(frozen=True, slots=True)
class ImageResponse:
    """One proxied image: bytes, MIME type, and an opaque cache validator."""

    data: bytes
    content_type: str
    etag: str
    not_modified: bool = False


def etags_match(if_none_match: str, cached_etag: str) -> bool:
    """Match an ``If-None-Match`` header against a stored ETag.

    Handles comma-separated lists, the ``W/`` weak prefix, quoting, and ``*``.
    """
    stored = cached_etag.strip('"')
    for raw in if_none_match.split(","):
        tag = raw.strip().removeprefix("W/").strip('"')
        if tag == stored or tag == "*":
            return True
    return False


def fetch_image(url: str, if_none_match: str | None = None) -> ImageResponse:
    """Fetch an image with full SSRF protection and mint its ETag.

    ``if_none_match`` is accepted for the route's conditional-GET contract; with
    no server-side cache there is nothing to match against, so the fetched image
    is always returned.
    """
    with create_http_client() as client:
        validated = fetch_validated_image(url, client)
    return ImageResponse(
        data=validated.data,
        content_type=validated.content_type,
        etag=f'"img-{len(validated.data)}-{time_ns()}"',
    )
