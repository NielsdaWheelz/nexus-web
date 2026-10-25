"""Show-owned source scans and their durable observations.

Retry rule: one current run per show; repeated refresh joins it. A run settles its
observation and is deleted atomically. Success schedules the next hourly slot;
failure sets a new head scan due after 15m/1h/6h/24h. The existing 15-minute
sweep adds up to one sweep interval plus queue delay. any known show admits an
explicit check; accepted work may finish after the last unsubscribe and publishes
only to then-current rules. only subscribed shows schedule another scan.
This module stays import-light because queue terminal hooks use settlement.
"""

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.ids import new_uuid7
from nexus.jobs.queue import JobExecutionContext, JobResult, lock_running_job_claim
from nexus.schemas import podcast as wire


def ensure_scheduled(db: Session, *, podcast_id: UUID) -> None:
    """A first rule becomes due at the next hour; existing due work keeps its slot."""
    db.execute(
        text("""
        UPDATE podcasts SET next_sync_at=date_trunc('hour',now())+interval '1 hour'
        WHERE id=:id AND next_sync_at IS NULL AND sync_run_id IS NULL
    """),
        {"id": podcast_id},
    )


def _admit(db: Session, *, podcast_id: UUID) -> None:
    """Create a head run for this locked show, or join its current scan."""
    from .traversal import enqueue_step

    row = db.execute(
        text("SELECT sync_run_id,feed_url FROM podcasts WHERE id=:id"), {"id": podcast_id}
    ).one()
    if row.sync_run_id is not None:
        return
    run_id = new_uuid7()
    db.execute(
        text("""
        INSERT INTO podcast_feed_runs(id,podcast_id,attempt_version,step_no,pending_urls,visited_urls,had_coverage_gaps)
        VALUES (:id,:podcast_id,1,0,CAST(:urls AS text[]),'{}',false)
    """),
        {"id": run_id, "podcast_id": podcast_id, "urls": [row.feed_url]},
    )
    db.execute(
        text("UPDATE podcasts SET sync_run_id=:run_id,next_sync_at=NULL WHERE id=:id"),
        {"id": podcast_id, "run_id": run_id},
    )
    enqueue_step(db, run_id=run_id)


def refresh(db: Session, viewer_id: UUID, scope: wire.PodcastRefreshManualScope) -> int:
    """Check any explicit known show; aggregate scopes retain member-library rules."""
    from nexus.services import libraries

    params: dict[str, Any] = {"viewer_id": viewer_id}
    predicate = ""
    with transaction(db):
        if isinstance(scope, wire.PodcastRefreshPodcastScope):
            podcast_id = db.scalar(
                text("SELECT id FROM podcasts WHERE id=:id FOR UPDATE"),
                {"id": scope.podcast_id},
            )
            if podcast_id is None:
                raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
            _admit(db, podcast_id=podcast_id)
            return 1
        if isinstance(scope, wire.PodcastRefreshLibraryScope):
            library = libraries.access(db, viewer_id, scope.library_id, lock=False)
            if not library.is_default:
                predicate = "AND s.library_id=:library_id"
                params["library_id"] = scope.library_id
        ids = list(
            db.scalars(
                text(f"""
            SELECT p.id FROM podcasts p WHERE EXISTS (
                SELECT 1 FROM library_podcast_subscriptions s
                JOIN libraries l ON l.id=s.library_id
                JOIN memberships m ON m.library_id=l.id AND m.user_id=:viewer_id
                WHERE s.podcast_id=p.id AND l.system_key IS NULL {predicate}
            ) ORDER BY p.id FOR UPDATE
        """),
                params,
            )
        )
        for podcast_id in ids:
            _admit(db, podcast_id=podcast_id)
        return len(ids)


def admit_due(db: Session, *, limit: int, context: JobExecutionContext) -> int:
    """The existing bounded sweep admits due shows; a long scan never overlaps itself."""
    with transaction(db):
        if lock_running_job_claim(db, context=context) is None:
            return 0
        ids = list(
            db.scalars(
                text("""
            SELECT p.id FROM podcasts p WHERE p.sync_run_id IS NULL AND p.next_sync_at<=now()
                AND EXISTS (SELECT 1 FROM library_podcast_subscriptions s WHERE s.podcast_id=p.id)
            ORDER BY p.next_sync_at,p.id LIMIT :limit FOR UPDATE SKIP LOCKED
        """),
                {"limit": min(max(limit, 1), 100)},
            )
        )
        for podcast_id in ids:
            _admit(db, podcast_id=podcast_id)
        return len(ids)


def settle_recurring(db: Session, *, run_id: UUID) -> None:
    """Copy a locked terminal run's observation and remove its current pointer/run."""
    row = db.execute(
        text("""
        SELECT p.id,r.failed_at FROM podcasts p JOIN podcast_feed_runs r ON r.id=p.sync_run_id
        WHERE r.id=:id AND (r.completed_at IS NOT NULL OR r.failed_at IS NOT NULL)
    """),
        {"id": run_id},
    ).first()
    if row is None:
        return
    db.execute(
        text("""
        UPDATE podcasts p SET sync_run_id=NULL,last_checked_at=now(),
            last_check_had_coverage_gaps=r.had_coverage_gaps,
            last_check_error_code=r.error_code,last_check_error_detail=r.error_detail,
            next_sync_at=CASE WHEN NOT EXISTS (
                SELECT 1 FROM library_podcast_subscriptions s WHERE s.podcast_id=p.id)
                THEN NULL WHEN r.failed_at IS NULL
                THEN date_trunc('hour',now())+interval '1 hour'
                ELSE now()+CASE LEAST(p.consecutive_sync_failures,3)
                    WHEN 0 THEN interval '15 minutes' WHEN 1 THEN interval '1 hour'
                    WHEN 2 THEN interval '6 hours' ELSE interval '24 hours' END END,
            consecutive_sync_failures=CASE WHEN r.failed_at IS NULL THEN 0
                ELSE p.consecutive_sync_failures+1 END,updated_at=now()
        FROM podcast_feed_runs r WHERE p.id=:podcast_id AND p.sync_run_id=r.id AND r.id=:run_id
    """),
        {"podcast_id": row.id, "run_id": run_id},
    )
    db.execute(text("DELETE FROM podcast_feed_runs WHERE id=:id"), {"id": run_id})


def stop_if_unused(db: Session, *, podcast_id: UUID) -> None:
    """Retire future scheduling; accepted source work keeps its pointer and fences."""
    if db.scalar(
        text("SELECT EXISTS(SELECT 1 FROM library_podcast_subscriptions WHERE podcast_id=:id)"),
        {"id": podcast_id},
    ):
        return
    db.execute(
        text("UPDATE podcasts SET next_sync_at=NULL WHERE id=:id"),
        {"id": podcast_id},
    )


def run_due_job(*, payload: Mapping[str, Any], context: JobExecutionContext) -> JobResult:
    with get_session_factory()() as db:
        return {
            "podcast_count": admit_due(
                db, limit=get_settings().podcast_refresh_due_limit, context=context
            )
        }
