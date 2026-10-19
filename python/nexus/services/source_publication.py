"""The fence every write of a source run passes, its progress, and its terminal failure.

I1: a run writes only inside ``run_source_publication_phase``, which locks the media
rows ascending, then the attempt, and requires that the attempt is this job's,
nonterminal and its media's latest, and that the queue claim is still live.
I3: a terminal failure writes the attempt's ``error_code`` and the media's
``last_error_code`` in one transaction.

Import-light: the background supervisor loads ``on_failure`` and ``on_dead_letter``
from here, so nothing below reaches storage or a provider.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, cast
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from nexus.db.models import MediaSourceAttempt
from nexus.db.retries import retry_serializable
from nexus.errors import ApiErrorCode, ResourceFailureDimension
from nexus.jobs.queue import JobExecutionContext, JobRow, lock_running_job_claim
from nexus.logging import get_logger
from nexus.schemas.import_history import (
    SourceFailed,
    SourceStageChanged,
    assume_safe_failure_code,
    queue_failure_code,
)
from nexus.schemas.media_sources import (
    SourceCountedProgress,
    SourceProgress,
    SourceStageProgress,
)
from nexus.services import source_types as st
from nexus.services.import_history import append_processing_event
from nexus.services.media_processing_state import (
    mark_media_failed_by_id,
    mark_ready_for_reading_by_id,
)
from nexus.services.podcasts.transcription_failure import (
    PodcastTranscriptionFailure,
    publish_podcast_transcription_failure,
)
from nexus.services.transcripts.state import set_media_transcript_state
from nexus.services.x_source import has_retained_x_publication

logger = get_logger(__name__)

_RESOURCE_LIMIT_MESSAGES: dict[ResourceFailureDimension, str] = {
    "Memory": "Source processing exceeded its memory resource limit.",
    "Time": "Source processing exceeded its time resource limit.",
    "Structure": "Source structure exceeded its processing resource limit.",
    "Output": "Source output exceeded its processing resource limit.",
}
_LATEST_ID_SQL = f"""SELECT id FROM media_source_attempts WHERE media_id = :media_id
    ORDER BY {st.LATEST_ORDER_SQL} LIMIT 1"""


@dataclass(frozen=True)
class SourcePublicationFence(JobExecutionContext):
    """A source attempt's claim: every publication phase fences on it."""

    attempt_id: UUID

    @classmethod
    def from_context(
        cls, *, attempt_id: UUID, context: JobExecutionContext
    ) -> SourcePublicationFence:
        return cls(context.job_id, context.execution_id, context.attempt_no, attempt_id)


class SourcePublicationSuperseded(Exception):
    """The worker no longer owns the exact source operation."""


def run_source_publication_phase[T](
    *,
    session_factory: sessionmaker[Session],
    label: str,
    fence: SourcePublicationFence,
    media_ids: tuple[UUID, ...],
    mutate: Callable[[Session, MediaSourceAttempt], T],
    discover: Callable[[Session], Iterable[UUID]] | None = None,
) -> T:
    """One fenced mutation in its own serializable transaction, database work only.

    ``discover`` runs first, inside the same transaction, so a phase whose media set
    is not known in advance still locks the whole set in ascending order.
    """
    db = session_factory()

    def phase() -> T:
        ordered = sorted({*media_ids, *(discover(db) if discover is not None else ())})
        locked = list(
            db.scalars(
                text("SELECT id FROM media WHERE id = ANY(:ids) ORDER BY id FOR NO KEY UPDATE"),
                {"ids": ordered},
            )
        )
        attempt = db.scalar(
            select(MediaSourceAttempt)
            .where(MediaSourceAttempt.id == fence.attempt_id)
            .with_for_update()
        )
        if locked != ordered:
            raise SourcePublicationSuperseded("media_identity_changed")
        if (
            attempt is None
            or attempt.job_id != fence.job_id
            or attempt.media_id not in ordered
            or attempt.status not in st.IN_FLIGHT
        ):
            raise SourcePublicationSuperseded("attempt_identity_changed")
        if db.scalar(text(_LATEST_ID_SQL), {"media_id": attempt.media_id}) != attempt.id:
            raise SourcePublicationSuperseded("newer_source_attempt_exists")
        if lock_running_job_claim(db, context=fence) is None:
            raise SourcePublicationSuperseded("queue_claim_lost")
        result = mutate(db, attempt)
        db.commit()
        return result

    try:
        return retry_serializable(db, label, phase)
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


