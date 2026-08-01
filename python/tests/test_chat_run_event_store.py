"""Integration contract for chat run state transitions."""

from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

import nexus.services.chat_runs as chat_runs
from nexus.db.models import ChatRun, Message
from nexus.jobs.queue import JobExecutionContext, JobRow
from nexus.services.chat_run_event_store import mark_running
from nexus.services.chat_run_finalize import finalize_run
from tests.factories import create_test_conversation, create_test_message

pytestmark = pytest.mark.integration


def _queued_run(db: Session, owner_id: UUID) -> ChatRun:
    conversation_id = create_test_conversation(db, owner_id)
    user_message_id = create_test_message(
        db, conversation_id, seq=1, role="user", content="Question"
    )
    assistant_message_id = create_test_message(
        db,
        conversation_id,
        seq=2,
        role="assistant",
        content="",
        status="pending",
        parent_message_id=user_message_id,
    )
    run = ChatRun(
        owner_user_id=owner_id,
        conversation_id=conversation_id,
        user_message_id=user_message_id,
        assistant_message_id=assistant_message_id,
        idempotency_key=f"mark-running-{uuid4()}",
        payload_hash="hash",
        status="queued",
    )
    db.add(run)
    db.commit()
    return run


def test_mark_running_atomically_stamps_resolved_execution_facts(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    run = _queued_run(db_session, bootstrapped_user)

    mark_running(
        db_session,
        run.id,
        provider="openai",
        model_name="gpt-5.6-terra",
        reasoning_effort="medium",
    )

    db_session.refresh(run)
    assert run.status == "running"
    assert run.started_at is not None
    assert (run.provider, run.model_name, run.reasoning_effort) == (
        "openai",
        "gpt-5.6-terra",
        "medium",
    )


def test_mark_running_defects_if_retry_resolves_different_facts(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    run = _queued_run(db_session, bootstrapped_user)
    mark_running(
        db_session,
        run.id,
        provider="openai",
        model_name="gpt-5.6-terra",
        reasoning_effort="medium",
    )

    with pytest.raises(AssertionError, match="facts do not match"):
        mark_running(
            db_session,
            run.id,
            provider="anthropic",
            model_name="claude-sonnet-5",
            reasoning_effort="high",
        )
    db_session.rollback()


def test_degraded_publication_is_complete_with_one_warning_occurrence(
    db_session: Session,
    bootstrapped_user: UUID,
) -> None:
    run = _queued_run(db_session, bootstrapped_user)
    mark_running(
        db_session,
        run.id,
        provider="openai",
        model_name="gpt-5.6-terra",
        reasoning_effort="medium",
    )

    finalize_run(
        db_session,
        run_id=run.id,
        assistant_content="Usable marker-free answer.",
        assistant_status="complete",
        run_status="complete",
        done_status="complete",
        error_code=None,
        support_id="abc123def456",
        publication_warning_code="CitationsUnavailable",
    )

    db_session.refresh(run)
    message = db_session.get(Message, run.assistant_message_id)
    done = db_session.execute(
        text("SELECT payload FROM chat_run_events WHERE run_id = :run_id AND event_type = 'done'"),
        {"run_id": run.id},
    ).scalar_one()
    assert run.status == "complete"
    assert run.error_code is None
    assert run.support_id == "abc123def456"
    assert run.publication_warning_code == "CitationsUnavailable"
    assert message is not None
    assert message.status == "complete"
    assert message.content == "Usable marker-free answer."
    assert done == {
        "status": "complete",
        "error_code": {"kind": "Absent"},
        "support_id": {"kind": "Present", "value": "abc123def456"},
        "publication_warning": {
            "kind": "Present",
            "value": {"code": "CitationsUnavailable"},
        },
        "usage": None,
        "final_chars": 26,
        "last_provider_event_seq": None,
        "cancelled": False,
    }


async def test_invariant_failure_rolls_back_and_escapes_to_queue_recovery(
    db_session: Session,
    bootstrapped_user: UUID,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = _queued_run(db_session, bootstrapped_user)
    original_title = db_session.execute(
        text("SELECT title FROM conversations WHERE id = :conversation_id"),
        {"conversation_id": run.conversation_id},
    ).scalar_one()

    async def raise_graph_invariant(db: Session, *_args: object, **_kwargs: object) -> None:
        db.execute(
            text(
                "UPDATE conversations SET title = 'partial publication' WHERE id = :conversation_id"
            ),
            {"conversation_id": run.conversation_id},
        )
        raise AssertionError("resource graph invariant")

    monkeypatch.setattr(chat_runs, "_execute_chat_run", raise_graph_invariant)

    job_id = uuid4()
    now = datetime.now(UTC)
    job = JobRow(
        id=job_id,
        kind="chat_run",
        payload={"run_id": str(run.id)},
        status="running",
        priority=50,
        attempts=1,
        max_attempts=3,
        available_at=now,
        lease_expires_at=now + timedelta(minutes=1),
        claimed_by="test-worker",
        dedupe_key=f"chat_run:{run.id}",
        error_code=None,
        last_error=None,
        result=None,
        started_at=now,
        finished_at=None,
        created_at=now,
        updated_at=now,
    )
    with pytest.raises(AssertionError, match="resource graph invariant"):
        await chat_runs.execute_chat_run(
            db_session,
            run_id=run.id,
            job=job,
            execution_context=JobExecutionContext(
                job_id=job_id,
                worker_id="test-worker",
                attempt_no=1,
            ),
            session_factory=cast(Any, object()),
            runtime=cast(Any, object()),
            settings=cast(Any, object()),
        )

    db_session.refresh(run)
    assert run.status == "queued"
    assert run.error_code is None
    assert run.support_id is None
    assert run.publication_warning_code is None
    assert (
        db_session.execute(
            text("SELECT title FROM conversations WHERE id = :conversation_id"),
            {"conversation_id": run.conversation_id},
        ).scalar_one()
        == original_title
    )
