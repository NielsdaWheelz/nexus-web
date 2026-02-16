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

from unittest.mock import MagicMock, patch
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.app import create_app
from nexus.auth.middleware import AuthMiddleware
from nexus.db.session import create_session_factory
from nexus.services.api_key_resolver import ResolvedKey
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.llm.errors import LLMError, LLMErrorClass
from nexus.services.llm.types import LLMResponse, LLMUsage
from nexus.services.rate_limit import RateLimiter, set_rate_limiter
from tests.helpers import auth_headers, create_test_user_id
from tests.support.test_verifier import MockJwtVerifier
from tests.utils.db import DirectSessionManager

# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def auth_client(engine):
    """Create a client with auth middleware for testing."""
    session_factory = create_session_factory(engine)

    def bootstrap_callback(user_id: UUID) -> UUID:
        db = session_factory()
        try:
            return ensure_user_and_default_library(db, user_id)
        finally:
            db.close()

    verifier = MockJwtVerifier()
    app = create_app(skip_auth_middleware=True)

    app.add_middleware(
        AuthMiddleware,
        verifier=verifier,
        requires_internal_header=False,
        internal_secret=None,
        bootstrap_callback=bootstrap_callback,
    )

    # Use context manager to trigger lifespan (sets up app.state.llm_router)
    with TestClient(app) as client:
        yield client


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
def mock_llm_response():
    """Standard mock LLM response."""
    # PR-04 LLMResponse uses 'text' instead of 'content'
    return LLMResponse(
        text="This is the assistant's response.",
        usage=LLMUsage(prompt_tokens=100, completion_tokens=50, total_tokens=150),
        provider_request_id="test-request-id",
    )


def create_test_model(session: Session) -> UUID:
    """Create or get test model in the database.

    Uses gpt-4o which may already exist from migration seeding.
    Returns the existing model's ID if it exists.
    """
    # First try to get existing model
    result = session.execute(
        text("""
            SELECT id FROM models WHERE provider = 'openai' AND model_name = 'gpt-4o'
        """)
    )
    row = result.fetchone()
    if row:
        return row[0]

    # Create new model if not exists
    model_id = uuid4()
    session.execute(
        text("""
            INSERT INTO models (id, provider, model_name, max_context_tokens, is_available)
            VALUES (:id, 'openai', 'gpt-4o', 128000, true)
        """),
        {"id": model_id},
    )
    session.commit()
    return model_id


def create_test_conversation(
    session: Session,
    owner_user_id: UUID,
    sharing: str = "private",
) -> UUID:
    """Create a test conversation directly in the database."""
    conversation_id = uuid4()
    session.execute(
        text("""
            INSERT INTO conversations (id, owner_user_id, sharing, next_seq)
            VALUES (:id, :owner_user_id, :sharing, 1)
        """),
        {"id": conversation_id, "owner_user_id": owner_user_id, "sharing": sharing},
    )
    session.commit()
    return conversation_id


def create_test_message(
    session: Session,
    conversation_id: UUID,
    seq: int,
    role: str = "user",
    content: str = "Test message",
    status: str = "complete",
    model_id: UUID | None = None,
) -> UUID:
    """Create a test message directly in the database."""
    message_id = uuid4()
    session.execute(
        text("""
            INSERT INTO messages (id, conversation_id, seq, role, content, status, model_id)
            VALUES (:id, :conversation_id, :seq, :role, :content, :status, :model_id)
        """),
        {
            "id": message_id,
            "conversation_id": conversation_id,
            "seq": seq,
            "role": role,
            "content": content,
            "status": status,
            "model_id": model_id,
        },
    )
    session.execute(
        text("UPDATE conversations SET next_seq = :next_seq WHERE id = :id"),
        {"next_seq": seq + 1, "id": conversation_id},
    )
    session.commit()
    return message_id


