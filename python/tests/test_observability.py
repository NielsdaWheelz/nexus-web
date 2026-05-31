"""Tests for observability instrumentation.

Covers:
- Redaction guard utilities (safe_kv)
- Logging ContextVars (path, method, flow_id, stream_jti)
- Nexus LLM event field safety
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
    set_stream_jti,
)
from nexus.services.redact import FORBIDDEN_KEYS, safe_kv

pytestmark = pytest.mark.unit


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
            safe_kv(prompt="hello world")

    def test_blocks_content_key(self):
        """'content' is forbidden."""
        with pytest.raises(ValueError):
            safe_kv(content="user message text")

    def test_blocks_api_key_key(self):
        """'api_key' is forbidden."""
        with pytest.raises(ValueError):
            safe_kv(api_key="sk-abc123")

    def test_blocks_token_key(self):
        """'token' is forbidden."""
        with pytest.raises(ValueError):
            safe_kv(token="eyJhbGciOiJIUzI1NiJ9")

    def test_all_forbidden_keys_blocked(self):
        """Every key in FORBIDDEN_KEYS is blocked when used raw."""
        for key in FORBIDDEN_KEYS:
            with pytest.raises(ValueError):
                safe_kv(**{key: "some value"})

    def test_redacts_forbidden_values_outside_dev_and_test(self, monkeypatch, log_sink):
        """Prod-like environments warn without returning raw sensitive values."""
        monkeypatch.setenv("NEXUS_ENV", "staging")

        result = safe_kv(prompt="secret prompt", provider="openai")

        assert result == {"prompt": "[REDACTED]", "provider": "openai"}
        assert log_sink == [
            {
                "event": "safe_kv_violation",
                "forbidden_keys": ["prompt"],
            }
        ]


# ─── ContextVar Tests ────────────────────────────────────────────────


class TestContextVars:
    """Tests for request-scoped logging ContextVars."""

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
        set_flow_id("flow-1")
        set_stream_jti("jti-1")
        clear_request_context()
        event_dict = add_request_context(None, "info", {})
        assert "request_id" not in event_dict
        assert "path" not in event_dict
        assert "method" not in event_dict
        assert "flow_id" not in event_dict
        assert "stream_jti" not in event_dict

    def test_none_values_not_injected(self):
        """None-valued context vars are omitted from log events."""
        set_request_context("req-1")
        event_dict = add_request_context(None, "info", {})
        assert "path" not in event_dict
        assert "flow_id" not in event_dict


# ─── Nexus LLM Log Field Tests ───────────────────────────────────────


class TestNexusLLMLogFields:
    """Tests for Nexus-owned LLM observability field names."""

    def test_chat_send_fields_are_safe(self):
        fields = safe_kv(
            provider="openai",
            model_name="gpt-test",
            reasoning_effort="none",
            key_mode="platform",
            streaming=True,
            llm_operation="chat_send",
            conversation_id="conv-1",
            assistant_message_id="msg-1",
            message_chars=123,
        )

        assert fields["llm_operation"] == "chat_send"
        assert fields["conversation_id"] == "conv-1"
        assert fields["assistant_message_id"] == "msg-1"

    def test_key_test_fields_are_safe(self):
        fields = safe_kv(
            provider="openai",
            model_name="gpt-test",
            reasoning_effort="none",
            key_mode="byok",
            streaming=False,
            llm_operation="key_test",
            message_chars=14,
        )

        assert fields["llm_operation"] == "key_test"
        assert fields["key_mode"] == "byok"


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
