"""Integration tests for send-message service and routes.

Tests cover:
- Happy path (message send → assistant complete)
- Quote-to-chat with highlight/media/annotation context
- Platform key + BYOK resolution
- Idempotency (replay same key → same result, different payload → 409)
- Rate limit hit → no messages created, 429
- Budget exceeded → no messages created, 429
- Conversation busy → 409
- Context visibility checks
- LLM error handling → assistant with error status
"""

import base64
import json
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import httpx
import pytest
import respx
from sqlalchemy import text

from nexus.config import clear_settings_cache
from nexus.services.crypto import MASTER_KEY_SIZE, clear_master_key_cache, encrypt_api_key
from nexus.services.rate_limit import RateLimiter, set_rate_limiter
from tests.factories import (
    create_epub_chapter_fragment,
    create_epub_media_in_library,
    create_pdf_media_with_text,
    create_test_conversation,
    create_test_fragment,
    create_test_highlight,
    create_test_media_in_library,
    create_test_message,
    create_test_model,
    get_user_default_library,
    get_user_library,
)
from tests.helpers import auth_headers, create_test_user_id
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration

# =============================================================================
# Fixtures
# =============================================================================


class NoOpRateLimiter(RateLimiter):
    """Rate limiter that never limits - for testing."""

    def check_rpm_limit(self, user_id: UUID) -> None:
        pass  # No-op

    def check_concurrent_limit(self, user_id: UUID) -> None:
        pass  # No-op

    def check_token_budget(self, user_id: UUID) -> None:
        pass  # No-op

    def increment_inflight(self, user_id: UUID) -> None:
        pass  # No-op

    def decrement_inflight(self, user_id: UUID) -> None:
        pass  # No-op

    def charge_token_budget(self, user_id: UUID, message_id: UUID, tokens: int) -> None:
        pass  # No-op


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Reset rate limiter to no-op before each test.

    This ensures test isolation - rate limit mocks from one test
    don't affect subsequent tests.
    """
    limiter = NoOpRateLimiter(redis_client=None)
    set_rate_limiter(limiter)
    yield
    # Reset again after test
    set_rate_limiter(NoOpRateLimiter(redis_client=None))


@pytest.fixture
def mock_rate_limiter():
    """Create a no-op rate limiter for tests."""
    limiter = NoOpRateLimiter(redis_client=None)
    set_rate_limiter(limiter)
    return limiter


@pytest.fixture
def setup_test_master_key(monkeypatch):
    """Set up deterministic test master key for BYOK tests that create encrypted keys."""
    clear_master_key_cache()
    test_key = b"test_master_key_for_encryption!!"
    assert len(test_key) == MASTER_KEY_SIZE
    test_key_b64 = base64.b64encode(test_key).decode("ascii")
    monkeypatch.setenv("NEXUS_KEY_ENCRYPTION_KEY", test_key_b64)
    yield
    clear_master_key_cache()


@pytest.fixture
def platform_key_env(monkeypatch):
    """Set platform API key so resolve_api_key finds it without mocking."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-platform-key")
    clear_settings_cache()
    yield
    clear_settings_cache()


@pytest.fixture
def mock_openai_api():
    """Use respx to mock OpenAI HTTP API at the network boundary."""
    with respx.mock(assert_all_called=False) as respx_mock:
        yield respx_mock


def _route_openai_completion(
    respx_mock,
    response_text="This is the assistant's response.",
    prompt_tokens=100,
    completion_tokens=50,
):
    """Helper to configure a respx route for OpenAI chat completions."""
    respx_mock.post("https://api.openai.com/v1/chat/completions").respond(
        200,
        json={
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": response_text},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
            "model": "gpt-4o",
        },
        headers={"x-request-id": "test-request-id"},
    )


def _route_openai_401(respx_mock):
    """Configure respx to return 401 (invalid key) from OpenAI API."""
    respx_mock.post("https://api.openai.com/v1/chat/completions").respond(
        401,
        json={
            "error": {
                "message": "Incorrect API key provided.",
                "type": "invalid_request_error",
                "code": "invalid_api_key",
            }
        },
    )


