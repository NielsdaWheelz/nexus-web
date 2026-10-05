"""Stream tokens: the short-lived HS256 JWTs of the direct-to-FastAPI `/stream/*` lane.

A stream token (60s) authenticates the browser's SSE requests and Android's
reading-copy download. It travels only in the Authorization header and is
verified statelessly (signature, iss, aud, exp, scope): a token authorizes any
number of requests until it expires.
"""

import base64
import binascii
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

import jwt

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger

logger = get_logger(__name__)

STREAM_TOKEN_ISSUER = "nexus-stream"
STREAM_TOKEN_AUDIENCE = "nexus-api"
STREAM_TOKEN_SCOPE = "stream"
STREAM_TOKEN_TTL_SECONDS = 60


@dataclass(frozen=True)
class StreamTokenResult:
    token: str
    stream_base_url: str  # normalized, no trailing slash
    expires_at: str  # ISO-8601


def _get_signing_key_bytes() -> bytes:
    """Decode the base64-encoded signing key to raw bytes."""
    settings = get_settings()
    key_b64 = settings.effective_stream_token_signing_key
    try:
        key_bytes = base64.b64decode(key_b64, validate=True)
    except binascii.Error as exc:
        raise ValueError(f"STREAM_TOKEN_SIGNING_KEY is not valid base64: {exc}") from exc
    if len(key_bytes) < 32:
        raise ValueError(
            f"STREAM_TOKEN_SIGNING_KEY must be at least 32 bytes, got {len(key_bytes)}"
        )
    return key_bytes


def mint_stream_token(user_id: UUID) -> StreamTokenResult:
    """Mint a short-lived stream token JWT for the given user."""
    settings = get_settings()
    now = int(time.time())
    payload = {
        "iss": STREAM_TOKEN_ISSUER,
        "aud": STREAM_TOKEN_AUDIENCE,
        "sub": str(user_id),
        "exp": now + STREAM_TOKEN_TTL_SECONDS,
        "iat": now,
        "scope": STREAM_TOKEN_SCOPE,
    }
    token = jwt.encode(payload, _get_signing_key_bytes(), algorithm="HS256")
    expires_at = datetime.fromtimestamp(now + STREAM_TOKEN_TTL_SECONDS, tz=UTC).isoformat()
    return StreamTokenResult(
        token=token,
        stream_base_url=settings.effective_stream_base_url.rstrip("/"),
        expires_at=expires_at,
    )


def verify_stream_token(token: str) -> UUID:
    """Return the user a stream token authenticates. Raises ApiError on failure."""
    try:
        payload = jwt.decode(
            token,
            _get_signing_key_bytes(),
            algorithms=["HS256"],
            issuer=STREAM_TOKEN_ISSUER,
            audience=STREAM_TOKEN_AUDIENCE,
            options={"require": ["exp", "iss", "aud", "sub", "scope"]},
        )
    except jwt.ExpiredSignatureError as err:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_EXPIRED, "Stream token has expired") from err
    except jwt.InvalidTokenError as exc:
        logger.warning("stream_token_invalid", error=str(exc))
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token") from exc
    if payload.get("scope") != STREAM_TOKEN_SCOPE:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token scope")
    try:
        return UUID(str(payload["sub"]))
    except (TypeError, ValueError) as exc:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token subject") from exc
