"""Cryptographic helpers for API key encryption.

Implements XChaCha20-Poly1305 authenticated encryption for BYOK API keys
using PyNaCl (libsodium bindings).

Per S3 spec:
- Keys are encrypted at rest using envelope encryption
- XChaCha20-Poly1305 provides authenticated encryption with a 24-byte nonce
- Master key is loaded from NEXUS_KEY_ENCRYPTION_KEY environment variable
- Keys are never logged; only fingerprints (last 4 chars) are used for debugging
- Nonce must be unique per encryption operation (randomly generated)

Security invariants:
- Never log plaintext keys or ciphertext
- Master key is validated on first use (32 bytes)
- Different nonces produce different ciphertext for same plaintext
- Decryption fails if nonce or master key is wrong (authentication)
"""

import base64
import os
from functools import lru_cache

from nacl.secret import SecretBox

from nexus.logging import get_logger

logger = get_logger(__name__)

# XChaCha20-Poly1305 nonce size (24 bytes)
NONCE_SIZE = 24

# Master key size (32 bytes for XChaCha20)
MASTER_KEY_SIZE = 32


class CryptoError(Exception):
    """Raised when cryptographic operations fail."""

    pass


@lru_cache(maxsize=1)
def _get_master_key() -> bytes:
    """Load and validate the master key from environment.

    The master key is cached after first load for performance.
    It is base64-encoded in the environment variable.

    Returns:
        The 32-byte master key.

    Raises:
        CryptoError: If the key is missing, invalid base64, or wrong size.
    """
    key_b64 = os.environ.get("NEXUS_KEY_ENCRYPTION_KEY")
    if not key_b64:
        raise CryptoError("NEXUS_KEY_ENCRYPTION_KEY environment variable is not set")

    try:
        key = base64.b64decode(key_b64)
    except Exception as e:
        raise CryptoError(f"NEXUS_KEY_ENCRYPTION_KEY is not valid base64: {e}") from e

    if len(key) != MASTER_KEY_SIZE:
        raise CryptoError(
            f"NEXUS_KEY_ENCRYPTION_KEY must be {MASTER_KEY_SIZE} bytes, got {len(key)} bytes"
        )

    return key


def require_master_key() -> bytes:
    """Load and validate the master encryption key.

    This function is the public interface for getting the master key.
    It loads from the NEXUS_KEY_ENCRYPTION_KEY environment variable.

    Returns:
        The 32-byte master key.

    Raises:
        CryptoError: If the key is missing or invalid.
    """
    return _get_master_key()


def generate_nonce() -> bytes:
    """Generate a random 24-byte nonce for encryption.

    Each encryption operation MUST use a unique nonce.
    Using the same nonce twice with the same key breaks security.

    Returns:
        24-byte random nonce.
    """
    return os.urandom(NONCE_SIZE)


def encrypt_secretbox(plaintext: bytes, nonce: bytes) -> bytes:
    """Encrypt data using XChaCha20-Poly1305.

    Args:
        plaintext: The data to encrypt.
        nonce: A 24-byte unique nonce. MUST be unique for each encryption.

    Returns:
        The ciphertext (encrypted data + 16-byte auth tag).

    Raises:
        CryptoError: If encryption fails.
        ValueError: If nonce is wrong size.
    """
    if len(nonce) != NONCE_SIZE:
        raise ValueError(f"Nonce must be {NONCE_SIZE} bytes, got {len(nonce)}")

    try:
        master_key = require_master_key()
        box = SecretBox(master_key)
        ciphertext = box.encrypt(plaintext, nonce=nonce)
        # SecretBox.encrypt returns nonce + ciphertext, but we store nonce separately
        # So we return only the ciphertext portion (skip first 24 bytes which is nonce)
        return ciphertext.ciphertext
    except CryptoError:
        raise
    except Exception as e:
        logger.error("encryption_failed", error=str(e))
        raise CryptoError(f"Encryption failed: {e}") from e


def decrypt_secretbox(ciphertext: bytes, nonce: bytes) -> bytes:
    """Decrypt data encrypted with XChaCha20-Poly1305.

    Args:
        ciphertext: The encrypted data (includes 16-byte auth tag).
        nonce: The 24-byte nonce used during encryption.

    Returns:
        The decrypted plaintext.

    Raises:
        CryptoError: If decryption fails (wrong key, wrong nonce, or tampered data).
        ValueError: If nonce is wrong size.
    """
    if len(nonce) != NONCE_SIZE:
        raise ValueError(f"Nonce must be {NONCE_SIZE} bytes, got {len(nonce)}")

    try:
        master_key = require_master_key()
        box = SecretBox(master_key)
        plaintext = box.decrypt(ciphertext, nonce=nonce)
        return plaintext
    except CryptoError:
        raise
    except Exception as e:
        logger.error("decryption_failed", error=str(e))
        raise CryptoError(f"Decryption failed: {e}") from e


def compute_key_fingerprint(api_key: str) -> str:
    """Compute a fingerprint for display purposes.

    The fingerprint is the last 4 characters of the API key.
    This is safe for logging and display while not revealing the full key.

    Args:
        api_key: The plaintext API key.

    Returns:
        The last 4 characters of the key.
    """
    if len(api_key) < 4:
        return api_key
    return api_key[-4:]


def clear_master_key_cache() -> None:
    """Clear the cached master key.

    Useful for testing or key rotation scenarios.
    """
    _get_master_key.cache_clear()


# =============================================================================
# High-Level API Key Encryption Functions (per PR-03 spec)
# =============================================================================

# Current master key version (v1 - no rotation implemented yet)
CURRENT_MASTER_KEY_VERSION = 1


def encrypt_api_key(plaintext: str) -> tuple[bytes, bytes, int, str]:
    """Encrypt an API key for storage.

    Per PR-03 spec:
    - Nonce is generated internally (24 random bytes) — never supplied by caller
    - Fingerprint is last 4 characters of plaintext
    - master_key_version is always 1 (current version)

    Args:
        plaintext: The plaintext API key to encrypt.

    Returns:
        Tuple of (ciphertext, nonce, master_key_version, fingerprint)

    Raises:
        CryptoError: If encryption fails or master key is not configured.
    """
    # Generate unique nonce for this encryption
    nonce = generate_nonce()

    # Encrypt the key
    ciphertext = encrypt_secretbox(plaintext.encode("utf-8"), nonce)

    # Compute fingerprint (last 4 chars)
    fingerprint = compute_key_fingerprint(plaintext)

    return ciphertext, nonce, CURRENT_MASTER_KEY_VERSION, fingerprint


def decrypt_api_key(ciphertext: bytes, nonce: bytes, version: int) -> str:
    """Decrypt an API key from storage.

    Per PR-03 spec:
    - If version == 1 → use current master key
    - If version unknown → raise ApiError(E_INTERNAL)

    Args:
        ciphertext: The encrypted API key.
        nonce: The 24-byte nonce used during encryption.
        version: The master key version used for encryption.

    Returns:
        The decrypted plaintext API key.

    Raises:
        CryptoError: If version is unknown or decryption fails.
    """
    if version != CURRENT_MASTER_KEY_VERSION:
        raise CryptoError(f"Unknown key version: {version}")

    plaintext_bytes = decrypt_secretbox(ciphertext, nonce)
    return plaintext_bytes.decode("utf-8")
