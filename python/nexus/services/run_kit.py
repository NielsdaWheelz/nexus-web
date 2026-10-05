"""Durable-run mechanics for chat runs.

A *durable run* is a parent row whose progress is replayed to clients as an
append-only, monotonically-sequenced event log over LISTEN/NOTIFY → SSE. The
generic mechanics — allocate the next event ``seq``, append the event row, bump
the parent's ``updated_at``, and perform the idempotent terminal status
transition that emits the closing ``done`` event — are owned here once. Domain
finalization stays with chat, which calls ``mark_terminal`` only for the status
flip + ``done`` event.

The notify channel and terminal status set dispatch on the ``RunStreamKind``
enum (``notify_channel`` / ``terminal_statuses``), so the route/SSE layer can
resolve them from a kind token without materializing the parent row.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, assert_never, cast
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent
from nexus.schemas.conversation import ChatRunEventOut

RunEventPayload = dict[str, JsonValue]

_CHAT_TERMINAL_STATUSES = frozenset({"complete", "error", "cancelled"})
_CHAT_CHANNEL = "chat_run_events"


class RunStreamKind(Enum):
    """The durable-run kinds that share the event/finalize mechanics."""

    ChatRun = "ChatRun"


def notify_channel(kind: RunStreamKind) -> str:
    """The LISTEN/NOTIFY channel for a run kind (the only per-kind SSE constant)."""
    if kind is RunStreamKind.ChatRun:
        return _CHAT_CHANNEL
    assert_never(kind)


def terminal_statuses(kind: RunStreamKind) -> frozenset[str]:
    """The terminal status set for a run kind (the one owner of each set)."""
    if kind is RunStreamKind.ChatRun:
        return _CHAT_TERMINAL_STATUSES
    assert_never(kind)


def append_event(
    db: Session,
    *,
    parent: ChatRun,
    event_type: str,
    payload: RunEventPayload,
) -> int:
    """Append one event with the next monotonic ``seq`` and return that seq.

    ``seq`` is ``COALESCE(MAX(seq), 0) + 1`` over the run's events. Bumps the
    parent's ``updated_at``. Flushes; does not commit — the caller owns the
    transaction boundary.
    """
    seq = int(
        db.execute(
            text("SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_run_events WHERE run_id = :run_id"),
            {"run_id": parent.id},
        ).scalar_one()
    )
    db.add(ChatRunEvent(run_id=parent.id, seq=seq, event_type=event_type, payload=payload))
    parent.updated_at = func.now()
    db.flush()
    return seq


def mark_terminal(
    db: Session,
    *,
    parent: ChatRun,
    status: str,
    done_payload: RunEventPayload,
    error_code: str | None = None,
) -> None:
    """Idempotently transition the run to a terminal status and emit ``done``.

    No-op when the parent is already terminal. Otherwise sets the parent's
    ``status`` and ``completed_at``, stamps ``error_code`` when given, then
    appends the ``done`` event. Does not commit — the caller owns the
    transaction boundary.
    """
    if parent.status in _CHAT_TERMINAL_STATUSES:
        return
    parent.status = status
    parent.completed_at = func.now()
    if error_code is not None:
        parent.error_code = error_code
    append_event(db, parent=parent, event_type="done", payload=done_payload)


def get_run_events(
    db: Session, kind: RunStreamKind, parent_id: UUID, after: int
) -> tuple[list[ChatRunEventOut], bool]:
    """Return the kind's replay events with ``seq > after`` plus the terminal flag.

    The single owner of the run-tail query that the SSE cursor stream re-reads on
    each notify. Viewer scoping is **not** here: the route's ``assert_viewer``
    owns ownership (it runs upfront, once).
    """
    rows = (
        db.execute(
            select(ChatRunEvent)
            .where(ChatRunEvent.run_id == parent_id, ChatRunEvent.seq > after)
            .order_by(ChatRunEvent.seq.asc())
        )
        .scalars()
        .all()
    )
    events = [
        ChatRunEventOut(
            seq=row.seq,
            event_type=cast(Any, row.event_type),
            payload=row.payload,
            created_at=row.created_at,
        )
        for row in rows
    ]
    return events, is_run_terminal(db, kind, parent_id)


def is_run_terminal(db: Session, kind: RunStreamKind, parent_id: UUID) -> bool:
    """Whether the run is terminal — a missing row counts as terminal.

    A row deleted mid-stream ends the SSE tail cleanly (it would otherwise stream
    forever). No viewer scoping.
    """
    status = db.execute(select(ChatRun.status).where(ChatRun.id == parent_id)).scalar_one_or_none()
    return status is None or status in terminal_statuses(kind)
