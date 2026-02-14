"""Stream token auth — mint and verify short-lived JWTs for /stream/* endpoints.

Per PR-08 spec §2:
- HS256 signed with STREAM_TOKEN_SIGNING_KEY (stays in fastapi env only)
- Claims: iss=nexus-stream, aud=nexus-api, sub=user_id, exp=now+60s, jti=uuid, scope=stream
- jti replay protection via Redis SETNX with TTL
- iss/aud prevent accidental acceptance of supabase tokens on stream routes
"""

import base64
import time
from datetime import UTC, datetime
from uuid import UUID, uuid4

import jwt

from nexus.config import get_settings
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.redact import safe_kv

logger = get_logger(__name__)

STREAM_TOKEN_ISSUER = "nexus-stream"
STREAM_TOKEN_AUDIENCE = "nexus-api"
STREAM_TOKEN_SCOPE = "stream"
STREAM_TOKEN_TTL_SECONDS = 60


def _get_signing_key_bytes() -> bytes:
    """Decode the base64-encoded signing key to raw bytes."""
    settings = get_settings()
    key_b64 = settings.effective_stream_token_signing_key
    try:
        key_bytes = base64.b64decode(key_b64)
    except Exception as e:
        raise ValueError(f"STREAM_TOKEN_SIGNING_KEY is not valid base64: {e}") from e
    if len(key_bytes) < 32:
        raise ValueError(
            f"STREAM_TOKEN_SIGNING_KEY must be at least 32 bytes, got {len(key_bytes)}"
        )
    return key_bytes


def mint_stream_token(user_id: UUID) -> dict:
    """Mint a short-lived stream token JWT.

    Args:
        user_id: The authenticated user's ID.

    Returns:
        Dict with token, stream_base_url, expires_at.
    """
    settings = get_settings()
    now = int(time.time())
    jti = str(uuid4())

    payload = {
        "iss": STREAM_TOKEN_ISSUER,
        "aud": STREAM_TOKEN_AUDIENCE,
        "sub": str(user_id),
        "exp": now + STREAM_TOKEN_TTL_SECONDS,
        "iat": now,
        "jti": jti,
        "scope": STREAM_TOKEN_SCOPE,
    }

    key_bytes = _get_signing_key_bytes()
    token = jwt.encode(payload, key_bytes, algorithm="HS256")

    expires_at = datetime.fromtimestamp(now + STREAM_TOKEN_TTL_SECONDS, tz=UTC).isoformat()

    return {
        "token": token,
        "stream_base_url": settings.effective_stream_base_url,
        "expires_at": expires_at,
    }


def verify_stream_token(token: str, redis_client=None) -> tuple[UUID, str | None]:
    """Verify a stream token and return the user_id and jti.

    Args:
        token: The JWT string from Authorization header.
        redis_client: Redis client for jti replay check. If None, skip replay check.

    Returns:
        Tuple of (user_id UUID, jti string or None).

    Raises:
        ApiError: On any verification failure.
    """
    key_bytes = _get_signing_key_bytes()

    try:
        payload = jwt.decode(
            token,
            key_bytes,
            algorithms=["HS256"],
            issuer=STREAM_TOKEN_ISSUER,
            audience=STREAM_TOKEN_AUDIENCE,
            options={"require": ["exp", "iss", "aud", "sub", "jti", "scope"]},
        )
    except jwt.ExpiredSignatureError as err:
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_EXPIRED,
            "Stream token has expired",
        ) from err
    except jwt.InvalidTokenError as e:
        logger.warning("stream_token_invalid", error=str(e))
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID,
            "Invalid stream token",
        ) from e

    # Verify scope
    if payload.get("scope") != STREAM_TOKEN_SCOPE:
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID,
            "Invalid stream token scope",
        )

    # jti replay check via Redis SETNX
    jti = payload["jti"]
    if redis_client is not None:
        try:
            exp = payload["exp"]
            ttl = max(1, exp - int(time.time()))
            # SETNX returns True if key was set (new), False if already exists (replay)
            was_set = redis_client.set(f"jti:{jti}", "1", nx=True, ex=ttl)
            if not was_set:
                # PR-09: Emit stream.jti_replay_blocked event
                logger.warning(
                    "stream.jti_replay_blocked",
                    **safe_kv(jti=jti),
                )
                raise ApiError(
                    ApiErrorCode.E_STREAM_TOKEN_REPLAYED,
                    "Stream token has already been used",
                )
        except ApiError:
            raise
        except Exception as e:
            # Redis failure — fail open for jti check (token is still valid by signature)
            logger.warning("stream_token_jti_check_failed", error=str(e))

    user_id = UUID(payload["sub"])
    return user_id, jti
