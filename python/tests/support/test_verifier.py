"""Test-only token verifier using locally generated RSA keypair.

This module provides MockJwtVerifier for use in unit tests only.
It is NOT part of the runtime code and should not be imported in production.

The verifier validates the same claim structure as SupabaseJwksVerifier
to catch config mistakes early during testing.
"""

import logging
import threading
from typing import Any
from uuid import UUID

import jwt
from jwt.exceptions import (
    DecodeError,
    ExpiredSignatureError,
    InvalidAudienceError,
    InvalidIssuerError,
    InvalidSignatureError,
    InvalidTokenError,
)

from nexus.errors import ApiError, ApiErrorCode

logger = logging.getLogger(__name__)

# Clock skew allowance in seconds (same as production verifier)
CLOCK_SKEW_SECONDS = 60


class MockJwtVerifier:
    """Test token verifier using locally generated RSA keypair.

    This verifier is used only in tests and validates the same claim structure
    as the production verifier to catch config mistakes early.

    Usage:
        from tests.support.test_verifier import MockJwtVerifier

        verifier = MockJwtVerifier()
        claims = verifier.verify(token)

        # To mint tokens, use the private key:
        private_key = MockJwtVerifier.get_private_key()
    """

    # Class-level RSA keypair (generated once)
    _private_key: bytes | None = None
    _public_key: bytes | None = None
    _lock = threading.Lock()

    def __init__(
        self,
        issuer: str = "test-issuer",
        audiences: list[str] | None = None,
    ):
        """Initialize the test token verifier.

        Args:
            issuer: Expected issuer for test tokens.
            audiences: List of allowed audience values.
        """
        self.issuer = issuer
        self.audiences = audiences or ["test-audience"]
        self._ensure_keypair()

    @classmethod
    def _ensure_keypair(cls) -> None:
        """Generate RSA keypair if not already generated."""
        with cls._lock:
            if cls._private_key is None:
                from cryptography.hazmat.backends import default_backend
                from cryptography.hazmat.primitives import serialization
                from cryptography.hazmat.primitives.asymmetric import rsa

                # Generate RSA key pair
                private_key = rsa.generate_private_key(
                    public_exponent=65537,
                    key_size=2048,
                    backend=default_backend(),
                )

                cls._private_key = private_key.private_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PrivateFormat.PKCS8,
                    encryption_algorithm=serialization.NoEncryption(),
                )

                cls._public_key = private_key.public_key().public_bytes(
                    encoding=serialization.Encoding.PEM,
                    format=serialization.PublicFormat.SubjectPublicKeyInfo,
                )

    @classmethod
    def get_private_key(cls) -> bytes:
        """Get the private key for signing tokens."""
        cls._ensure_keypair()
        assert cls._private_key is not None
        return cls._private_key

    @classmethod
    def get_public_key(cls) -> bytes:
        """Get the public key for verifying tokens."""
        cls._ensure_keypair()
        assert cls._public_key is not None
        return cls._public_key

    def verify(self, token: str) -> dict[str, Any]:
        """Verify a test JWT token.

        Validates the same claims as the production verifier:
        - exp with +/-60s clock skew
        - sub must be valid UUID
        - iss validated against configured issuer
        - aud validated against configured audiences

        Args:
            token: The JWT token string.

        Returns:
            Decoded claims dictionary.

        Raises:
            ApiError(E_UNAUTHENTICATED): Token is invalid.
        """
        public_key = self.get_public_key()

        try:
            payload = jwt.decode(
                token,
                public_key,
                algorithms=["RS256"],
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
