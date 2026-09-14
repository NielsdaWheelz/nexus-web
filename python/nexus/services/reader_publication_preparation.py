"""Accept exactly one durable immutable backfill for an existing publication."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from nexus.db.models import Media, ReaderPublication
from nexus.jobs.queue import JobRow, enqueue_unique_job
from nexus.schemas.reader_publication import ReaderPublicationPreparationRequest
from nexus.services.reader_publication import ReaderPublicationBusy


def enqueue_reader_publication(
    db: Session, *, request: ReaderPublicationPreparationRequest
) -> JobRow:
    """Caller commits acceptance; dead work remains available to operator repair."""
    media = db.scalar(select(Media).where(Media.id == request.media_id).with_for_update())
    generation = db.scalar(
        select(ReaderPublication.generation).where(ReaderPublication.media_id == request.media_id)
    )
    if (
        media is None
        or media.kind not in {"pdf", "epub", "web_article"}
        or media.processing_status != "ready_for_reading"
        or generation != request.expected_generation
    ):
        raise ReaderPublicationBusy()
    job, _created = enqueue_unique_job(
        db,
        kind="prepare_reader_publication",
        payload=request.model_dump(mode="json"),
        dedupe_key=f"reader-publication:{request.media_id}:{request.expected_generation}:reader-1",
    )
    return job
