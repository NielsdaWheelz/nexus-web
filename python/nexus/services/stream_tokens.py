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

logger = get_logger(__name__)

STREAM_TOKEN_ISSUER = "nexus-stream"
STREAM_TOKEN_AUDIENCE = "nexus-api"
STREAM_TOKEN_SCOPE = "stream"
STREAM_TOKEN_TTL_SECONDS = 60
OFFLINE_READING_PACKAGE_SCOPE = "offline-reading-package"
OFFLINE_READING_PACKAGE_TOKEN_TTL_SECONDS = 300
OFFLINE_READING_PACKAGE_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class StreamTokenResult:
    token: str
    stream_base_url: str  # normalized, no trailing slash
    expires_at: str  # ISO-8601


@dataclass(frozen=True)
class VerifiedStreamToken:
    user_id: UUID
    jti: str


@dataclass(frozen=True)
class OfflineReadingPackageTokenResult:
    token: str
    package_base_url: str
    account_id: UUID
    reader_generation: int
    package_schema_version: int
    expires_at: str


@dataclass(frozen=True)
class VerifiedOfflineReadingPackageToken:
    user_id: UUID
    jti: str
    media_id: UUID
    reader_generation: int
    package_schema_version: int
    exp_epoch: int


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


def mint_offline_reading_package_token(
    *,
    user_id: UUID,
    media_id: UUID,
    reader_generation: int,
) -> OfflineReadingPackageTokenResult:
    if reader_generation < 1:
        raise ValueError("reader_generation must be positive")
    settings = get_settings()
    now = int(time.time())
    expires = now + OFFLINE_READING_PACKAGE_TOKEN_TTL_SECONDS
    payload = {
        "iss": STREAM_TOKEN_ISSUER,
        "aud": STREAM_TOKEN_AUDIENCE,
        "sub": str(user_id),
        "exp": expires,
        "iat": now,
        "jti": str(uuid4()),
        "scope": OFFLINE_READING_PACKAGE_SCOPE,
        "media_id": str(media_id),
        "reader_generation": reader_generation,
        "package_schema_version": OFFLINE_READING_PACKAGE_SCHEMA_VERSION,
    }
    return OfflineReadingPackageTokenResult(
        token=jwt.encode(payload, _get_signing_key_bytes(), algorithm="HS256"),
        package_base_url=settings.effective_stream_base_url.rstrip("/"),
        account_id=user_id,
        reader_generation=reader_generation,
        package_schema_version=OFFLINE_READING_PACKAGE_SCHEMA_VERSION,
        expires_at=datetime.fromtimestamp(expires, tz=UTC).isoformat(),
    )


def verify_stream_token(token: str) -> VerifiedStreamToken:
    """Verify a stream token and claim its JTI once. Raises ApiError on failure."""
    payload = _decode_token(
        token,
        required_claims=("exp", "iss", "aud", "sub", "jti", "scope"),
    )
    if payload.get("scope") != STREAM_TOKEN_SCOPE:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token scope")

    jti = payload["jti"]
    exp = payload["exp"]
    if not isinstance(jti, str) or not jti or type(exp) is not int:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token claims")
    try:
        user_id = UUID(str(payload["sub"]))
    except (TypeError, ValueError) as exc:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token subject") from exc
    _claim_jti_once(jti=jti, user_id=user_id, exp_epoch=exp)
    return VerifiedStreamToken(user_id=user_id, jti=jti)


def verify_offline_reading_package_token(
    token: str,
    *,
    expected_media_id: UUID,
) -> VerifiedOfflineReadingPackageToken:
    payload = _decode_token(
        token,
        required_claims=(
            "exp",
            "iat",
            "iss",
            "aud",
            "sub",
            "jti",
            "scope",
            "media_id",
            "reader_generation",
            "package_schema_version",
        ),
    )
    if payload.get("scope") != OFFLINE_READING_PACKAGE_SCOPE:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid package token scope")
    try:
        user_id = UUID(str(payload["sub"]))
        media_id = UUID(str(payload["media_id"]))
    except (TypeError, ValueError) as exc:
        raise ApiError(
            ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid package token identity"
        ) from exc
    generation = payload["reader_generation"]
    schema_version = payload["package_schema_version"]
    jti = payload["jti"]
    exp = payload["exp"]
    if (
        media_id != expected_media_id
        or type(generation) is not int
        or generation < 1
        or type(schema_version) is not int
        or schema_version != OFFLINE_READING_PACKAGE_SCHEMA_VERSION
        or not isinstance(jti, str)
        or not jti
        or type(exp) is not int
    ):
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid package token claims")
    return VerifiedOfflineReadingPackageToken(
        user_id=user_id,
        jti=jti,
        media_id=media_id,
        reader_generation=generation,
        package_schema_version=schema_version,
        exp_epoch=exp,
    )


def claim_offline_reading_package_token(
    token: VerifiedOfflineReadingPackageToken,
) -> None:
    _claim_jti_once(jti=token.jti, user_id=token.user_id, exp_epoch=token.exp_epoch)


def _decode_token(token: str, *, required_claims: tuple[str, ...]) -> dict[str, object]:
    try:
        return jwt.decode(
            token,
            _get_signing_key_bytes(),
            algorithms=["HS256"],
            issuer=STREAM_TOKEN_ISSUER,
            audience=STREAM_TOKEN_AUDIENCE,
            options={"require": list(required_claims)},
        )
    except jwt.ExpiredSignatureError as err:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_EXPIRED, "Stream token has expired") from err
    except jwt.InvalidTokenError as exc:
        logger.warning("stream_token_invalid", error=str(exc))
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token") from exc


def _claim_jti_once(*, jti: str, user_id: UUID, exp_epoch: int) -> None:
    expires_at = datetime.fromtimestamp(exp_epoch, tz=UTC)
    db = get_session_factory()()

    def op() -> None:
        try:
            _claim_jti_once_transaction(db, jti=jti, user_id=user_id, expires_at=expires_at)
        except IntegrityError as exc:
            db.rollback()
            if _is_jti_primary_key_conflict(exc):
                logger.warning("stream.jti_replay_blocked", jti=jti)
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
            logger.warning("stream.jti_replay_blocked", jti=jti)
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
    return integrity_constraint_name(exc) == "stream_token_jti_claims_pkey"
