"""Test driver for the exact production source-job boundary."""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from nexus.jobs.queue import (
    JobExecutionContext,
    claim_job,
    complete_job,
    enqueue_job,
    fail_job,
)
from nexus.services.media_source_ingest import run_source_attempt


def run_queued_source_attempt(
    db: Session,
    *,
    media_id: UUID,
    actor_user_id: UUID | None = None,
    request_id: str | None = None,
) -> dict[str, object]:
    """Claim, execute, and complete the latest exact source operation."""
    attempt = (
        db.execute(
            text(
                """
                SELECT id, job_id, created_by_user_id, status
                FROM media_source_attempts
                WHERE media_id = :media_id
                ORDER BY attempt_no DESC, created_at DESC, id DESC
                LIMIT 1
                FOR UPDATE
                """
            ),
            {"media_id": media_id},
        )
        .mappings()
        .one()
    )
    actor_id = actor_user_id or attempt["created_by_user_id"]
    if actor_id is None:
        raise AssertionError("source test operation has no actor")
    job_id = attempt["job_id"]
    if job_id is None:
        job = enqueue_job(
            db,
            kind="ingest_media_source",
            payload={
                "media_id": str(media_id),
                "attempt_id": str(attempt["id"]),
                "actor_user_id": str(actor_id),
                "request_id": request_id,
            },
            max_attempts=3,
        )
        job_id = job.id
        db.execute(
            text(
                """
                UPDATE media_source_attempts
                SET job_id = :job_id, status = 'queued', updated_at = now()
                WHERE id = :attempt_id
                """
            ),
            {"job_id": job_id, "attempt_id": attempt["id"]},
        )
    db.commit()

    worker_id = f"source-test:{media_id}"
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=300,
        allowed_kinds=("ingest_media_source",),
    )
    if claimed is None or claimed.id != job_id:
        raise AssertionError("test did not claim the expected source operation")
    db.commit()

    try:
        result = run_source_attempt(
            session_factory=sessionmaker(
                bind=db.get_bind(),
                autocommit=False,
                autoflush=False,
                expire_on_commit=False,
                join_transaction_mode="create_savepoint",
            ),
            media_id=media_id,
            attempt_id=UUID(str(attempt["id"])),
            actor_user_id=UUID(str(actor_id)),
            request_id=request_id,
            context=JobExecutionContext(
                job_id=claimed.id,
                worker_id=worker_id,
                attempt_no=claimed.attempts,
            ),
        )
    except Exception as exc:
        raw_code = getattr(exc, "code", "E_WORKER_TASK_FAILED")
        error_code = str(getattr(raw_code, "value", raw_code))
        transition = fail_job(
            db,
            job_id=claimed.id,
            worker_id=worker_id,
            error_code=error_code,
            error_message=str(exc),
            retry_delays_seconds=(60, 300),
        )
        if transition is None:
            raise AssertionError("test source operation lost its queue claim") from exc
        db.commit()
        raise
    if not complete_job(
        db,
        job_id=claimed.id,
        worker_id=worker_id,
        result_payload=result,
    ):
        observed_claim = db.execute(
            text(
                """
                SELECT status, attempts, claimed_by, lease_expires_at, kind, payload
                FROM background_jobs
                WHERE id = :job_id
                """
            ),
            {"job_id": claimed.id},
        ).one_or_none()
        raise AssertionError(f"test source operation lost its queue claim: {observed_claim!r}")
    db.commit()
    return result


def run_queued_source_pipeline(
    db: Session,
    *,
    media_id: UUID,
    actor_user_id: UUID | None = None,
    request_id: str | None = None,
) -> dict[str, object]:
    """Execute one source operation and every durable indexing successor it creates."""
    result = run_queued_source_attempt(
        db,
        media_id=media_id,
        actor_user_id=actor_user_id,
        request_id=request_id,
    )
    while True:
        pending_kinds = set(
            db.execute(
                text(
                    """
                    SELECT kind
                    FROM background_jobs
                    WHERE payload->>'media_id' = :media_id
                      AND status IN ('pending', 'failed')
                      AND kind IN (
                        'media_content_reindex_job',
                        'podcast_reindex_semantic_job'
                      )
                    """
                ),
                {"media_id": str(media_id)},
            )
            .scalars()
            .all()
        )
        if "media_content_reindex_job" in pending_kinds:
            run_queued_media_content_reindex(db, media_id=media_id)
            continue
        if "podcast_reindex_semantic_job" in pending_kinds:
            run_queued_transcript_semantic_reindex(db, media_id=media_id)
            continue
        return result


def run_queued_media_content_reindex(
    db: Session,
    *,
    media_id: UUID,
) -> dict[str, object]:
    """Execute the newest durable document-index job through its production task."""
    job_id = db.execute(
        text(
            """
            SELECT id
            FROM background_jobs
            WHERE kind = 'media_content_reindex_job'
              AND payload->>'media_id' = :media_id
              AND status IN ('pending', 'failed')
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
        ),
        {"media_id": str(media_id)},
    ).scalar_one()
    db.commit()

    worker_id = f"media-content-reindex-test:{media_id}"
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=900,
        allowed_kinds=("media_content_reindex_job",),
    )
    if claimed is None:
        raise AssertionError("test did not claim the expected media content-reindex operation")
    db.commit()

    from nexus.tasks.media_content_reindex import media_content_reindex_job

    result = media_content_reindex_job(
        payload=claimed.payload,
        context=JobExecutionContext(
            job_id=claimed.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
        ),
    )
    if not complete_job(
        db,
        job_id=claimed.id,
        worker_id=worker_id,
        result_payload=result,
    ):
        raise AssertionError("test media content-reindex operation lost its queue claim")
    db.commit()
    return result


def run_queued_transcript_semantic_reindex(
    db: Session,
    *,
    media_id: UUID,
) -> dict[str, object]:
    """Execute the newest exact semantic job for a transcript."""
    job_id = db.execute(
        text(
            """
            SELECT id
            FROM background_jobs
            WHERE kind = 'podcast_reindex_semantic_job'
              AND payload->>'media_id' = :media_id
              AND status IN ('pending', 'failed')
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
        ),
        {"media_id": str(media_id)},
    ).scalar_one()
    db.commit()

    worker_id = f"transcript-semantic-test:{media_id}"
    claimed = claim_job(
        db,
        job_id=job_id,
        worker_id=worker_id,
        lease_seconds=900,
        allowed_kinds=("podcast_reindex_semantic_job",),
    )
    if claimed is None:
        raise AssertionError("test did not claim the expected transcript semantic operation")
    db.commit()

    from nexus.tasks.podcast_reindex_semantic import podcast_reindex_semantic_job

    result = podcast_reindex_semantic_job(
        media_id=str(claimed.payload["media_id"]),
        requested_by_user_id=(
            str(claimed.payload["requested_by_user_id"])
            if claimed.payload.get("requested_by_user_id")
            else None
        ),
        request_reason=str(claimed.payload.get("request_reason", "operator_requeue")),
        request_id=(
            str(claimed.payload["request_id"]) if claimed.payload.get("request_id") else None
        ),
        context=JobExecutionContext(
            job_id=claimed.id,
            worker_id=worker_id,
            attempt_no=claimed.attempts,
        ),
        session_factory=sessionmaker(
            bind=db.get_bind(),
            autocommit=False,
            autoflush=False,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ),
    )
    result_payload = dict(result or {})
    if not complete_job(
        db,
        job_id=claimed.id,
        worker_id=worker_id,
        result_payload=result_payload,
    ):
        raise AssertionError("test semantic operation lost its queue claim")
    db.commit()
    return result_payload
