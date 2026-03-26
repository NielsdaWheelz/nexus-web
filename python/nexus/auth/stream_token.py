"""Stream token auth — mint and verify short-lived JWTs for /stream/* endpoints."""

import base64
import time
from datetime import UTC, datetime
from uuid import UUID, uuid4

import jwt
from sqlalchemy import text

from nexus.config import get_settings
from nexus.db.session import get_session_factory
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


def verify_stream_token(token: str) -> tuple[UUID, str]:
    """Verify a stream token and return the user_id and jti.

    Args:
        token: The JWT string from Authorization header.

    Returns:
        Tuple of (user_id UUID, jti string).

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

    jti = payload["jti"]
    user_id = UUID(payload["sub"])
    _claim_jti_once(jti=jti, user_id=user_id, exp_epoch=int(payload["exp"]))
    return user_id, jti


def _claim_jti_once(*, jti: str, user_id: UUID, exp_epoch: int) -> None:
    expires_at = datetime.fromtimestamp(exp_epoch, tz=UTC)
    session_factory = get_session_factory()
    db = session_factory()
    try:
        db.execute(text("DELETE FROM stream_token_jti_claims WHERE expires_at <= now()"))
        inserted = db.execute(
            text(
                """
                INSERT INTO stream_token_jti_claims (jti, user_id, expires_at, created_at)
                VALUES (:jti, :user_id, :expires_at, now())
                ON CONFLICT (jti) DO NOTHING
                """
            ),
            {
                "jti": jti,
                "user_id": user_id,
                "expires_at": expires_at,
            },
        )
        if inserted.rowcount == 0:
            logger.warning("stream.jti_replay_blocked", **safe_kv(jti=jti))
            db.rollback()
            raise ApiError(
                ApiErrorCode.E_STREAM_TOKEN_REPLAYED,
                "Stream token has already been used",
            )
        db.commit()
    except ApiError:
        raise
    except Exception as exc:
        db.rollback()
        logger.warning("stream_token_jti_claim_failed", error=str(exc))
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID,
            "Unable to verify stream token",
        ) from exc
    finally:
        db.close()
