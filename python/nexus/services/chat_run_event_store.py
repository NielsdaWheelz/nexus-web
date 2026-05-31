"""Write-of-truth for chat_run_events: durable append plus run-state transitions."""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent
from nexus.schemas.conversation import chat_run_event_payload_json

TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})


def append_run_event(db: Session, run: ChatRun, event_type: str, payload: dict[str, Any]) -> None:
    seq = run.next_event_seq
    payload = chat_run_event_payload_json(event_type, payload)
    db.add(ChatRunEvent(run_id=run.id, seq=seq, event_type=event_type, payload=payload))
    run.next_event_seq = seq + 1
    run.updated_at = func.now()
    db.flush()


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
