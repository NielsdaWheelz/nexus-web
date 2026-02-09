"""Internal stream token minting endpoint.

Per PR-08 spec §2:
- POST /internal/stream-tokens — mints a stream token JWT
- BFF-only: requires X-Nexus-Internal header + supabase bearer auth
- Signing key never leaves fastapi env
- Rate-limited: shares the same per-user RPM limit as send-message
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.auth.stream_token import mint_stream_token
from nexus.services.rate_limit import get_rate_limiter

router = APIRouter(tags=["stream-tokens"])


@router.post("/internal/stream-tokens")
def create_stream_token(
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    """Mint a short-lived stream token for direct browser→fastapi SSE.

    The BFF proxies to this endpoint with supabase bearer + X-Nexus-Internal.
    Returns a JWT the browser can use for /stream/* endpoints.

    Response:
        {
            "token": "<jwt>",
            "stream_base_url": "https://api.nexus.example.com",
            "expires_at": "2026-02-08T21:01:00+00:00"
        }
    """
    # Share RPM limit with send-message
    rate_limiter = get_rate_limiter()
    rate_limiter.check_rpm_limit(viewer.user_id)

    result = mint_stream_token(viewer.user_id)
    return {"data": result}
