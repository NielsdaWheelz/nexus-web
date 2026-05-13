"""Unit tests for token verifiers.

Tests the SupabaseJwksVerifier (with mocked HTTP) and MockJwtVerifier.
"""

import json
import time
from unittest.mock import MagicMock, patch
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from nexus.auth.verifier import SupabaseJwksVerifier
from nexus.errors import ApiError, ApiErrorCode
from tests.support.mock_verifier import MockJwtVerifier

pytestmark = pytest.mark.unit


class TestSupabaseJwksVerifier:
    """Unit tests for SupabaseJwksVerifier.

    All tests mock HTTP calls to the JWKS endpoint.
    """

    @pytest.fixture
    def rsa_keypair(self):
        """Generate an RSA keypair for testing."""
        private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend(),
        )
        public_key = private_key.public_key()
        return private_key, public_key

    @pytest.fixture
    def jwks_response(self, rsa_keypair):
        """Generate a JWKS response for the test keypair."""
        _, public_key = rsa_keypair
        jwk = RSAAlgorithm.to_jwk(public_key, as_dict=True)
        jwk["kid"] = "test-key-id"
        jwk["use"] = "sig"
        jwk["alg"] = "RS256"
        return {"keys": [jwk]}

    @pytest.fixture
    def verifier(self):
        """Create a verifier with test configuration."""
        return SupabaseJwksVerifier(
            jwks_url="https://test.supabase.co/.well-known/jwks.json",
            issuer="https://test.supabase.co",
            audiences=["authenticated"],
            cache_ttl=3600,
        )

    def mint_token(self, private_key, sub: str, **overrides) -> str:
        """Helper to mint tokens for testing."""
        now = int(time.time())
        payload = {
            "sub": sub,
            "iss": "https://test.supabase.co",
            "aud": "authenticated",
            "iat": now,
            "exp": now + 3600,
            **overrides,
        }
        private_bytes = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        return jwt.encode(payload, private_bytes, algorithm="RS256", headers={"kid": "test-key-id"})

    def signing_key_patch(self, verifier, public_key):
        """Patch JWKS lookup so decode tests only exercise claim verification."""
        mock_signing_key = MagicMock()
        mock_signing_key.key = public_key
        return patch.object(verifier, "_get_signing_key", return_value=mock_signing_key)

    def json_response(self, payload):
        """Build a minimal urlopen-compatible JSON response."""

        class JsonResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, traceback):
                return None

            def read(self):
                return json.dumps(payload).encode()

        return JsonResponse()

    def test_valid_token(self, verifier, rsa_keypair):
        """Test 1: Valid token returns claims."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        token = self.mint_token(private_key, user_id)

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            claims = verifier.verify(token)

            assert claims["sub"] == user_id
            assert claims["iss"] == "https://test.supabase.co"
            assert claims["aud"] == "authenticated"

    def test_invalid_signature(self, verifier, rsa_keypair):
        """Test 2: Invalid signature returns E_UNAUTHENTICATED."""
        # Generate a different keypair for the token
        wrong_private_key = rsa.generate_private_key(
            public_exponent=65537,
            key_size=2048,
            backend=default_backend(),
        )
        user_id = str(uuid4())
        token = self.mint_token(wrong_private_key, user_id)

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED

    def test_expired_token(self, verifier, rsa_keypair):
        """Test 3: Expired token returns E_UNAUTHENTICATED."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        # Token expired 2 minutes ago (beyond clock skew)
        token = self.mint_token(private_key, user_id, exp=int(time.time()) - 120)

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED
            assert "expired" in exc_info.value.message.lower()

    def test_wrong_issuer(self, verifier, rsa_keypair):
        """Test 4: Wrong issuer returns E_UNAUTHENTICATED."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        token = self.mint_token(private_key, user_id, iss="https://wrong.supabase.co")

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED
            assert "issuer" in exc_info.value.message.lower()

    def test_wrong_audience(self, verifier, rsa_keypair):
        """Test 5: Wrong audience returns E_UNAUTHENTICATED."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        token = self.mint_token(private_key, user_id, aud="wrong-audience")

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED
            assert "audience" in exc_info.value.message.lower()

    def test_missing_audience(self, verifier, rsa_keypair):
        """Test 6: Missing audience claim returns E_UNAUTHENTICATED."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        # Create token without audience
        now = int(time.time())
        payload = {
            "sub": user_id,
            "iss": "https://test.supabase.co",
            "iat": now,
            "exp": now + 3600,
        }
        private_bytes = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        token = jwt.encode(
            payload, private_bytes, algorithm="RS256", headers={"kid": "test-key-id"}
        )

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED

    def test_invalid_sub_format(self, verifier, rsa_keypair):
        """Test 7: Invalid sub format (not UUID) returns E_UNAUTHENTICATED."""
        private_key, _ = rsa_keypair
        token = self.mint_token(private_key, "not-a-uuid")

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED
            assert "uuid" in exc_info.value.message.lower()

    def test_jwks_client_uses_bounded_cache_and_timeout(self):
        """Test 8: JWKS client uses TTL-bounded set cache and explicit timeout."""
        verifier = SupabaseJwksVerifier(
            jwks_url="https://test.supabase.co/.well-known/jwks.json",
            issuer="https://test.supabase.co",
            audiences=["authenticated"],
            cache_ttl=123,
            fetch_timeout=2.5,
        )

        client = verifier._get_jwks_client()

        assert client.timeout == 2.5
        assert client.jwk_set_cache is not None
        assert client.jwk_set_cache.lifespan == 123
        assert not hasattr(client.get_signing_key, "cache_info")
        assert verifier._get_jwks_client() is client

    def test_cached_jwks_used_within_ttl(self, verifier, rsa_keypair, jwks_response):
        """Cached JWKS verifies repeat requests without another fetch."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        token = self.mint_token(private_key, user_id)

        with patch(
            "jwt.jwks_client.urllib.request.urlopen",
            return_value=self.json_response(jwks_response),
        ) as urlopen:
            first_claims = verifier.verify(token)
            second_claims = verifier.verify(token)

        assert first_claims["sub"] == user_id
        assert second_claims["sub"] == user_id
        assert urlopen.call_count == 1

    def test_kid_not_found_returns_unauthenticated(self, verifier, rsa_keypair):
        """Test 9: Kid not found returns E_UNAUTHENTICATED."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        token = self.mint_token(private_key, user_id)

        from jwt.exceptions import PyJWKClientError

        with patch.object(verifier, "_get_jwks_client") as mock_client:
            mock_jwk_client = MagicMock()
            mock_jwk_client.get_signing_key_from_jwt.side_effect = PyJWKClientError(
                "Unable to find a signing key"
            )
            mock_client.return_value = mock_jwk_client

            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED
            assert "signing key" in exc_info.value.message.lower()
            mock_jwk_client.get_signing_key_from_jwt.assert_called_once_with(token)

    def test_jwks_fetch_failure(self, verifier, rsa_keypair):
        """Test 10: JWKS fetch failure returns E_AUTH_UNAVAILABLE."""
        private_key, _ = rsa_keypair
        token = self.mint_token(private_key, str(uuid4()))

        def raise_timeout(*args, **kwargs):
            assert kwargs["timeout"] == verifier.fetch_timeout
            raise TimeoutError("timed out")

        with patch("jwt.jwks_client.urllib.request.urlopen", side_effect=raise_timeout) as urlopen:
            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

        assert exc_info.value.code == ApiErrorCode.E_AUTH_UNAVAILABLE
        assert urlopen.call_count == 1

    def test_jwks_invalid_response(self, verifier):
        """Test 11: JWKS invalid response returns E_AUTH_UNAVAILABLE."""
        from jwt.exceptions import PyJWKClientError

        token = "some.fake.token"

        with patch.object(verifier, "_get_jwks_client") as mock_client:
            mock_jwk_client = MagicMock()
            mock_jwk_client.get_signing_key_from_jwt.side_effect = PyJWKClientError(
                "Invalid JWKS response"
            )
            mock_client.return_value = mock_jwk_client

            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_AUTH_UNAVAILABLE

    def test_clock_skew_accepted(self, verifier, rsa_keypair):
        """Test 12: Token expired 30s ago (within clock skew) is accepted."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        # Token expired 30 seconds ago (within 60s clock skew)
        token = self.mint_token(private_key, user_id, exp=int(time.time()) - 30)

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            claims = verifier.verify(token)
            assert claims["sub"] == user_id

    def test_clock_skew_exceeded(self, verifier, rsa_keypair):
        """Test 13: Token expired 90s ago (beyond clock skew) is rejected."""
        private_key, _ = rsa_keypair
        user_id = str(uuid4())
        # Token expired 90 seconds ago (beyond 60s clock skew)
        token = self.mint_token(private_key, user_id, exp=int(time.time()) - 90)

        with self.signing_key_patch(verifier, rsa_keypair[1]):
            with pytest.raises(ApiError) as exc_info:
                verifier.verify(token)

            assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED


