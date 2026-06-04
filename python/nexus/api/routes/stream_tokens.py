"""Internal stream token minting endpoint.

Behavior:
- POST /internal/stream-tokens mints a stream token JWT
- BFF-only: requires X-Nexus-Internal header + Supabase bearer auth
- Signing key never leaves the FastAPI environment
- Rate-limited: shares the same per-user RPM limit as chat run creation
"""

from typing import Annotated

from fastapi import APIRouter, Depends

from nexus.auth.middleware import Viewer, get_viewer
from nexus.responses import success_response
from nexus.services.rate_limit import get_rate_limiter
from nexus.services.stream_tokens import mint_stream_token

router = APIRouter(tags=["stream-tokens"])


@router.post("/internal/stream-tokens")
def create_stream_token(
    viewer: Annotated[Viewer, Depends(get_viewer)],
) -> dict:
    """Mint a short-lived stream token for direct browser-to-FastAPI SSE.

    The BFF proxies to this endpoint with Supabase bearer + X-Nexus-Internal.
    Returns a JWT the browser can use for direct SSE endpoints.

    Response:
        {
            "token": "<jwt>",
            "stream_base_url": "https://api.nexus.example.com",
            "expires_at": "2026-02-08T21:01:00+00:00"
        }
    """
    # Cross-endpoint throttle shared with chat-run creation — an explicit route
    # guard, deliberately not folded into the service mint.
    get_rate_limiter().check_rpm_limit(viewer.user_id)

    result = mint_stream_token(viewer.user_id)
    return success_response(
        {
            "token": result.token,
            "stream_base_url": result.stream_base_url,
            "expires_at": result.expires_at,
        }
    )
