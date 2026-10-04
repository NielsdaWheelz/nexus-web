"""Generic durable-run mechanics shared by chat runs and oracle readings.

A *durable run* is a parent row whose progress is replayed to clients as an
append-only, monotonically-sequenced event log over LISTEN/NOTIFY → SSE. The
generic mechanics — allocate the next event ``seq``, append the event row, bump
the parent's ``updated_at`` (when it has one), and perform the idempotent
terminal status transition that emits the closing ``done`` event — are owned
here once. **Domain finalization stays per-feature**: chat writes assistant
content/usage, oracle writes passages/concordance/marginalia; each calls
``mark_terminal`` only for the status flip + ``done`` event.

Per-kind knowledge has two single homes here: the event model + parent-FK column
and ``updated_at`` presence dispatch on the parent ORM via the exhaustive
``isinstance`` chains (``append_event``/``mark_terminal``); the notify channel and
terminal status set dispatch on the ``RunStreamKind`` enum (``notify_channel`` /
``terminal_statuses``), so the route/SSE layer can resolve them from a kind token
without materializing the parent row.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, assert_never, cast
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import ChatRun, ChatRunEvent, OracleReading, OracleReadingEvent
from nexus.schemas.conversation import ChatRunEventOut
from nexus.schemas.oracle import OracleReadingEventOut

RunEventPayload = dict[str, JsonValue]

_CHAT_TERMINAL_STATUSES = frozenset({"complete", "error", "cancelled"})
_ORACLE_TERMINAL_STATUSES = frozenset({"complete", "failed"})
_CHAT_CHANNEL = "chat_run_events"
_ORACLE_CHANNEL = "oracle_reading_events"


class RunStreamKind(Enum):
    """The durable-run kinds that share the generic event/finalize mechanics."""

    ChatRun = "ChatRun"
    OracleReading = "OracleReading"


def notify_channel(kind: RunStreamKind) -> str:
    """The LISTEN/NOTIFY channel for a run kind (the only per-kind SSE constant)."""
    if kind is RunStreamKind.ChatRun:
        return _CHAT_CHANNEL
    if kind is RunStreamKind.OracleReading:
        return _ORACLE_CHANNEL
    assert_never(kind)


def terminal_statuses(kind: RunStreamKind) -> frozenset[str]:
    """The terminal status set for a run kind (the one owner of each set)."""
    if kind is RunStreamKind.ChatRun:
        return _CHAT_TERMINAL_STATUSES
    if kind is RunStreamKind.OracleReading:
        return _ORACLE_TERMINAL_STATUSES
    assert_never(kind)


def append_event(
    db: Session,
    *,
    parent: ChatRun | OracleReading,
    event_type: str,
    payload: RunEventPayload,
) -> int:
    """Append one event with the next monotonic ``seq`` and return that seq.

    ``seq`` is ``COALESCE(MAX(seq), 0) + 1`` over the kind's events table for this
    parent (uniform for both kinds). Bumps the parent's ``updated_at`` when the
    parent has one (chat only). Flushes; does not commit — the caller owns the
    transaction boundary.
    """
    if isinstance(parent, ChatRun):
        seq = _next_seq(db, table="chat_run_events", fk="run_id", parent_id=parent.id)
        db.add(ChatRunEvent(run_id=parent.id, seq=seq, event_type=event_type, payload=payload))
        parent.updated_at = func.now()
    elif isinstance(parent, OracleReading):
        seq = _next_seq(db, table="oracle_reading_events", fk="reading_id", parent_id=parent.id)
        db.add(
            OracleReadingEvent(
                reading_id=parent.id, seq=seq, event_type=event_type, payload=payload
            )
        )
    else:
        assert_never(parent)
    db.flush()
    return seq


def mark_terminal(
    db: Session,
    *,
    parent: ChatRun | OracleReading,
    status: str,
    done_payload: RunEventPayload,
    error_code: str | None = None,
    error_detail: str | None = None,
) -> None:
    """Idempotently transition the run to a terminal status and emit ``done``.

    No-op when the parent is already terminal. Otherwise sets the parent's
    ``status`` and ``completed_at``, stamps ``error_code`` on the parent when
    given and ``error_detail`` on an oracle reading (operator-facing, never
    rendered), sets ``failed_at`` on
    a failed oracle reading (its failed-has-error CHECK), then appends the
    ``done`` event. Does not commit — the caller owns the transaction boundary.
    """
    if isinstance(parent, ChatRun):
        terminal = _CHAT_TERMINAL_STATUSES
    elif isinstance(parent, OracleReading):
        terminal = _ORACLE_TERMINAL_STATUSES
    else:
        assert_never(parent)
    if parent.status in terminal:
        return
    parent.status = status
    parent.completed_at = func.now()
    if error_code is not None:
        parent.error_code = error_code
    if error_detail is not None:
        if not isinstance(parent, OracleReading):
            raise AssertionError("error_detail is an oracle reading column")
        parent.error_detail = error_detail
    if isinstance(parent, OracleReading) and status == "failed":
        parent.failed_at = func.now()
    append_event(db, parent=parent, event_type="done", payload=done_payload)


def get_run_events(
    db: Session, kind: RunStreamKind, parent_id: UUID, after: int
) -> tuple[list[ChatRunEventOut | OracleReadingEventOut], bool]:
    """Return the kind's replay events with ``seq > after`` plus the terminal flag.

    The single owner of the run-tail query (Chat/Oracle) that the SSE cursor
    stream re-reads on each notify. Per-kind payload coercion is preserved exactly
    as the old per-surface functions did. Viewer scoping is **not** here: the
    route's ``assert_viewer`` owns ownership (it runs upfront, once).
    """
    events: list[ChatRunEventOut | OracleReadingEventOut]
    if kind is RunStreamKind.ChatRun:
        chat_rows = (
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
            for row in chat_rows
        ]
    elif kind is RunStreamKind.OracleReading:
        oracle_rows = (
            db.execute(
                select(OracleReadingEvent)
                .where(
                    OracleReadingEvent.reading_id == parent_id,
                    OracleReadingEvent.seq > after,
                )
                .order_by(OracleReadingEvent.seq)
            )
            .scalars()
            .all()
        )
        events = [
            # The strict Oracle event schema narrows both the persisted event
            # discriminator and its matching payload at the database read edge.
            OracleReadingEventOut.model_validate(
                {
                    "seq": row.seq,
                    "event_type": row.event_type,
                    "payload": dict(row.payload) if isinstance(row.payload, dict) else {},
                }
            )
            for row in oracle_rows
        ]
    else:
        assert_never(kind)
    return events, is_run_terminal(db, kind, parent_id)


def is_run_terminal(db: Session, kind: RunStreamKind, parent_id: UUID) -> bool:
    """Whether the run is terminal — a missing row counts as terminal.

    A row deleted mid-stream ends the SSE tail cleanly (it would otherwise stream
    forever). No viewer scoping.
    """
    if kind is RunStreamKind.ChatRun:
        status = db.execute(
            select(ChatRun.status).where(ChatRun.id == parent_id)
        ).scalar_one_or_none()
        return status is None or status in terminal_statuses(kind)
    if kind is RunStreamKind.OracleReading:
        status = db.execute(
            select(OracleReading.status).where(OracleReading.id == parent_id)
        ).scalar_one_or_none()
        return status is None or status in terminal_statuses(kind)
    assert_never(kind)


def _next_seq(db: Session, *, table: str, fk: str, parent_id: UUID) -> int:
    return int(
        db.execute(
            text(f"SELECT COALESCE(MAX(seq), 0) + 1 FROM {table} WHERE {fk} = :parent_id"),
            {"parent_id": parent_id},
        ).scalar_one()
    )
