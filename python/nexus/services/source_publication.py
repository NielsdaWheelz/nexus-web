"""Exact queue-claim fencing for authoritative source publications."""

from __future__ import annotations

from collections.abc import Callable
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
        cls,
        *,
        attempt_id: UUID,
        context: JobExecutionContext,
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


def reset_source_progress(attempt: MediaSourceAttempt) -> None:
    """Reset the full progress snapshot when an exact source run starts."""
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
    """Publish one monotonic counted snapshot under the exact source lease."""
    if total < 1 or completed < 0 or completed > total:
        raise ValueError("source extraction progress is outside its counted range")

    def mutate(db: Session, attempt: MediaSourceAttempt) -> None:
        if attempt.processing_stage not in {"Validate", "Extract"}:
            raise AssertionError("source extraction progress regressed from a later stage")
        if attempt.progress_total is not None and int(attempt.progress_total) != total:
            raise AssertionError("source extraction progress total changed within one run")
        if attempt.progress_unit is not None and str(attempt.progress_unit) != unit:
            raise AssertionError("source extraction progress unit changed within one run")
        if completed < int(attempt.progress_completed or 0):
            raise AssertionError("source extraction progress regressed within one run")
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
    *,
    session_factory: sessionmaker[Session],
    fence: SourcePublicationFence,
    media_id: UUID,
) -> None:
    """Advance an exact source run to its final publication stage."""

    def mutate(db: Session, attempt: MediaSourceAttempt) -> None:
        if attempt.processing_stage not in {"Validate", "Extract"}:
            raise AssertionError("source finalization started from an invalid stage")
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


def load_source_progress(
    db: Session,
    media_ids: tuple[UUID, ...],
) -> dict[UUID, SourceProgress]:
    """Load and normalize the latest source progress for each requested media.

    Presence means "a source run is in flight". A terminal attempt keeps its last
    persisted stage as history, but must project Absent so completed media do not
    report perpetual `Finalize` progress on MediaOut, SSE, and Activity.
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
    progress_by_media_id: dict[UUID, SourceProgress] = {}
    for attempt in attempts:
        progress = _source_progress_from_attempt(attempt)
        if progress is not None:
            progress_by_media_id[attempt.media_id] = progress
    return progress_by_media_id


def _source_progress_from_attempt(attempt: MediaSourceAttempt) -> SourceProgress | None:
    stage = attempt.processing_stage
    completed = int(attempt.progress_completed or 0)
    total = attempt.progress_total
    unit = attempt.progress_unit
    updated_at = attempt.progress_updated_at
    run_count = int(attempt.run_count or 0)
    if stage is None:
        if completed != 0 or total is not None or unit is not None or updated_at is not None:
            raise AssertionError("absent source progress has persisted progress fields")
        return None
    if stage not in {"Validate", "Extract", "Finalize"}:
        raise AssertionError("source progress stage is invalid")
    if run_count < 1 or updated_at is None:
        raise AssertionError("present source progress is missing its run identity")
    if total is None and unit is None and completed == 0:
        return SourceStageProgress(
            kind="Stage",
            stage=cast(Literal["Validate", "Extract", "Finalize"], stage),
            run_count=run_count,
            updated_at=updated_at,
        )
    if stage != "Extract" or total is None or unit not in {"Page", "Chapter"}:
        raise AssertionError("counted source progress has an invalid shape")
    if int(total) < 1 or completed < 0 or completed > int(total):
        raise AssertionError("counted source progress is outside its persisted range")
    return SourceCountedProgress(
        kind="Counted",
        stage="Extract",
        completed=completed,
        total=int(total),
        unit=cast(Literal["Page", "Chapter"], unit),
        run_count=run_count,
        updated_at=updated_at,
    )


def require_source_publication(
    db: Session,
    *,
    fence: SourcePublicationFence,
    media_ids: tuple[UUID, ...],
) -> MediaSourceAttempt:
    """Lock the full source identity and authorize this transaction's writes."""
    return _require_source_publication(
        db,
        fence=fence,
        media_ids=media_ids,
        allowed_attempt_statuses={"accepted", "queued", "running"},
    )


