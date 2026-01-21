"""Test-only endpoints.

These endpoints are ONLY available when NEXUS_ENV=test.
They are used for BFF smoke tests to verify header attachment.

SECURITY: These endpoints must NEVER be enabled in staging or prod.
"""

from fastapi import APIRouter, Request

from nexus.config import Environment, get_settings

router = APIRouter()


@router.get("/__test/echo_headers")
async def echo_headers(request: Request) -> dict:
    """Echo request headers back as JSON.

    This endpoint is used by BFF smoke tests to verify:
    - Bearer token is forwarded correctly
    - X-Nexus-Internal header is attached

    ONLY enabled when NEXUS_ENV=test.

    Returns:
        Dict with "headers" containing all request headers.
    """
    settings = get_settings()

    # Safety check: refuse to run outside of test environment
    if settings.nexus_env != Environment.TEST:
        return {
            "error": {
                "code": "E_FORBIDDEN",
                "message": "This endpoint is only available in test environment",
            }
        }

    # Convert headers to dict (lowercase keys)
    headers_dict = {k.lower(): v for k, v in request.headers.items()}

    return {"data": {"headers": headers_dict}}
