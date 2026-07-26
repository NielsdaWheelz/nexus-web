"""Unit contract for the chat-owned outcome to queue-payload adapter."""

from uuid import uuid4

import pytest

from nexus.schemas.presence import absent, present
from nexus.services.chat_runs import (
    CancelledChatExecution,
    DegradedChatExecution,
    FailedChatExecution,
    PublishedChatExecution,
    SkippedChatExecution,
)
from nexus.tasks.chat_run import _serialize_chat_execution

pytestmark = pytest.mark.unit


def test_serializes_every_chat_execution_outcome_to_one_tagged_queue_shape() -> None:
    run_id = uuid4()
    message_id = uuid4()

    assert _serialize_chat_execution(
        PublishedChatExecution(run_id=run_id, message_id=message_id, citation_count=2)
    ) == {
        "kind": "Published",
        "run_id": str(run_id),
        "message_id": str(message_id),
        "citation_count": 2,
    }
    assert _serialize_chat_execution(
        DegradedChatExecution(
            run_id=run_id,
            message_id=message_id,
            warning_code="CitationsUnavailable",
            support_id="abc123def456",
        )
    ) == {
        "kind": "Degraded",
        "run_id": str(run_id),
        "message_id": str(message_id),
        "warning_code": "CitationsUnavailable",
        "support_id": "abc123def456",
    }
    assert _serialize_chat_execution(
        FailedChatExecution(
            run_id=run_id,
            error_code=present("stream_interrupted"),
            support_id=present("abc123def456"),
        )
    ) == {
        "kind": "Failed",
        "run_id": str(run_id),
        "error_code": {"kind": "Present", "value": "stream_interrupted"},
        "support_id": {"kind": "Present", "value": "abc123def456"},
    }
    assert _serialize_chat_execution(CancelledChatExecution(run_id=run_id)) == {
        "kind": "Cancelled",
        "run_id": str(run_id),
    }
    assert _serialize_chat_execution(SkippedChatExecution(reason="MissingRun")) == {
        "kind": "Skipped",
        "reason": "MissingRun",
    }
    assert _serialize_chat_execution(
        FailedChatExecution(run_id=run_id, error_code=absent(), support_id=absent())
    )["support_id"] == {"kind": "Absent"}
