"""Import-light queue projections and parent notifications for capture work."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobRow, get_job
from nexus.schemas.x_captures import QuoteRetrieval


def retrieval(db: Session, job_id: UUID | None) -> QuoteRetrieval | None:
    if job_id is None:
        return None
    job = get_job(db, job_id)
    if job is None:
        return None
    status = (
        "succeeded"
        if job.status == "succeeded"
        else "failed"
        if job.status == "dead"
        else "recovering"
        if job.status == "failed" or job.error_code is not None
        else "running"
        if job.status == "running"
        else "queued"
    )
    message = job.last_error
    if job.kind == "capture_x_quote" and job.status == "dead":
        has_excerpt = db.scalar(
            text("""SELECT EXISTS (SELECT 1 FROM document_embeds de
            JOIN x_post_captures c ON c.id=de.target_x_post_capture_id
            WHERE de.capture_job_id=:id AND c.payload->>'kind'='article_excerpt')"""),
            {"id": job_id},
        )
        message = (
            "couldn't fetch the full post; captured excerpt kept"
            if has_excerpt
            else "post not captured"
        )
    return QuoteRetrieval(
        job_id=job.id,
        status=status,
        error_code=job.error_code,
        message=message,
        can_retry=job.status == "dead",
    )


def on_history(db: Session, job: JobRow, execution_id: UUID) -> None:
    del execution_id
    media_id = job.payload.get("media_id")
    if media_id is not None:
        db.execute(text("SELECT pg_notify('media_events', :id)"), {"id": str(media_id)})
