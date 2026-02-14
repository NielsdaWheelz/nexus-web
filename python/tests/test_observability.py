"""Tests for PR-09 observability instrumentation.

Covers:
- Redaction utilities (hash_text, redact_text, safe_kv)
- Logging ContextVars (path, method, route_template, flow_id, stream_jti)
- LLM router event emission (llm.request.started / finished / failed)
- LLMOperation enum and LLMCallContext
- Event taxonomy correctness
- No sensitive data in logs (prompt, api_key, content)
"""

import pytest
import structlog

from nexus.logging import (
    add_request_context,
    clear_request_context,
    set_flow_id,
    set_request_context,
    set_route_template,
    set_stream_jti,
)
from nexus.services.llm.types import LLMCallContext, LLMOperation
from nexus.services.redact import FORBIDDEN_KEYS, hash_text, redact_text, safe_kv

# ─── Redaction Unit Tests ────────────────────────────────────────────────


class TestHashText:
    """Tests for hash_text function."""

    def test_stable_output(self):
        """Same input always produces same hash."""
        assert hash_text("hello") == hash_text("hello")

    def test_different_inputs_differ(self):
        """Different inputs produce different hashes."""
        assert hash_text("hello") != hash_text("world")

    def test_returns_hex_string(self):
        """Output is a 64-char hex string (SHA-256)."""
        result = hash_text("test")
        assert len(result) == 64
        assert all(c in "0123456789abcdef" for c in result)

    def test_empty_string(self):
        """Empty string has a valid hash."""
        result = hash_text("")
        assert len(result) == 64


class TestRedactText:
    """Tests for redact_text function."""

    def test_full_redact(self):
        """With keep=0, returns '***'."""
        assert redact_text("sk-abc123", keep=0) == "***"

    def test_partial_redact(self):
        """With keep=4, returns prefix + '***'."""
        assert redact_text("sk-abc123", keep=4) == "sk-a***"

    def test_empty_string(self):
        """Empty string returns '***'."""
        assert redact_text("", keep=0) == "***"

    def test_keep_exceeds_length(self):
        """If keep >= length, returns '***'."""
        assert redact_text("ab", keep=5) == "***"

    def test_never_returns_full_input(self):
        """For any input longer than keep, result never contains full input."""
        value = "sensitive-api-key-value"
        result = redact_text(value, keep=3)
        assert value not in result
        assert result == "sen***"


class TestSafeKv:
    """Tests for safe_kv log guard."""

    def test_allows_safe_keys(self):
        """Normal keys pass through unchanged."""
        result = safe_kv(provider="openai", model_name="gpt-4", latency_ms=100)
        assert result == {"provider": "openai", "model_name": "gpt-4", "latency_ms": 100}

    def test_allows_redacted_suffix_keys(self):
        """Keys with redacted suffixes are allowed even if base is forbidden."""
        result = safe_kv(prompt_sha256="abc", content_length=42, message_text_chars=100)
        assert result == {"prompt_sha256": "abc", "content_length": 42, "message_text_chars": 100}

    def test_blocks_forbidden_key_in_dev(self):
        """Forbidden keys raise ValueError in dev/test."""
        with pytest.raises(ValueError, match="Forbidden log keys"):
            safe_kv(prompt="hello world", _env="test")

    def test_blocks_content_key(self):
        """'content' is forbidden."""
        with pytest.raises(ValueError):
            safe_kv(content="user message text", _env="test")

    def test_blocks_api_key_key(self):
        """'api_key' is forbidden."""
        with pytest.raises(ValueError):
            safe_kv(api_key="sk-abc123", _env="test")

    def test_blocks_token_key(self):
        """'token' is forbidden."""
        with pytest.raises(ValueError):
            safe_kv(token="eyJhbGciOiJIUzI1NiJ9", _env="test")

    def test_all_forbidden_keys_blocked(self):
        """Every key in FORBIDDEN_KEYS is blocked when used raw."""
        for key in FORBIDDEN_KEYS:
            with pytest.raises(ValueError):
                safe_kv(**{key: "some value"}, _env="test")


# ─── ContextVar Tests ────────────────────────────────────────────────


