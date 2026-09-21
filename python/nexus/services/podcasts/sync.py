"""One lease-fenced Podcast subscription sync attempt."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.db.session import transaction
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import JobExecutionContext, JobRow, lock_and_renew_running_job_claim
from nexus.logging import get_logger
from nexus.services.consumption import _lectern_store

from ._normalize import parse_iso_datetime
from .feed import fetch_live_feed_snapshot
from .ingest import sync_subscription_ingest
from .provider import PODCAST_INDEX_EPISODE_PAGE_SIZE, get_podcast_index_client
from .refresh import (
    PODCAST_SYNC_JOB_KIND,
    bump_refresh_collections_in_txn,
    failed_next_sync_at,
    healthy_next_sync_at,
    podcast_sync_dedupe_key,
)
from .types import PODCAST_SYNC_ERROR_MESSAGE_MAX_LENGTH, PODCAST_SYNC_JOB_LEASE_SECONDS

logger = get_logger(__name__)


@dataclass(frozen=True)
class SubscriptionSyncResult:
    status: str
    new_episode_count: int
    source_limited: bool


@dataclass(frozen=True, slots=True)
class _Epoch:
    subscription_id: UUID
    user_id: UUID
    podcast_id: UUID
    sync_generation: int


def run_podcast_subscription_sync_now(
    db: Session,
    *,
    payload: Mapping[str, Any],
    context: JobExecutionContext,
) -> SubscriptionSyncResult:
    """Claim the attempt, fetch outside any transaction, commit one fenced batch."""
    epoch = _Epoch(
        subscription_id=UUID(str(payload["subscription_id"])),
        user_id=UUID(str(payload["user_id"])),
        podcast_id=UUID(str(payload["podcast_id"])),
        sync_generation=int(payload["sync_generation"]),
    )
    cutoff_at = _claim_attempt(db, epoch=epoch, context=context)
    if cutoff_at is None:
        return SubscriptionSyncResult("Stale", 0, False)

    try:
        metadata = _read_podcast_source(db, epoch.podcast_id)
        snapshot = fetch_live_feed_snapshot(
            provider_episode_candidates=get_podcast_index_client().fetch_recent_episodes(
                metadata["provider_podcast_id"], PODCAST_INDEX_EPISODE_PAGE_SIZE
            ),
            feed_url=metadata["feed_url"],
        )
        return _commit_sync(
            db,
            epoch=epoch,
            context=context,
            cutoff_at=cutoff_at,
            feed_url=metadata["feed_url"],
            episodes=sorted(
                snapshot.episodes,
                key=lambda episode: parse_iso_datetime(episode.get("published_at"))
                or datetime.min.replace(tzinfo=UTC),
                reverse=True,
            ),
            source_limited=snapshot.source_limited,
        )
    except ApiError as exc:
        with transaction(db):
            row = _fence(db, epoch=epoch, context=context, require_running=True)
            if row is None:
                return SubscriptionSyncResult("Stale", 0, False)
            _publish_terminal_failure(
                db,
                epoch=epoch,
                error_code=exc.code.value,
                error_message=exc.message,
                completed_at=_database_now(db),
            )
            return SubscriptionSyncResult("Failed", 0, False)


def dead_letter_podcast_subscription_sync(db: Session, job: JobRow) -> None:
    """Terminalize a retry-exhausted sync so the due sweep can re-admit the show."""
    if job.kind != PODCAST_SYNC_JOB_KIND:
        return
    epoch = _Epoch(
        subscription_id=UUID(str(job.payload["subscription_id"])),
        user_id=UUID(str(job.payload["user_id"])),
        podcast_id=UUID(str(job.payload["podcast_id"])),
        sync_generation=int(job.payload["sync_generation"]),
    )
    if job.dedupe_key != podcast_sync_dedupe_key(epoch.subscription_id, epoch.sync_generation):
        return
    row = _lock_epoch(db, epoch)
    if row is None or row["sync_job_id"] != job.id:
        return
    status = str(row["sync_status"])
    if status not in {"Pending", "Running"}:
        return
    if status == "Running" and int(row["sync_job_attempt_no"] or -1) != job.attempts:
        return
    _publish_terminal_failure(
        db,
        epoch=epoch,
        error_code=ApiErrorCode.E_PODCAST_SYNC_RETRY_EXHAUSTED.value,
        error_message=job.last_error or "Podcast sync exhausted its retry budget",
        completed_at=_database_now(db),
    )


def _claim_attempt(db: Session, *, epoch: _Epoch, context: JobExecutionContext) -> datetime | None:
    with transaction(db):
        row = _fence(db, epoch=epoch, context=context, require_running=False)
        if row is None:
            return None
        started_at = _database_now(db)
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET sync_status = 'Running',
                    sync_error_code = NULL,
                    sync_error_message = NULL,
                    sync_attempts = sync_attempts + 1,
                    sync_started_at = :started_at,
                    sync_completed_at = NULL,
                    sync_job_attempt_no = :attempt_no,
                    updated_at = :started_at
                WHERE id = :subscription_id
                """
            ),
            {
                "subscription_id": epoch.subscription_id,
                "started_at": started_at,
                "attempt_no": context.attempt_no,
            },
        )
        bump_refresh_collections_in_txn(db, (epoch.user_id,))
        return started_at


