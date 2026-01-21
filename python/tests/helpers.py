"""Test helpers for authentication and common test operations.

Provides:
- Token minting for test authentication
- Header generation for test requests
- User creation helpers
"""

import time
from uuid import UUID, uuid4

import jwt

from nexus.auth.verifier import MockTokenVerifier

# Default test token settings
DEFAULT_ISSUER = "test-issuer"
DEFAULT_AUDIENCE = "test-audience"
DEFAULT_EXPIRES_IN = 3600  # 1 hour


def mint_test_token(
    user_id: UUID | str,
    expires_in: int = DEFAULT_EXPIRES_IN,
    issuer: str = DEFAULT_ISSUER,
    audience: str = DEFAULT_AUDIENCE,
    **extra_claims,
) -> str:
    """Mint a valid test JWT token.

    Args:
        user_id: The user ID to set as the `sub` claim.
        expires_in: Token validity in seconds from now.
        issuer: The `iss` claim value.
        audience: The `aud` claim value.
        **extra_claims: Additional claims to include in the token.

    Returns:
        A signed JWT token string.
    """
    private_key = MockTokenVerifier.get_private_key()

    now = int(time.time())
    payload = {
        "sub": str(user_id),
        "iss": issuer,
        "aud": audience,
        "iat": now,
        "exp": now + expires_in,
        **extra_claims,
    }

    return jwt.encode(payload, private_key, algorithm="RS256")


def mint_expired_token(
    user_id: UUID | str,
    issuer: str = DEFAULT_ISSUER,
    audience: str = DEFAULT_AUDIENCE,
) -> str:
    """Mint a token that expired 1 hour ago.

    Args:
        user_id: The user ID to set as the `sub` claim.
        issuer: The `iss` claim value.
        audience: The `aud` claim value.

    Returns:
        A signed JWT token string that is already expired.
    """
    return mint_test_token(
        user_id=user_id,
        expires_in=-3600,  # Expired 1 hour ago
        issuer=issuer,
        audience=audience,
    )


def mint_token_with_bad_signature(
    user_id: UUID | str,
    issuer: str = DEFAULT_ISSUER,
    audience: str = DEFAULT_AUDIENCE,
) -> str:
    """Mint a token signed with a different key (bad signature).

    Args:
        user_id: The user ID to set as the `sub` claim.
        issuer: The `iss` claim value.
        audience: The `aud` claim value.

    Returns:
        A JWT token with an invalid signature.
    """
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    # Generate a different private key
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend(),
    )
    private_key_bytes = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )

    now = int(time.time())
    payload = {
        "sub": str(user_id),
        "iss": issuer,
        "aud": audience,
        "iat": now,
        "exp": now + DEFAULT_EXPIRES_IN,
    }

    return jwt.encode(payload, private_key_bytes, algorithm="RS256")


def auth_headers(user_id: UUID | str, **token_kwargs) -> dict[str, str]:
    """Return headers dict with valid Authorization for the given user.

    Args:
        user_id: The user ID to authenticate as.
        **token_kwargs: Additional arguments passed to mint_test_token.

    Returns:
        Dict with Authorization header.
    """
    token = mint_test_token(user_id, **token_kwargs)
    return {"Authorization": f"Bearer {token}"}


def create_test_user_id() -> UUID:
    """Generate a random UUID for a test user.

    Returns:
        A random UUID.
    """
    return uuid4()
