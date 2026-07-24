"""Exact queue-claim fencing for authoritative source publications."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import MediaSourceAttempt
from nexus.db.retries import retry_serializable
from nexus.jobs.queue import JobExecutionContext, lock_and_renew_running_job_claim
from nexus.logging import get_logger

SOURCE_PUBLICATION_LEASE_SECONDS = 300
logger = get_logger(__name__)


@dataclass(frozen=True)
class SourcePublicationFence:
    attempt_id: UUID
    job_id: UUID
    worker_id: str
    attempt_no: int

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
        )

    def execution_context(self) -> JobExecutionContext:
        return JobExecutionContext(
            job_id=self.job_id,
            worker_id=self.worker_id,
            attempt_no=self.attempt_no,
        )


class SourcePublicationSuperseded(Exception):
    """The worker no longer owns the exact source operation."""


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
                FOR UPDATE
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