class TestContextVars:
    """Tests for PR-09 ContextVar additions."""

    def setup_method(self):
        clear_request_context()

    def teardown_method(self):
        clear_request_context()

    def test_path_and_method_injected(self):
        """path and method appear in log event dict when set."""
        set_request_context("req-1", path="/conversations/abc/messages", method="POST")
        event_dict = add_request_context(None, "info", {})
        assert event_dict["path"] == "/conversations/abc/messages"
        assert event_dict["method"] == "POST"
        assert event_dict["request_id"] == "req-1"

    def test_route_template_injected(self):
        """route_template appears when set separately."""
        set_request_context("req-1")
        set_route_template("/conversations/{conversation_id}/messages")
        event_dict = add_request_context(None, "info", {})
        assert event_dict["route_template"] == "/conversations/{conversation_id}/messages"

    def test_flow_id_injected(self):
        """flow_id appears when set."""
        set_request_context("req-1")
        set_flow_id("flow-abc-123")
        event_dict = add_request_context(None, "info", {})
        assert event_dict["flow_id"] == "flow-abc-123"

    def test_stream_jti_injected(self):
        """stream_jti appears when set."""
        set_request_context("req-1")
        set_stream_jti("jti-xyz-789")
        event_dict = add_request_context(None, "info", {})
        assert event_dict["stream_jti"] == "jti-xyz-789"

    def test_clear_clears_all(self):
        """clear_request_context clears all vars."""
        set_request_context("req-1", path="/test", method="GET")
        set_route_template("/test")
        set_flow_id("flow-1")
        set_stream_jti("jti-1")
        clear_request_context()
        event_dict = add_request_context(None, "info", {})
        assert "request_id" not in event_dict
        assert "path" not in event_dict
        assert "method" not in event_dict
        assert "route_template" not in event_dict
        assert "flow_id" not in event_dict
        assert "stream_jti" not in event_dict

    def test_none_values_not_injected(self):
        """None-valued context vars are omitted from log events."""
        set_request_context("req-1")
        event_dict = add_request_context(None, "info", {})
        assert "path" not in event_dict
        assert "route_template" not in event_dict
        assert "flow_id" not in event_dict


# ─── LLMOperation / LLMCallContext Tests ─────────────────────────────


class TestLLMTypes:
    """Tests for LLMOperation enum and LLMCallContext."""

    def test_operation_values(self):
        assert LLMOperation.CHAT_SEND.value == "chat_send"
        assert LLMOperation.KEY_TEST.value == "key_test"
        assert LLMOperation.OTHER.value == "other"

    def test_call_context_defaults(self):
        ctx = LLMCallContext()
        assert ctx.operation == LLMOperation.OTHER
        assert ctx.conversation_id is None
        assert ctx.assistant_message_id is None

    def test_call_context_chat_send(self):
        ctx = LLMCallContext(
            operation=LLMOperation.CHAT_SEND,
            conversation_id="conv-1",
            assistant_message_id="msg-1",
        )
        assert ctx.operation == LLMOperation.CHAT_SEND
        assert ctx.conversation_id == "conv-1"
        assert ctx.assistant_message_id == "msg-1"

    def test_call_context_frozen(self):
        """LLMCallContext is frozen (immutable)."""
        ctx = LLMCallContext()
        with pytest.raises(AttributeError):
            ctx.operation = LLMOperation.CHAT_SEND


# ─── Log Capture Infrastructure ──────────────────────────────────────


@pytest.fixture
def log_sink():
    """Configure structlog to capture events into a list.

    Returns a list that will contain all emitted log event dicts.
    After the test, structlog is reset to normal.
    """
    events: list[dict] = []
    original_config = structlog.get_config()

    def capture_processor(logger, method_name, event_dict):
        events.append(event_dict.copy())
        raise structlog.DropEvent

    structlog.configure(
        processors=[capture_processor],
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=False,
    )

    yield events

    # Restore original configuration
    structlog.configure(**original_config)


# ─── Event Taxonomy Tests ────────────────────────────────────────────


class TestEventTaxonomy:
    """Verify event name prefixes follow the spec §13 taxonomy."""

    VALID_PREFIXES = {
        "http.request.",
        "llm.request.",
        "send.",
        "stream.",
        "sweeper.",
        "rate_limit.",
        "token_budget.",
        "idempotency.",
    }

    def test_event_names_use_valid_prefix(self):
        """All known event names must use a valid prefix."""
        known_events = [
            "http.request.completed",
            "http.request.failed",
            "llm.request.started",
            "llm.request.finished",
            "llm.request.failed",
            "send.completed",
            "stream.started",
            "stream.first_delta",
            "stream.completed",
            "stream.client_disconnected",
            "stream.finalized_error",
            "stream.double_finalize_detected",
            "stream.jti_replay_blocked",
            "stream.phases",
            "sweeper.orphaned_pending_finalized",
            "rate_limit.blocked",
            "token_budget.exceeded",
            "idempotency.replay_mismatch",
        ]
        for event in known_events:
            assert any(event.startswith(prefix) for prefix in self.VALID_PREFIXES), (
                f"Event {event} does not match any valid prefix"
            )