def _commit_sync(
    db: Session,
    *,
    epoch: _Epoch,
    context: JobExecutionContext,
    cutoff_at: datetime,
    feed_url: str,
    episodes: list[dict[str, Any]],
    source_limited: bool,
) -> SubscriptionSyncResult:
    """Ingest the batch, advance the auto-queue watermark and settle the epoch."""
    with transaction(db):
        row = _fence(db, epoch=epoch, context=context, require_running=True)
        if row is None:
            return SubscriptionSyncResult("Stale", 0, False)
        ingest = sync_subscription_ingest(
            db=db,
            viewer_id=epoch.user_id,
            podcast_id=epoch.podcast_id,
            feed_url=feed_url,
            selected_episodes=episodes,
            now=_database_now(db),
        )
        status = "SourceLimited" if source_limited or ingest.source_limited else "Complete"
        watermark = row["auto_queue_watermark_at"]
        if bool(row["auto_queue"]) and (watermark is None or watermark < cutoff_at):
            _advance_auto_queue(db, epoch=epoch, cutoff_at=cutoff_at, watermark=watermark)
        completed_at = _database_now(db)
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET sync_status = :status,
                    sync_error_code = NULL,
                    sync_error_message = NULL,
                    sync_completed_at = :completed_at,
                    last_checked_at = :completed_at,
                    next_sync_at = :next_sync_at,
                    consecutive_sync_failures = 0,
                    sync_job_id = NULL,
                    sync_job_attempt_no = NULL,
                    updated_at = :completed_at
                WHERE id = :subscription_id
                """
            ),
            {
                "subscription_id": epoch.subscription_id,
                "status": status,
                "completed_at": completed_at,
                "next_sync_at": healthy_next_sync_at(epoch.subscription_id, completed_at),
            },
        )
        bump_refresh_collections_in_txn(db, (epoch.user_id,))
        return SubscriptionSyncResult(
            status=status,
            new_episode_count=ingest.ingested_episode_count,
            source_limited=status == "SourceLimited",
        )


def _advance_auto_queue(
    db: Session, *, epoch: _Epoch, cutoff_at: datetime, watermark: datetime | None
) -> None:
    """Queue every episode published in this window, once, into the Lectern."""
    db.execute(
        text("SELECT 1 FROM users WHERE id = :user_id FOR UPDATE"),
        {"user_id": epoch.user_id},
    )
    eligible = [
        UUID(str(media_id))
        for media_id in db.execute(
            text(
                f"""
                SELECT media_id
                FROM podcast_episodes
                WHERE podcast_id = :podcast_id
                  AND published_at IS NOT NULL
                  AND published_at <= :cutoff
                  {"" if watermark is None else "AND published_at > :watermark"}
                ORDER BY published_at, media_id
                """
            ),
            {"podcast_id": epoch.podcast_id, "cutoff": cutoff_at, "watermark": watermark},
        ).scalars()
    ]
    if eligible:
        _lectern_store.ensure_missing_in_txn(
            db, viewer_id=epoch.user_id, media_ids=eligible, source="AutoSubscription"
        )
    db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET auto_queue_watermark_at =
                GREATEST(COALESCE(auto_queue_watermark_at, :cutoff), :cutoff)
            WHERE id = :subscription_id
            """
        ),
        {"subscription_id": epoch.subscription_id, "cutoff": cutoff_at},
    )


