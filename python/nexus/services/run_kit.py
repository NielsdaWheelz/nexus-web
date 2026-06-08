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

from dataclasses import dataclass
from enum import Enum
from typing import assert_never
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import func, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ChatRun,
    ChatRunEvent,
    LibraryIntelligenceArtifactRevision,
    LibraryIntelligenceRevisionEvent,
    OracleReading,
    OracleReadingEvent,
)

RunEventPayload = dict[str, JsonValue]

_CHAT_TERMINAL_STATUSES = frozenset({"complete", "error", "cancelled"})
_ORACLE_TERMINAL_STATUSES = frozenset({"complete", "failed"})
_LIBRARY_INTELLIGENCE_TERMINAL_STATUSES = frozenset({"ready", "failed"})
_CHAT_CHANNEL = "chat_run_events"
_ORACLE_CHANNEL = "oracle_reading_events"
_LIBRARY_INTELLIGENCE_CHANNEL = "library_intelligence_revision_events"


class RunStreamKind(Enum):
    """The durable-run kinds that share the generic event/finalize mechanics."""

    ChatRun = "ChatRun"
    OracleReading = "OracleReading"
    LibraryIntelligence = "LibraryIntelligence"


@dataclass(frozen=True)
class RunStream:
    """A durable-run event stream bound to one parent run row."""

    parent: ChatRun | OracleReading | LibraryIntelligenceArtifactRevision


def chat_run_stream(run: ChatRun) -> RunStream:
    return RunStream(parent=run)


def oracle_reading_stream(reading: OracleReading) -> RunStream:
    return RunStream(parent=reading)


def library_intelligence_revision_stream(
    revision: LibraryIntelligenceArtifactRevision,
) -> RunStream:
    return RunStream(parent=revision)


def notify_channel(kind: RunStreamKind) -> str:
    """The LISTEN/NOTIFY channel for a run kind (the only per-kind SSE constant)."""
    if kind is RunStreamKind.ChatRun:
        return _CHAT_CHANNEL
    if kind is RunStreamKind.OracleReading:
        return _ORACLE_CHANNEL
    if kind is RunStreamKind.LibraryIntelligence:
        return _LIBRARY_INTELLIGENCE_CHANNEL
    assert_never(kind)


def terminal_statuses(kind: RunStreamKind) -> frozenset[str]:
    """The terminal status set for a run kind (the one owner of each set)."""
    if kind is RunStreamKind.ChatRun:
        return _CHAT_TERMINAL_STATUSES
    if kind is RunStreamKind.OracleReading:
        return _ORACLE_TERMINAL_STATUSES
    if kind is RunStreamKind.LibraryIntelligence:
        return _LIBRARY_INTELLIGENCE_TERMINAL_STATUSES
    assert_never(kind)


def append_event(
    db: Session,
    *,
    stream: RunStream,
    event_type: str,
    payload: RunEventPayload,
) -> int:
    """Append one event with the next monotonic ``seq`` and return that seq.

    ``seq`` is ``COALESCE(MAX(seq), 0) + 1`` over the kind's events table for this
    parent (uniform for both kinds). Bumps the parent's ``updated_at`` when the
    parent has one (chat only). Flushes; does not commit — the caller owns the
    transaction boundary.
    """
    parent = stream.parent
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
    elif isinstance(parent, LibraryIntelligenceArtifactRevision):
        seq = _next_seq(
            db, table="library_intelligence_revision_events", fk="revision_id", parent_id=parent.id
        )
        db.add(
            LibraryIntelligenceRevisionEvent(
                revision_id=parent.id, seq=seq, event_type=event_type, payload=payload
            )
        )
    else:
        assert_never(parent)
    db.flush()
    return seq


def mark_terminal(
    db: Session,
    *,
    stream: RunStream,
    status: str,
    done_payload: RunEventPayload,
) -> None:
    """Idempotently transition the run to a terminal status and emit ``done``.

    No-op when the parent is already terminal. Otherwise sets the parent's
    ``status`` and ``completed_at``, then appends the ``done`` event. Does not
    commit — the caller owns the transaction boundary.
    """
    parent = stream.parent
    if isinstance(parent, ChatRun):
        terminal = _CHAT_TERMINAL_STATUSES
    elif isinstance(parent, OracleReading):
        terminal = _ORACLE_TERMINAL_STATUSES
    elif isinstance(parent, LibraryIntelligenceArtifactRevision):
        terminal = _LIBRARY_INTELLIGENCE_TERMINAL_STATUSES
    else:
        assert_never(parent)
    if parent.status in terminal:
        return
    parent.status = status
    parent.completed_at = func.now()
    append_event(db, stream=stream, event_type="done", payload=done_payload)


def _next_seq(db: Session, *, table: str, fk: str, parent_id: UUID) -> int:
    return int(
        db.execute(
            text(f"SELECT COALESCE(MAX(seq), 0) + 1 FROM {table} WHERE {fk} = :parent_id"),
            {"parent_id": parent_id},
        ).scalar_one()
    )
