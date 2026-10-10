"""The run event log: append, tail, the stop flag and the one terminal fold.

``chat_run_events`` is append-only with a dense per-run ``seq``; an AFTER trigger
notifies ``CHANNEL`` with the run id and the SSE tail re-reads on it. Every effect
locks the run before the job claim (run -> job), everywhere.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import Row, func, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import ChatRun, ChatRunEvent
from nexus.jobs.queue import JobExecutionContext, lock_running_job_claim
from nexus.schemas.conversation import (
    ChatRunAssistantTextDeltaEventPayload,
    ChatRunContextRefAddedEventPayload,
    ChatRunDoneEventPayload,
    ChatRunToolCallDoneEventOut,
    ChatRunToolCallStartEventOut,
    ChatRunToolResultEventOut,
)

TERMINAL = frozenset({"complete", "error", "cancelled"})
CHANNEL = "chat_run_events"
type Event = (
    ChatRunAssistantTextDeltaEventPayload
    | ChatRunToolCallStartEventOut
    | ChatRunToolCallDoneEventOut
    | ChatRunToolResultEventOut
    | ChatRunContextRefAddedEventPayload
    | ChatRunDoneEventPayload
)


class LostClaim(RuntimeError):
    """This job attempt no longer owns its run; it must write nothing more."""


def lock_run(db: Session, run_id: UUID) -> ChatRun | None:
    """Lock the run and refresh it, even in a session that already holds it."""

    return db.scalar(
        select(ChatRun)
        .where(ChatRun.id == run_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )


def fence(db: Session, context: JobExecutionContext) -> None:
    """Lock this attempt's live claim into the caller's transaction (after the run)."""

    if not lock_running_job_claim(db, context=context):
        raise LostClaim(f"chat job {context.job_id} lost its claim")


def append(db: Session, run: ChatRun, event: Event) -> None:
    """Append at the next seq under the caller's run lock. Flushes, never commits."""

    seq = db.execute(
        text("SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_run_events WHERE run_id = :run_id"),
        {"run_id": run.id},
    ).scalar_one()
    db.add(
        ChatRunEvent(
            run_id=run.id,
            seq=seq,
            event_type=event.event_type,
            payload=event.model_dump(mode="json"),
        )
    )
    db.flush()


def append_live(
    sessions: sessionmaker[Session], run_id: UUID, event: Event, context: JobExecutionContext
) -> None:
    """One streamed frame in its own committed transaction; runs on a worker thread."""

    with sessions() as db:
        run = lock_run(db, run_id)
        if run is not None and run.status not in TERMINAL:
            fence(db, context)
            append(db, run, event)
        db.commit()


def read_after(db: Session, run_id: UUID, after: int) -> tuple[Sequence[Row[Any]], bool]:
    """Frames past ``after`` and whether the run is over (a deleted run is over)."""

    rows = db.execute(
        select(ChatRunEvent.seq, ChatRunEvent.event_type, ChatRunEvent.payload)
        .where(ChatRunEvent.run_id == run_id, ChatRunEvent.seq > after)
        .order_by(ChatRunEvent.seq)
    ).all()
    status = db.scalar(select(ChatRun.status).where(ChatRun.id == run_id))
    return rows, status is None or status in TERMINAL


def cancel_requested(db: Session, run_id: UUID) -> bool:
    return db.scalar(select(ChatRun.cancel_requested_at).where(ChatRun.id == run_id)) is not None


def finalize(
    db: Session,
    run: ChatRun,
    *,
    status: Literal["complete", "error", "cancelled"],
    content: str,
    error_code: str | None = None,
    support_id: str | None = None,
    warning: Literal["CitationsUnavailable"] | None = None,
    usage: dict[str, Any] | None = None,
) -> None:
    """The sole terminal writer, on a locked run: the answer, open tool calls, ``done``.

    A no-op on a terminal run, so ``done`` is written exactly once. Never commits.
    """

    if run.status in TERMINAL:
        return
    db.execute(
        text(
            "UPDATE messages SET content = :content, status = :status, updated_at = now()"
            " WHERE id = :id"
        ),
        {"content": content, "status": status, "id": run.assistant_message_id},
    )
    # A call the route rejected, or one a stop cut short, never reported its result.
    db.execute(
        text(
            "UPDATE message_tool_calls SET status = :status, updated_at = now()"
            " WHERE assistant_message_id = :id AND status IN ('pending', 'running')"
        ),
        {
            "status": "cancelled" if status == "cancelled" else "error",
            "id": run.assistant_message_id,
        },
    )
    run.status = status
    run.completed_at = func.now()
    run.updated_at = func.now()
    run.error_code = error_code
    run.support_id = support_id
    run.publication_warning_code = warning
    append(db, run, ChatRunDoneEventPayload(status=status, usage=usage))


def finalize_dead(db: Session, run: ChatRun) -> None:
    """An attempt died after starting: ``cancelled`` if a stop was asked, else ``interrupted``."""

    if run.cancel_requested_at is not None:
        finalize(db, run, status="cancelled", content="")
    else:
        finalize(db, run, status="error", content="", error_code="interrupted")
