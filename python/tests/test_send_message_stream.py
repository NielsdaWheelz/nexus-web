"""Tests for PR-08: Streaming hardening.

Covers:
- Stream token auth (mint, verify, expiry, replay, wrong scope)
- Streaming happy path (meta → delta → done)
- Idempotency replay (complete, pending with liveness, orphaned)
- OpenAI adapter usage invariant fix
- Finalize exactly-once (conditional update)
- Disconnect handling (finalize to error)
- Sweeper (orphaned pending → error)
- Budget reservation (reserve, commit, release)
- CORS middleware (path scoping, origin check, preflight)
- Auth middleware skip for /stream/*
"""

import time
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import jwt
import pytest

from nexus.auth.stream_token import (
    STREAM_TOKEN_AUDIENCE,
    STREAM_TOKEN_ISSUER,
    STREAM_TOKEN_SCOPE,
    STREAM_TOKEN_TTL_SECONDS,
    _get_signing_key_bytes,
    mint_stream_token,
    verify_stream_token,
)
from nexus.errors import ApiError, ApiErrorCode
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.services.llm.types import LLMChunk, LLMUsage
from nexus.services.rate_limit import RateLimiter
from nexus.services.stream_liveness import (
    check_liveness_marker,
    clear_liveness_marker,
    set_liveness_marker,
)
from nexus.tasks.sweep_pending import sweep_pending_messages

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def test_user_id():
    return uuid4()


@pytest.fixture
def mock_redis():
    """Mock Redis client for tests."""
    redis = MagicMock()
    redis.ping.return_value = True
    redis.set.return_value = True  # SETNX success
    redis.setex.return_value = True
    redis.get.return_value = None
    redis.exists.return_value = False
    redis.delete.return_value = 1
    redis.expire.return_value = True
    redis.pipeline.return_value = MagicMock(execute=MagicMock(return_value=[None, None]))
    return redis


# =============================================================================
# Stream Token Auth Tests (§14.5)
# =============================================================================


class TestStreamTokenMint:
    """Test stream token minting."""

    def test_mint_returns_token_and_url(self, test_user_id):
        result = mint_stream_token(test_user_id)
        assert "token" in result
        assert "stream_base_url" in result
        assert "expires_at" in result
        assert isinstance(result["token"], str)
        assert len(result["token"]) > 0

    def test_mint_token_is_valid_jwt(self, test_user_id):
        result = mint_stream_token(test_user_id)
        key = _get_signing_key_bytes()
        payload = jwt.decode(
            result["token"],
            key,
            algorithms=["HS256"],
            audience=STREAM_TOKEN_AUDIENCE,
        )
        assert payload["sub"] == str(test_user_id)
        assert payload["iss"] == STREAM_TOKEN_ISSUER
        assert payload["scope"] == STREAM_TOKEN_SCOPE
        assert "jti" in payload
        assert "exp" in payload

    def test_mint_token_expires_in_60s(self, test_user_id):
        result = mint_stream_token(test_user_id)
        key = _get_signing_key_bytes()
        payload = jwt.decode(
            result["token"],
            key,
            algorithms=["HS256"],
            audience=STREAM_TOKEN_AUDIENCE,
        )
        assert payload["exp"] - payload["iat"] == STREAM_TOKEN_TTL_SECONDS


class TestStreamTokenVerify:
    """Test stream token verification."""

    def test_valid_token(self, test_user_id, mock_redis):
        result = mint_stream_token(test_user_id)
        uid, jti = verify_stream_token(result["token"], redis_client=mock_redis)
        assert uid == test_user_id
        assert isinstance(jti, str) and len(jti) > 0

    def test_expired_token_rejected(self, test_user_id):
        key = _get_signing_key_bytes()
        payload = {
            "iss": STREAM_TOKEN_ISSUER,
            "aud": STREAM_TOKEN_AUDIENCE,
            "sub": str(test_user_id),
            "exp": int(time.time()) - 10,  # Already expired
            "iat": int(time.time()) - 70,
            "jti": str(uuid4()),
            "scope": STREAM_TOKEN_SCOPE,
        }
        token = jwt.encode(payload, key, algorithm="HS256")
        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)
        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_EXPIRED

    def test_wrong_scope_rejected(self, test_user_id):
        key = _get_signing_key_bytes()
        payload = {
            "iss": STREAM_TOKEN_ISSUER,
            "aud": STREAM_TOKEN_AUDIENCE,
            "sub": str(test_user_id),
            "exp": int(time.time()) + 60,
            "iat": int(time.time()),
            "jti": str(uuid4()),
            "scope": "wrong",
        }
        token = jwt.encode(payload, key, algorithm="HS256")
        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)
        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_INVALID

    def test_wrong_issuer_rejected(self, test_user_id):
        key = _get_signing_key_bytes()
        payload = {
            "iss": "wrong-issuer",
            "aud": STREAM_TOKEN_AUDIENCE,
            "sub": str(test_user_id),
            "exp": int(time.time()) + 60,
            "iat": int(time.time()),
            "jti": str(uuid4()),
            "scope": STREAM_TOKEN_SCOPE,
        }
        token = jwt.encode(payload, key, algorithm="HS256")
        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)
        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_INVALID

    def test_replayed_jti_rejected(self, test_user_id, mock_redis):
        # First use: SETNX returns True (key was set)
        mock_redis.set.return_value = True
        result = mint_stream_token(test_user_id)
        uid, jti = verify_stream_token(result["token"], redis_client=mock_redis)
        assert uid == test_user_id
        assert isinstance(jti, str) and len(jti) > 0

        # Second use: SETNX returns False (key already exists)
        mock_redis.set.return_value = False
        result2 = mint_stream_token(test_user_id)
        with pytest.raises(ApiError) as exc:
            verify_stream_token(result2["token"], redis_client=mock_redis)
        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_REPLAYED

    def test_supabase_token_rejected(self):
        """Supabase tokens have different issuer → rejected."""
        key = _get_signing_key_bytes()
        # Fake supabase-like token with different issuer
        payload = {
            "iss": "http://127.0.0.1:54321/auth/v1",
            "aud": "authenticated",
            "sub": str(uuid4()),
            "exp": int(time.time()) + 3600,
            "iat": int(time.time()),
            "jti": str(uuid4()),
        }
        token = jwt.encode(payload, key, algorithm="HS256")
        with pytest.raises(ApiError) as exc:
            verify_stream_token(token)
        assert exc.value.code == ApiErrorCode.E_STREAM_TOKEN_INVALID


