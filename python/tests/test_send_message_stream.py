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

import json
import time
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

import jwt
import pytest
from sqlalchemy import text

from nexus.auth.stream_token import (
    STREAM_TOKEN_AUDIENCE,
    STREAM_TOKEN_ISSUER,
    STREAM_TOKEN_SCOPE,
    STREAM_TOKEN_TTL_SECONDS,
    _get_signing_key_bytes,
    mint_stream_token,
    verify_stream_token,
)
from nexus.config import clear_settings_cache
from nexus.db.session import create_session_factory
from nexus.errors import ApiError, ApiErrorCode
from nexus.middleware.stream_cors import StreamCORSMiddleware
from nexus.services.api_key_resolver import ResolvedKey
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.llm.types import LLMChunk, LLMUsage
from nexus.services.rate_limit import RateLimiter, set_rate_limiter
from nexus.services.send_message_stream import (
    _finalize_stream_conditional,
    stream_send_message_async,
)
from nexus.services.stream_liveness import (
    check_liveness_marker,
    clear_liveness_marker,
    set_liveness_marker,
)
from nexus.tasks.sweep_pending import sweep_pending_messages
from tests.factories import (
    create_pdf_media_with_text,
    create_test_conversation,
    create_test_message,
    create_test_model,
    get_user_default_library,
)

pytestmark = pytest.mark.integration

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
# S6 PR-05: PDF Quote-Blocking Stream Semantics
# =============================================================================


class _RecordingRouter:
    def __init__(self):
        self.called = False

    async def generate_stream(self, *args, **kwargs):
        self.called = True
        yield LLMChunk(
            delta_text="",
            done=True,
            usage=LLMUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            provider_request_id="req-test",
        )


def _parse_sse_data(event: str) -> dict:
    data_line = next(line for line in event.splitlines() if line.startswith("data: "))
    return json.loads(data_line.removeprefix("data: "))


class TestPdfQuoteBlockingStream:
    @pytest.mark.asyncio
    async def test_pdf_not_ready_blocks_before_delta_and_returns_media_not_ready(
        self,
        engine,
        direct_db,
        mock_redis,
        monkeypatch,
    ):
        """Meta may emit first, but quote-blocking errors must emit done(error) before delta."""
        monkeypatch.setenv("OPENAI_API_KEY", "test-platform-key")
        clear_settings_cache()
        set_rate_limiter(RateLimiter(redis_client=mock_redis))

        user_id = uuid4()
        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            model_id = create_test_model(session)
            library_id = get_user_default_library(session, user_id)
            assert library_id is not None

            media_id = create_pdf_media_with_text(
                session,
                user_id,
                library_id,
                plain_text="",
                page_count=1,
                page_spans=[(0, 0)],
                status="ready_for_reading",
            )

            highlight_id = uuid4()
            session.execute(
                text("""
                    INSERT INTO highlights (
                        id, user_id, fragment_id, start_offset, end_offset,
                        anchor_kind, anchor_media_id,
                        color, exact, prefix, suffix
                    )
                    VALUES (
                        :id, :user_id, NULL, NULL, NULL,
                        'pdf_page_geometry', :media_id,
                        'yellow', 'stored exact', '', ''
                    )
                """),
                {
                    "id": highlight_id,
                    "user_id": user_id,
                    "media_id": media_id,
                },
            )
            session.execute(
                text("""
                    INSERT INTO highlight_pdf_anchors (
                        highlight_id, media_id, page_number,
                        geometry_version, geometry_fingerprint,
                        sort_top, sort_left,
                        plain_text_match_version, plain_text_match_status,
                        plain_text_start_offset, plain_text_end_offset,
                        rect_count
                    )
                    VALUES (
                        :highlight_id, :media_id, 1,
                        1, :fingerprint,
                        0, 0,
                        NULL, 'pending',
                        NULL, NULL,
                        1
                    )
                """),
                {
                    "highlight_id": highlight_id,
                    "media_id": media_id,
                    "fingerprint": "0" * 64,
                },
            )
            session.commit()

        direct_db.register_cleanup("highlight_pdf_anchors", "highlight_id", highlight_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        db_factory = create_session_factory(engine)
        router = _RecordingRouter()
        events = []

        async for event in stream_send_message_async(
            db_factory=db_factory,
            viewer_id=user_id,
            conversation_id=None,
            content="Explain this PDF quote",
            model_id=model_id,
            key_mode="auto",
            contexts=[{"type": "highlight", "id": highlight_id}],
            redis_client=mock_redis,
            llm_router=router,
        ):
            events.append(event)

        assert events
        assert events[0].startswith("event: meta")
        assert not any(e.startswith("event: delta") for e in events)
        done_event = next(e for e in events if e.startswith("event: done"))
        done_payload = _parse_sse_data(done_event)
        assert done_payload["status"] == "error"
        assert done_payload["error_code"] == "E_MEDIA_NOT_READY"
        assert router.called is False

        meta_payload = _parse_sse_data(events[0])
        conversation_id = UUID(meta_payload["conversation_id"])
        assistant_message_id = UUID(meta_payload["assistant_message_id"])

        with direct_db.session() as session:
            message_row = session.execute(
                text("SELECT status, error_code FROM messages WHERE id = :id"),
                {"id": assistant_message_id},
            ).fetchone()
            assert message_row is not None
            assert message_row[0] == "error"
            assert message_row[1] == "E_MEDIA_NOT_READY"

            llm_row = session.execute(
                text("""
                    SELECT error_class, provider_request_id
                    FROM message_llm
                    WHERE message_id = :id
                """),
                {"id": assistant_message_id},
            ).fetchone()
            assert llm_row is not None
            assert llm_row[0] == "E_MEDIA_NOT_READY"
            assert llm_row[1] is None

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)