def create_test_media(
    session: Session,
    user_id: UUID,
    library_id: UUID,
    title: str = "Test Article",
    status: str = "ready_for_reading",
) -> UUID:
    """Create test media in the database."""
    media_id = uuid4()
    # Create media
    session.execute(
        text("""
            INSERT INTO media (id, kind, title, canonical_source_url, processing_status)
            VALUES (:id, 'web_article', :title, 'https://example.com/article', :status)
        """),
        {"id": media_id, "title": title, "status": status},
    )
    # Link to library
    session.execute(
        text("""
            INSERT INTO library_media (library_id, media_id)
            VALUES (:library_id, :media_id)
        """),
        {"library_id": library_id, "media_id": media_id},
    )
    # S4: seed intrinsic provenance when seeding into a default library
    session.execute(
        text("""
            INSERT INTO default_library_intrinsics (default_library_id, media_id)
            SELECT :library_id, :media_id
            WHERE EXISTS (
                SELECT 1 FROM libraries WHERE id = :library_id AND is_default = true
            )
            ON CONFLICT DO NOTHING
        """),
        {"library_id": library_id, "media_id": media_id},
    )
    session.commit()
    return media_id


def create_test_fragment(
    session: Session, media_id: UUID, content: str = "Fragment content"
) -> UUID:
    """Create a test fragment in the database."""
    fragment_id = uuid4()
    session.execute(
        text("""
            INSERT INTO fragments (id, media_id, idx, canonical_text, html_sanitized)
            VALUES (:id, :media_id, 0, :content, :html)
        """),
        {"id": fragment_id, "media_id": media_id, "content": content, "html": f"<p>{content}</p>"},
    )
    session.commit()
    return fragment_id


def create_test_highlight(
    session: Session,
    user_id: UUID,
    fragment_id: UUID,
    exact: str = "highlighted text",
) -> UUID:
    """Create a test highlight in the database."""
    highlight_id = uuid4()
    session.execute(
        text("""
            INSERT INTO highlights (id, user_id, fragment_id, start_offset, end_offset, color, exact, prefix, suffix)
            VALUES (:id, :user_id, :fragment_id, 0, 20, 'yellow', :exact, '', '')
        """),
        {"id": highlight_id, "user_id": user_id, "fragment_id": fragment_id, "exact": exact},
    )
    session.commit()
    return highlight_id