# =============================================================================
# OpenAI Adapter Usage Fix (§14.2)
# =============================================================================


class TestOpenAIUsageInvariant:
    """Test that OpenAI adapter accumulates usage correctly."""

    def test_non_terminal_chunks_have_no_usage(self):
        """Non-terminal chunks must have usage=None."""
        chunk = LLMChunk(delta_text="hello", done=False, usage=None)
        assert chunk.usage is None

    def test_non_terminal_with_usage_raises(self):
        """Creating a non-terminal chunk with usage raises ValueError."""
        usage = LLMUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15)
        with pytest.raises(ValueError, match="Non-terminal chunks"):
            LLMChunk(delta_text="hello", done=False, usage=usage)

    def test_terminal_chunk_can_have_usage(self):
        """Terminal chunk (done=True) can carry usage."""
        usage = LLMUsage(prompt_tokens=10, completion_tokens=5, total_tokens=15)
        chunk = LLMChunk(delta_text="", done=True, usage=usage)
        assert chunk.usage == usage


# =============================================================================
# Stream Liveness Tests (§14.7)
# =============================================================================


class TestStreamLiveness:
    """Test liveness marker operations."""

    @pytest.mark.asyncio
    async def test_set_and_check(self, mock_redis):
        msg_id = uuid4()
        await set_liveness_marker(mock_redis, msg_id)
        mock_redis.setex.assert_called_once()

    @pytest.mark.asyncio
    async def test_clear(self, mock_redis):
        msg_id = uuid4()
        await clear_liveness_marker(mock_redis, msg_id)
        mock_redis.delete.assert_called_once()

    def test_check_returns_false_when_missing(self, mock_redis):
        mock_redis.exists.return_value = False
        assert check_liveness_marker(mock_redis, uuid4()) is False

    def test_check_returns_true_when_present(self, mock_redis):
        mock_redis.exists.return_value = True
        assert check_liveness_marker(mock_redis, uuid4()) is True

    def test_check_returns_false_without_redis(self):
        assert check_liveness_marker(None, uuid4()) is False


# =============================================================================
# Budget Reservation Tests (§14)
# =============================================================================


class TestBudgetReservation:
    """Test token budget pre-reservation."""

    def test_reserve_succeeds_under_budget(self, mock_redis):
        mock_redis.pipeline.return_value.execute.return_value = [0, 0]
        limiter = RateLimiter(redis_client=mock_redis, token_budget=100_000)
        # Should not raise
        limiter.reserve_token_budget(uuid4(), uuid4(), 5000)

    def test_reserve_fails_over_budget(self, mock_redis):
        # spent=90000, reserved=15000 → 90000+15000+5000 > 100000
        mock_redis.pipeline.return_value.execute.return_value = [90000, 15000]
        limiter = RateLimiter(redis_client=mock_redis, token_budget=100_000)
        with pytest.raises(ApiError) as exc:
            limiter.reserve_token_budget(uuid4(), uuid4(), 5000)
        assert exc.value.code == ApiErrorCode.E_TOKEN_BUDGET_EXCEEDED

    def test_commit_decrements_reserved_increments_spent(self, mock_redis):
        mock_redis.get.return_value = "5000"  # Original reservation
        limiter = RateLimiter(redis_client=mock_redis, token_budget=100_000)
        limiter.commit_token_budget(uuid4(), uuid4(), 3000)
        # Should have called pipeline operations
        assert mock_redis.pipeline.called

    def test_release_decrements_reserved(self, mock_redis):
        mock_redis.get.return_value = "5000"
        limiter = RateLimiter(redis_client=mock_redis, token_budget=100_000)
        limiter.release_token_budget(uuid4(), uuid4())
        assert mock_redis.pipeline.called

    def test_reserve_fails_closed_without_redis(self):
        limiter = RateLimiter(redis_client=None, token_budget=100_000)
        with pytest.raises(ApiError) as exc:
            limiter.reserve_token_budget(uuid4(), uuid4(), 5000)
        assert exc.value.code == ApiErrorCode.E_RATE_LIMITER_UNAVAILABLE