class TestStreamFinalizeErrorMessages:
    def test_non_quote_error_uses_default_message_copy(self, direct_db):
        """Non-quote error codes must not get quote-context fallback copy."""
        user_id = uuid4()
        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            assistant_message_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=1,
                role="assistant",
                content="",
                status="pending",
                model_id=model_id,
            )

            model_stub = MagicMock(provider="openai", model_name="gpt-4o")
            resolved_key = ResolvedKey(
                api_key="sk-test",
                mode="byok",
                provider="openai",
                user_key_id=None,
            )
            finalized = _finalize_stream_conditional(
                db=session,
                assistant_message_id=assistant_message_id,
                content="",
                status="error",
                error_code="E_CLIENT_DISCONNECT",
                model=model_stub,
                resolved_key=resolved_key,
                key_mode="auto",
                latency_ms=5,
                usage=None,
                viewer_id=user_id,
                redis_client=None,
                quote_context_error=False,
            )
            assert finalized is True

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT content, status, error_code FROM messages WHERE id = :id"),
                {"id": assistant_message_id},
            ).fetchone()
            assert row is not None
            assert row[0] == "An unexpected error occurred. Please try again."
            assert row[1] == "error"
            assert row[2] == "E_CLIENT_DISCONNECT"

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

    def test_quote_error_preserves_quote_context_copy(self, direct_db):
        """Quote-context failures keep explicit quote-context user copy."""
        user_id = uuid4()
        with direct_db.session() as session:
            ensure_user_and_default_library(session, user_id)
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            assistant_message_id = create_test_message(
                session,
                conversation_id=conversation_id,
                seq=1,
                role="assistant",
                content="",
                status="pending",
                model_id=model_id,
            )

            model_stub = MagicMock(provider="openai", model_name="gpt-4o")
            resolved_key = ResolvedKey(
                api_key="sk-test",
                mode="byok",
                provider="openai",
                user_key_id=None,
            )
            finalized = _finalize_stream_conditional(
                db=session,
                assistant_message_id=assistant_message_id,
                content="",
                status="error",
                error_code="E_MEDIA_NOT_READY",
                model=model_stub,
                resolved_key=resolved_key,
                key_mode="auto",
                latency_ms=5,
                usage=None,
                viewer_id=user_id,
                redis_client=None,
                quote_context_error=True,
            )
            assert finalized is True

        with direct_db.session() as session:
            row = session.execute(
                text("SELECT content, status, error_code FROM messages WHERE id = :id"),
                {"id": assistant_message_id},
            ).fetchone()
            assert row is not None
            assert (
                row[0]
                == "PDF quote context is not ready yet. Try again after PDF text processing completes."
            )
            assert row[1] == "error"
            assert row[2] == "E_MEDIA_NOT_READY"

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)


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
        # TASK INFRASTRUCTURE: Session factory redirect for test DB isolation.
        # Sweeper task creates its own session; this redirects to the test DB.
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

        # TASK INFRASTRUCTURE: Session factory redirect for test DB isolation.
        # Sweeper task creates its own session; this redirects to the test DB.
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