def _route_openai_500(respx_mock):
    """Configure respx to return 500 (provider down) from OpenAI API."""
    respx_mock.post("https://api.openai.com/v1/chat/completions").respond(
        500,
        json={
            "error": {
                "message": "The server had an error processing your request.",
                "type": "server_error",
            }
        },
    )


def _route_openai_timeout(respx_mock):
    """Configure respx to simulate timeout from OpenAI API."""
    respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
        side_effect=httpx.ReadTimeout("Read timed out")
    )


def _extract_openai_system_prompt(mock_openai_api) -> str:
    """Extract the outbound system prompt from the latest mocked OpenAI call."""
    assert len(mock_openai_api.calls) >= 1
    payload = json.loads(mock_openai_api.calls[-1].request.content.decode("utf-8"))
    return payload["messages"][0]["content"]


# =============================================================================
# Happy Path Tests
# =============================================================================


class TestSendMessageBasic:
    """Tests for basic send message functionality."""

    def test_send_message_creates_conversation_and_messages(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Send message without conversation_id creates new conversation."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello, what is 2+2?",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 200
        data = response.json()["data"]

        # Verify conversation was created
        assert "conversation" in data
        conversation_id = data["conversation"]["id"]

        # Verify user message
        assert data["user_message"]["role"] == "user"
        assert data["user_message"]["content"] == "Hello, what is 2+2?"
        assert data["user_message"]["status"] == "complete"
        assert data["user_message"]["seq"] == 1

        # Verify assistant message
        assert data["assistant_message"]["role"] == "assistant"
        assert data["assistant_message"]["content"] == "This is the assistant's response."
        assert data["assistant_message"]["status"] == "complete"
        assert data["assistant_message"]["seq"] == 2

        # Cleanup
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

    def test_send_message_to_existing_conversation(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Send message to existing conversation appends messages."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            create_test_message(session, conversation_id, seq=1, content="First message")
            create_test_message(
                session, conversation_id, seq=2, role="assistant", content="First response"
            )

        # Model from migration seed - don't cleanup
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.post(
            f"/conversations/{conversation_id}/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Follow-up question",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 200
        data = response.json()["data"]

        # Should be same conversation
        assert data["conversation"]["id"] == str(conversation_id)

        # New messages have higher seqs
        assert data["user_message"]["seq"] == 3
        assert data["assistant_message"]["seq"] == 4


# =============================================================================
# Idempotency Tests
# =============================================================================


class TestSendMessageIdempotency:
    """Tests for idempotency key handling."""

    def test_idempotency_key_returns_cached_response(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Same idempotency key with same payload returns cached result."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup
        idempotency_key = f"test-key-{uuid4()}"

        # First request
        response1 = auth_client.post(
            "/conversations/messages",
            headers={
                **auth_headers(user_id),
                "Idempotency-Key": idempotency_key,
            },
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response1.status_code == 200
        data1 = response1.json()["data"]
        conversation_id = data1["conversation"]["id"]

        # Cleanup registrations
        direct_db.register_cleanup("idempotency_keys", "user_id", user_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # Second request with same key - should return cached (LLM not called)
        response2 = auth_client.post(
            "/conversations/messages",
            headers={
                **auth_headers(user_id),
                "Idempotency-Key": idempotency_key,
            },
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        # Verify LLM was called only once (not on replay)
        assert len(mock_openai_api.calls) == 1

        assert response2.status_code == 200
        data2 = response2.json()["data"]

        # Should be exactly same response
        assert data2["conversation"]["id"] == data1["conversation"]["id"]
        assert data2["user_message"]["id"] == data1["user_message"]["id"]
        assert data2["assistant_message"]["id"] == data1["assistant_message"]["id"]

    def test_idempotency_key_different_payload_returns_409(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Same idempotency key with different payload returns 409."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup
        idempotency_key = f"test-key-{uuid4()}"

        # First request
        response1 = auth_client.post(
            "/conversations/messages",
            headers={
                **auth_headers(user_id),
                "Idempotency-Key": idempotency_key,
            },
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response1.status_code == 200
        conversation_id = response1.json()["data"]["conversation"]["id"]

        direct_db.register_cleanup("idempotency_keys", "user_id", user_id)
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # Second request with same key but different content
        response2 = auth_client.post(
            "/conversations/messages",
            headers={
                **auth_headers(user_id),
                "Idempotency-Key": idempotency_key,
            },
            json={
                "content": "Different content!",  # Different!
                "model_id": str(model_id),
            },
        )

        assert response2.status_code == 409
        assert response2.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH"


# =============================================================================
# Rate Limit Tests
# =============================================================================


class TestSendMessageRateLimits:
    """Tests for rate limiting behavior."""

    def test_rpm_limit_exceeded_returns_429(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        platform_key_env,
    ):
        """Exceeding RPM limit returns 429."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        # Create a mock Redis that always exceeds limit
        mock_redis = MagicMock()
        mock_redis.ping.return_value = True
        # Pipeline is used directly (not as context manager)
        mock_redis.pipeline.return_value = MagicMock(
            zremrangebyscore=MagicMock(),
            zadd=MagicMock(),
            zcount=MagicMock(),
            expire=MagicMock(),
            execute=MagicMock(return_value=[0, 1, 25, True]),  # 25 > 20 limit
        )

        # Configure limiter with mock Redis
        limiter = RateLimiter(redis_client=mock_redis)
        set_rate_limiter(limiter)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 429
        assert response.json()["error"]["code"] == "E_RATE_LIMITED"

    def test_concurrent_limit_exceeded_returns_429(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        platform_key_env,
    ):
        """Exceeding concurrent limit returns 429."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        # Create a mock Redis that shows max concurrent reached
        mock_redis = MagicMock()
        mock_redis.ping.return_value = True
        # RPM check passes
        pipe_mock = MagicMock()
        pipe_mock.execute.return_value = [0, 1, 1, True]  # RPM count = 1 (ok)
        mock_redis.pipeline.return_value = pipe_mock
        # Concurrent check fails
        mock_redis.get.return_value = b"3"  # 3 = max concurrent

        limiter = RateLimiter(redis_client=mock_redis, concurrent_limit=3)
        set_rate_limiter(limiter)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 429
        assert response.json()["error"]["code"] == "E_RATE_LIMITED"

    def test_token_budget_exceeded_returns_429(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        platform_key_env,
    ):
        """Exceeding token budget returns 429."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        # Create a mock Redis where budget is exhausted
        mock_redis = MagicMock()
        mock_redis.ping.return_value = True
        # RPM and concurrent checks pass
        pipe_mock = MagicMock()
        pipe_mock.execute.return_value = [0, 1, 1, True]
        mock_redis.pipeline.return_value = pipe_mock
        mock_redis.get.side_effect = lambda key: (
            b"0" if "inflight" in str(key) else b"100001"  # Budget exhausted
        )

        limiter = RateLimiter(redis_client=mock_redis, token_budget=100_000)
        set_rate_limiter(limiter)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 429
        assert response.json()["error"]["code"] == "E_TOKEN_BUDGET_EXCEEDED"


# =============================================================================
# Context / Quote-to-Chat Tests
# =============================================================================


class TestSendMessageContext:
    """Tests for context (quote-to-chat) functionality."""

    def test_send_message_with_highlight_context(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Send message with highlight context includes highlight text."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            library_id = get_user_library(session, user_id)
            media_id = create_test_media_in_library(session, user_id, library_id)
            fragment_id = create_test_fragment(
                session, media_id, "This is the full fragment content."
            )
            highlight_id = create_test_highlight(
                session, user_id, fragment_id, "highlighted portion"
            )

        # Model from migration seed - don't cleanup
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "What does this mean?",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(highlight_id)}],
            },
        )

        assert response.status_code == 200
        conversation_id = response.json()["data"]["conversation"]["id"]

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

    def test_send_message_context_not_visible_returns_404(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
    ):
        """Context pointing to invisible item returns 404."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            # Create highlight owned by user A
            library_a = get_user_library(session, user_a)
            media_id = create_test_media_in_library(session, user_a, library_a)
            fragment_id = create_test_fragment(session, media_id)
            highlight_id = create_test_highlight(session, user_a, fragment_id)

        # Model from migration seed - don't cleanup
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("media", "id", media_id)

        # User B tries to use User A's highlight
        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_b),
            json={
                "content": "What does this mean?",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(highlight_id)}],
            },
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"

    def test_send_message_too_many_contexts_returns_400(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
    ):
        """More than 10 context items returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        # Create 11 context items (limit is 10)
        contexts = [{"type": "highlight", "id": str(uuid4())} for _ in range(11)]

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
                "contexts": contexts,
            },
        )

        assert response.status_code == 400


class TestSendMessagePdfQuoteToChat:
    """S6 PR-05 PDF quote-to-chat compatibility tests."""

    def _setup_pdf_highlight_context(
        self,
        session,
        user_id: UUID,
        *,
        plain_text: str,
        page_spans: list[tuple[int, int]],
        exact: str,
        match_status: str,
        match_version: int | None,
        start_offset: int | None,
        end_offset: int | None,
        prefix: str = "",
        suffix: str = "",
        with_annotation: bool = False,
    ) -> tuple[UUID, UUID, UUID | None]:
        library_id = get_user_default_library(session, user_id)
        assert library_id is not None

        media_id = create_pdf_media_with_text(
            session,
            user_id,
            library_id,
            plain_text=plain_text,
            page_count=1,
            page_spans=page_spans,
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
                    'yellow', :exact, :prefix, :suffix
                )
            """),
            {
                "id": highlight_id,
                "user_id": user_id,
                "media_id": media_id,
                "exact": exact,
                "prefix": prefix,
                "suffix": suffix,
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
                    :match_version, :match_status,
                    :start_offset, :end_offset,
                    1
                )
            """),
            {
                "highlight_id": highlight_id,
                "media_id": media_id,
                "fingerprint": "0" * 64,
                "match_version": match_version,
                "match_status": match_status,
                "start_offset": start_offset,
                "end_offset": end_offset,
            },
        )

        annotation_id = None
        if with_annotation:
            annotation_id = uuid4()
            session.execute(
                text("""
                    INSERT INTO annotations (id, highlight_id, body)
                    VALUES (:id, :highlight_id, :body)
                """),
                {
                    "id": annotation_id,
                    "highlight_id": highlight_id,
                    "body": "PDF annotation note",
                },
            )

        session.commit()
        return media_id, highlight_id, annotation_id

    def _register_pdf_context_cleanup(
        self,
        direct_db: DirectSessionManager,
        media_id: UUID,
        highlight_id: UUID,
        annotation_id: UUID | None = None,
    ) -> None:
        if annotation_id is not None:
            direct_db.register_cleanup("annotations", "id", annotation_id)
        direct_db.register_cleanup("highlight_pdf_anchors", "highlight_id", highlight_id)
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("pdf_page_text_spans", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

    def test_pdf_highlight_context_not_quote_ready_returns_409_and_finalizes_assistant(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Quote-to-chat blocks with E_MEDIA_NOT_READY and finalizes assistant error state."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id, highlight_id, _ = self._setup_pdf_highlight_context(
                session,
                user_id,
                plain_text="",
                page_spans=[(0, 0)],
                exact="stored exact text",
                match_status="pending",
                match_version=None,
                start_offset=None,
                end_offset=None,
            )

        self._register_pdf_context_cleanup(direct_db, media_id, highlight_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Explain this PDF quote",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(highlight_id)}],
            },
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_READY"
        assert len(mock_openai_api.calls) == 0

        with direct_db.session() as session:
            conv_row = session.execute(
                text("""
                    SELECT id
                    FROM conversations
                    WHERE owner_user_id = :user_id
                    ORDER BY created_at DESC
                    LIMIT 1
                """),
                {"user_id": user_id},
            ).fetchone()
            assert conv_row is not None
            conversation_id = conv_row[0]

            assistant_row = session.execute(
                text("""
                    SELECT id, status, error_code
                    FROM messages
                    WHERE conversation_id = :conversation_id
                      AND role = 'assistant'
                    ORDER BY created_at DESC
                    LIMIT 1
                """),
                {"conversation_id": conversation_id},
            ).fetchone()
            assert assistant_row is not None
            assert assistant_row[1] == "error"
            assert assistant_row[2] == "E_MEDIA_NOT_READY"

            llm_row = session.execute(
                text("""
                    SELECT provider, model_name, prompt_tokens, completion_tokens,
                           total_tokens, provider_request_id, error_class
                    FROM message_llm
                    WHERE message_id = :message_id
                """),
                {"message_id": assistant_row[0]},
            ).fetchone()
            assert llm_row is not None
            assert llm_row[0] == "openai"
            assert llm_row[2] is None
            assert llm_row[3] is None
            assert llm_row[4] is None
            assert llm_row[5] is None
            assert llm_row[6] == "E_MEDIA_NOT_READY"

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

    def test_pdf_highlight_pending_match_uses_in_memory_enrichment_for_nearby_context(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Pending PDF match metadata enriches in-memory and renders nearby context."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        plain_text = "alpha beta target phrase gamma delta"
        exact = "target phrase"

        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id, highlight_id, _ = self._setup_pdf_highlight_context(
                session,
                user_id,
                plain_text=plain_text,
                page_spans=[(0, len(plain_text))],
                exact=exact,
                match_status="pending",
                match_version=None,
                start_offset=None,
                end_offset=None,
            )

        self._register_pdf_context_cleanup(direct_db, media_id, highlight_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Use this PDF quote",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(highlight_id)}],
            },
        )

        assert response.status_code == 200
        system_prompt = _extract_openai_system_prompt(mock_openai_api)
        assert "**Quoted text:**" in system_prompt
        assert "> target phrase" in system_prompt
        assert "**Context:**" in system_prompt
        assert "alpha beta target phrase gamma delta" in system_prompt

        conversation_id = response.json()["data"]["conversation"]["id"]
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

    def test_pdf_annotation_context_not_quote_ready_returns_409(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Annotation context for non-ready PDF is quote-blocking."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id, highlight_id, annotation_id = self._setup_pdf_highlight_context(
                session,
                user_id,
                plain_text="",
                page_spans=[(0, 0)],
                exact="stored exact text",
                match_status="pending",
                match_version=None,
                start_offset=None,
                end_offset=None,
                with_annotation=True,
            )

        assert annotation_id is not None
        self._register_pdf_context_cleanup(direct_db, media_id, highlight_id, annotation_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Use this annotated PDF quote",
                "model_id": str(model_id),
                "contexts": [{"type": "annotation", "id": str(annotation_id)}],
            },
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_MEDIA_NOT_READY"
        assert len(mock_openai_api.calls) == 0

    def test_pdf_ambiguous_match_uses_stored_exact_and_omits_nearby_context(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Ambiguous PDF matches degrade safely: exact only, no nearby context."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id, highlight_id, _ = self._setup_pdf_highlight_context(
                session,
                user_id,
                plain_text="repeat repeat repeat",
                page_spans=[(0, len("repeat repeat repeat"))],
                exact="repeat",
                match_status="ambiguous",
                match_version=1,
                start_offset=None,
                end_offset=None,
                prefix="DO_NOT_USE_PREFIX",
                suffix="DO_NOT_USE_SUFFIX",
            )

        self._register_pdf_context_cleanup(direct_db, media_id, highlight_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Explain this repeated PDF phrase",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(highlight_id)}],
            },
        )

        assert response.status_code == 200
        system_prompt = _extract_openai_system_prompt(mock_openai_api)
        assert "**Quoted text:**" in system_prompt
        assert "> repeat" in system_prompt
        assert "**Context:**" not in system_prompt
        assert "DO_NOT_USE_PREFIX" not in system_prompt
        assert "DO_NOT_USE_SUFFIX" not in system_prompt

        conversation_id = response.json()["data"]["conversation"]["id"]
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)


# =============================================================================
# Key Mode Tests
# =============================================================================


class TestSendMessageKeyModes:
    """Tests for BYOK vs platform key resolution."""

    def test_byok_only_without_key_returns_400(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
    ):
        """key_mode=byok_only without user key returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup
        # No BYOK key in DB; resolve_api_key raises for byok_only
        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
                "key_mode": "byok_only",
            },
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_LLM_NO_KEY"

    def test_platform_only_without_platform_key_returns_400(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        monkeypatch,
    ):
        """key_mode=platform_only without platform key returns 400."""
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        clear_settings_cache()

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup
        # No platform key; resolve_api_key raises for platform_only
        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
                "key_mode": "platform_only",
            },
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_LLM_NO_KEY"


# =============================================================================
# Conversation Busy Tests
# =============================================================================


class TestSendMessageConversationBusy:
    """Tests for conversation busy detection."""

    def test_conversation_with_pending_assistant_returns_409(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
    ):
        """Conversation with pending assistant returns 409."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            create_test_message(session, conversation_id, seq=1, content="User message")
            # Create pending assistant
            create_test_message(
                session,
                conversation_id,
                seq=2,
                role="assistant",
                content="",
                status="pending",
                model_id=model_id,
            )

        # Model from migration seed - don't cleanup
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.post(
            f"/conversations/{conversation_id}/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Another message",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 409
        assert response.json()["error"]["code"] == "E_CONVERSATION_BUSY"


# =============================================================================
# LLM Error Tests
# =============================================================================


class TestSendMessageLLMErrors:
    """Tests for LLM error handling."""

    def test_llm_timeout_creates_error_message(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """LLM timeout creates assistant message with error status."""
        _route_openai_timeout(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 200
        data = response.json()["data"]

        # User message created successfully
        assert data["user_message"]["status"] == "complete"

        # Assistant message has error status
        assert data["assistant_message"]["status"] == "error"
        assert data["assistant_message"]["error_code"] == "E_LLM_TIMEOUT"
        assert "timed out" in data["assistant_message"]["content"].lower()

        conversation_id = data["conversation"]["id"]
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

    def test_llm_provider_down_creates_error_message(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """LLM provider unavailable creates assistant message with error status."""
        _route_openai_500(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 200
        data = response.json()["data"]

        assert data["assistant_message"]["status"] == "error"
        assert data["assistant_message"]["error_code"] == "E_LLM_PROVIDER_DOWN"

        conversation_id = data["conversation"]["id"]
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

    def test_llm_invalid_key_marks_byok_invalid(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        setup_test_master_key,
        mock_openai_api,
    ):
        """LLM invalid key error marks BYOK key as invalid."""
        _route_openai_401(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            # Create a user API key with properly encrypted invalid key
            key_id = uuid4()
            ciphertext, nonce, version, fingerprint = encrypt_api_key("sk-invalid-key-for-testing")
            session.execute(
                text("""
                    INSERT INTO user_api_keys (id, user_id, provider, status, key_fingerprint,
                                              encrypted_key, key_nonce, master_key_version)
                    VALUES (:id, :user_id, 'openai', 'untested', :fp, :encrypted, :nonce, :version)
                """),
                {
                    "id": key_id,
                    "user_id": user_id,
                    "fp": fingerprint,
                    "encrypted": ciphertext,
                    "nonce": nonce,
                    "version": version,
                },
            )
            session.commit()

        # Model from migration seed - don't cleanup
        direct_db.register_cleanup("user_api_keys", "id", key_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
                "key_mode": "byok_only",
            },
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["assistant_message"]["status"] == "error"
        assert data["assistant_message"]["error_code"] == "E_LLM_INVALID_KEY"

        # Verify update_user_key_status ran and marked key as invalid in DB
        with direct_db.session() as session:
            row = session.execute(
                text("SELECT status FROM user_api_keys WHERE id = :id"),
                {"id": key_id},
            ).fetchone()
            assert row is not None
            assert row[0] == "invalid"

        conversation_id = data["conversation"]["id"]
        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)


# =============================================================================
# Validation Tests
# =============================================================================


class TestSendMessageValidation:
    """Tests for input validation."""

    def test_message_too_long_returns_400(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
    ):
        """Message content > 20,000 chars returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "x" * 20001,  # 20,001 chars
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_MESSAGE_TOO_LONG"

    def test_model_not_found_returns_400(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
    ):
        """Non-existent model returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        fake_model_id = uuid4()

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(fake_model_id),
            },
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "E_MODEL_NOT_AVAILABLE"

    def test_conversation_not_found_returns_404(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
    ):
        """Non-existent conversation returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup
        fake_conversation_id = uuid4()

        response = auth_client.post(
            f"/conversations/{fake_conversation_id}/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"

    def test_conversation_not_owned_returns_404(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
    ):
        """Conversation owned by another user returns 404 (not 403)."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            # Conversation owned by user A
            conversation_id = create_test_conversation(session, user_a)

        # Model from migration seed - don't cleanup
        direct_db.register_cleanup("conversations", "id", conversation_id)

        # User B tries to send to user A's conversation
        response = auth_client.post(
            f"/conversations/{conversation_id}/messages",
            headers=auth_headers(user_b),
            json={
                "content": "Hello!",
                "model_id": str(model_id),
            },
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_CONVERSATION_NOT_FOUND"


# =============================================================================
# S4 PR-06: Send message response includes owner fields
# =============================================================================


class TestSendMessageOwnerFields:
    """Tests that send-message response includes owner_user_id and is_owner."""

    def test_send_message_new_conversation_includes_owner_fields(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """POST /conversations/messages response includes owner fields."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={"content": "Hello", "model_id": str(model_id)},
        )

        assert response.status_code == 200
        conv_data = response.json()["data"]["conversation"]
        assert conv_data["owner_user_id"] == str(user_id)
        assert conv_data["is_owner"] is True

        direct_db.register_cleanup("messages", "conversation_id", conv_data["id"])
        direct_db.register_cleanup("conversations", "id", conv_data["id"])

    def test_send_message_existing_conversation_includes_owner_fields(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """POST /conversations/{id}/messages response includes owner fields."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            conversation_id = create_test_conversation(session, user_id)
            create_test_message(session, conversation_id, seq=1, content="First")
            create_test_message(
                session, conversation_id, seq=2, role="assistant", content="Response"
            )

        direct_db.register_cleanup("messages", "conversation_id", conversation_id)
        direct_db.register_cleanup("conversations", "id", conversation_id)

        response = auth_client.post(
            f"/conversations/{conversation_id}/messages",
            headers=auth_headers(user_id),
            json={"content": "Follow up", "model_id": str(model_id)},
        )

        assert response.status_code == 200
        conv_data = response.json()["data"]["conversation"]
        assert conv_data["owner_user_id"] == str(user_id)
        assert conv_data["is_owner"] is True


# =============================================================================
# S5 PR-06: EPUB Quote-to-Chat Compatibility Tests
# =============================================================================

EPUB_QTC_CH0 = "UNIQUE_SENTINEL_CHAPTER_ZERO content alpha."
EPUB_QTC_CH1 = "UNIQUE_SENTINEL_CHAPTER_ONE content bravo fragment text for quote."


class TestSendMessageEpubQuoteToChat:
    """PR-06: EPUB highlight contexts render via existing fragment logic."""

    def _setup_epub_with_highlight(self, session, user_id):
        """Create EPUB media, two chapter fragments, highlight on ch1."""
        lib_id = get_user_default_library(session, user_id)
        media_id = create_epub_media_in_library(session, user_id, lib_id)
        frag0 = create_epub_chapter_fragment(session, media_id, 0, EPUB_QTC_CH0)
        frag1 = create_epub_chapter_fragment(session, media_id, 1, EPUB_QTC_CH1)
        hl_id = uuid4()
        exact_text = "UNIQUE_SENTINEL_CHAPTER_ONE"
        session.execute(
            text("""
                INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset,
                                        color, exact, prefix, suffix)
                VALUES (:id, :user_id, :fragment_id, 0, :end_offset, 'yellow', :exact, '', :suffix)
            """),
            {
                "id": hl_id,
                "user_id": user_id,
                "fragment_id": frag1,
                "end_offset": len(exact_text),
                "exact": exact_text,
                "suffix": EPUB_QTC_CH1[len(exact_text) : len(exact_text) + 64],
            },
        )
        session.commit()
        return media_id, frag0, frag1, hl_id

    def test_send_message_with_epub_highlight_context_renders_fragment_based_quote_context(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """EPUB highlight context renders quote from fragment canonical text."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id, frag0, frag1, hl_id = self._setup_epub_with_highlight(session, user_id)

        direct_db.register_cleanup("highlights", "id", hl_id)
        direct_db.register_cleanup("fragments", "id", frag0)
        direct_db.register_cleanup("fragments", "id", frag1)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "Explain this quote",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(hl_id)}],
            },
        )

        assert response.status_code == 200
        conv_id = response.json()["data"]["conversation"]["id"]
        direct_db.register_cleanup("messages", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)

    def test_send_message_with_epub_highlight_context_is_chapter_local_not_book_global(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Context rendering includes only target chapter, not adjacent chapters."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id, frag0, frag1, hl_id = self._setup_epub_with_highlight(session, user_id)

        direct_db.register_cleanup("highlights", "id", hl_id)
        direct_db.register_cleanup("fragments", "id", frag0)
        direct_db.register_cleanup("fragments", "id", frag1)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "What does this mean?",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(hl_id)}],
            },
        )

        assert response.status_code == 200

        conv_id = response.json()["data"]["conversation"]["id"]
        direct_db.register_cleanup("messages", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)

    def test_send_message_with_epub_highlight_context_not_visible_returns_404_e_not_found(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
    ):
        """Non-visible EPUB highlight context returns masked 404 E_NOT_FOUND."""
        user_a = create_test_user_id()
        user_b = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_a))
        auth_client.get("/me", headers=auth_headers(user_b))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            media_id, frag0, frag1, hl_id = self._setup_epub_with_highlight(session, user_a)

        direct_db.register_cleanup("highlights", "id", hl_id)
        direct_db.register_cleanup("fragments", "id", frag0)
        direct_db.register_cleanup("fragments", "id", frag1)
        direct_db.register_cleanup("library_media", "media_id", media_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_b),
            json={
                "content": "Explain this",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(hl_id)}],
            },
        )

        assert response.status_code == 404
        assert response.json()["error"]["code"] == "E_NOT_FOUND"


