"""Sync: keep each followed show's recent window current.

A subscription row is the sync's state machine: Pending -> Running -> Complete,
SourceLimited or Failed. Admission flips only terminal rows to Pending and enqueues one
job per flipped row under the row lock, so at most one sync is admitted per subscription;
the job queue's single claim runs it. The commit locks the row while it is Running, so a
stalled run that outlived its lease and overlaps its retry finds the row settled and
writes nothing; episode writes are idempotent by alias anyway (ingest.py), and the
auto-queue watermark only grows under the row lock.

Lock order: the subscription row, then ingest's (alias locks, show row, media, library),
then the user row for the Lectern.
"""

import hashlib
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import JobRow, enqueue_job
from nexus.logging import get_logger
from nexus.schemas import podcast as wire
from nexus.services import library_governance
from nexus.services.consumption import lectern

from .feed import fetch_page, merge
from .ingest import ingest_episodes
from .provider import WINDOW, get_podcast_index_client

logger = get_logger(__name__)

JOB_KIND = "podcast_sync_subscription_job"
TERMINAL = ("Complete", "SourceLimited", "Failed")
_ADMIT = """
    UPDATE podcast_subscriptions
    SET sync_status = 'Pending', sync_error_code = NULL, sync_error_message = NULL,
        sync_started_at = NULL, sync_completed_at = NULL, updated_at = now()
    WHERE id = ANY(CAST(:ids AS uuid[])) AND sync_status = ANY(CAST(:terminal AS text[]))
    RETURNING id
"""


def enqueue(db: Session, subscription_id: UUID, *, interactive: bool) -> None:
    """Enqueue the one job of a row the caller just made Pending."""
    enqueue_job(
        db,
        kind=JOB_KIND,
        payload={"subscription_id": str(subscription_id)},
        priority=75 if interactive else 100,
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
            library = library_governance.lock_library_for_member(
                db, viewer_id, scope.library_id, lock=False
            )
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


def admit_due(db: Session, *, limit: int) -> int:
    """The sweep: the oldest due terminal rows, at most 100, skipping rows others hold."""
    with transaction(db):
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


def run(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """Claim, fetch with no transaction open, then ingest, auto-queue and settle at once."""
    subscription_id = UUID(str(payload["subscription_id"]))
    with transaction(db):
        sub = db.execute(
            text("""
                UPDATE podcast_subscriptions s
                SET sync_status = 'Running', sync_attempts = s.sync_attempts + 1,
                    sync_started_at = now(), updated_at = now()
                FROM podcasts p
                WHERE s.id = :id AND p.id = s.podcast_id AND s.sync_status IN ('Pending', 'Running')
                RETURNING s.user_id, s.podcast_id, s.sync_started_at,
                          p.provider_podcast_id, p.feed_url
            """),
            {"id": subscription_id},
        ).first()
    if sub is None:
        return {"status": "Stale"}
    try:
        window = get_podcast_index_client().recent_episodes(sub.provider_podcast_id)
        page = fetch_page(sub.feed_url)
    except ApiError as exc:
        with transaction(db):
            _fail(db, subscription_id, exc.code.value, exc.message)
        return {"status": "Failed", "error_code": exc.code.value}
    with transaction(db):
        held = db.execute(
            text("""
                SELECT auto_queue, auto_queue_watermark_at FROM podcast_subscriptions
                WHERE id = :id AND sync_status = 'Running' FOR UPDATE
            """),
            {"id": subscription_id},
        ).first()
        if held is None:  # unsubscribed, or an overlapping run already settled it
            return {"status": "Stale"}
        result = ingest_episodes(
            db,
            viewer_id=sub.user_id,
            podcast_id=sub.podcast_id,
            feed_url=sub.feed_url,
            episodes=merge(window, page.episodes),
        )
        if held.auto_queue and held.auto_queue_watermark_at < sub.sync_started_at:
            _auto_queue(db, subscription_id, sub, held.auto_queue_watermark_at)
        limited = len(window) >= WINDOW or page.next_url is not None or result.skipped > 0
        status = "SourceLimited" if limited else "Complete"
        jitter = int.from_bytes(hashlib.sha256(subscription_id.bytes).digest()[:8]) % 1801
        db.execute(
            text("""
                UPDATE podcast_subscriptions
                SET sync_status = :status, sync_completed_at = now(), last_checked_at = now(),
                    next_sync_at = now() + :delay, consecutive_sync_failures = 0,
                    sync_error_code = NULL, sync_error_message = NULL, updated_at = now()
                WHERE id = :id
            """),
            {"id": subscription_id, "status": status, "delay": timedelta(hours=23, seconds=jitter)},
        )
        return {"status": status, "inserted": result.inserted, "skipped": result.skipped}


def _auto_queue(db: Session, subscription_id: UUID, sub: Any, watermark: datetime) -> None:
    """Put each episode published in (watermark, sync start] on the Lectern once. A full
    Lectern holds the watermark for a later sync instead of failing this one."""
    db.execute(text("SELECT 1 FROM users WHERE id = :id FOR UPDATE"), {"id": sub.user_id})
    media_ids = db.scalars(
        text("""
            SELECT media_id FROM podcast_episodes
            WHERE podcast_id = :podcast_id AND published_at > :watermark
              AND published_at <= :cutoff
            ORDER BY published_at, media_id
        """),
        {"podcast_id": sub.podcast_id, "watermark": watermark, "cutoff": sub.sync_started_at},
    ).all()
    try:
        lectern.ensure_missing_in_txn(db, viewer_id=sub.user_id, media_ids=list(media_ids))
    except ApiError as exc:  # raised before it writes anything
        if exc.code is not ApiErrorCode.E_LIMIT:
            raise
        logger.warning("podcast_auto_queue_lectern_full", subscription_id=str(subscription_id))
        return
    db.execute(
        text("UPDATE podcast_subscriptions SET auto_queue_watermark_at = :at WHERE id = :id"),
        {"id": subscription_id, "at": sub.sync_started_at},
    )


def _fail(db: Session, subscription_id: UUID, code: str, message: str) -> None:
    """Settle a live sync Failed and back off 15 m, 1 h, 6 h, then daily."""
    db.execute(
        text("""
            UPDATE podcast_subscriptions
            SET sync_status = 'Failed', sync_error_code = :code, sync_error_message = :message,
                sync_completed_at = now(), last_checked_at = now(), updated_at = now(),
                consecutive_sync_failures = consecutive_sync_failures + 1,
                next_sync_at = now() + CASE LEAST(consecutive_sync_failures, 3)
                    WHEN 0 THEN interval '15 minutes' WHEN 1 THEN interval '1 hour'
                    WHEN 2 THEN interval '6 hours' ELSE interval '24 hours' END
            WHERE id = :id AND sync_status IN ('Pending', 'Running')
        """),
        {"id": subscription_id, "code": code, "message": message[:1000]},
    )


def dead_letter(db: Session, job: JobRow) -> None:
    """A retry-exhausted sync settles Failed so the sweep can admit the show again."""
    _fail(
        db,
        UUID(str(job.payload["subscription_id"])),
        ApiErrorCode.E_PODCAST_SYNC_RETRY_EXHAUSTED.value,
        job.last_error or "Podcast sync exhausted its retry budget",
    )
