"""Tests for cryptographic helpers.

Tests the XChaCha20-Poly1305 encryption/decryption functions for BYOK API keys.

Per S3 spec:
- Keys are encrypted using XChaCha20-Poly1305 (libsodium via PyNaCl)
- Nonce must be 24 bytes and unique per encryption
- Different nonces produce different ciphertext for same plaintext
- Decryption fails with wrong nonce or wrong master key
"""

import base64

import pytest

from nexus.services.crypto import (
    MASTER_KEY_SIZE,
    NONCE_SIZE,
    CryptoError,
    clear_master_key_cache,
    compute_key_fingerprint,
    decrypt_secretbox,
    encrypt_secretbox,
    generate_nonce,
    require_master_key,
)


@pytest.fixture(autouse=True)
def setup_test_master_key(monkeypatch):
    """Set up a deterministic test master key for all tests."""
    # Clear any cached key first
    clear_master_key_cache()

    # Generate a deterministic test key (32 bytes)
    test_key = b"test_master_key_for_encryption!!"
    assert len(test_key) == MASTER_KEY_SIZE

    # Set the environment variable
    test_key_b64 = base64.b64encode(test_key).decode("ascii")
    monkeypatch.setenv("NEXUS_KEY_ENCRYPTION_KEY", test_key_b64)

    yield

    # Clear cache after test
    clear_master_key_cache()


class TestMasterKey:
    """Tests for master key loading and validation."""

    def test_require_master_key_loads_from_env(self):
        """Master key is loaded from NEXUS_KEY_ENCRYPTION_KEY."""
        key = require_master_key()

        assert len(key) == MASTER_KEY_SIZE
        assert key == b"test_master_key_for_encryption!!"

    def test_missing_key_raises_error(self, monkeypatch):
        """Missing NEXUS_KEY_ENCRYPTION_KEY raises CryptoError."""
        clear_master_key_cache()
        monkeypatch.delenv("NEXUS_KEY_ENCRYPTION_KEY", raising=False)

        with pytest.raises(CryptoError) as exc_info:
            require_master_key()

        assert "not set" in str(exc_info.value)

    def test_invalid_base64_raises_error(self, monkeypatch):
        """Invalid base64 in NEXUS_KEY_ENCRYPTION_KEY raises CryptoError."""
        clear_master_key_cache()
        monkeypatch.setenv("NEXUS_KEY_ENCRYPTION_KEY", "not-valid-base64!!!")

        with pytest.raises(CryptoError) as exc_info:
            require_master_key()

        assert "not valid base64" in str(exc_info.value)

    def test_wrong_key_size_raises_error(self, monkeypatch):
        """Key of wrong size raises CryptoError."""
        clear_master_key_cache()
        wrong_size_key = b"too_short"
        monkeypatch.setenv(
            "NEXUS_KEY_ENCRYPTION_KEY",
            base64.b64encode(wrong_size_key).decode("ascii"),
        )

        with pytest.raises(CryptoError) as exc_info:
            require_master_key()

        assert "must be 32 bytes" in str(exc_info.value)


class TestNonceGeneration:
    """Tests for nonce generation."""

    def test_generate_nonce_returns_correct_size(self):
        """Generated nonce is 24 bytes."""
        nonce = generate_nonce()

        assert len(nonce) == NONCE_SIZE

    def test_generate_nonce_is_random(self):
        """Each generated nonce is unique (with very high probability)."""
        nonces = [generate_nonce() for _ in range(100)]

        # All nonces should be unique
        assert len(set(nonces)) == 100