# --- progress ------------------------------------------------------------------


def reset_source_progress(attempt: MediaSourceAttempt) -> None:
    attempt.processing_stage = "Validate"
    attempt.progress_completed = 0
    attempt.progress_total = None
    attempt.progress_unit = None
    attempt.progress_updated_at = func.now()


def record_source_progress(
    *,
    session_factory: sessionmaker[Session],
    fence: SourcePublicationFence,
    media_id: UUID,
    stage: Literal["Extract", "Finalize"],
    counted: tuple[int, int, Literal["Page", "Chapter"]] | None = None,
) -> None:
    """Publish one stage snapshot; Extract may carry ``(completed, total, unit)``."""

    def mutate(db: Session, attempt: MediaSourceAttempt) -> None:
        if attempt.processing_stage != stage:
            append_processing_event(
                db,
                media_id=media_id,
                facts=SourceStageChanged(source_attempt_id=fence.attempt_id),
                stage=stage,
                failure_code=None,
            )
        completed, total, unit = counted or (0, None, None)
        attempt.processing_stage = stage
        attempt.progress_completed = completed
        attempt.progress_total = total
        attempt.progress_unit = unit
        attempt.progress_updated_at = func.now()

    run_source_publication_phase(
        session_factory=session_factory,
        label=f"record_source_{stage.lower()}",
        fence=fence,
        media_ids=(media_id,),
        mutate=mutate,
    )


def load_source_progress(db: Session, media_ids: tuple[UUID, ...]) -> dict[UUID, SourceProgress]:
    """Progress of each media's in-flight latest attempt; a settled media reports none."""
    if not media_ids:
        return {}
    rows = db.execute(
        text(f"""
            SELECT DISTINCT ON (media_id) media_id, processing_stage, progress_completed,
                progress_total, progress_unit, progress_updated_at
            FROM media_source_attempts
            WHERE media_id = ANY(:ids) AND status IN ('accepted', 'queued', 'running')
            ORDER BY media_id, {st.LATEST_ORDER_SQL}
        """),
        {"ids": list(media_ids)},
    ).mappings()
    progress: dict[UUID, SourceProgress] = {}
    for row in rows:
        stage, updated_at = row["processing_stage"], row["progress_updated_at"]
        if stage is None or updated_at is None:
            continue
        if stage == "Extract" and row["progress_total"] is not None:
            progress[row["media_id"]] = SourceCountedProgress(
                completed=row["progress_completed"],
                total=row["progress_total"],
                unit=cast(Literal["Page", "Chapter"], row["progress_unit"]),
                updated_at=updated_at,
            )
        else:
            progress[row["media_id"]] = SourceStageProgress(
                stage=cast(Literal["Validate", "Extract", "Finalize"], stage),
                updated_at=updated_at,
            )
    return progress


# --- terminal failure ----------------------------------------------------------


@dataclass(frozen=True)
class SourceAttemptFailure:
    media_id: UUID
    attempt_id: UUID
    error_code: str
    error_message: str
    now: datetime