def _publish_terminal_failure(
    db: Session,
    *,
    epoch: _Epoch,
    error_code: str,
    error_message: str,
    completed_at: datetime,
) -> None:
    """Write the one terminal Failed epoch inside the caller's transaction."""
    failures = int(
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET sync_status = 'Failed',
                    sync_error_code = :error_code,
                    sync_error_message = :error_message,
                    sync_completed_at = :completed_at,
                    last_checked_at = :completed_at,
                    consecutive_sync_failures = consecutive_sync_failures + 1,
                    sync_job_id = NULL,
                    sync_job_attempt_no = NULL,
                    updated_at = :completed_at
                WHERE id = :subscription_id
                RETURNING consecutive_sync_failures
                """
            ),
            {
                "subscription_id": epoch.subscription_id,
                "error_code": error_code,
                "error_message": error_message[:PODCAST_SYNC_ERROR_MESSAGE_MAX_LENGTH],
                "completed_at": completed_at,
            },
        ).scalar_one()
    )
    db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET next_sync_at = :next_sync_at, updated_at = :completed_at
            WHERE id = :subscription_id
            """
        ),
        {
            "subscription_id": epoch.subscription_id,
            "next_sync_at": failed_next_sync_at(failures, completed_at),
            "completed_at": completed_at,
        },
    )
    bump_refresh_collections_in_txn(db, (epoch.user_id,))


def _fence(
    db: Session,
    *,
    epoch: _Epoch,
    context: JobExecutionContext,
    require_running: bool,
) -> RowMapping | None:
    """Renew this exact queue attempt, then lock its exact subscription epoch.

    The queue reclaims a running row whose lease expired, so a stalled worker and
    its replacement can both be live: only the renewed claim may write.
    """
    job = lock_and_renew_running_job_claim(
        db, context=context, lease_seconds=PODCAST_SYNC_JOB_LEASE_SECONDS
    )
    if job is None or job.dedupe_key != podcast_sync_dedupe_key(
        epoch.subscription_id, epoch.sync_generation
    ):
        return None
    row = _lock_epoch(db, epoch)
    if row is None or row["sync_job_id"] != context.job_id:
        return None
    if require_running:
        if str(row["sync_status"]) != "Running":
            return None
        if int(row["sync_job_attempt_no"] or -1) != context.attempt_no:
            return None
    elif str(row["sync_status"]) not in {"Pending", "Running"}:
        return None
    return row


def _lock_epoch(db: Session, epoch: _Epoch) -> RowMapping | None:
    return (
        db.execute(
            text(
                """
                SELECT sync_status, sync_job_id, sync_job_attempt_no,
                       auto_queue, auto_queue_watermark_at
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                  AND user_id = :user_id
                  AND podcast_id = :podcast_id
                  AND sync_generation = :sync_generation
                FOR UPDATE
                """
            ),
            {
                "subscription_id": epoch.subscription_id,
                "user_id": epoch.user_id,
                "podcast_id": epoch.podcast_id,
                "sync_generation": epoch.sync_generation,
            },
        )
        .mappings()
        .first()
    )


def _read_podcast_source(db: Session, podcast_id: UUID) -> dict[str, str]:
    row = db.execute(
        text("SELECT provider_podcast_id, feed_url FROM podcasts WHERE id = :podcast_id"),
        {"podcast_id": podcast_id},
    ).first()
    db.rollback()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    return {"provider_podcast_id": str(row[0]), "feed_url": str(row[1])}


def _database_now(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()
