"""The durable chat-run event log: append, emit, and the one terminal fold.

``chat_run_events`` is the replay log the browser reconnects to: append-only,
monotonic ``seq`` per run, exactly one ``done`` written by ``finalize_run``.
The generic seq/append/terminal mechanics live in ``run_kit``; this module owns
the chat payload contract and the chat run-state transitions.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Literal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, Message
from nexus.schemas.conversation import (
    ChatRunToolResultEventPayload,
    chat_publication_warning_from_nullable,
    chat_run_event_payload_json,
)
from nexus.schemas.presence import presence_from_nullable
from nexus.services import run_kit
from nexus.services.conversations import message_document

TERMINAL_RUN_STATUSES = run_kit.terminal_statuses(run_kit.RunStreamKind.ChatRun)

type TerminalStatus = Literal["complete", "error", "cancelled"]


def lock_chat_run_for_update(db: Session, run_id: UUID) -> ChatRun | None:
    """Lock and refresh the authoritative run even in non-expiring sessions."""

    return db.execute(
        select(ChatRun)
        .where(ChatRun.id == run_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    ).scalar_one_or_none()


def append_run_event(db: Session, run: ChatRun, event_type: str, payload: dict[str, Any]) -> None:
    run_kit.append_event(
        db,
        parent=run,
        event_type=event_type,
        payload=chat_run_event_payload_json(event_type, payload),
    )


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
        # Chat's global effect order is run -> job. MCP admission and
        # publication take the same order, so a streamed frame can never hold
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
    appended exactly once. It never commits — the worker owns that boundary.
    """

    run = lock_chat_run_for_update(db, run_id)
    if run is None or run.status in TERMINAL_RUN_STATUSES:
        return

    assistant_message = db.get(Message, run.assistant_message_id)
    if assistant_message is not None:
        assistant_message.content = assistant_content
        assistant_message.status = status
        assistant_message.updated_at = func.now()
        assistant_message.message_document = message_document("assistant", assistant_content)

    run.support_id = support_id
    run.publication_warning_code = publication_warning_code
    run_kit.mark_terminal(
        db,
        parent=run,
        status=status,
        done_payload=chat_run_event_payload_json(
            "done",
            {
                "status": status,
                "error_code": presence_from_nullable(error_code),
                "support_id": presence_from_nullable(support_id),
                "publication_warning": chat_publication_warning_from_nullable(
                    publication_warning_code
                ),
                "usage": usage,
                "final_chars": len(assistant_content) if status == "complete" else None,
                "last_provider_event_seq": last_provider_event_seq,
                "cancelled": status == "cancelled",
            },
        ),
        error_code=error_code,
    )
