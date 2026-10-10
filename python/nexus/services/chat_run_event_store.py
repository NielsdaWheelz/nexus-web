"""The durable chat-run event log: append, emit, and the one terminal fold.

``chat_run_events`` is the replay log the browser reconnects to: append-only,
monotonic ``seq`` per run, exactly one ``done`` written by ``finalize_run``. An
AFTER trigger ``pg_notify``s ``CHAT_RUN_EVENTS_CHANNEL`` with the run id on each
append; the SSE tail re-reads ``read_run_events`` on each notification.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal, cast
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent, Message
from nexus.schemas.conversation import (
    ChatRunEventOut,
    ChatRunToolResultEventPayload,
    chat_publication_warning_from_nullable,
    chat_run_event_payload_json,
)
from nexus.schemas.presence import presence_from_nullable

TERMINAL_RUN_STATUSES = frozenset({"complete", "error", "cancelled"})
CHAT_RUN_EVENTS_CHANNEL = "chat_run_events"

type TerminalStatus = Literal["complete", "error", "cancelled"]


def bounded_text_prefix(text: str, *, max_chars: int, max_bytes: int) -> str:
    """Return a whole-code-point prefix inside the chat event limits."""
    if max_chars < 1 or max_bytes < 1:
        return ""
    byte_count = 0
    end = 0
    for character in text[:max_chars]:
        encoded_bytes = len(character.encode("utf-8"))
        if byte_count + encoded_bytes > max_bytes:
            break
        byte_count += encoded_bytes
        end += 1
    return text[:end]


def lock_chat_run_for_update(db: Session, run_id: UUID) -> ChatRun | None:
    """Lock and refresh the authoritative run even in non-expiring sessions."""

    return db.execute(
        select(ChatRun)
        .where(ChatRun.id == run_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    ).scalar_one_or_none()


def append_run_event(db: Session, run: ChatRun, event_type: str, payload: dict[str, Any]) -> None:
    """Append one event at the run's next monotonic ``seq`` and bump the run.

    Flushes; does not commit — the caller owns the transaction boundary.
    """
    seq = int(
        db.execute(
            text("SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_run_events WHERE run_id = :run_id"),
            {"run_id": run.id},
        ).scalar_one()
    )
    db.add(
        ChatRunEvent(
            run_id=run.id,
            seq=seq,
            event_type=event_type,
            payload=chat_run_event_payload_json(event_type, payload),
        )
    )
    run.updated_at = func.now()
    db.flush()


def read_run_events(db: Session, run_id: UUID, after: int) -> tuple[list[ChatRunEventOut], bool]:
    """Events with ``seq > after`` plus whether the run is terminal.

    A missing run counts as terminal, so a run deleted mid-stream ends the SSE
    tail. Viewer scoping belongs to the caller.
    """
    rows = db.scalars(
        select(ChatRunEvent)
        .where(ChatRunEvent.run_id == run_id, ChatRunEvent.seq > after)
        .order_by(ChatRunEvent.seq.asc())
    ).all()
    events = [
        ChatRunEventOut(
            seq=row.seq,
            event_type=cast(Any, row.event_type),
            payload=row.payload,
            created_at=row.created_at,
        )
        for row in rows
    ]
    status = db.execute(select(ChatRun.status).where(ChatRun.id == run_id)).scalar_one_or_none()
    return events, status is None or status in TERMINAL_RUN_STATUSES


def append_and_commit(
    db: Session,
    run_id: UUID,
    event_type: str,
    payload: dict[str, Any],
    *,
    lease_fence: Callable[[], None] | None,
) -> None:
    run = lock_chat_run_for_update(db, run_id)
    if run is None:
        raise RuntimeError("chat run disappeared before event append")
    if run.status in TERMINAL_RUN_STATUSES:
        db.commit()
        return
    if lease_fence is not None:
        # Chat's global effect order is run -> job. Tool admission and
        # publication take the same order, so a streamed frame cannot hold
        # the job while waiting on a concurrent call that already owns the run.
        lease_fence()
    append_run_event(db, run, event_type, payload)
    db.commit()


class ChatRunEventEmitter:
    """The one writer of chat run events.

    Streaming frames commit inline so the SSE tail sees them immediately; batch
    frames join the caller's transaction.
    """

    def __init__(
        self,
        db: Session,
        run: ChatRun,
        *,
        lease_fence: Callable[[], None] | None = None,
    ) -> None:
        self._db = db
        self._run = run
        self._lease_fence = lease_fence

    def assistant_text_delta(
        self,
        *,
        text: str,
        provider_event_seq_start: int,
        provider_event_seq_end: int,
    ) -> None:
        append_and_commit(
            self._db,
            self._run.id,
            "assistant_text_delta",
            {
                "assistant_message_id": str(self._run.assistant_message_id),
                "text": text,
                "provider_event_seq_start": provider_event_seq_start,
                "provider_event_seq_end": provider_event_seq_end,
            },
            lease_fence=self._lease_fence,
        )

    def assistant_activity(
        self,
        *,
        phase: str,
        provider_event_seq_start: int,
        provider_event_seq_end: int,
    ) -> None:
        append_and_commit(
            self._db,
            self._run.id,
            "assistant_activity",
            {
                "assistant_message_id": str(self._run.assistant_message_id),
                "phase": phase,
                "label": None,
                "provider_event_seq_start": provider_event_seq_start,
                "provider_event_seq_end": provider_event_seq_end,
            },
            lease_fence=self._lease_fence,
        )

    def batch(self, event_type: str, payload: dict[str, Any]) -> None:
        if self._lease_fence is not None:
            self._lease_fence()
        append_run_event(self._db, self._run, event_type, payload)

    def tool_result(self, payload: ChatRunToolResultEventPayload) -> None:
        self.batch("tool_result", payload.model_dump(mode="json"))


def mark_running(db: Session, run_id: UUID) -> None:
    """Enter ``running``; immutable execution facts already live in GenerationSpec."""

    run = lock_chat_run_for_update(db, run_id)
    if run is None:
        raise RuntimeError("chat run disappeared before running transition")
    if run.status == "queued":
        run.status = "running"
        run.started_at = run.started_at or func.now()
        run.updated_at = func.now()
    db.commit()


def is_cancel_requested(db: Session, run_id: UUID) -> bool:
    cancelled_at = db.execute(
        select(ChatRun.cancel_requested_at).where(ChatRun.id == run_id)
    ).scalar_one_or_none()
    return cancelled_at is not None


def finalize_run(
    db: Session,
    *,
    run_id: UUID,
    status: TerminalStatus,
    assistant_content: str,
    error_code: str | None = None,
    support_id: str | None = None,
    publication_warning_code: Literal["CitationsUnavailable"] | None = None,
    usage: dict[str, Any] | None = None,
    last_provider_event_seq: int | None = None,
) -> None:
    """Write the run's terminal status, the final assistant text, and ``done``.

    The sole terminal fold: it no-ops on an already-terminal run, so ``done`` is
    appended exactly once, and it settles every tool call still open (a call the
    route rejected never reports a result). It never commits — the worker owns
    that boundary.
    """

    run = lock_chat_run_for_update(db, run_id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return

    assistant_message = db.get(Message, run.assistant_message_id)
    if assistant_message is not None:
        assistant_message.content = assistant_content
        assistant_message.status = status
        assistant_message.updated_at = func.now()
    db.execute(
        text(
            "UPDATE message_tool_calls SET status = :status, updated_at = now() "
            "WHERE assistant_message_id = :assistant_message_id "
            "AND status IN ('pending', 'running')"
        ),
        {
            "status": "cancelled" if status == "cancelled" else "error",
            "assistant_message_id": run.assistant_message_id,
        },
    )

    run.support_id = support_id
    run.publication_warning_code = publication_warning_code
    run.status = status
    run.completed_at = func.now()
    if error_code is not None:
        run.error_code = error_code
    append_run_event(
        db,
        run,
        "done",
        {
            "status": status,
            "error_code": presence_from_nullable(error_code),
            "support_id": presence_from_nullable(support_id),
            "publication_warning": chat_publication_warning_from_nullable(publication_warning_code),
            "usage": usage,
            "final_chars": len(assistant_content) if status == "complete" else None,
            "last_provider_event_seq": last_provider_event_seq,
            "cancelled": status == "cancelled",
        },
    )


def finalize_dead_run(db: Session, run: ChatRun) -> None:
    """End a locked run whose attempt died: ``cancelled`` if asked, else ``interrupted``."""

    cancelled = run.cancel_requested_at is not None
    finalize_run(
        db,
        run_id=run.id,
        status="cancelled" if cancelled else "error",
        assistant_content="",
        error_code=None if cancelled else "interrupted",
    )