class TestMockJwtVerifier:
    """Tests for MockJwtVerifier."""

    def test_valid_token(self):
        """MockJwtVerifier accepts valid tokens."""
        verifier = MockJwtVerifier()
        user_id = str(uuid4())

        from tests.helpers import mint_test_token

        token = mint_test_token(user_id)
        claims = verifier.verify(token)

        assert claims["sub"] == user_id

    def test_expired_token(self):
        """MockJwtVerifier rejects expired tokens."""
        verifier = MockJwtVerifier()
        user_id = str(uuid4())

        from tests.helpers import mint_expired_token

        token = mint_expired_token(user_id)

        with pytest.raises(ApiError) as exc_info:
            verifier.verify(token)

        assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED

    def test_bad_signature(self):
        """MockJwtVerifier rejects tokens with bad signatures."""
        verifier = MockJwtVerifier()
        user_id = str(uuid4())

        from tests.helpers import mint_token_with_bad_signature

        token = mint_token_with_bad_signature(user_id)

        with pytest.raises(ApiError) as exc_info:
            verifier.verify(token)

        assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED

    def test_wrong_issuer(self):
        """MockJwtVerifier rejects tokens with wrong issuer."""
        verifier = MockJwtVerifier()
        user_id = str(uuid4())

        from tests.helpers import mint_test_token

        token = mint_test_token(user_id, issuer="wrong-issuer")

        with pytest.raises(ApiError) as exc_info:
            verifier.verify(token)

        assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED

    def test_wrong_audience(self):
        """MockJwtVerifier rejects tokens with wrong audience."""
        verifier = MockJwtVerifier()
        user_id = str(uuid4())

        from tests.helpers import mint_test_token

        token = mint_test_token(user_id, audience="wrong-audience")

        with pytest.raises(ApiError) as exc_info:
            verifier.verify(token)

        assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED

    def test_invalid_sub(self):
        """MockJwtVerifier rejects tokens with invalid sub (not UUID)."""
        verifier = MockJwtVerifier()

        from tests.helpers import mint_test_token

        token = mint_test_token("not-a-uuid")

        with pytest.raises(ApiError) as exc_info:
            verifier.verify(token)

        assert exc_info.value.code == ApiErrorCode.E_UNAUTHENTICATED
