"""Stream-token service: mint/verify the short-lived JWTs that authenticate
direct browser-callable SSE endpoints, backed by a JTI replay-prevention table.

Moved out of `auth/` because it owns persistence (the `stream_token_jti_claims`
table) and a serializable-retried claim — the definition of a service, not an
auth adapter. Returns typed results so call sites never index string keys.
"""

import base64
import binascii
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

import jwt
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from nexus.config import get_settings
from nexus.db.errors import integrity_constraint_name
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiError, ApiErrorCode
from nexus.logging import get_logger
from nexus.services.redact import safe_kv

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


@dataclass(frozen=True)
class VerifiedStreamToken:
    user_id: UUID
    jti: str


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
        "jti": str(uuid4()),
        "scope": STREAM_TOKEN_SCOPE,
    }
    token = jwt.encode(payload, _get_signing_key_bytes(), algorithm="HS256")
    expires_at = datetime.fromtimestamp(now + STREAM_TOKEN_TTL_SECONDS, tz=UTC).isoformat()
    return StreamTokenResult(
        token=token,
        stream_base_url=settings.effective_stream_base_url.rstrip("/"),
        expires_at=expires_at,
    )


def verify_stream_token(token: str) -> VerifiedStreamToken:
    """Verify a stream token and claim its JTI once. Raises ApiError on failure."""
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
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_EXPIRED, "Stream token has expired") from err
    except jwt.InvalidTokenError as e:
        logger.warning("stream_token_invalid", error=str(e))
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token") from e

    if payload.get("scope") != STREAM_TOKEN_SCOPE:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token scope")

    jti = payload["jti"]
    try:
        user_id = UUID(payload["sub"])
    except (TypeError, ValueError) as exc:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token subject") from exc
    _claim_jti_once(jti=jti, user_id=user_id, exp_epoch=int(payload["exp"]))
    return VerifiedStreamToken(user_id=user_id, jti=jti)


def _claim_jti_once(*, jti: str, user_id: UUID, exp_epoch: int) -> None:
    expires_at = datetime.fromtimestamp(exp_epoch, tz=UTC)
    db = get_session_factory()()

    def op() -> None:
        try:
            _claim_jti_once_transaction(db, jti=jti, user_id=user_id, expires_at=expires_at)
        except IntegrityError as exc:
            db.rollback()
            if _is_jti_primary_key_conflict(exc):
                logger.warning("stream.jti_replay_blocked", **safe_kv(jti=jti))
                raise ApiError(
                    ApiErrorCode.E_STREAM_TOKEN_REPLAYED,
                    "Stream token has already been used",
                ) from exc
            raise

    try:
        retry_serializable(db, "stream_token_jti_claim", op)
    except ApiError:
        raise
    except SQLAlchemyError as exc:
        logger.warning("stream_token_jti_claim_failed", error=str(exc))
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID, "Unable to verify stream token"
        ) from exc
    finally:
        db.close()


def _claim_jti_once_transaction(db, *, jti: str, user_id: UUID, expires_at: datetime) -> None:
    with transaction(db):
        db.execute(text("DELETE FROM stream_token_jti_claims WHERE expires_at <= now()"))
        existing = db.execute(
            text("SELECT 1 FROM stream_token_jti_claims WHERE jti = :jti"),
            {"jti": jti},
        ).first()
        if existing is not None:
            logger.warning("stream.jti_replay_blocked", **safe_kv(jti=jti))
            raise ApiError(
                ApiErrorCode.E_STREAM_TOKEN_REPLAYED, "Stream token has already been used"
            )
        result = db.execute(
            text(
                """
                INSERT INTO stream_token_jti_claims (
                    jti,
                    user_id,
                    expires_at,
                    created_at
                )
                VALUES (:jti, :user_id, :expires_at, now())
                """
            ),
            {"jti": jti, "user_id": user_id, "expires_at": expires_at},
        )
        if getattr(result, "rowcount", None) != 1:
            raise RuntimeError("stream token JTI claim insert affected an unexpected row count")


def _is_jti_primary_key_conflict(exc: IntegrityError) -> bool:
    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "stream_token_jti_claims_pkey"
    return "stream_token_jti_claims_pkey" in str(exc.orig)
