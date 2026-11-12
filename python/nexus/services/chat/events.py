"""The run event log: append, tail, the stop flag and the one terminal fold.

``chat_run_events`` is append-only with a dense per-run ``seq``; an AFTER trigger
notifies ``CHANNEL`` with the run id and the SSE tail re-reads on it. Account state precedes the run and job claim; generation locks, when needed, precede account state.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import Row, func, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import ChatRun, ChatRunEvent
from nexus.jobs.queue import JobExecutionContext, enqueue_job, lock_running_job_claim
from nexus.schemas.chat import (
    ChatRunAssistantTextDeltaEventPayload,
    ChatRunDoneEventPayload,
    ChatRunToolCallStartEventPayload,
    ChatRunToolResultEventPayload,
)
from nexus.services.chat import deletion
from nexus.services.search import projection

TERMINAL = frozenset({"complete", "error", "cancelled"})
CHANNEL = "chat_run_events"
type Event = (
    ChatRunAssistantTextDeltaEventPayload
    | ChatRunToolCallStartEventPayload
    | ChatRunToolResultEventPayload
    | ChatRunDoneEventPayload
)


class LostClaim(RuntimeError):
    """This job attempt no longer owns its run; it must write nothing more."""


def lock_run(db: Session, run_id: UUID) -> ChatRun | None:
    """Lock the run and refresh it, even in a session that already holds it."""

    owner = db.scalar(select(ChatRun.owner_user_id).where(ChatRun.id == run_id))
    if owner is None:
        return None
    deletion.lock_revision(db, owner)
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
) -> None:
    """The sole terminal writer, on a locked run: the answer, open tool calls, ``done``.

    A no-op on a terminal run, so ``done`` is written exactly once. Never commits.
    Complete answers require the caller's serializable attempt before run/claim reads;
    Every settled answer updates its current search projection.
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
    # A call a stop or a dead attempt cut short never reported its result.
    db.execute(
        text(
            "UPDATE tool_calls SET status = :status"
            " WHERE assistant_message_id = :id AND status = 'running'"
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
    append(db, run, ChatRunDoneEventPayload(status=status))
    projection.refresh(db, "message", [run.assistant_message_id])
    enqueue_head(db, run.owner_user_id)


def enqueue_head(db: Session, viewer_id: UUID) -> None:
    """Admit only the first unsettled turn; the account mutex serializes this decision."""
    db.flush()
    head = db.scalar(
        text("""SELECT r.id FROM chat_runs r JOIN messages m ON m.id=r.user_message_id
        WHERE r.owner_user_id=:viewer AND r.status IN ('queued','running') ORDER BY m.seq LIMIT 1"""),
        {"viewer": viewer_id},
    )
    if (
        head is None
        or db.scalar(
            text("SELECT id FROM background_jobs WHERE dedupe_key=:key"),
            {"key": f"chat_run:{head}"},
        )
        is not None
    ):
        return
    enqueue_job(
        db,
        kind="chat_run",
        payload={"run_id": str(head)},
        priority=50,
        dedupe_key=f"chat_run:{head}",
    )


def finalize_dead(db: Session, run: ChatRun) -> None:
    """Retain committed text and the ledger's known failure; never reconstruct by generation."""
    from nexus.services.chat.citations import unpublished

    if run.status in TERMINAL:
        return
    content = db.scalar(
        text("""SELECT COALESCE(string_agg(payload->>'text','' ORDER BY seq),'')
        FROM chat_run_events WHERE run_id=:id AND event_type='assistant_text_delta'"""),
        {"id": run.id},
    )
    generation = db.execute(
        text("""SELECT id,failure_code FROM llm_calls
        WHERE owner_kind='chat_run' AND owner_id=:id ORDER BY generation_seq DESC LIMIT 1"""),
        {"id": run.id},
    ).first()
    stopped = run.cancel_requested_at is not None
    finalize(
        db,
        run,
        status="cancelled" if stopped else "error",
        content=unpublished(content or ""),
        error_code=None
        if stopped
        else (generation.failure_code if generation and generation.failure_code else "interrupted"),
        support_id=generation.id.hex[:12] if generation else run.support_id,
    )
