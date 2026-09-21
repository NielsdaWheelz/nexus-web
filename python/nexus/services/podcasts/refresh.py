"""Podcast sync generation admission: manual refresh and the due sweep."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.orm import Session

from nexus.db.errors import TransactionRestart
from nexus.db.retries import retry_read_committed, retry_serializable
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, NotFoundError
from nexus.jobs.queue import enqueue_unique_job, promote_unclaimed_job
from nexus.schemas.podcast import (
    PodcastRefreshLibraryScope,
    PodcastRefreshManualScope,
    PodcastRefreshPodcastScope,
)
from nexus.services import library_governance
from nexus.services.collection_revisions import CollectionFamily, bump_collection_families

from .types import (
    PODCAST_HEALTHY_SYNC_BASE_SECONDS,
    PODCAST_HEALTHY_SYNC_JITTER_MAX_SECONDS,
    PODCAST_REFRESH_DUE_MAX_LIMIT,
    PODCAST_SYNC_BULK_PRIORITY,
    PODCAST_SYNC_FAILURE_BACKOFF_SECONDS,
    PODCAST_SYNC_INTERACTIVE_PRIORITY,
)

PODCAST_SYNC_JOB_KIND = "podcast_sync_subscription_job"
_ACTIVE_SYNC_STATUSES = frozenset({"Pending", "Running"})
_TERMINAL_SYNC_STATUSES = frozenset({"Complete", "SourceLimited", "Failed"})


def podcast_sync_payload(
    *,
    subscription_id: UUID,
    user_id: UUID,
    podcast_id: UUID,
    sync_generation: int,
) -> dict[str, object]:
    return {
        "subscription_id": str(subscription_id),
        "user_id": str(user_id),
        "podcast_id": str(podcast_id),
        "sync_generation": int(sync_generation),
    }


def podcast_sync_dedupe_key(subscription_id: UUID, sync_generation: int) -> str:
    return f"podcast-sync:{subscription_id}:{int(sync_generation)}"


def healthy_next_sync_at(subscription_id: UUID, now: datetime) -> datetime:
    """A day out, spread by a stable per-subscription jitter."""
    digest = hashlib.sha256(subscription_id.bytes).digest()
    jitter = int.from_bytes(digest[:8], byteorder="big") % (
        PODCAST_HEALTHY_SYNC_JITTER_MAX_SECONDS + 1
    )
    return now + timedelta(seconds=PODCAST_HEALTHY_SYNC_BASE_SECONDS + jitter)


def failed_next_sync_at(consecutive_failures: int, now: datetime) -> datetime:
    index = min(max(int(consecutive_failures), 1), len(PODCAST_SYNC_FAILURE_BACKOFF_SECONDS)) - 1
    return now + timedelta(seconds=PODCAST_SYNC_FAILURE_BACKOFF_SECONDS[index])


def admit_subscription_generation_in_txn(
    db: Session,
    *,
    subscription_id: UUID,
    user_id: UUID,
    podcast_id: UUID,
    priority: int,
) -> None:
    """Join the live generation or open one, so an epoch has at most one job.

    The caller owns the surrounding retryable transaction. An interactive join
    observes the queue id, locks that row first, then re-reads the subscription
    to preserve the global queue -> subscription lock order.
    """
    preflight = _require_epoch(
        _read_subscription(db, subscription_id, lock=False),
        subscription_id=subscription_id,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    preflight_status = str(preflight["sync_status"])
    preflight_job_id = preflight["sync_job_id"]
    if (
        preflight_status in _ACTIVE_SYNC_STATUSES
        and preflight_job_id is not None
        and priority == PODCAST_SYNC_INTERACTIVE_PRIORITY
    ):
        generation = int(preflight["sync_generation"])
        promote_unclaimed_job(
            db,
            job_id=UUID(str(preflight_job_id)),
            kind=PODCAST_SYNC_JOB_KIND,
            payload=podcast_sync_payload(
                subscription_id=subscription_id,
                user_id=user_id,
                podcast_id=podcast_id,
                sync_generation=generation,
            ),
            dedupe_key=podcast_sync_dedupe_key(subscription_id, generation),
            priority=priority,
        )
    row = _require_epoch(
        _read_subscription(db, subscription_id, lock=True),
        subscription_id=subscription_id,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    status = str(row["sync_status"])
    generation = int(row["sync_generation"])
    current_job_id = row["sync_job_id"]
    if status in _TERMINAL_SYNC_STATUSES:
        generation += 1
        current_job_id = None
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET sync_generation = :sync_generation,
                    sync_status = 'Pending',
                    sync_error_code = NULL,
                    sync_error_message = NULL,
                    sync_started_at = NULL,
                    sync_completed_at = NULL,
                    sync_job_id = NULL,
                    sync_job_attempt_no = NULL,
                    updated_at = now()
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id, "sync_generation": generation},
        )
    if current_job_id is not None:
        return

    job, _inserted = enqueue_unique_job(
        db,
        kind=PODCAST_SYNC_JOB_KIND,
        payload=podcast_sync_payload(
            subscription_id=subscription_id,
            user_id=user_id,
            podcast_id=podcast_id,
            sync_generation=generation,
        ),
        dedupe_key=podcast_sync_dedupe_key(subscription_id, generation),
        priority=priority,
    )
    db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET sync_job_id = :job_id, updated_at = now()
            WHERE id = :subscription_id AND sync_generation = :sync_generation
            """
        ),
        {
            "subscription_id": subscription_id,
            "sync_generation": generation,
            "job_id": job.id,
        },
    )


