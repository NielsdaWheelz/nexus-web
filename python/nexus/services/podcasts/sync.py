"""Exact-attempt Podcast subscription sync with one durable ingest checkpoint."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory, transaction
from nexus.errors import ApiError, ApiErrorCode, NotFoundError
from nexus.jobs.queue import JobExecutionContext, JobRow, lock_and_renew_running_job_claim
from nexus.logging import get_logger
from nexus.services.collection_revisions import CollectionFamily, bump_collection_families
from nexus.services.consumption import service as consumption_service

from ._normalize import parse_iso_datetime
from .feed import fetch_live_feed_snapshot
from .ingest import sync_subscription_ingest
from .provider import PODCAST_INDEX_EPISODE_PAGE_SIZE, get_podcast_index_client
from .refresh import (
    PODCAST_SYNC_JOB_KIND,
    bump_refresh_collections_in_txn,
    failed_next_sync_at,
    finish_joined_items_in_txn,
    healthy_next_sync_at,
    podcast_sync_dedupe_key,
    podcast_sync_payload,
    set_joined_items_running_in_txn,
)
from .types import (
    PODCAST_REFRESH_ERROR_MESSAGE_MAX_LENGTH,
    PODCAST_SYNC_JOB_LEASE_SECONDS,
    PodcastHealthySyncStatus,
)

logger = get_logger(__name__)


def _database_now(db: Session) -> datetime:
    return db.execute(text("SELECT now()")).scalar_one()


@dataclass(frozen=True)
class PodcastSyncPayload:
    subscription_id: UUID
    user_id: UUID
    podcast_id: UUID
    sync_generation: int

    @classmethod
    def parse(cls, payload: Mapping[str, Any]) -> PodcastSyncPayload:
        if set(payload) != {
            "subscription_id",
            "user_id",
            "podcast_id",
            "sync_generation",
        }:
            raise ValueError("Podcast sync payload has unexpected fields")
        generation = payload["sync_generation"]
        if type(generation) is not int:
            raise ValueError("Podcast sync generation must be an integer")
        if generation < 1:
            raise ValueError("Podcast sync generation must be a positive integer")
        return cls(
            subscription_id=UUID(str(payload["subscription_id"])),
            user_id=UUID(str(payload["user_id"])),
            podcast_id=UUID(str(payload["podcast_id"])),
            sync_generation=generation,
        )

    def wire(self) -> dict[str, object]:
        return podcast_sync_payload(
            subscription_id=self.subscription_id,
            user_id=self.user_id,
            podcast_id=self.podcast_id,
            sync_generation=self.sync_generation,
        )


@dataclass(frozen=True)
class SubscriptionSyncResult:
    status: str
    new_episode_count: int
    source_limited: bool
    reason: str | None = None
    error_code: str | None = None


@dataclass(frozen=True)
class _SyncCheckpoint:
    status: PodcastHealthySyncStatus
    cutoff_at: datetime
    new_episode_count: int
    completed_at: datetime


@dataclass(frozen=True)
class _Claim:
    cutoff_at: datetime
    checkpoint: _SyncCheckpoint | None


def _require_exact_queue_attempt(
    db: Session,
    *,
    payload: PodcastSyncPayload,
    context: JobExecutionContext,
) -> JobRow | None:
    job = lock_and_renew_running_job_claim(
        db,
        context=context,
        lease_seconds=PODCAST_SYNC_JOB_LEASE_SECONDS,
    )
    if job is None:
        return None
    if (
        job.kind != PODCAST_SYNC_JOB_KIND
        or job.payload != payload.wire()
        or job.dedupe_key
        != podcast_sync_dedupe_key(payload.subscription_id, payload.sync_generation)
    ):
        raise RuntimeError("Podcast sync queue attempt does not match its exact operation")
    return job


def _lock_subscription_epoch(
    db: Session,
    *,
    payload: PodcastSyncPayload,
) -> Mapping[str, Any] | None:
    return (
        db.execute(
            text(
                """
                SELECT
                    id, user_id, podcast_id, sync_generation, sync_status,
                    sync_job_id, sync_job_attempt_no, sync_attempts, sync_started_at,
                    auto_queue, auto_queue_watermark_at,
                    sync_checkpoint_status, sync_checkpoint_cutoff_at,
                    sync_checkpoint_new_episode_count, sync_checkpoint_completed_at
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                  AND user_id = :user_id
                  AND podcast_id = :podcast_id
                  AND sync_generation = :sync_generation
                FOR UPDATE
                """
            ),
            {
                "subscription_id": payload.subscription_id,
                "user_id": payload.user_id,
                "podcast_id": payload.podcast_id,
                "sync_generation": payload.sync_generation,
            },
        )
        .mappings()
        .first()
    )


def _checkpoint_from_row(row: Mapping[str, Any]) -> _SyncCheckpoint | None:
    values = (
        row["sync_checkpoint_status"],
        row["sync_checkpoint_cutoff_at"],
        row["sync_checkpoint_new_episode_count"],
        row["sync_checkpoint_completed_at"],
    )
    if all(value is None for value in values):
        return None
    if any(value is None for value in values):
        raise RuntimeError("Podcast sync checkpoint is partial")
    status = str(values[0])
    if status not in {"Complete", "SourceLimited"}:
        raise RuntimeError("Podcast sync checkpoint has an invalid status")
    return _SyncCheckpoint(
        status=cast(PodcastHealthySyncStatus, status),
        cutoff_at=values[1],
        new_episode_count=int(values[2]),
        completed_at=values[3],
    )


def _claim_sync_attempt(
    db: Session,
    *,
    payload: PodcastSyncPayload,
    context: JobExecutionContext,
) -> _Claim | None:
    with transaction(db):
        if _require_exact_queue_attempt(db, payload=payload, context=context) is None:
            return None
        row = _lock_subscription_epoch(db, payload=payload)
        if (
            row is None
            or row["sync_job_id"] != context.job_id
            or str(row["sync_status"]) not in {"Pending", "Running"}
        ):
            return None
        cutoff_at = _database_now(db)
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    sync_status = 'Running',
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
                "subscription_id": payload.subscription_id,
                "started_at": cutoff_at,
                "attempt_no": context.attempt_no,
            },
        )
        set_joined_items_running_in_txn(
            db,
            subscription_id=payload.subscription_id,
            sync_generation=payload.sync_generation,
            started_at=cutoff_at,
        )
        bump_refresh_collections_in_txn(db, (payload.user_id,))
        return _Claim(
            cutoff_at=cutoff_at,
            checkpoint=_checkpoint_from_row(row),
        )


def _read_podcast_metadata(db: Session, podcast_id: UUID) -> dict[str, str]:
    row = db.execute(
        text(
            """
            SELECT provider_podcast_id, feed_url
            FROM podcasts
            WHERE id = :podcast_id
            """
        ),
        {"podcast_id": podcast_id},
    ).fetchone()
    db.rollback()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    return {
        "provider_podcast_id": str(row[0]),
        "feed_url": str(row[1]),
    }


def _write_ingest_checkpoint(
    db: Session,
    *,
    payload: PodcastSyncPayload,
    context: JobExecutionContext,
    cutoff_at: datetime,
    selected_episodes: list[dict[str, Any]],
    feed_url: str,
    source_limited: bool,
) -> _SyncCheckpoint | None:
    with transaction(db):
        if _require_exact_queue_attempt(db, payload=payload, context=context) is None:
            return None
        row = _lock_subscription_epoch(db, payload=payload)
        if (
            row is None
            or row["sync_job_id"] != context.job_id
            or int(row["sync_job_attempt_no"] or -1) != context.attempt_no
            or str(row["sync_status"]) != "Running"
        ):
            return None
        existing = _checkpoint_from_row(row)
        if existing is not None:
            return existing

        ingest_now = _database_now(db)
        ingest_result = sync_subscription_ingest(
            db=db,
            viewer_id=payload.user_id,
            podcast_id=payload.podcast_id,
            feed_url=feed_url,
            selected_episodes=selected_episodes,
            now=ingest_now,
        )
        status: PodcastHealthySyncStatus = (
            "SourceLimited" if source_limited or ingest_result.source_limited else "Complete"
        )
        checkpoint = _SyncCheckpoint(
            status=status,
            cutoff_at=cutoff_at,
            new_episode_count=ingest_result.ingested_episode_count,
            completed_at=ingest_now,
        )
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    sync_checkpoint_status = :status,
                    sync_checkpoint_cutoff_at = :cutoff_at,
                    sync_checkpoint_new_episode_count = :new_episode_count,
                    sync_checkpoint_completed_at = :completed_at,
                    updated_at = :completed_at
                WHERE id = :subscription_id
                """
            ),
            {
                "subscription_id": payload.subscription_id,
                "status": checkpoint.status,
                "cutoff_at": checkpoint.cutoff_at,
                "new_episode_count": checkpoint.new_episode_count,
                "completed_at": checkpoint.completed_at,
            },
        )
        return checkpoint


