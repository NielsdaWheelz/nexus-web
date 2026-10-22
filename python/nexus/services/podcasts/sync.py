"""Recent checks for followed shows; admission records the exact owning queue job.

Admission preserves the previous check's observation until terminal settlement. Every
worker effect locks its running execution, then its subscription and matches sync_job_id;
an older job cannot publish after another refresh is admitted. Fetches hold no locks.
Retries repeat alias-based ingest; success or failure clears the owning job and advances
sync_completed_at. No check queues audio, transcription or listening intentions.
"""

import hashlib
from collections.abc import Mapping
from datetime import timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import (
    JobExecutionContext,
    JobResult,
    JobRow,
    enqueue_job,
    lock_running_job_claim,
)
from nexus.schemas import podcast as wire
from nexus.services import libraries, users
from nexus.services.suggestion_changes import record_input_change

from .feed import fetch_page, merge
from .ingest import ingest_episodes
from .provider import get_podcast_index_client

JOB_KIND = "podcast_sync_subscription_job"
TERMINAL = ("Complete", "Failed")
_ADMIT = """
    UPDATE podcast_subscriptions
    SET sync_status = 'Pending', sync_started_at = NULL, updated_at = now()
    WHERE id = ANY(CAST(:ids AS uuid[])) AND sync_status = ANY(CAST(:terminal AS text[]))
    RETURNING id
"""


def enqueue(db: Session, subscription_id: UUID, *, interactive: bool) -> None:
    """Admit the job for a Pending subscription the caller holds locked."""
    job = enqueue_job(
        db,
        kind=JOB_KIND,
        payload={"subscription_id": str(subscription_id)},
        priority=75 if interactive else 100,
    )
    db.execute(
        text("UPDATE podcast_subscriptions SET sync_job_id = :job_id WHERE id = :id"),
        {"id": subscription_id, "job_id": job.id},
    )


def _admit(db: Session, ids: list[UUID], *, interactive: bool) -> None:
    """Open a sync for each locked terminal row; a live one is joined, not duplicated."""
    admitted = db.scalars(text(_ADMIT), {"ids": ids, "terminal": list(TERMINAL)}).all()
    for subscription_id in admitted:
        enqueue(db, subscription_id, interactive=interactive)


def refresh(db: Session, viewer_id: UUID, scope: wire.PodcastRefreshManualScope) -> int:
    """Admit every subscription in scope; the count includes ones already syncing."""
    predicate = ""
    params: dict[str, object] = {"viewer_id": viewer_id}
    if isinstance(scope, wire.PodcastRefreshPodcastScope):
        predicate = "AND podcast_id = :podcast_id"
        params["podcast_id"] = scope.podcast_id
    with transaction(db):
        if isinstance(scope, wire.PodcastRefreshLibraryScope):
            library = libraries.access(db, viewer_id, scope.library_id, lock=False)
            if not library.is_default:
                params["library_id"] = scope.library_id
                predicate = """AND podcast_id IN (
                    SELECT podcast_id FROM library_entries WHERE library_id = :library_id)"""
        ids = db.scalars(
            text(f"""
                SELECT id FROM podcast_subscriptions
                WHERE user_id = :viewer_id {predicate}
                ORDER BY id FOR UPDATE
            """),
            params,
        ).all()
        if isinstance(scope, wire.PodcastRefreshPodcastScope) and not ids:
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
        _admit(db, list(ids), interactive=True)
        return len(ids)


def admit_due(db: Session, *, limit: int, context: JobExecutionContext) -> int:
    """The fenced sweep admits at most 100 oldest due rows, skipping held rows."""
    with transaction(db):
        if lock_running_job_claim(db, context=context) is None:
            return 0
        ids = db.scalars(
            text("""
                SELECT id FROM podcast_subscriptions
                WHERE next_sync_at <= now() AND sync_status = ANY(CAST(:terminal AS text[]))
                ORDER BY next_sync_at, id
                LIMIT :limit FOR UPDATE SKIP LOCKED
            """),
            {"limit": min(max(limit, 1), 100), "terminal": list(TERMINAL)},
        ).all()
        _admit(db, list(ids), interactive=False)
        return len(ids)


