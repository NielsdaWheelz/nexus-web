"""Dead-letter reactions the background supervisor runs for owners it may not import.

Each runs in the transaction that makes its job dead and never commits. Its
owner's module imports a storage, parser or provider graph the lean supervisor
must not load, so the reaction is the one statement that owner would write.
"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import JobRow


def note_index(db: Session, job: JobRow) -> None:
    """Note indexing: an index still waiting on this rebuild fails with the job's code.

    Every edit marks the index pending, so a ready or no_text one is current and stays.
    """
    db.execute(
        text("""UPDATE content_index_states
            SET status = 'failed', status_reason = left(:reason, 1000), updated_at = now()
            WHERE owner_kind = 'note_block' AND owner_id = :id AND status = 'pending'"""),
        {
            "id": UUID(job.payload["note_block_id"]),
            "reason": f"{job.error_code}: {job.last_error}",
        },
    )


def media_teardown(db: Session, job: JobRow) -> None:
    """Media deletion: void the exact intent while its media lives.

    A job whose media is already gone keeps its dead row, which a requeue finishes.
    """
    db.execute(
        text("""DELETE FROM media_teardown_intents
            WHERE id = :intent_id AND media_id = :media_id
              AND EXISTS (SELECT 1 FROM media WHERE id = :media_id)"""),
        {"intent_id": UUID(job.payload["intentId"]), "media_id": UUID(job.payload["mediaId"])},
    )


def podcast_backfill(db: Session, job: JobRow) -> None:
    """Podcast backfill: fail the backfill still at this step; "Retry backlog" reseeds it."""
    code = job.error_code
    db.execute(
        text("""UPDATE podcast_subscription_backfills
            SET failed_at = now(), error_code = left(:code, 100), error_detail = left(:detail, 500),
                updated_at = now()
            WHERE id = :id AND step_no = :step_no AND completed_at IS NULL
              AND source_limited_at IS NULL AND failed_at IS NULL"""),
        {
            "id": UUID(job.payload["backfillId"]),
            "step_no": job.payload["expectedStepNo"],
            "code": code,
            "detail": f"Podcast backfill exhausted retries; job={job.id}; classification={code}",
        },
    )
