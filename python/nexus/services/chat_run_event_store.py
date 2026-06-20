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


class ChatRunEventEmitter:
    """Single owner of durable chat run-event append. Streaming events commit
    inline (SSE visibility); batch events defer to the caller's transaction.

    The current payload grammar lives here in one place (a later streaming
    cutover reshapes payloads HERE, not at 20 call sites). Streaming methods are
    typed and build the exact payload dict, then ``append_and_commit`` so the SSE
    tail sees them immediately; batch methods accept the pre-built (varied,
    call-site-assembled) payload dict and ``append_run_event`` without committing,
    leaving the commit to the executor's existing batch boundary.
    """

    def __init__(self, db: Session, run: ChatRun) -> None:
        self._db = db
        self._run = run

    # -- Streaming events: typed, commit inline (SSE visibility) --------------

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
        )

    def tool_call_start(
        self,
        *,
        tool_name: str,
        tool_call_index: int,
        provider_tool_call_id: str,
        provider_event_seq_start: int,
        provider_event_seq_end: int,
    ) -> None:
        append_and_commit(
            self._db,
            self._run.id,
            "tool_call_start",
            {
                "tool_call_id": None,
                "assistant_message_id": str(self._run.assistant_message_id),
                "tool_name": tool_name,
                "tool_call_index": tool_call_index,
                "provider_tool_call_id": provider_tool_call_id,
                "provider_event_seq_start": provider_event_seq_start,
                "provider_event_seq_end": provider_event_seq_end,
            },
        )

    def tool_call_delta(
        self,
        *,
        tool_name: str,
        tool_call_index: int,
        provider_tool_call_id: str,
        input_delta: str,
        input_preview: str | None,
        provider_event_seq_start: int,
        provider_event_seq_end: int,
    ) -> None:
        append_and_commit(
            self._db,
            self._run.id,
            "tool_call_delta",
            {
                "tool_call_id": None,
                "assistant_message_id": str(self._run.assistant_message_id),
                "tool_name": tool_name,
                "tool_call_index": tool_call_index,
                "provider_tool_call_id": provider_tool_call_id,
                "input_delta": input_delta,
                "input_preview": input_preview,
                "provider_event_seq_start": provider_event_seq_start,
                "provider_event_seq_end": provider_event_seq_end,
            },
        )

    def tool_call_done(
        self,
        *,
        tool_name: str,
        tool_call_index: int,
        provider_tool_call_id: str,
        input: dict[str, Any],
        provider_event_seq_start: int,
        provider_event_seq_end: int,
    ) -> None:
        append_and_commit(
            self._db,
            self._run.id,
            "tool_call_done",
            {
                "tool_call_id": None,
                "assistant_message_id": str(self._run.assistant_message_id),
                "tool_name": tool_name,
                "tool_call_index": tool_call_index,
                "provider_tool_call_id": provider_tool_call_id,
                "input": input,
                "provider_event_seq_start": provider_event_seq_start,
                "provider_event_seq_end": provider_event_seq_end,
            },
        )

    # -- Batch events: pre-built payload, defer commit to the caller ----------

    def meta(self, payload: dict[str, Any]) -> None:
        append_run_event(self._db, self._run, "meta", payload)

    def tool_result(self, payload: dict[str, Any]) -> None:
        append_run_event(self._db, self._run, "tool_result", payload)

    def citation_index(self, payload: dict[str, Any]) -> None:
        append_run_event(self._db, self._run, "citation_index", payload)

    def context_ref_added(self, payload: dict[str, Any]) -> None:
        append_run_event(self._db, self._run, "context_ref_added", payload)


def mark_running(db: Session, run_id: UUID) -> None:
    run = db.execute(select(ChatRun).where(ChatRun.id == run_id).with_for_update()).scalars().one()
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


def has_provider_output_without_terminal(db: Session, run_id: UUID) -> bool:
    rows = db.execute(
        text(
            """
            SELECT event_type
            FROM chat_run_events
            WHERE run_id = :run_id
              AND event_type IN (
                'assistant_activity',
                'assistant_text_delta',
                'tool_call_start',
                'tool_call_delta',
                'tool_call_done',
                'done'
              )
            """
        ),
        {"run_id": run_id},
    ).fetchall()
    event_types = {row[0] for row in rows}
    return (
        bool(
            event_types
            & {
                "assistant_activity",
                "assistant_text_delta",
                "tool_call_start",
                "tool_call_delta",
                "tool_call_done",
            }
        )
        and "done" not in event_types
    )