def run(db: Session, payload: dict[str, Any], *, context: JobExecutionContext) -> dict[str, Any]:
    """Start, fetch outside a transaction, then ingest and settle under both fences."""
    subscription_id = UUID(str(payload["subscription_id"]))
    params = {"id": subscription_id, "job_id": context.job_id}
    with transaction(db):
        viewer_id = db.scalar(
            text("SELECT user_id FROM podcast_subscriptions WHERE id=:id"), {"id": subscription_id}
        )
        if viewer_id is None:
            return {"status": "Stale"}
        users.lock_viewer(db, viewer_id)
        if lock_running_job_claim(db, context=context) is None:
            return {"status": "Stale"}
        sub = db.execute(
            text("""
                UPDATE podcast_subscriptions s
                SET sync_status = 'Running', sync_attempts = s.sync_attempts + 1,
                    sync_started_at = now(), updated_at = now()
                FROM podcasts p
                WHERE s.id = :id AND s.sync_job_id = :job_id AND p.id = s.podcast_id
                  AND s.sync_status IN ('Pending', 'Running')
                RETURNING s.user_id, s.podcast_id, p.provider_podcast_id, p.feed_url
            """),
            params,
        ).first()
    if sub is None:
        return {"status": "Stale"}
    try:
        window = get_podcast_index_client().recent_episodes(sub.provider_podcast_id)
        page = fetch_page(sub.feed_url)
    except ApiError as exc:
        with transaction(db):
            if lock_running_job_claim(db, context=context) is None or not _fail(
                db, subscription_id, context.job_id, exc.code.value, exc.message
            ):
                return {"status": "Stale"}
        return {"status": "Failed", "error_code": exc.code.value}
    with transaction(db):
        users.lock_viewer(db, sub.user_id)
        if lock_running_job_claim(db, context=context) is None:
            return {"status": "Stale"}
        held = db.execute(
            text("""
                SELECT id FROM podcast_subscriptions
                WHERE id = :id AND sync_job_id = :job_id AND sync_status = 'Running'
                FOR UPDATE
            """),
            params,
        ).first()
        if held is None:
            return {"status": "Stale"}
        result = ingest_episodes(
            db,
            viewer_id=sub.user_id,
            podcast_id=sub.podcast_id,
            feed_url=sub.feed_url,
            episodes=merge(window, page.episodes),
        )
        jitter = int.from_bytes(hashlib.sha256(subscription_id.bytes).digest()[:8]) % 1801
        db.execute(
            text("""
                UPDATE podcast_subscriptions
                SET sync_status = 'Complete', sync_completed_at = now(), last_checked_at = now(),
                    next_sync_at = now() + :delay, consecutive_sync_failures = 0,
                    sync_error_code = NULL, sync_error_message = NULL,
                    sync_had_rejected_items = :rejected, sync_job_id = NULL, updated_at = now()
                WHERE id = :id AND sync_job_id = :job_id
            """),
            params | {"delay": timedelta(hours=23, seconds=jitter), "rejected": result.skipped > 0},
        )
        if result.changed:
            record_input_change(db)
        return {"status": "Complete"}


def _fail(db: Session, subscription_id: UUID, job_id: UUID, code: str, message: str) -> bool:
    """Settle only this job's live sync; back off 15 m, 1 h, 6 h, then daily."""
    params = {"id": subscription_id, "job_id": job_id}
    if (
        db.execute(
            text("""
            SELECT id FROM podcast_subscriptions
            WHERE id = :id AND sync_job_id = :job_id AND sync_status IN ('Pending', 'Running')
            FOR UPDATE
        """),
            params,
        ).first()
        is None
    ):
        return False
    db.execute(
        text("""
            UPDATE podcast_subscriptions
            SET sync_status = 'Failed', sync_error_code = :code, sync_error_message = :message,
                sync_completed_at = now(), last_checked_at = now(), updated_at = now(),
                sync_job_id = NULL, consecutive_sync_failures = consecutive_sync_failures + 1,
                next_sync_at = now() + CASE LEAST(consecutive_sync_failures, 3)
                    WHEN 0 THEN interval '15 minutes' WHEN 1 THEN interval '1 hour'
                    WHEN 2 THEN interval '6 hours' ELSE interval '24 hours' END
            WHERE id = :id AND sync_job_id = :job_id
        """),
        params | {"code": code, "message": message[:1000]},
    )
    return True


def dead_letter(db: Session, job: JobRow) -> None:
    """The queue already fenced this terminal transaction; match its owning sync job."""
    _fail(
        db,
        UUID(str(job.payload["subscription_id"])),
        job.id,
        ApiErrorCode.E_PODCAST_SYNC_RETRY_EXHAUSTED.value,
        job.last_error or "Podcast sync exhausted its retry budget",
    )


def run_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    """The ``podcast_sync_subscription_job`` handler."""
    with get_session_factory()() as db:
        return run(db, dict(payload), context=context)


def run_due_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    """The periodic ``podcast_refresh_due_job`` handler."""
    with get_session_factory()() as db:
        return {
            "subscription_count": admit_due(
                db, limit=get_settings().podcast_refresh_due_limit, context=context
            )
        }