class TestEncryptDecrypt:
    """Tests for encrypt/decrypt round-trip."""

    def test_encrypt_decrypt_roundtrip(self):
        """Encrypted data can be decrypted back to original."""
        plaintext = b"sk-test-api-key-12345"
        nonce = generate_nonce()

        ciphertext = encrypt_secretbox(plaintext, nonce)
        decrypted = decrypt_secretbox(ciphertext, nonce)

        assert decrypted == plaintext

    def test_encrypt_decrypt_roundtrip_various_sizes(self):
        """Round-trip works for various plaintext sizes."""
        test_cases = [
            b"",  # Empty
            b"x",  # Single byte
            b"short",  # Short
            b"A" * 100,  # Medium
            b"B" * 10000,  # Large
        ]

        for plaintext in test_cases:
            nonce = generate_nonce()
            ciphertext = encrypt_secretbox(plaintext, nonce)
            decrypted = decrypt_secretbox(ciphertext, nonce)
            assert decrypted == plaintext

    def test_different_nonces_produce_different_ciphertext(self):
        """Same plaintext with different nonces produces different ciphertext."""
        plaintext = b"sk-test-api-key-12345"
        nonce1 = generate_nonce()
        nonce2 = generate_nonce()

        ciphertext1 = encrypt_secretbox(plaintext, nonce1)
        ciphertext2 = encrypt_secretbox(plaintext, nonce2)

        assert ciphertext1 != ciphertext2

    def test_ciphertext_is_larger_than_plaintext(self):
        """Ciphertext includes 16-byte auth tag."""
        plaintext = b"sk-test-api-key-12345"
        nonce = generate_nonce()

        ciphertext = encrypt_secretbox(plaintext, nonce)

        # XChaCha20-Poly1305 adds 16-byte auth tag
        assert len(ciphertext) == len(plaintext) + 16

    def test_wrong_nonce_fails_decryption(self):
        """Decryption with wrong nonce fails."""
        plaintext = b"sk-test-api-key-12345"
        nonce = generate_nonce()
        wrong_nonce = generate_nonce()

        ciphertext = encrypt_secretbox(plaintext, nonce)

        with pytest.raises(CryptoError):
            decrypt_secretbox(ciphertext, wrong_nonce)

    def test_tampered_ciphertext_fails_decryption(self):
        """Decryption of tampered ciphertext fails (authentication)."""
        plaintext = b"sk-test-api-key-12345"
        nonce = generate_nonce()

        ciphertext = encrypt_secretbox(plaintext, nonce)

        # Tamper with ciphertext
        tampered = bytearray(ciphertext)
        tampered[0] ^= 0xFF  # Flip bits in first byte
        tampered = bytes(tampered)

        with pytest.raises(CryptoError):
            decrypt_secretbox(tampered, nonce)

    def test_wrong_master_key_fails_decryption(self, monkeypatch):
        """Decryption with different master key fails."""
        plaintext = b"sk-test-api-key-12345"
        nonce = generate_nonce()

        # Encrypt with current key
        ciphertext = encrypt_secretbox(plaintext, nonce)

        # Change master key
        clear_master_key_cache()
        different_key = b"different_key_for_testing!!!!!32"
        assert len(different_key) == MASTER_KEY_SIZE
        monkeypatch.setenv(
            "NEXUS_KEY_ENCRYPTION_KEY",
            base64.b64encode(different_key).decode("ascii"),
        )

        with pytest.raises(CryptoError):
            decrypt_secretbox(ciphertext, nonce)


class TestNonceValidation:
    """Tests for nonce validation."""

    def test_encrypt_rejects_wrong_nonce_size(self):
        """Encryption rejects nonce of wrong size."""
        plaintext = b"test"
        wrong_nonce = b"too_short"

        with pytest.raises(ValueError) as exc_info:
            encrypt_secretbox(plaintext, wrong_nonce)

        assert "24 bytes" in str(exc_info.value)

    def test_decrypt_rejects_wrong_nonce_size(self):
        """Decryption rejects nonce of wrong size."""
        ciphertext = b"x" * 32  # Dummy ciphertext
        wrong_nonce = b"too_short"

        with pytest.raises(ValueError) as exc_info:
            decrypt_secretbox(ciphertext, wrong_nonce)

        assert "24 bytes" in str(exc_info.value)


class TestKeyFingerprint:
    """Tests for key fingerprint computation."""

    def test_fingerprint_is_last_4_chars(self):
        """Fingerprint is the last 4 characters of the key."""
        api_key = "sk-proj-abc123xyz789"
        fingerprint = compute_key_fingerprint(api_key)

        assert fingerprint == "z789"

    def test_fingerprint_short_key(self):
        """Short keys (< 4 chars) return the whole key."""
        assert compute_key_fingerprint("abc") == "abc"
        assert compute_key_fingerprint("ab") == "ab"
        assert compute_key_fingerprint("a") == "a"
        assert compute_key_fingerprint("") == ""
