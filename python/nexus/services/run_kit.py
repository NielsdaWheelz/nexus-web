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

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from typing import Any, assert_never, cast
from uuid import UUID

from pydantic import JsonValue
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from nexus.db.models import (
    ArtifactRevision,
    ArtifactRevisionEvent,
    ChatRun,
    ChatRunEvent,
    OracleReading,
    OracleReadingEvent,
)
from nexus.schemas.artifact import ArtifactRevisionEventOut
from nexus.schemas.conversation import ChatRunEventOut
from nexus.schemas.oracle import OracleReadingEventOut

RunEventPayload = dict[str, JsonValue]

_CHAT_TERMINAL_STATUSES = frozenset({"complete", "error", "cancelled"})
_ORACLE_TERMINAL_STATUSES = frozenset({"complete", "failed"})
_ARTIFACT_REVISION_TERMINAL_STATUSES = frozenset({"ready", "failed"})
_CHAT_CHANNEL = "chat_run_events"
_ORACLE_CHANNEL = "oracle_reading_events"
_ARTIFACT_REVISION_CHANNEL = "artifact_revision_events"


class RunStreamKind(Enum):
    """The durable-run kinds that share the generic event/finalize mechanics."""

    ChatRun = "ChatRun"
    OracleReading = "OracleReading"
    ArtifactRevision = "ArtifactRevision"


@dataclass(frozen=True)
class RunStream:
    """A durable-run event stream bound to one parent run row."""

    parent: ChatRun | OracleReading | ArtifactRevision


def chat_run_stream(run: ChatRun) -> RunStream:
    return RunStream(parent=run)


def oracle_reading_stream(reading: OracleReading) -> RunStream:
    return RunStream(parent=reading)


def artifact_revision_stream(revision: ArtifactRevision) -> RunStream:
    return RunStream(parent=revision)


def notify_channel(kind: RunStreamKind) -> str:
    """The LISTEN/NOTIFY channel for a run kind (the only per-kind SSE constant)."""
    if kind is RunStreamKind.ChatRun:
        return _CHAT_CHANNEL
    if kind is RunStreamKind.OracleReading:
        return _ORACLE_CHANNEL
    if kind is RunStreamKind.ArtifactRevision:
        return _ARTIFACT_REVISION_CHANNEL
    assert_never(kind)