def _require_source_publication(
    db: Session,
    *,
    fence: SourcePublicationFence,
    media_ids: tuple[UUID, ...],
    allowed_attempt_statuses: set[str],
) -> MediaSourceAttempt:
    ordered_media_ids = sorted(set(media_ids))
    locked_media_ids = list(
        db.scalars(
            text(
                """
                SELECT id
                FROM media
                WHERE id = ANY(:media_ids)
                ORDER BY id ASC
                FOR NO KEY UPDATE
                """
            ),
            {"media_ids": ordered_media_ids},
        )
    )
    if locked_media_ids != ordered_media_ids:
        logger.warning(
            "source_publication_superseded",
            reason="media_identity_changed",
            attempt_id=str(fence.attempt_id),
            job_id=str(fence.job_id),
            expected_media_ids=[str(value) for value in ordered_media_ids],
            locked_media_ids=[str(value) for value in locked_media_ids],
        )
        raise SourcePublicationSuperseded

    attempt = db.scalar(
        select(MediaSourceAttempt)
        .where(MediaSourceAttempt.id == fence.attempt_id)
        .with_for_update()
    )
    if (
        attempt is None
        or attempt.job_id != fence.job_id
        or attempt.media_id not in ordered_media_ids
        or attempt.status not in allowed_attempt_statuses
    ):
        logger.warning(
            "source_publication_superseded",
            reason="attempt_identity_changed",
            attempt_id=str(fence.attempt_id),
            job_id=str(fence.job_id),
            observed_attempt_job_id=(
                str(attempt.job_id) if attempt is not None and attempt.job_id else None
            ),
            observed_attempt_status=(attempt.status if attempt is not None else None),
        )
        raise SourcePublicationSuperseded
    latest_attempt_id = db.scalar(
        select(MediaSourceAttempt.id)
        .where(MediaSourceAttempt.media_id == attempt.media_id)
        .order_by(
            MediaSourceAttempt.attempt_no.desc(),
            MediaSourceAttempt.created_at.desc(),
            MediaSourceAttempt.id.desc(),
        )
        .limit(1)
    )
    if latest_attempt_id != attempt.id:
        logger.warning(
            "source_publication_superseded",
            reason="newer_source_attempt_exists",
            attempt_id=str(fence.attempt_id),
            job_id=str(fence.job_id),
            latest_attempt_id=str(latest_attempt_id) if latest_attempt_id else None,
        )
        raise SourcePublicationSuperseded

    job = lock_and_renew_running_job_claim(
        db,
        context=fence.execution_context(),
        lease_seconds=SOURCE_PUBLICATION_LEASE_SECONDS,
    )
    if job is None:
        logger.warning(
            "source_publication_superseded",
            reason="queue_claim_lost",
            attempt_id=str(fence.attempt_id),
            job_id=str(fence.job_id),
            worker_id=fence.worker_id,
            attempt_no=fence.attempt_no,
        )
        raise SourcePublicationSuperseded
    if (
        job.kind != "ingest_media_source"
        or str(job.payload.get("attempt_id")) != str(fence.attempt_id)
        or str(job.payload.get("media_id")) != str(attempt.media_id)
    ):
        # justify-defect: the source attempt and queue payload are one durable identity.
        raise AssertionError("source publication queue identity is malformed")
    return attempt


def run_source_publication_phase[T](
    *,
    session_factory: sessionmaker[Session],
    label: str,
    fence: SourcePublicationFence,
    media_ids: tuple[UUID, ...],
    mutate: Callable[[Session, MediaSourceAttempt], T],
) -> T:
    """Run one exact source mutation in its owned fresh-session boundary.

    One session exists for the complete bounded ``retry_serializable`` call and
    is closed before this function returns.  Every retry reacquires the complete
    media -> attempt -> exact queue-claim lock set before the callback receives
    the freshly loaded attempt.  The callback may perform database work only;
    callers must finish provider, filesystem, and object-store I/O first.
    """
    db = session_factory()
    try:

        def transaction() -> T:
            attempt = require_source_publication(
                db,
                fence=fence,
                media_ids=media_ids,
            )
            result = mutate(db, attempt)
            db.commit()
            return result

        return retry_serializable(
            db,
            label,
            transaction,
        )
    finally:
        db.close()
