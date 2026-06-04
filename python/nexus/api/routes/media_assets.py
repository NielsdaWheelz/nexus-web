"""Media asset routes: external image proxy and private EPUB asset serving.

Transport-only: validate input, call one service, return the binary response.
Both paths own static `/media/<literal>` prefixes, so this router must be
registered before the `media` router (see create_api_router).
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import Response

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_session_factory
from nexus.services import epub_assets, image_proxy

router = APIRouter(tags=["media"])


@router.get("/media/image")
def get_proxied_image(
    url: str,
    request: Request,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Response:
    """Proxy an external image through the server with SSRF protection.

    Validates URL scheme/port/host (no private IPs, no credentials), decodes the
    image with Pillow, caches by normalized URL with ETag, and answers conditional
    GETs with 304.

    Raises:
        E_SSRF_BLOCKED (403): URL violates security rules.
        E_IMAGE_FETCH_FAILED (502): Failed to fetch from upstream.
        E_INGEST_TIMEOUT (504): Upstream fetch timed out.
        E_IMAGE_TOO_LARGE (413): Image exceeds 10MB or 4096x4096 dimensions.
        E_INVALID_REQUEST (400): Malformed URL or invalid image content.
    """
    result = image_proxy.fetch_image(url, if_none_match=request.headers.get("If-None-Match"))
    if result.not_modified:
        return Response(status_code=304, headers={"ETag": result.etag})
    return Response(
        content=result.data,
        media_type=result.content_type,
        headers={"Cache-Control": "private, max-age=86400", "ETag": result.etag},
    )


@router.get("/media/{media_id}/assets/{asset_key:path}")
def get_epub_asset(
    media_id: UUID,
    asset_key: str,
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> Response:
    """Serve an EPUB reader image asset through the canonical safe fetch path.

    Visibility, kind, readiness, key-format, and the served-asset CSP are owned by
    the service; the route maps the result onto response headers.
    """
    result = epub_assets.get_epub_asset_for_viewer(
        session_factory=get_session_factory(),
        viewer_id=viewer.user_id,
        media_id=media_id,
        asset_key=asset_key,
    )
    headers = {
        "Cache-Control": result.cache_control,
        "Content-Length": str(len(result.data)),
        "X-Content-Type-Options": "nosniff",
    }
    if result.content_security_policy:
        headers["Content-Security-Policy"] = result.content_security_policy
    return Response(content=result.data, media_type=result.content_type, headers=headers)