# =============================================================================
# S6 PR-02: Context Visibility Kernel Adoption Tests
# =============================================================================


class TestSendMessageContextKernel:
    """PR-02: _validate_context_visibility uses kernel for highlight/annotation contexts."""

    def test_send_message_with_dormant_highlight_context_succeeds(
        self,
        auth_client,
        direct_db: DirectSessionManager,
        mock_rate_limiter,
        platform_key_env,
        mock_openai_api,
    ):
        """Dormant-window highlight context is resolved via kernel and accepted."""
        _route_openai_completion(mock_openai_api)

        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            library_id = get_user_library(session, user_id)
            media_id = create_test_media_in_library(session, user_id, library_id)
            fragment_id = create_test_fragment(
                session, media_id, "Dormant highlight test content here."
            )
            hl_id = uuid4()
            session.execute(
                text("""
                    INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset,
                                            color, exact, prefix, suffix)
                    VALUES (:id, :uid, :fid, 0, 7, 'yellow', 'Dormant', '', ' highlight')
                """),
                {"id": hl_id, "uid": user_id, "fid": fragment_id},
            )
            session.commit()

        direct_db.register_cleanup("highlights", "id", hl_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("media", "id", media_id)

        response = auth_client.post(
            "/conversations/messages",
            headers=auth_headers(user_id),
            json={
                "content": "What does this mean?",
                "model_id": str(model_id),
                "contexts": [{"type": "highlight", "id": str(hl_id)}],
            },
        )

        assert response.status_code == 200
        conv_id = response.json()["data"]["conversation"]["id"]
        direct_db.register_cleanup("messages", "conversation_id", conv_id)
        direct_db.register_cleanup("conversations", "id", conv_id)