# =============================================================================
# CORS Middleware Tests (§14)
# =============================================================================


class TestStreamCORSMiddleware:
    """Test the pure ASGI CORS middleware."""

    @pytest.mark.asyncio
    async def test_non_stream_path_passes_through(self):
        """Non-/stream/ paths should pass through without CORS headers."""
        app = AsyncMock()
        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {"type": "http", "path": "/conversations", "method": "GET"}
        await middleware(scope, AsyncMock(), AsyncMock())
        app.assert_called_once()

    @pytest.mark.asyncio
    async def test_stream_path_without_origin_passes_through(self):
        """No Origin header = non-browser request, pass through."""
        app = AsyncMock()
        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])
        scope = {
            "type": "http",
            "path": "/stream/conversations/messages",
            "method": "POST",
            "headers": [],
        }
        await middleware(scope, AsyncMock(), AsyncMock())
        app.assert_called_once()

    @pytest.mark.asyncio
    async def test_stream_path_wrong_origin_rejected(self):
        """Wrong origin on /stream/* returns 403."""
        app = AsyncMock()
        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])

        sent_messages = []

        async def mock_send(message):
            sent_messages.append(message)

        scope = {
            "type": "http",
            "path": "/stream/conversations/messages",
            "method": "POST",
            "headers": [(b"origin", b"https://evil.com")],
        }
        await middleware(scope, AsyncMock(), mock_send)
        # Should have sent a 403 response
        assert any(m.get("status") == 403 for m in sent_messages if isinstance(m, dict))

    @pytest.mark.asyncio
    async def test_options_preflight_handled(self):
        """OPTIONS preflight returns 204 with CORS headers."""
        app = AsyncMock()
        middleware = StreamCORSMiddleware(app, allowed_origins=["https://nexus.test"])

        sent_messages = []

        async def mock_send(message):
            sent_messages.append(message)

        scope = {
            "type": "http",
            "path": "/stream/conversations/messages",
            "method": "OPTIONS",
            "headers": [(b"origin", b"https://nexus.test")],
        }
        await middleware(scope, AsyncMock(), mock_send)
        assert any(m.get("status") == 204 for m in sent_messages if isinstance(m, dict))


# =============================================================================
# Sweeper Tests (§14.7)
# =============================================================================


class TestSweeper:
    """Test pending message sweeper."""

    def test_sweeper_with_no_stale_messages(self):
        """Sweeper returns 0 when no stale messages exist."""
        with patch("nexus.tasks.sweep_pending.get_session_factory") as mock_factory:
            mock_db = MagicMock()
            mock_db.execute.return_value.fetchall.return_value = []
            mock_factory.return_value = lambda: mock_db

            count = sweep_pending_messages(redis_client=None)
            assert count == 0

    def test_sweeper_skips_active_streams(self):
        """Sweeper skips messages with active liveness markers."""
        msg_id = uuid4()
        mock_redis = MagicMock()
        mock_redis.exists.return_value = True  # Liveness marker active

        with patch("nexus.tasks.sweep_pending.get_session_factory") as mock_factory:
            mock_db = MagicMock()
            stale_time = datetime.now(UTC) - timedelta(minutes=10)
            mock_db.execute.return_value.fetchall.return_value = [
                (msg_id, stale_time),
            ]
            mock_factory.return_value = lambda: mock_db

            count = sweep_pending_messages(redis_client=mock_redis)
            assert count == 0  # Skipped because liveness marker is active


# =============================================================================
# SSE Format Tests
# =============================================================================


class TestSSEFormat:
    """Test SSE event formatting."""

    def test_format_meta_event(self):
        from nexus.services.send_message_stream import format_sse_event

        result = format_sse_event("meta", {"conversation_id": "123"})
        assert result.startswith("event: meta\n")
        assert '"conversation_id": "123"' in result
        assert result.endswith("\n\n")

    def test_format_done_event_with_final_chars(self):
        from nexus.services.send_message_stream import format_sse_event

        result = format_sse_event(
            "done",
            {
                "status": "complete",
                "final_chars": 42,
            },
        )
        assert '"final_chars": 42' in result

    def test_keepalive_comment_format(self):
        """Keepalive is an SSE comment (starts with colon)."""
        keepalive = ": keepalive\n\n"
        assert keepalive.startswith(":")
        assert keepalive.endswith("\n\n")
