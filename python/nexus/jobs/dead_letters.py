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
from nexus.services.media_locks import lock_media_rows_in_order


def authored_text_index(db: Session, job: JobRow) -> None:
    """Note indexing: an index still waiting on this rebuild fails with the job's code.

    Only its payload revision in pending/indexing can fail. Published lexical text
    survives; completed ready/no_text outcomes and newer revisions stay unchanged.
    """
    db.execute(
        text("""UPDATE content_index_states
            SET status = 'failed', status_reason = left(:reason, 1000), updated_at = now()
            WHERE owner_kind = :kind AND owner_id = :id AND revision = :revision AND status IN ('pending', 'indexing')"""),
        {
            "id": UUID(job.payload["owner_id"]),
            "kind": job.payload["owner_kind"],
            "revision": int(job.payload["revision"]),
            "reason": f"{job.error_code}: {job.last_error}",
        },
    )


def x_capture_index(db: Session, job: JobRow) -> None:
    """Keep lexical capture text; stop reporting work after its last job exhausts."""
    db.execute(
        text("""
        UPDATE content_index_states s SET status='failed',status_reason=left(:reason,1000),updated_at=now()
        FROM fragments f WHERE s.owner_kind='fragment' AND s.owner_id=f.id
          AND f.x_post_capture_id=:capture_id AND s.status IN ('pending','indexing')
          AND NOT EXISTS (SELECT 1 FROM background_jobs other
              WHERE other.kind='x_capture_content_reindex' AND other.id<>:job_id
                AND other.payload->>'capture_id'=CAST(:capture_id AS text)
                AND other.status IN ('pending','failed','running','held'))
    """),
        {
            "capture_id": UUID(job.payload["capture_id"]),
            "job_id": job.id,
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


def feed_run(db: Session, job: JobRow) -> None:
    """Pause only this exact live page, under the queue's fenced terminal execution."""
    from nexus.services.feeds import sync

    assert job.execution_id is not None
    run_id = UUID(job.payload["run_id"])
    params = {
        "id": run_id,
        "job_id": job.id,
        "attempt": job.payload["expected_attempt_version"],
        "step": job.payload["expected_step_no"],
        "code": job.error_code,
        "detail": (job.last_error or "Feed page exhausted its retry budget")[:500],
    }
    feed_id = db.scalar(text("SELECT feed_id FROM feed_runs WHERE id=:id"), params)
    if feed_id is None:
        return
    db.execute(text("SELECT id FROM feeds WHERE id=:id FOR UPDATE"), {"id": feed_id})
    row = db.execute(
        text("""
        SELECT r.id FROM feed_runs r JOIN feeds p ON p.id=r.feed_id
        WHERE r.id=:id AND r.job_id=:job_id AND r.attempt_version=:attempt AND r.step_no=:step
            AND r.completed_at IS NULL AND r.failed_at IS NULL AND r.cancelled_at IS NULL
            AND (p.head_run_id=r.id OR p.catchup_run_id=r.id OR EXISTS(SELECT 1 FROM library_feed_imports i WHERE i.run_id=r.id))
        FOR UPDATE OF r
    """),
        params,
    ).first()
    if row is None:
        return
    db.execute(
        text("""
        UPDATE feed_runs SET failed_at=now(),job_id=NULL,error_code=:code,
            error_detail=:detail,updated_at=now() WHERE id=:id
    """),
        params,
    )
    sync.settle_recurring(db, run_id=run_id)


def feed_opml(db: Session, job: JobRow) -> None:
    """Retain unsent rows and child identities when their exact queue step exhausts."""
    db.execute(
        text("""UPDATE feed_opml_imports SET state='needs_attention',current_job_id=NULL,updated_at=now()
        WHERE id=:id AND current_job_id=:job AND attempt_version=:attempt AND state='running'"""),
        {
            "id": UUID(job.payload["batch_id"]),
            "job": job.id,
            "attempt": job.payload["expected_attempt_version"],
        },
    )


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


def lock_owner(db: Session, job: JobRow) -> None:
    """Import-light settlement locks, in the same order as each domain publisher."""
    match job.kind:
        case "chat_run":
            from nexus.services.chat.events import lock_run

            lock_run(db, UUID(job.payload["run_id"]))
        case "ingest_media_source":
            lock_media_rows_in_order(db, [UUID(job.payload["media_id"])], lock_mode="no_key_update")
            db.execute(
                text("SELECT id FROM media_source_attempts WHERE id=:id FOR UPDATE"),
                {"id": UUID(job.payload["attempt_id"])},
            )
        case "media_content_reindex_job":
            lock_media_rows_in_order(db, [UUID(job.payload["media_id"])], lock_mode="no_key_update")
        case "media_unit_build":
            db.execute(
                text("SELECT id FROM media_summaries WHERE id=:id FOR UPDATE"),
                {"id": UUID(job.payload["summary_id"])},
            )
        case "feed_opml_step":
            params = {"id": UUID(job.payload["batch_id"])}
            db.execute(
                text(
                    "SELECT u.id FROM users u JOIN feed_opml_imports p ON p.user_id=u.id WHERE p.id=:id FOR UPDATE OF u"
                ),
                params,
            )
            db.execute(text("SELECT id FROM feed_opml_imports WHERE id=:id FOR UPDATE"), params)
        case "feed_page":
            params = {"id": UUID(job.payload["run_id"])}
            db.execute(
                text(
                    "SELECT p.id FROM feeds p JOIN feed_runs r ON r.feed_id=p.id WHERE r.id=:id FOR UPDATE OF p"
                ),
                params,
            )
            db.execute(text("SELECT id FROM feed_runs WHERE id=:id FOR UPDATE"), params)
        case "podcast_chapters":
            db.execute(
                text("SELECT id FROM media WHERE id=:id FOR UPDATE"),
                {"id": UUID(job.payload["media_id"])},
            )
        case "authored_text_reindex_job":
            db.execute(
                text(
                    "SELECT owner_id FROM content_index_states WHERE owner_kind=:kind AND owner_id=:id FOR UPDATE"
                ),
                {"kind": job.payload["owner_kind"], "id": UUID(job.payload["owner_id"])},
            )
        case "x_capture_content_reindex":
            db.execute(
                text(
                    "SELECT owner_id FROM content_index_states WHERE owner_kind='fragment' AND owner_id IN (SELECT id FROM fragments WHERE x_post_capture_id=:id) ORDER BY owner_id FOR UPDATE"
                ),
                {"id": UUID(job.payload["capture_id"])},
            )
        case "media_teardown":
            db.execute(
                text("SELECT id FROM media WHERE id=:id FOR UPDATE"),
                {"id": UUID(job.payload["media_id"])},
            )
            db.execute(
                text("SELECT id FROM media_teardown_intents WHERE id=:id FOR UPDATE"),
                {"id": UUID(job.payload["intent_id"])},
            )
        case _:
            raise AssertionError(f"no settlement lock contract for {job.kind}")
