"""Stream tokens: the short-lived HS256 JWTs of the two direct-to-FastAPI lanes.

A stream token (60s) authenticates the browser's `/stream/*` SSE requests. A
package token (300s) authenticates one offline-reading package download and
binds its media, reader generation and package schema. Both travel only in the
Authorization header and are verified statelessly (signature, iss, aud, exp,
scope, typed claims): a token authorizes any number of requests until it
expires.
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
from nexus.schemas.offline_reading_package import OFFLINE_READING_PACKAGE_SCHEMA_VERSION

logger = get_logger(__name__)

STREAM_TOKEN_ISSUER = "nexus-stream"
STREAM_TOKEN_AUDIENCE = "nexus-api"
STREAM_TOKEN_SCOPE = "stream"
STREAM_TOKEN_TTL_SECONDS = 60
OFFLINE_READING_PACKAGE_SCOPE = "offline-reading-package"
OFFLINE_READING_PACKAGE_TOKEN_TTL_SECONDS = 300


@dataclass(frozen=True)
class StreamTokenResult:
    token: str
    stream_base_url: str  # normalized, no trailing slash
    expires_at: str  # ISO-8601


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
    reader_generation: int


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


def verify_stream_token(token: str) -> UUID:
    """Return the user a stream token authenticates. Raises ApiError on failure."""
    payload = _decode_token(token, required_claims=("exp", "iss", "aud", "sub", "scope"))
    if payload.get("scope") != STREAM_TOKEN_SCOPE:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token scope")
    try:
        return UUID(str(payload["sub"]))
    except (TypeError, ValueError) as exc:
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid stream token subject") from exc


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
    if (
        media_id != expected_media_id
        or type(generation) is not int
        or generation < 1
        or type(schema_version) is not int
        or schema_version != OFFLINE_READING_PACKAGE_SCHEMA_VERSION
    ):
        raise ApiError(ApiErrorCode.E_STREAM_TOKEN_INVALID, "Invalid package token claims")
    return VerifiedOfflineReadingPackageToken(user_id=user_id, reader_generation=generation)


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