def enqueue_manual_refresh(
    db: Session,
    *,
    viewer_id: UUID,
    scope: PodcastRefreshManualScope,
) -> int:
    """Enqueue one sync per in-scope subscription and report how many."""

    def attempt() -> int:
        with transaction(db):
            subscriptions = _manual_scope_subscriptions(db, viewer_id=viewer_id, scope=scope)
            for subscription_id, user_id, podcast_id in subscriptions:
                admit_subscription_generation_in_txn(
                    db,
                    subscription_id=subscription_id,
                    user_id=user_id,
                    podcast_id=podcast_id,
                    priority=PODCAST_SYNC_INTERACTIVE_PRIORITY,
                )
            if subscriptions:
                bump_refresh_collections_in_txn(db, (viewer_id,))
            return len(subscriptions)

    return retry_read_committed(db, "enqueue_podcast_manual_refresh", attempt)


def admit_due_subscriptions(db: Session, *, limit: int) -> int:
    """Claim the oldest due subscriptions and enqueue one bulk sync each."""
    effective_limit = min(max(int(limit), 1), PODCAST_REFRESH_DUE_MAX_LIMIT)

    def attempt() -> int:
        with transaction(db):
            rows = (
                db.execute(
                    text(
                        """
                        SELECT id, user_id, podcast_id
                        FROM podcast_subscriptions
                        WHERE next_sync_at <= now()
                          AND sync_status IN ('Complete', 'SourceLimited', 'Failed')
                        ORDER BY next_sync_at, id
                        LIMIT :limit
                        FOR UPDATE SKIP LOCKED
                        """
                    ),
                    {"limit": effective_limit},
                )
                .mappings()
                .all()
            )
            for row in rows:
                admit_subscription_generation_in_txn(
                    db,
                    subscription_id=UUID(str(row["id"])),
                    user_id=UUID(str(row["user_id"])),
                    podcast_id=UUID(str(row["podcast_id"])),
                    priority=PODCAST_SYNC_BULK_PRIORITY,
                )
            if rows:
                bump_refresh_collections_in_txn(
                    db, tuple(UUID(str(row["user_id"])) for row in rows)
                )
            return len(rows)

    return retry_serializable(db, "admit_due_podcast_subscriptions", attempt)


def bump_refresh_collections_in_txn(db: Session, viewer_ids: tuple[UUID, ...]) -> None:
    bump_collection_families(
        db,
        viewer_ids=tuple(sorted(set(viewer_ids))),
        families=(CollectionFamily.LibraryEntries, CollectionFamily.PodcastSubscriptions),
    )


def _manual_scope_subscriptions(
    db: Session,
    *,
    viewer_id: UUID,
    scope: PodcastRefreshManualScope,
) -> list[tuple[UUID, UUID, UUID]]:
    params: dict[str, object] = {"viewer_id": viewer_id}
    predicate = ""
    if isinstance(scope, PodcastRefreshPodcastScope):
        params["podcast_id"] = scope.podcast_id
        predicate = "AND podcast_id = :podcast_id"
    elif isinstance(scope, PodcastRefreshLibraryScope):
        context = library_governance.lock_library_for_member(
            db, viewer_id, scope.library_id, lock=False
        )
        if not context.is_default:
            params["library_id"] = scope.library_id
            predicate = """
                AND EXISTS (
                    SELECT 1
                    FROM library_entries entry
                    WHERE entry.library_id = :library_id
                      AND entry.podcast_id = podcast_subscriptions.podcast_id
                )
            """
    rows = db.execute(
        text(
            f"""
            SELECT id, user_id, podcast_id
            FROM podcast_subscriptions
            WHERE user_id = :viewer_id
              {predicate}
            ORDER BY id
            """
        ),
        params,
    ).fetchall()
    if isinstance(scope, PodcastRefreshPodcastScope) and not rows:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")
    return [(UUID(str(row[0])), UUID(str(row[1])), UUID(str(row[2]))) for row in rows]


def _read_subscription(db: Session, subscription_id: UUID, *, lock: bool) -> RowMapping | None:
    return (
        db.execute(
            text(
                """
                SELECT id, user_id, podcast_id, sync_generation, sync_status, sync_job_id
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
                + (" FOR UPDATE" if lock else "")
            ),
            {"subscription_id": subscription_id},
        )
        .mappings()
        .first()
    )


def _require_epoch(
    row: RowMapping | None,
    *,
    subscription_id: UUID,
    user_id: UUID,
    podcast_id: UUID,
) -> RowMapping:
    if (
        row is None
        or UUID(str(row["id"])) != subscription_id
        or UUID(str(row["user_id"])) != user_id
        or UUID(str(row["podcast_id"])) != podcast_id
    ):
        raise TransactionRestart("Podcast subscription epoch changed during refresh admission")
    return row
