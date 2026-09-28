"""External image proxy and private EPUB asset serving.

Both own static ``/media/<literal>`` prefixes, so this router is registered
before the media router (see create_api_router).
"""

from typing import Annotated
from uuid import UUID

from anyio import CapacityLimiter, to_thread
from fastapi import APIRouter, Depends
from fastapi.responses import Response
from starlette.types import Receive, Scope, Send

from nexus.auth.middleware import Viewer, get_viewer
from nexus.db.session import get_session_factory
from nexus.services import epub_assets
from nexus.services.image_validation import (
    ValidatedImage,
    create_http_client,
    fetch_validated_image,
)

router = APIRouter(tags=["media"])

_image_fetch_slots = CapacityLimiter(2)
_WRITE_CHUNK_BYTES = 64 * 1024


class _ProxiedImageResponse(Response):
    def __init__(self, url: str) -> None:
        super().__init__()
        self.url = url

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        def fetch() -> ValidatedImage:
            with create_http_client() as client:
                return fetch_validated_image(self.url, client)

        # Hold the slot through transfer, including cancellation and send
        # failure, and validate before publishing any success headers.
        async with _image_fetch_slots:
            image = await to_thread.run_sync(fetch)
            response = Response(
                content=image.data,
                media_type=image.content_type,
                headers={"Cache-Control": "private, max-age=86400"},
            )
            await send(
                {
                    "type": "http.response.start",
                    "status": response.status_code,
                    "headers": response.raw_headers,
                }
            )
            # One large write can fill the socket buffer before backpressure is
            # checked again, so bound every write.
            for offset in range(0, len(response.body), _WRITE_CHUNK_BYTES):
                await send(
                    {
                        "type": "http.response.body",
                        "body": response.body[offset : offset + _WRITE_CHUNK_BYTES],
                        "more_body": True,
                    }
                )
            await send({"type": "http.response.body", "body": b"", "more_body": False})


@router.get("/media/image")
async def get_proxied_image(url: str, viewer: Annotated[Viewer, Depends(get_viewer)]) -> Response:
    """Proxy one external image behind SSRF validation; the browser caches it for a day."""
    return _ProxiedImageResponse(url)


@router.get("/media/{media_id}/assets/{asset_key:path}")
def get_epub_asset(
    media_id: UUID, asset_key: str, viewer: Annotated[Viewer, Depends(get_viewer)]
) -> Response:
    """Serve one private EPUB image asset; the service owns every policy decision."""
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
