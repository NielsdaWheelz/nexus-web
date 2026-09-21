"""Import-history projections of queue-envelope outcomes.

The sibling of ``dead_letter_projections``: the worker applies the kind's
declared projection in the same transaction that commits a queue transition, so
a committed execution failure can never lack its history. Every branch is
total -- ``queue_failure_code`` maps any code, and a missing owner row (the
media was torn down under a dying job) records nothing rather than aborting the
transition.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Literal, assert_never
from uuid import UUID

from sqlalchemy import text

from nexus.schemas.import_history import (
    IndexFailed,
    IndexRetryScheduled,
    SafeFailureCode,
    SourceFailed,
    SourceRetryScheduled,
    Stage,
    queue_failure_code,
)
from nexus.schemas.presence import Presence, absent, presence_from_nullable, present
from nexus.services.import_history import append_processing_event
from nexus.services.source_history import source_failure_progress, source_history_stage

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from nexus.jobs.queue import JobRow

type HistoryProjection = Literal["None", "SourceAttempt", "ContentIndex"]
"""Closed set of history owners a job kind may declare."""

_INDEX_STAGE: Presence[Stage] = present("Index")


@dataclass(frozen=True)
class RetryScheduled:
    next_attempt_at: datetime
    error_code: str


@dataclass(frozen=True)
class Dead:
    error_code: str


@dataclass(frozen=True)
class Interrupted:
    """An expired running claim: ``execution_id`` is the interrupted execution,
    ``None`` when it predates execution identity; ``terminal`` when the queue
    dead-lettered it instead of reclaiming it."""

    execution_id: UUID | None
    terminal: bool


@dataclass(frozen=True)
class Rescheduled:
    next_attempt_at: datetime


type HistoryOutcome = RetryScheduled | Dead | Interrupted | Rescheduled


def apply_history_projection(
    db: Session, *, projection: HistoryProjection, job: JobRow, outcome: HistoryOutcome
) -> None:
    """Record one queue-envelope outcome for the job's history owner."""
    if projection == "None":
        return
    execution_id = job.execution_id
    failure: SafeFailureCode | None = None
    terminal = False
    next_attempt_at: datetime | None = None
    match outcome:
        case RetryScheduled(next_attempt_at=next_attempt_at, error_code=error_code):
            failure = queue_failure_code(error_code)
        case Dead(error_code=error_code):
            failure = queue_failure_code(error_code)
            terminal = True
        case Interrupted(execution_id=execution_id, terminal=terminal):
            failure = "E_WORKER_INTERRUPTED"
        case Rescheduled(next_attempt_at=next_attempt_at):
            pass
        case _ as unreachable:
            assert_never(unreachable)
    recorder = _record_source_attempt if projection == "SourceAttempt" else _record_content_index
    recorder(db, job, presence_from_nullable(execution_id), failure, terminal, next_attempt_at)


def _record_source_attempt(
    db: Session,
    job: JobRow,
    execution_id: Presence[UUID],
    failure: SafeFailureCode | None,
    terminal: bool,
    next_attempt_at: datetime | None,
) -> None:
    attempt_id = UUID(str(job.payload["attempt_id"]))
    media_id = UUID(str(job.payload["media_id"]))
    attempt = (
        db.execute(
            text(
                """
                SELECT source_type, processing_stage, progress_completed, progress_total,
                       progress_unit
                FROM media_source_attempts
                WHERE id = :attempt_id AND media_id = :media_id
                """
            ),
            {"attempt_id": attempt_id, "media_id": media_id},
        )
        .mappings()
        .one_or_none()
    )
    if attempt is None:
        return
    stage: Presence[Stage] = present(
        source_history_stage(
            source_type=str(attempt["source_type"]),
            processing_stage=attempt["processing_stage"],
        )
    )
    if failure is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=SourceFailed(
                source_attempt_id=attempt_id,
                execution_id=execution_id,
                origin="Execution",
                terminal=terminal,
                progress=source_failure_progress(
                    processing_stage=attempt["processing_stage"],
                    progress_completed=int(attempt["progress_completed"]),
                    progress_total=attempt["progress_total"],
                    progress_unit=attempt["progress_unit"],
                ),
            ),
            stage=stage,
            failure_code=present(failure),
        )
    if next_attempt_at is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=SourceRetryScheduled(
                source_attempt_id=attempt_id,
                execution_id=execution_id,
                next_attempt_at=next_attempt_at,
            ),
            stage=stage,
            failure_code=absent(),
        )


def _record_content_index(
    db: Session,
    job: JobRow,
    execution_id: Presence[UUID],
    failure: SafeFailureCode | None,
    terminal: bool,
    next_attempt_at: datetime | None,
) -> None:
    media_id = UUID(str(job.payload["media_id"]))
    revision = int(job.payload["revision"])
    if (
        db.execute(text("SELECT 1 FROM media WHERE id = :media_id"), {"media_id": media_id}).first()
        is None
    ):
        return
    if failure is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=IndexFailed(
                revision=revision,
                job_id=job.id,
                execution_id=execution_id,
                origin="Execution",
                terminal=terminal,
            ),
            stage=_INDEX_STAGE,
            failure_code=present(failure),
        )
    if next_attempt_at is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=IndexRetryScheduled(
                revision=revision,
                job_id=job.id,
                execution_id=execution_id,
                next_attempt_at=next_attempt_at,
            ),
            stage=_INDEX_STAGE,
            failure_code=absent(),
        )