def publish_source_attempt_failure(db: Session, failure: SourceAttemptFailure) -> None:
    """Settle one nonterminal attempt failed and mirror it on its media (I3); a podcast
    transcript fails through the transcript owner, which leaves the episode readable, and a
    retained X publication stays ready (its failed refresh is the attempt, not the copy)."""
    db.execute(
        text("SELECT id FROM media WHERE id = :id FOR NO KEY UPDATE"), {"id": failure.media_id}
    ).one()
    row = (
        db.execute(
            text("""
                UPDATE media_source_attempts
                SET status = 'failed', error_code = :code, error_message = :message,
                    finished_at = :now, updated_at = :now
                WHERE id = :attempt_id AND media_id = :media_id
                  AND status IN ('accepted', 'queued', 'running')
                RETURNING source_type, processing_stage, progress_completed,
                          progress_total, progress_unit
            """),
            {
                "attempt_id": failure.attempt_id,
                "media_id": failure.media_id,
                "code": failure.error_code,
                "message": failure.error_message[:1000],
                "now": failure.now,
            },
        )
        .mappings()
        .one()
    )
    source_type = str(row["source_type"])
    append_processing_event(
        db,
        media_id=failure.media_id,
        facts=SourceFailed(
            source_attempt_id=failure.attempt_id,
            origin="Domain",
            terminal=True,
            progress=st.source_failure_progress(
                processing_stage=row["processing_stage"],
                progress_completed=row["progress_completed"],
                progress_total=row["progress_total"],
                progress_unit=row["progress_unit"],
            ),
        ),
        stage=st.source_history_stage(
            source_type=source_type, processing_stage=row["processing_stage"]
        ),
        failure_code=assume_safe_failure_code(failure.error_code),
    )
    if source_type == st.PODCAST_EPISODE_TRANSCRIPT:
        publish_podcast_transcription_failure(
            db,
            PodcastTranscriptionFailure(
                media_id=failure.media_id,
                error_code=failure.error_code,
                error_message=failure.error_message,
                now=failure.now,
            ),
        )
        return
    if source_type in {st.X_AUTHOR_THREAD, st.X_POST, st.X_ARTICLE} and has_retained_x_publication(
        db, media_id=failure.media_id
    ):
        mark_ready_for_reading_by_id(db, media_id=failure.media_id, now=failure.now)
        return
    transcript = source_type in st.TRANSCRIPT_SOURCE_TYPES
    mark_media_failed_by_id(
        db,
        media_id=failure.media_id,
        error_code=failure.error_code,
        error_message=failure.error_message[:1000],
        now=failure.now,
    )
    if transcript:
        set_media_transcript_state(
            db,
            media_id=failure.media_id,
            transcript_state="unavailable",
            transcript_coverage="none",
            last_request_reason=None,
            last_error_code=failure.error_code,
            now=failure.now,
        )


# --- queue hooks (run in the background supervisor) ----------------------------


def on_failure(db: Session, job: JobRow) -> dict[str, str] | None:
    """A child that died after its attempt committed success completes instead; a job
    that is no longer its attempt's, or whose attempt is not latest, is superseded."""
    row = (
        db.execute(
            text(f"""
                SELECT a.job_id, a.status,
                       a.id = ({_LATEST_ID_SQL.replace(":media_id", "a.media_id")}) AS latest
                FROM media_source_attempts a WHERE a.id = :attempt_id
            """),
            {"attempt_id": job.payload["attempt_id"]},
        )
        .mappings()
        .one_or_none()
    )
    if row is None or row["job_id"] != job.id or not row["latest"]:
        return {"status": "superseded"}
    return {"kind": "SourceProjectionSucceeded"} if row["status"] == st.SUCCEEDED else None


def on_dead_letter(db: Session, job: JobRow) -> None:
    """A dead job fails its attempt when no retry can help: a resource limit, or a
    podcast transcript (a later request admits a new attempt). Any other source keeps
    its dead job for the repair offer."""
    source_type = db.scalar(
        text("""SELECT source_type FROM media_source_attempts
            WHERE id = :id AND status IN ('accepted', 'queued', 'running')"""),
        {"id": job.payload["attempt_id"]},
    )
    resource = job.error_code == ApiErrorCode.E_RESOURCE_LIMIT.value
    if source_type is None or not (resource or source_type == st.PODCAST_EPISODE_TRANSCRIPT):
        return
    assert job.error_code and job.last_error  # a dead claim has both
    message = job.last_error
    if resource:
        assert job.result is not None  # the worker records a resource failure's dimension
        message = _RESOURCE_LIMIT_MESSAGES[job.result["dimension"]]
    publish_source_attempt_failure(
        db,
        SourceAttemptFailure(
            media_id=UUID(job.payload["media_id"]),
            attempt_id=UUID(job.payload["attempt_id"]),
            error_code=queue_failure_code(job.error_code),
            error_message=message,
            now=db.scalar(text("SELECT clock_timestamp()")),
        ),
    )
