"""Token verification implementations.

Provides:
- TokenVerifier: Protocol for token verification
- SupabaseJwksVerifier: Verifier using Supabase JWKS (used in all environments)

Note: Test-only verifiers are in tests/support/test_verifier.py
"""

import logging
import threading
import time
from typing import Any, Protocol
from uuid import UUID

import jwt
from jwt import PyJWKClient
from jwt.exceptions import (
    DecodeError,
    ExpiredSignatureError,
    InvalidAudienceError,
    InvalidIssuerError,
    InvalidSignatureError,
    InvalidTokenError,
    PyJWKClientError,
)

from nexus.errors import ApiError, ApiErrorCode

logger = logging.getLogger(__name__)

# Clock skew allowance in seconds
CLOCK_SKEW_SECONDS = 60


class TokenVerifier(Protocol):
    """Protocol for token verification.

    Implementations must verify JWT tokens and return decoded claims.
    """

    def verify(self, token: str) -> dict[str, Any]:
        """Verify token and return decoded claims.

        Args:
            token: The JWT token string to verify.

        Returns:
            Decoded JWT claims dictionary.

        Raises:
            ApiError(E_UNAUTHENTICATED): Token is invalid, expired, or malformed.
            ApiError(E_AUTH_UNAVAILABLE): Infrastructure failure (JWKS unreachable).
        """
        ...


class SupabaseJwksVerifier:
    """Production token verifier using Supabase JWKS.

    Validates:
    - Signature via JWKS
    - Algorithm: RS256 or ES256 (JWKS determines which key is used)
    - exp with ±60s clock skew
    - iss matches configured issuer (after normalization)
    - aud must be in configured audience list
    - sub must be valid UUID
    """

    def __init__(
        self,
        jwks_url: str,
        issuer: str,
        audiences: list[str],
        cache_ttl: int = 3600,  # 1 hour
    ):
        """Initialize the Supabase JWKS verifier.

        Args:
            jwks_url: Full URL to the JWKS endpoint.
            issuer: Expected issuer (trailing slash will be stripped).
            audiences: List of allowed audience values.
            cache_ttl: How long to cache JWKS keys in seconds.
        """
        self.jwks_url = jwks_url
        self.issuer = issuer.rstrip("/")
        self.audiences = audiences
        self.cache_ttl = cache_ttl

        # Thread-safe JWKS client with caching
        self._jwks_client: PyJWKClient | None = None
        self._jwks_lock = threading.Lock()
        self._last_refresh: float = 0

    def _get_jwks_client(self) -> PyJWKClient:
        """Get or create the JWKS client with lazy initialization."""
        with self._jwks_lock:
            if self._jwks_client is None:
                self._jwks_client = PyJWKClient(
                    self.jwks_url,
                    cache_keys=True,
                    lifespan=self.cache_ttl,
                )
            return self._jwks_client

    def _refresh_jwks(self) -> None:
        """Force refresh of JWKS keys (called on kid miss)."""
        with self._jwks_lock:
            # Create a fresh client to force cache refresh
            self._jwks_client = PyJWKClient(
                self.jwks_url,
                cache_keys=True,
                lifespan=self.cache_ttl,
            )
            self._last_refresh = time.time()

    def verify(self, token: str) -> dict[str, Any]:
        """Verify a Supabase JWT token.

        Args:
            token: The JWT token string.

        Returns:
            Decoded claims dictionary.

        Raises:
            ApiError(E_UNAUTHENTICATED): Token is invalid.
            ApiError(E_AUTH_UNAVAILABLE): JWKS fetch failed.
        """
        # Get signing key from JWKS
        try:
            signing_key = self._get_signing_key(token)
        except PyJWKClientError as e:
            logger.warning(
                "auth_failure",
                extra={
                    "reason": "jwks_unavailable",
                    "error": str(e),
                },
            )
            raise ApiError(
                ApiErrorCode.E_AUTH_UNAVAILABLE,
                "Authentication service unavailable",
            ) from e

        # Decode and verify token
        # Accept both RS256 (RSA) and ES256 (ECDSA) - Supabase cloud uses RS256,
        # Supabase local (newer versions) uses ES256
        try:
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256", "ES256"],
                audience=self.audiences,
                issuer=self.issuer,
                leeway=CLOCK_SKEW_SECONDS,
                options={
                    "require": ["exp", "iss", "sub"],
                    "verify_aud": True,
                },
            )
        except ExpiredSignatureError as e:
            logger.warning("auth_failure", extra={"reason": "expired_token"})
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Token expired") from e
        except InvalidSignatureError as e:
            logger.warning("auth_failure", extra={"reason": "invalid_signature"})
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid token signature") from e
        except InvalidIssuerError as e:
            logger.warning("auth_failure", extra={"reason": "invalid_issuer"})
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid token issuer") from e
        except InvalidAudienceError as e:
            logger.warning("auth_failure", extra={"reason": "invalid_audience"})
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid token audience") from e
        except DecodeError as e:
            logger.warning("auth_failure", extra={"reason": "decode_error", "error": str(e)})
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid token format") from e
        except InvalidTokenError as e:
            logger.warning("auth_failure", extra={"reason": "invalid_token", "error": str(e)})
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid token") from e

        # Validate sub is a valid UUID
        sub = payload.get("sub")
        if not sub:
            logger.warning("auth_failure", extra={"reason": "missing_sub"})
            raise ApiError(ApiErrorCode.E_UNAUTHENTICATED, "Invalid token: missing sub")

        try:
            UUID(sub)
        except (ValueError, TypeError) as e:
            logger.warning("auth_failure", extra={"reason": "invalid_sub"})
            raise ApiError(
                ApiErrorCode.E_UNAUTHENTICATED, "Invalid token: sub is not a valid UUID"
            ) from e

        return payload

    def _get_signing_key(self, token: str) -> Any:
        """Get the signing key for the token, with retry on kid miss.

        Args:
            token: The JWT token string.

        Returns:
            The signing key from JWKS.

        Raises:
            PyJWKClientError: If JWKS fetch fails.
            ApiError(E_UNAUTHENTICATED): If kid not found after refresh.
        """
        client = self._get_jwks_client()

        try:
            return client.get_signing_key_from_jwt(token)
        except PyJWKClientError as e:
            # Check if this is a "kid not found" error
            if "Unable to find" in str(e) or "kid" in str(e).lower():
                # Refresh JWKS and retry once
                logger.info("Refreshing JWKS due to kid miss")
                self._refresh_jwks()
                client = self._get_jwks_client()

                try:
                    return client.get_signing_key_from_jwt(token)
                except PyJWKClientError as retry_e:
                    logger.warning("auth_failure", extra={"reason": "kid_not_found"})
                    raise ApiError(
                        ApiErrorCode.E_UNAUTHENTICATED,
                        "Invalid token: signing key not found",
                    ) from retry_e
            # Re-raise for other errors (network issues, etc.)
            raise