def _eligible_auto_subscription_media(
    db: Session,
    *,
    podcast_id: UUID,
    sync_cutoff_at: datetime,
    watermark: datetime | None,
) -> list[UUID]:
    watermark_predicate = "" if watermark is None else "AND published_at > :watermark"
    rows = db.execute(
        text(
            f"""
            SELECT media_id
            FROM podcast_episodes
            WHERE podcast_id = :podcast_id
              AND published_at IS NOT NULL
              AND published_at <= :cutoff
              {watermark_predicate}
            ORDER BY published_at, media_id
            """
        ),
        {
            "podcast_id": podcast_id,
            "cutoff": sync_cutoff_at,
            "watermark": watermark,
        },
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def _finalize_healthy_sync(
    *,
    payload: PodcastSyncPayload,
    context: JobExecutionContext,
) -> bool:
    fresh = get_session_factory()()

    def attempt() -> bool:
        with transaction(fresh):
            if _require_exact_queue_attempt(fresh, payload=payload, context=context) is None:
                return False
            row = _lock_subscription_epoch(fresh, payload=payload)
            if (
                row is None
                or row["sync_job_id"] != context.job_id
                or int(row["sync_job_attempt_no"] or -1) != context.attempt_no
                or str(row["sync_status"]) != "Running"
            ):
                return False
            checkpoint = _checkpoint_from_row(row)
            if checkpoint is None:
                raise RuntimeError("Podcast sync finalization requires an ingest checkpoint")

            auto_queue = bool(row["auto_queue"])
            watermark: datetime | None = row["auto_queue_watermark_at"]
            if auto_queue:
                if (
                    fresh.execute(
                        text("SELECT 1 FROM users WHERE id = :user_id FOR UPDATE"),
                        {"user_id": payload.user_id},
                    ).first()
                    is None
                ):
                    return False
                if watermark is None or watermark < checkpoint.cutoff_at:
                    eligible = _eligible_auto_subscription_media(
                        fresh,
                        podcast_id=payload.podcast_id,
                        sync_cutoff_at=checkpoint.cutoff_at,
                        watermark=watermark,
                    )
                    if eligible:
                        consumption_service.ensure_missing_items_in_txn(
                            fresh,
                            viewer_id=payload.user_id,
                            media_ids=eligible,
                            source="AutoSubscription",
                        )
                    fresh.execute(
                        text(
                            """
                            UPDATE podcast_subscriptions
                            SET auto_queue_watermark_at =
                                GREATEST(
                                    COALESCE(auto_queue_watermark_at, :cutoff),
                                    :cutoff
                                )
                            WHERE id = :subscription_id
                            """
                        ),
                        {
                            "subscription_id": payload.subscription_id,
                            "cutoff": checkpoint.cutoff_at,
                        },
                    )

            completed_at = _database_now(fresh)
            fresh.execute(
                text(
                    """
                    UPDATE podcast_subscriptions
                    SET
                        sync_status = :status,
                        sync_error_code = NULL,
                        sync_error_message = NULL,
                        sync_completed_at = :completed_at,
                        last_checked_at = :completed_at,
                        next_sync_at = :next_sync_at,
                        consecutive_sync_failures = 0,
                        sync_job_id = NULL,
                        sync_job_attempt_no = NULL,
                        sync_checkpoint_status = NULL,
                        sync_checkpoint_cutoff_at = NULL,
                        sync_checkpoint_new_episode_count = NULL,
                        sync_checkpoint_completed_at = NULL,
                        updated_at = :completed_at
                    WHERE id = :subscription_id
                    """
                ),
                {
                    "subscription_id": payload.subscription_id,
                    "status": checkpoint.status,
                    "completed_at": completed_at,
                    "next_sync_at": healthy_next_sync_at(
                        payload.subscription_id,
                        completed_at,
                    ),
                },
            )
            finish_joined_items_in_txn(
                fresh,
                subscription_id=payload.subscription_id,
                sync_generation=payload.sync_generation,
                status=checkpoint.status,
                new_episode_count=checkpoint.new_episode_count,
                completed_at=completed_at,
            )
            bump_refresh_collections_in_txn(fresh, (payload.user_id,))
            return True

    try:
        return retry_serializable(fresh, "finalize_podcast_subscription_sync", attempt)
    finally:
        fresh.close()


def _terminalize_modeled_failure(
    db: Session,
    *,
    payload: PodcastSyncPayload,
    context: JobExecutionContext,
    error_code: str,
    error_message: str,
) -> bool:
    with transaction(db):
        if _require_exact_queue_attempt(db, payload=payload, context=context) is None:
            return False
        row = _lock_subscription_epoch(db, payload=payload)
        if (
            row is None
            or row["sync_job_id"] != context.job_id
            or int(row["sync_job_attempt_no"] or -1) != context.attempt_no
            or str(row["sync_status"]) != "Running"
        ):
            return False
        checkpoint = _checkpoint_from_row(row)
        new_episode_count = checkpoint.new_episode_count if checkpoint is not None else 0
        completed_at = _database_now(db)
        failures = int(
            db.execute(
                text(
                    """
                    UPDATE podcast_subscriptions
                    SET
                        sync_status = 'Failed',
                        sync_error_code = :error_code,
                        sync_error_message = :error_message,
                        sync_completed_at = :completed_at,
                        last_checked_at = :completed_at,
                        consecutive_sync_failures = consecutive_sync_failures + 1,
                        sync_job_id = NULL,
                        sync_job_attempt_no = NULL,
                        sync_checkpoint_status = NULL,
                        sync_checkpoint_cutoff_at = NULL,
                        sync_checkpoint_new_episode_count = NULL,
                        sync_checkpoint_completed_at = NULL,
                        updated_at = :completed_at
                    WHERE id = :subscription_id
                    RETURNING consecutive_sync_failures
                    """
                ),
                {
                    "subscription_id": payload.subscription_id,
                    "error_code": error_code,
                    "error_message": error_message[:PODCAST_REFRESH_ERROR_MESSAGE_MAX_LENGTH],
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
                "subscription_id": payload.subscription_id,
                "next_sync_at": failed_next_sync_at(failures, completed_at),
                "completed_at": completed_at,
            },
        )
        finish_joined_items_in_txn(
            db,
            subscription_id=payload.subscription_id,
            sync_generation=payload.sync_generation,
            status="Failed",
            new_episode_count=new_episode_count,
            error_code=error_code,
            error_message=error_message,
            completed_at=completed_at,
        )
        bump_refresh_collections_in_txn(db, (payload.user_id,))
        return True


def run_podcast_subscription_sync_now(
    db: Session,
    *,
    payload: Mapping[str, Any],
    context: JobExecutionContext,
) -> SubscriptionSyncResult:
    parsed = PodcastSyncPayload.parse(payload)
    claim = _claim_sync_attempt(db, payload=parsed, context=context)
    if claim is None:
        return SubscriptionSyncResult(
            status="Stale",
            new_episode_count=0,
            source_limited=False,
            reason="StaleEpochGenerationOrAttempt",
        )

    checkpoint = claim.checkpoint
    try:
        if checkpoint is None:
            metadata = _read_podcast_metadata(db, parsed.podcast_id)
            provider_candidates = get_podcast_index_client().fetch_recent_episodes(
                metadata["provider_podcast_id"],
                PODCAST_INDEX_EPISODE_PAGE_SIZE,
            )
            snapshot = fetch_live_feed_snapshot(
                provider_episode_candidates=provider_candidates,
                feed_url=metadata["feed_url"],
            )
            selected_episodes = sorted(
                snapshot.episodes,
                key=lambda episode: parse_iso_datetime(episode.get("published_at"))
                or datetime.min.replace(tzinfo=UTC),
                reverse=True,
            )
            checkpoint = _write_ingest_checkpoint(
                db,
                payload=parsed,
                context=context,
                cutoff_at=claim.cutoff_at,
                selected_episodes=selected_episodes,
                feed_url=metadata["feed_url"],
                source_limited=snapshot.source_limited,
            )
            if checkpoint is None:
                return SubscriptionSyncResult(
                    status="Stale",
                    new_episode_count=0,
                    source_limited=False,
                    reason="StaleAfterFeedFetch",
                )

        if not _finalize_healthy_sync(payload=parsed, context=context):
            return SubscriptionSyncResult(
                status="Stale",
                new_episode_count=0,
                source_limited=False,
                reason="StaleBeforeFinalization",
            )
        return SubscriptionSyncResult(
            status=checkpoint.status,
            new_episode_count=checkpoint.new_episode_count,
            source_limited=checkpoint.status == "SourceLimited",
        )
    except ApiError as exc:
        terminalized = _terminalize_modeled_failure(
            db,
            payload=parsed,
            context=context,
            error_code=exc.code.value,
            error_message=exc.message,
        )
        return SubscriptionSyncResult(
            status="Failed" if terminalized else "Stale",
            new_episode_count=0,
            source_limited=False,
            reason=None if terminalized else "StaleDuringFailure",
            error_code=exc.code.value if terminalized else None,
        )


def dead_letter_podcast_subscription_sync(db: Session, job: JobRow) -> None:
    if job.kind != PODCAST_SYNC_JOB_KIND:
        return
    try:
        payload = PodcastSyncPayload.parse(job.payload)
    except (TypeError, ValueError):
        return
    if job.dedupe_key != podcast_sync_dedupe_key(
        payload.subscription_id,
        payload.sync_generation,
    ):
        return

    row = _lock_subscription_epoch(db, payload=payload)
    if row is None or row["sync_job_id"] != job.id:
        return
    status = str(row["sync_status"])
    if status == "Running" and int(row["sync_job_attempt_no"] or -1) != job.attempts:
        return
    if status not in {"Pending", "Running"}:
        return

    checkpoint = _checkpoint_from_row(row)
    new_episode_count = checkpoint.new_episode_count if checkpoint is not None else 0
    completed_at = _database_now(db)
    failures = int(
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    sync_status = 'Failed',
                    sync_error_code = :error_code,
                    sync_error_message = :error_message,
                    sync_completed_at = :completed_at,
                    last_checked_at = :completed_at,
                    consecutive_sync_failures = consecutive_sync_failures + 1,
                    sync_job_id = NULL,
                    sync_job_attempt_no = NULL,
                    sync_checkpoint_status = NULL,
                    sync_checkpoint_cutoff_at = NULL,
                    sync_checkpoint_new_episode_count = NULL,
                    sync_checkpoint_completed_at = NULL,
                    updated_at = :completed_at
                WHERE id = :subscription_id
                RETURNING consecutive_sync_failures
                """
            ),
            {
                "subscription_id": payload.subscription_id,
                "error_code": ApiErrorCode.E_PODCAST_SYNC_RETRY_EXHAUSTED.value,
                "error_message": (job.last_error or "Podcast sync exhausted its retry budget")[
                    :PODCAST_REFRESH_ERROR_MESSAGE_MAX_LENGTH
                ],
                "completed_at": completed_at,
            },
        ).scalar_one()
    )
    db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET next_sync_at = :next_sync_at
            WHERE id = :subscription_id
            """
        ),
        {
            "subscription_id": payload.subscription_id,
            "next_sync_at": failed_next_sync_at(failures, completed_at),
        },
    )
    finish_joined_items_in_txn(
        db,
        subscription_id=payload.subscription_id,
        sync_generation=payload.sync_generation,
        status="Failed",
        new_episode_count=new_episode_count,
        error_code=ApiErrorCode.E_PODCAST_SYNC_RETRY_EXHAUSTED.value,
        error_message=job.last_error or "Podcast sync exhausted its retry budget",
        completed_at=completed_at,
    )
    bump_collection_families(
        db,
        viewer_ids=(payload.user_id,),
        families=(
            CollectionFamily.LibraryEntries,
            CollectionFamily.PodcastSubscriptions,
        ),
    )