def terminal_statuses(kind: RunStreamKind) -> frozenset[str]:
    """The terminal status set for a run kind (the one owner of each set)."""
    if kind is RunStreamKind.ChatRun:
        return _CHAT_TERMINAL_STATUSES
    if kind is RunStreamKind.OracleReading:
        return _ORACLE_TERMINAL_STATUSES
    if kind is RunStreamKind.ArtifactRevision:
        return _ARTIFACT_REVISION_TERMINAL_STATUSES
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
    elif isinstance(parent, ArtifactRevision):
        seq = _next_seq(db, table="artifact_revision_events", fk="revision_id", parent_id=parent.id)
        db.add(
            ArtifactRevisionEvent(
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
    error_code: str | None = None,
    error_detail: str | None = None,
) -> None:
    """Idempotently transition the run to a terminal status and emit ``done``.

    No-op when the parent is already terminal. Otherwise sets the parent's
    ``status`` and ``completed_at``, stamps ``error_code``/``error_detail`` on
    the parent when given (this is the one writer of the run-parent error pair;
    ``error_detail`` is operator-facing, never rendered), sets ``failed_at`` on
    a failed oracle reading (its failed-has-error CHECK), then appends the
    ``done`` event. Does not commit — the caller owns the transaction boundary.
    """
    parent = stream.parent
    if isinstance(parent, ChatRun):
        terminal = _CHAT_TERMINAL_STATUSES
    elif isinstance(parent, OracleReading):
        terminal = _ORACLE_TERMINAL_STATUSES
    elif isinstance(parent, ArtifactRevision):
        terminal = _ARTIFACT_REVISION_TERMINAL_STATUSES
    else:
        assert_never(parent)
    if parent.status in terminal:
        return
    parent.status = status
    parent.completed_at = func.now()
    if error_code is not None:
        parent.error_code = error_code
    if error_detail is not None:
        parent.error_detail = error_detail
    if isinstance(parent, OracleReading) and status == "failed":
        parent.failed_at = func.now()
    append_event(db, stream=stream, event_type="done", payload=done_payload)


def get_run_events(
    db: Session, kind: RunStreamKind, parent_id: UUID, after: int
) -> tuple[list[ChatRunEventOut | OracleReadingEventOut | ArtifactRevisionEventOut], bool]:
    """Return the kind's replay events with ``seq > after`` plus the terminal flag.

    The single owner of the run-tail query (chat/oracle/LI) that the SSE cursor
    stream re-reads on each notify. Per-kind payload coercion is preserved exactly
    as the old per-surface functions did. Viewer scoping is **not** here: the
    route's ``assert_viewer`` owns ownership (it runs upfront, once).
    """
    events: list[ChatRunEventOut | OracleReadingEventOut | ArtifactRevisionEventOut]
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
            OracleReadingEventOut(
                seq=row.seq, event_type=row.event_type, payload=dict(row.payload or {})
            )
            for row in oracle_rows
        ]
    elif kind is RunStreamKind.ArtifactRevision:
        artifact_rows = (
            db.execute(
                select(ArtifactRevisionEvent)
                .where(
                    ArtifactRevisionEvent.revision_id == parent_id,
                    ArtifactRevisionEvent.seq > after,
                )
                .order_by(ArtifactRevisionEvent.seq)
            )
            .scalars()
            .all()
        )
        events = [
            ArtifactRevisionEventOut(
                seq=row.seq,
                event_type=row.event_type,
                payload=dict(row.payload) if isinstance(row.payload, dict) else {},
            )
            for row in artifact_rows
        ]
    else:
        assert_never(kind)
    return events, is_run_terminal(db, kind, parent_id)


def is_run_terminal(db: Session, kind: RunStreamKind, parent_id: UUID) -> bool:
    """Whether the run is terminal — a missing row counts as terminal.

    A row deleted mid-stream ends the SSE tail cleanly (it would otherwise stream
    forever). Adopts the scalar-status query for all three kinds. No viewer scoping.
    """
    if kind is RunStreamKind.ChatRun:
        status = db.execute(
            select(ChatRun.status).where(ChatRun.id == parent_id)
        ).scalar_one_or_none()
    elif kind is RunStreamKind.OracleReading:
        status = db.execute(
            select(OracleReading.status).where(OracleReading.id == parent_id)
        ).scalar_one_or_none()
    elif kind is RunStreamKind.ArtifactRevision:
        status = db.execute(
            select(ArtifactRevision.status).where(ArtifactRevision.id == parent_id)
        ).scalar_one_or_none()
    else:
        assert_never(kind)
    return status is None or status in terminal_statuses(kind)


def fail_run_after_worker_exception[P](
    db: Session,
    *,
    load_parent: Callable[[Session], P | None],
    is_terminal: Callable[[P], bool],
    write_failure: Callable[[Session, P], None],
) -> tuple[P | None, bool]:
    """Shared worker-boundary failure write for oracle/LI/media-unit tasks.

    Rolls back the broken transaction, reloads the run parent on the clean
    session, no-ops when it is missing or already terminal, otherwise applies
    ``write_failure`` (typically ``mark_terminal(status="failed", error_code=…,
    error_detail=…)``) and commits. Returns ``(parent, failed_now)``: parent is
    ``None`` when missing; ``failed_now`` is True only when this call wrote the
    failure.
    """
    db.rollback()
    parent = load_parent(db)
    if parent is None or is_terminal(parent):
        db.commit()
        return parent, False
    write_failure(db, parent)
    db.commit()
    return parent, True


def _next_seq(db: Session, *, table: str, fk: str, parent_id: UUID) -> int:
    return int(
        db.execute(
            text(f"SELECT COALESCE(MAX(seq), 0) + 1 FROM {table} WHERE {fk} = :parent_id"),
            {"parent_id": parent_id},
        ).scalar_one()
    )
