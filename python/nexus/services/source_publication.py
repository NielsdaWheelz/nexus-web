"""Exact queue-claim fencing for authoritative source publications."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import MediaSourceAttempt, MediaSourceAttemptStatus
from nexus.db.retries import retry_serializable
from nexus.jobs.queue import JobExecutionContext, lock_and_renew_running_job_claim
from nexus.logging import get_logger
from nexus.schemas.import_history import SourceStageChanged, Stage
from nexus.schemas.presence import absent, present
from nexus.services.import_history import append_processing_event

SOURCE_PUBLICATION_LEASE_SECONDS = 300
_NONTERMINAL = {"accepted", "queued", "running"}
logger = get_logger(__name__)


@dataclass(frozen=True)
class SourcePublicationFence:
    attempt_id: UUID
    job_id: UUID
    worker_id: str
    attempt_no: int
    resource_class: Literal["Light", "Heavy"]
    execution_id: UUID

    @classmethod
    def from_context(
        cls, *, attempt_id: UUID, context: JobExecutionContext
    ) -> SourcePublicationFence:
        return cls(
            attempt_id=attempt_id,
            job_id=context.job_id,
            worker_id=context.worker_id,
            attempt_no=context.attempt_no,
            resource_class=context.resource_class,
            execution_id=context.execution_id,
        )

    def execution_context(self) -> JobExecutionContext:
        return JobExecutionContext(
            job_id=self.job_id,
            worker_id=self.worker_id,
            attempt_no=self.attempt_no,
            resource_class=self.resource_class,
            execution_id=self.execution_id,
        )


class SourcePublicationSuperseded(Exception):
    """The worker no longer owns the exact source operation."""


@dataclass(frozen=True)
class SourceStageProgress:
    kind: Literal["Stage"]
    stage: Literal["Validate", "Extract", "Finalize"]
    run_count: int
    updated_at: datetime


@dataclass(frozen=True)
class SourceCountedProgress:
    kind: Literal["Counted"]
    stage: Literal["Extract"]
    completed: int
    total: int
    unit: Literal["Page", "Chapter"]
    run_count: int
    updated_at: datetime


type SourceProgress = SourceStageProgress | SourceCountedProgress


def require_source_publication(
    db: Session, *, fence: SourcePublicationFence, media_ids: tuple[UUID, ...]
) -> MediaSourceAttempt:
    """Lock the full source identity, in ascending id order, and authorize writes."""
    ordered_media_ids = sorted(set(media_ids))
    locked_media_ids = list(
        db.scalars(
            text(
                "SELECT id FROM media WHERE id = ANY(:media_ids) ORDER BY id ASC FOR NO KEY UPDATE"
            ),
            {"media_ids": ordered_media_ids},
        )
    )
    if locked_media_ids != ordered_media_ids:
        raise SourcePublicationSuperseded("media_identity_changed")

    attempt = db.scalar(
        select(MediaSourceAttempt)
        .where(MediaSourceAttempt.id == fence.attempt_id)
        .with_for_update()
    )
    if (
        attempt is None
        or attempt.job_id != fence.job_id
        or attempt.media_id not in ordered_media_ids
        or attempt.status not in _NONTERMINAL
    ):
        raise SourcePublicationSuperseded("attempt_identity_changed")
    if latest_source_attempt_id(db, attempt.media_id) != attempt.id:
        raise SourcePublicationSuperseded("newer_source_attempt_exists")
    if (
        lock_and_renew_running_job_claim(
            db, context=fence.execution_context(), lease_seconds=SOURCE_PUBLICATION_LEASE_SECONDS
        )
        is None
    ):
        raise SourcePublicationSuperseded("queue_claim_lost")
    return attempt


def latest_source_attempt_id(db: Session, media_id: UUID) -> UUID | None:
    """The one authoritative attempt of a media, ordered (attempt_no, created_at, id)."""
    return db.scalar(
        select(MediaSourceAttempt.id)
        .where(MediaSourceAttempt.media_id == media_id)
        .order_by(
            MediaSourceAttempt.attempt_no.desc(),
            MediaSourceAttempt.created_at.desc(),
            MediaSourceAttempt.id.desc(),
        )
        .limit(1)
    )


def run_source_publication_phase[T](
    *,
    session_factory: sessionmaker[Session],
    label: str,
    fence: SourcePublicationFence,
    media_ids: tuple[UUID, ...],
    mutate: Callable[[Session, MediaSourceAttempt], T],
    discover: Callable[[Session], Iterable[UUID]] | None = None,
) -> T:
    """Run one exact source mutation in its own fresh-session transaction.

    ``discover`` runs first, inside the same serializable transaction and before
    any lock, so a phase whose affected media set is not known in advance still
    takes the complete lock set in ascending id order. The callback may perform
    database work only; provider, filesystem and object-store I/O must be done.
    """
    db = session_factory()
    try:

        def transaction() -> T:
            extra = tuple(discover(db)) if discover is not None else ()
            attempt = require_source_publication(db, fence=fence, media_ids=(*media_ids, *extra))
            result = mutate(db, attempt)
            db.commit()
            return result

        try:
            return retry_serializable(db, label, transaction)
        except SourcePublicationSuperseded as exc:
            logger.warning(
                "source_publication_superseded",
                label=label,
                reason=str(exc),
                attempt_id=str(fence.attempt_id),
                job_id=str(fence.job_id),
            )
            raise
    finally:
        db.close()


def reset_source_progress(attempt: MediaSourceAttempt) -> None:
    """Reset the progress snapshot when an exact source run starts."""
    attempt.processing_stage = "Validate"
    attempt.progress_completed = 0
    attempt.progress_total = None
    attempt.progress_unit = None
    attempt.progress_updated_at = func.now()


def record_source_extraction_progress(
    *,
    session_factory: sessionmaker[Session],
    fence: SourcePublicationFence,
    media_id: UUID,
    completed: int,
    total: int,
    unit: Literal["Page", "Chapter"],
) -> None:
    """Publish one counted extraction snapshot under the exact source lease."""

    def mutate(db: Session, attempt: MediaSourceAttempt) -> None:
        if attempt.processing_stage != "Extract":
            _record_stage_changed(db, fence=fence, media_id=media_id, stage="Extract")
        attempt.processing_stage = "Extract"
        attempt.progress_completed = completed
        attempt.progress_total = total
        attempt.progress_unit = unit
        attempt.progress_updated_at = func.now()

    run_source_publication_phase(
        session_factory=session_factory,
        label="record_source_extraction_progress",
        fence=fence,
        media_ids=(media_id,),
        mutate=mutate,
    )


def record_source_finalizing(
    *, session_factory: sessionmaker[Session], fence: SourcePublicationFence, media_id: UUID
) -> None:
    """Advance an exact source run to its final publication stage."""

    def mutate(db: Session, attempt: MediaSourceAttempt) -> None:
        _record_stage_changed(db, fence=fence, media_id=media_id, stage="Finalize")
        attempt.processing_stage = "Finalize"
        attempt.progress_completed = 0
        attempt.progress_total = None
        attempt.progress_unit = None
        attempt.progress_updated_at = func.now()

    run_source_publication_phase(
        session_factory=session_factory,
        label="record_source_finalizing",
        fence=fence,
        media_ids=(media_id,),
        mutate=mutate,
    )


def _record_stage_changed(
    db: Session, *, fence: SourcePublicationFence, media_id: UUID, stage: Stage
) -> None:
    append_processing_event(
        db,
        media_id=media_id,
        facts=SourceStageChanged(
            source_attempt_id=fence.attempt_id, execution_id=fence.execution_id
        ),
        stage=present(stage),
        failure_code=absent(),
    )


def load_source_progress(db: Session, media_ids: tuple[UUID, ...]) -> dict[UUID, SourceProgress]:
    """Progress for each media with a source run in flight.

    A terminal attempt keeps its last stage as history but projects absent, so
    completed media never report perpetual ``Finalize`` progress.
    """
    if not media_ids:
        return {}
    attempts = db.scalars(
        select(MediaSourceAttempt)
        .where(
            MediaSourceAttempt.media_id.in_(media_ids),
            MediaSourceAttempt.status.in_(
                (
                    MediaSourceAttemptStatus.accepted,
                    MediaSourceAttemptStatus.queued,
                    MediaSourceAttemptStatus.running,
                )
            ),
        )
        .distinct(MediaSourceAttempt.media_id)
        .order_by(
            MediaSourceAttempt.media_id,
            MediaSourceAttempt.attempt_no.desc(),
            MediaSourceAttempt.created_at.desc(),
            MediaSourceAttempt.id.desc(),
        )
    ).all()
    progress: dict[UUID, SourceProgress] = {}
    for attempt in attempts:
        stage = attempt.processing_stage
        updated_at = attempt.progress_updated_at
        if stage is None or updated_at is None:
            continue
        run_count = int(attempt.run_count or 0)
        total = attempt.progress_total
        unit = attempt.progress_unit
        if stage == "Extract" and total is not None and unit in {"Page", "Chapter"}:
            progress[attempt.media_id] = SourceCountedProgress(
                kind="Counted",
                stage="Extract",
                completed=int(attempt.progress_completed or 0),
                total=int(total),
                unit=cast(Literal["Page", "Chapter"], unit),
                run_count=run_count,
                updated_at=updated_at,
            )
        else:
            progress[attempt.media_id] = SourceStageProgress(
                kind="Stage",
                stage=cast(Literal["Validate", "Extract", "Finalize"], stage),
                run_count=run_count,
                updated_at=updated_at,
            )
    return progress
