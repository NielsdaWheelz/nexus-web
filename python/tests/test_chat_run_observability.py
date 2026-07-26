"""Focused contract for the one terminal chat-run receipt."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
import structlog
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.services.chat_runs import _log_chat_run_finished
from tests.factories import create_test_conversation, create_test_message

pytestmark = pytest.mark.integration


def test_chat_run_finished_emits_one_exact_terminal_receipt(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    conversation_id = create_test_conversation(db_session, bootstrapped_user)
    user_message_id = create_test_message(
        db_session, conversation_id, seq=1, role="user", content="Question"
    )
    assistant_message_id = create_test_message(
        db_session,
        conversation_id,
        seq=2,
        role="assistant",
        content="Answer",
        status="complete",
        parent_message_id=user_message_id,
    )
    created_at = datetime(2026, 7, 26, 12, 0, tzinfo=UTC)
    started_at = created_at + timedelta(milliseconds=125)
    completed_at = started_at + timedelta(milliseconds=875)
    run = ChatRun(
        owner_user_id=bootstrapped_user,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=f"receipt-{uuid4()}",
        payload_hash="hash",
        status="complete",
        provider="openai",
        model_name="gpt-5.6-terra",
        reasoning_effort="medium",
        support_id="abc123def456",
        publication_warning_code="CitationsUnavailable",
        created_at=created_at,
        started_at=started_at,
        completed_at=completed_at,
    )
    db_session.add(run)
    db_session.commit()

    with structlog.testing.capture_logs() as logs:
        _log_chat_run_finished(
            db_session,
            run_id=run.id,
            outcome="Degraded",
            citation_finalize_ms=7,
            first_visible_text_ms=42,
            provider_event_count=9,
        )

    assert logs == [
        {
            "event": "ChatRun.Finished",
            "log_level": "info",
            "nexus.chat_run.id": str(run.id),
            "nexus.conversation.id": str(conversation_id),
            "nexus.chat_run.outcome": "Degraded",
            "nexus.chat_run.error_code": None,
            "nexus.chat_run.warning_code": "CitationsUnavailable",
            "nexus.chat_run.support_id": "abc123def456",
            "nexus.llm.provider": "openai",
            "nexus.llm.model": "gpt-5.6-terra",
            "nexus.llm.reasoning": "medium",
            "nexus.chat_run.queue_wait_ms": 125,
            "nexus.chat_run.execution_ms": 875,
            "nexus.chat_run.citation_finalize_ms": 7,
            "nexus.chat_run.first_visible_text_ms": 42,
            "nexus.chat_run.provider_event_count": 9,
        }
    ]
