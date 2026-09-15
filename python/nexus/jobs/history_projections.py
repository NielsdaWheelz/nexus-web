"""Import-history projections of queue-envelope outcomes, applied inside the
worker's queue transition.

The sibling of ``dead_letter_projections``: a registry-declared, closed per-kind
projection the worker applies in the same transaction that commits a queue
transition, so a committed execution failure can never lack its history. The
seam records only what the queue knows -- execution identity, the safe code,
the next attempt time -- and reads the owner's row for the stage it was at.

Import discipline matches ``dead_letter_projections``: SQLAlchemy, the history
schema, and the source-history leaf at module scope, never the ORM, a parser, a
provider, or a storage client -- the supervisor imports this module through the
registry and stays slim (`tests/testkit/background_process_containment_probe.py`
names what it may not load). Every branch is total:
``queue_failure_code`` maps any code, and a missing owner row (the media was
torn down under a dying job) records nothing rather than aborting the transition.
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


@dataclass(frozen=True)
class _Failure:
    execution_id: UUID | None
    code: SafeFailureCode
    terminal: bool


@dataclass(frozen=True)
class _Retry:
    execution_id: UUID | None
    next_attempt_at: datetime


def apply_history_projection(
    db: Session, *, projection: HistoryProjection, job: JobRow, outcome: HistoryOutcome
) -> None:
    """Record one queue-envelope outcome for the job's history owner."""
    if projection == "None":
        return
    failure: _Failure | None = None
    retry: _Retry | None = None
    match outcome:
        case RetryScheduled(next_attempt_at=next_attempt_at, error_code=error_code):
            failure = _Failure(job.execution_id, queue_failure_code(error_code), terminal=False)
            retry = _Retry(job.execution_id, next_attempt_at)
        case Dead(error_code=error_code):
            failure = _Failure(job.execution_id, queue_failure_code(error_code), terminal=True)
        case Interrupted(execution_id=execution_id, terminal=terminal):
            failure = _Failure(execution_id, "E_WORKER_INTERRUPTED", terminal)
        case Rescheduled(next_attempt_at=next_attempt_at):
            retry = _Retry(job.execution_id, next_attempt_at)
        case _ as unreachable:
            assert_never(unreachable)
    if projection == "SourceAttempt":
        _record_source_attempt(db, job, failure=failure, retry=retry)
        return
    if projection == "ContentIndex":
        _record_content_index(db, job, failure=failure, retry=retry)
        return
    assert_never(projection)


def _record_source_attempt(
    db: Session, job: JobRow, *, failure: _Failure | None, retry: _Retry | None
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
                execution_id=presence_from_nullable(failure.execution_id),
                origin="Execution",
                terminal=failure.terminal,
                progress=source_failure_progress(
                    processing_stage=attempt["processing_stage"],
                    progress_completed=int(attempt["progress_completed"]),
                    progress_total=attempt["progress_total"],
                    progress_unit=attempt["progress_unit"],
                ),
            ),
            stage=stage,
            failure_code=present(failure.code),
        )
    if retry is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=SourceRetryScheduled(
                source_attempt_id=attempt_id,
                execution_id=presence_from_nullable(retry.execution_id),
                next_attempt_at=retry.next_attempt_at,
            ),
            stage=stage,
            failure_code=absent(),
        )


def _record_content_index(
    db: Session, job: JobRow, *, failure: _Failure | None, retry: _Retry | None
) -> None:
    media_id = UUID(str(job.payload["media_id"]))
    revision = int(job.payload["revision"])
    owner = db.execute(text("SELECT 1 FROM media WHERE id = :media_id"), {"media_id": media_id})
    if owner.first() is None:
        return
    if failure is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=IndexFailed(
                revision=revision,
                job_id=job.id,
                execution_id=presence_from_nullable(failure.execution_id),
                origin="Execution",
                terminal=failure.terminal,
            ),
            stage=_INDEX_STAGE,
            failure_code=present(failure.code),
        )
    if retry is not None:
        append_processing_event(
            db,
            media_id=media_id,
            facts=IndexRetryScheduled(
                revision=revision,
                job_id=job.id,
                execution_id=presence_from_nullable(retry.execution_id),
                next_attempt_at=retry.next_attempt_at,
            ),
            stage=_INDEX_STAGE,
            failure_code=absent(),
        )
