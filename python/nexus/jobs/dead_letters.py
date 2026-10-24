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
from nexus.services.generation import ledger


def note_index(db: Session, job: JobRow) -> None:
    """Note indexing: an index still waiting on this rebuild fails with the job's code.

    Only its payload revision in pending/indexing can fail. Published lexical text
    survives; completed ready/no_text outcomes and newer revisions stay unchanged.
    """
    db.execute(
        text("""UPDATE content_index_states
            SET status = 'failed', status_reason = left(:reason, 1000), updated_at = now()
            WHERE owner_kind = 'note_block' AND owner_id = :id AND revision = :revision AND status IN ('pending', 'indexing')"""),
        {
            "id": UUID(job.payload["note_block_id"]),
            "revision": int(job.payload["revision"]),
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
        {"intent_id": UUID(job.payload["intent_id"]), "media_id": UUID(job.payload["media_id"])},
    )


def media_unit_build(db: Session, job: JobRow) -> None:
    """Media intelligence: the open generation closes and the exact head the job was building
    fails with its code (I16); a head re-ensured since (another fingerprint) stays."""
    ledger.on_dead_letter(db, job)
    db.execute(
        text("""UPDATE media_summaries
            SET status = 'failed', error_code = :code, error_detail = :detail, updated_at = now()
            WHERE id = :id AND status = 'building' AND content_fingerprint = :fingerprint"""),
        {
            "id": UUID(job.payload["summary_id"]),
            "fingerprint": job.payload["content_fingerprint"],
            "code": job.error_code,
            "detail": job.last_error,
        },
    )


def podcast_feed_run(db: Session, job: JobRow) -> None:
    """Pause only this exact live page, under the queue's fenced terminal execution."""
    from nexus.services.podcasts import imports, sync

    assert job.execution_id is not None
    run_id = UUID(job.payload["run_id"])
    params = {
        "id": run_id,
        "job_id": job.id,
        "attempt": job.payload["expected_attempt_version"],
        "step": job.payload["expected_step_no"],
        "code": job.error_code,
        "detail": (job.last_error or "Podcast page exhausted its retry budget")[:500],
    }
    podcast_id = db.scalar(text("SELECT podcast_id FROM podcast_feed_runs WHERE id=:id"), params)
    if podcast_id is None:
        return
    db.execute(text("SELECT id FROM podcasts WHERE id=:id FOR UPDATE"), {"id": podcast_id})
    row = db.execute(
        text("""
        SELECT r.id FROM podcast_feed_runs r JOIN podcasts p ON p.id=r.podcast_id
        WHERE r.id=:id AND r.job_id=:job_id AND r.attempt_version=:attempt AND r.step_no=:step
            AND r.completed_at IS NULL AND r.failed_at IS NULL AND r.cancelled_at IS NULL
            AND (p.sync_run_id=r.id OR EXISTS(SELECT 1 FROM podcast_library_imports i WHERE i.run_id=r.id))
        FOR UPDATE OF r
    """),
        params,
    ).first()
    if row is None:
        return
    db.execute(
        text("""
        UPDATE podcast_feed_runs SET failed_at=now(),job_id=NULL,error_code=:code,
            error_detail=:detail,updated_at=now() WHERE id=:id
    """),
        params,
    )
    imports.finish_run(db, run_id=run_id)
    sync.settle_recurring(db, run_id=run_id)


def podcast_chapters(db: Session, job: JobRow) -> None:
    """Release only this media/source/job; failed retrieval preserves published rows."""
    assert job.execution_id is not None
    media_id = UUID(job.payload["media_id"])
    db.execute(text("SELECT id FROM media WHERE id=:id FOR UPDATE"), {"id": media_id})
    db.execute(
        text("""
        UPDATE podcast_episodes SET chapters_job_id=NULL
        WHERE media_id=:id AND chapters_job_id=:job_id AND chapters_source_url=:url
    """),
        {"id": media_id, "job_id": job.id, "url": job.payload["expected_source_url"]},
    )
