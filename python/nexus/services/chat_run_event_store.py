"""Chat-run lifecycle helpers: durable append plus chat-bound state transitions.

The generic event-append/seq mechanics live in ``run_kit``; this module owns the
chat-specific concerns: validating the SSE payload contract before storage and
the chat run-state transitions (running, cancel-checks, terminal accounting).
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun
from nexus.schemas.conversation import chat_run_event_payload_json
from nexus.services import run_kit

TERMINAL_RUN_STATUSES = run_kit.terminal_statuses(run_kit.RunStreamKind.ChatRun)


def append_run_event(db: Session, run: ChatRun, event_type: str, payload: dict[str, Any]) -> None:
    """Validate the chat SSE payload contract, then durably append via run_kit."""
    validated = chat_run_event_payload_json(event_type, payload)
    run_kit.append_event(
        db,
        stream=run_kit.chat_run_stream(run),
        event_type=event_type,
        payload=validated,
    )


def append_and_commit(db: Session, run_id: UUID, event_type: str, payload: dict[str, Any]) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
    if run.status in TERMINAL_RUN_STATUSES:
        db.commit()
        return
    append_run_event(db, run, event_type, payload)
    db.commit()


def mark_running(db: Session, run_id: UUID) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
    if run.status == "queued":
        run.status = "running"
        run.started_at = run.started_at or func.now()
        run.updated_at = func.now()
    db.commit()


def is_cancel_requested(db: Session, run_id: UUID) -> bool:
    run = db.get(ChatRun, run_id)
    return run is not None and run.cancel_requested_at is not None


def has_delta_without_terminal(db: Session, run_id: UUID) -> bool:
    rows = db.execute(
        text(
            """
            SELECT event_type
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type IN ('delta', 'done')
            """
        ),
        {"run_id": run_id},
    ).fetchall()
    event_types = {row[0] for row in rows}
    return "delta" in event_types and "done" not in event_types