def get_user_library(session: Session, user_id: UUID) -> UUID:
    """Get user's default library ID."""
    result = session.execute(
        text("""
            SELECT library_id FROM memberships
            WHERE user_id = :user_id AND role = 'admin'
            LIMIT 1
        """),
        {"user_id": user_id},
    )
    row = result.fetchone()
    return row[0] if row else None


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
        mock_llm_response,
    ):
        """Send message without conversation_id creates new conversation."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )
            mock_generate.return_value = mock_llm_response

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
        mock_llm_response,
    ):
        """Send message to existing conversation appends messages."""
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

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )
            mock_generate.return_value = mock_llm_response

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
        mock_llm_response,
    ):
        """Same idempotency key with same payload returns cached result."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup
        idempotency_key = f"test-key-{uuid4()}"

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )
            mock_generate.return_value = mock_llm_response

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

        # Second request with same key - should return cached
        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )
            # LLM should NOT be called for replay
            mock_generate.return_value = mock_llm_response

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

            # Verify LLM was not called on replay
            mock_generate.assert_not_called()

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
        mock_llm_response,
    ):
        """Same idempotency key with different payload returns 409."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup
        idempotency_key = f"test-key-{uuid4()}"

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )
            mock_generate.return_value = mock_llm_response

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
        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
        mock_llm_response,
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

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
        mock_llm_response,
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

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
        mock_llm_response,
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
            b"0" if "inflight" in key else b"100001"  # Budget exhausted
        )

        limiter = RateLimiter(redis_client=mock_redis, token_budget=100_000)
        set_rate_limiter(limiter)

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
        mock_llm_response,
    ):
        """Send message with highlight context includes highlight text."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            library_id = get_user_library(session, user_id)
            media_id = create_test_media(session, user_id, library_id)
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

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )
            mock_generate.return_value = mock_llm_response

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
            media_id = create_test_media(session, user_a, library_a)
            fragment_id = create_test_fragment(session, media_id)
            highlight_id = create_test_highlight(session, user_a, fragment_id)

        # Model from migration seed - don't cleanup
        direct_db.register_cleanup("highlights", "id", highlight_id)
        direct_db.register_cleanup("fragments", "id", fragment_id)
        direct_db.register_cleanup("media", "id", media_id)

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
    ):
        """More than 10 context items returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        # Create 11 context items (limit is 10)
        contexts = [{"type": "highlight", "id": str(uuid4())} for _ in range(11)]

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.side_effect = LLMError(
                error_class=LLMErrorClass.INVALID_KEY,
                message="No BYOK key available",
            )

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
    ):
        """key_mode=platform_only without platform key returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.side_effect = LLMError(
                error_class=LLMErrorClass.INVALID_KEY,
                message="No platform key configured",
            )

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

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
    ):
        """LLM timeout creates assistant message with error status."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )
            mock_generate.side_effect = LLMError(
                error_class=LLMErrorClass.TIMEOUT,
                message="Request timed out",
            )

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
    ):
        """LLM provider unavailable creates assistant message with error status."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )
            mock_generate.side_effect = LLMError(
                error_class=LLMErrorClass.PROVIDER_DOWN,
                message="Provider unavailable",
            )

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
    ):
        """LLM invalid key error marks BYOK key as invalid."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)
            # Create a user API key
            key_id = uuid4()
            session.execute(
                text("""
                    INSERT INTO user_api_keys (id, user_id, provider, status, key_fingerprint, encrypted_key, key_nonce)
                    VALUES (:id, :user_id, 'openai', 'untested', 'fp_test', :encrypted, :nonce)
                """),
                {
                    "id": key_id,
                    "user_id": user_id,
                    "encrypted": b"encrypted_key_data_here",
                    "nonce": b"x" * 24,  # 24 bytes required
                },
            )
            session.commit()

        # Model from migration seed - don't cleanup
        direct_db.register_cleanup("user_api_keys", "id", key_id)

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
            patch("nexus.services.send_message.update_user_key_status") as mock_update_status,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="invalid-key",
                mode="byok",
                provider="openai",
                user_key_id=str(key_id),
            )
            mock_generate.side_effect = LLMError(
                error_class=LLMErrorClass.INVALID_KEY,
                message="API key is invalid",
            )

            response = auth_client.post(
                "/conversations/messages",
                headers=auth_headers(user_id),
                json={
                    "content": "Hello!",
                    "model_id": str(model_id),
                    "key_mode": "byok_only",
                },
            )

            # Should update key status to invalid
            mock_update_status.assert_called_once()
            call_args = mock_update_status.call_args
            assert call_args[0][1] == str(key_id)  # user_key_id
            assert call_args[0][2] == "invalid"  # status

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["assistant_message"]["status"] == "error"
        assert data["assistant_message"]["error_code"] == "E_LLM_INVALID_KEY"

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
    ):
        """Message content > 20,000 chars returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
    ):
        """Non-existent model returns 400."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        fake_model_id = uuid4()

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
    ):
        """Non-existent conversation returns 404."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        # Model from migration seed - don't cleanup
        fake_conversation_id = uuid4()

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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

        with patch("nexus.services.send_message.resolve_api_key") as mock_resolve:
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key",
                mode="platform",
                provider="openai",
            )

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
        mock_llm_response,
    ):
        """POST /conversations/messages response includes owner fields."""
        user_id = create_test_user_id()
        auth_client.get("/me", headers=auth_headers(user_id))

        with direct_db.session() as session:
            model_id = create_test_model(session)

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key", mode="platform", provider="openai"
            )
            mock_generate.return_value = mock_llm_response

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
        mock_llm_response,
    ):
        """POST /conversations/{id}/messages response includes owner fields."""
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

        with (
            patch("nexus.services.send_message.resolve_api_key") as mock_resolve,
            patch("nexus.services.send_message.generate") as mock_generate,
        ):
            mock_resolve.return_value = ResolvedKey(
                api_key="test-key", mode="platform", provider="openai"
            )
            mock_generate.return_value = mock_llm_response

            response = auth_client.post(
                f"/conversations/{conversation_id}/messages",
                headers=auth_headers(user_id),
                json={"content": "Follow up", "model_id": str(model_id)},
            )

        assert response.status_code == 200
        conv_data = response.json()["data"]["conversation"]
        assert conv_data["owner_user_id"] == str(user_id)
        assert conv_data["is_owner"] is True
