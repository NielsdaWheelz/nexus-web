"""Podcast refresh-run admission, aggregation, observation, and retention."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, cast
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.db.errors import TransactionRestart
from nexus.db.retries import retry_serializable
from nexus.db.session import transaction
from nexus.errors import ApiErrorCode, ConflictError, InvalidRequestError, NotFoundError
from nexus.jobs.queue import enqueue_unique_job, promote_unclaimed_job
from nexus.schemas.podcast import (
    PodcastRefreshLibraryScope,
    PodcastRefreshManualScope,
    PodcastRefreshPodcastScope,
    PodcastRefreshRunCreateOut,
    PodcastRefreshRunSnapshotOut,
)
from nexus.schemas.presence import presence_from_nullable
from nexus.services import library_governance
from nexus.services.collection_revisions import CollectionFamily, bump_collection_families

from .control_replay import podcast_control_request_bytes
from .handles import seal_podcast_refresh_run
from .types import (
    PODCAST_HEALTHY_SYNC_BASE_SECONDS,
    PODCAST_HEALTHY_SYNC_JITTER_MAX_SECONDS,
    PODCAST_REFRESH_DUE_MAX_LIMIT,
    PODCAST_REFRESH_ERROR_MESSAGE_MAX_LENGTH,
    PODCAST_REFRESH_RUN_PRUNE_LIMIT,
    PODCAST_REFRESH_RUN_RETENTION_DAYS,
    PODCAST_SYNC_BULK_PRIORITY,
    PODCAST_SYNC_FAILURE_BACKOFF_SECONDS,
    PODCAST_SYNC_INTERACTIVE_PRIORITY,
    PodcastRefreshRunItemStatus,
    PodcastRefreshRunStatus,
    PodcastSyncStatus,
)

PODCAST_SYNC_JOB_KIND = "podcast_sync_subscription_job"
PODCAST_REFRESH_NOTIFY_CHANNEL = "podcast_refresh_events"
PODCAST_REFRESH_CREATE_PATH = "/podcasts/refresh-runs"

_ACTIVE_SYNC_STATUSES = frozenset({"Pending", "Running"})
_TERMINAL_SYNC_STATUSES = frozenset({"Complete", "SourceLimited", "Failed"})
_ACTIVE_ITEM_STATUSES = frozenset({"Pending", "Running"})
_TERMINAL_ITEM_STATUSES = frozenset({"Complete", "SourceLimited", "Failed", "Skipped"})


@dataclass(frozen=True)
class GenerationAdmission:
    subscription_id: UUID
    user_id: UUID
    podcast_id: UUID
    sync_generation: int
    status: PodcastSyncStatus
    job_id: UUID
    inserted_job: bool
    promoted_job: bool


@dataclass(frozen=True)
class RefreshAggregation:
    status: PodcastRefreshRunStatus
    requested_count: int
    finished_count: int
    succeeded_count: int
    source_limited_count: int
    failed_count: int
    skipped_count: int
    new_episode_count: int


@dataclass(frozen=True)
class DueAdmissionResult:
    subscription_count: int
    run_count: int


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
    digest = hashlib.sha256(subscription_id.bytes).digest()
    jitter_seconds = int.from_bytes(digest[:8], byteorder="big") % (
        PODCAST_HEALTHY_SYNC_JITTER_MAX_SECONDS + 1
    )
    return now + timedelta(seconds=PODCAST_HEALTHY_SYNC_BASE_SECONDS + jitter_seconds)


def failed_next_sync_at(consecutive_failures: int, now: datetime) -> datetime:
    index = min(max(int(consecutive_failures), 1), len(PODCAST_SYNC_FAILURE_BACKOFF_SECONDS)) - 1
    return now + timedelta(seconds=PODCAST_SYNC_FAILURE_BACKOFF_SECONDS[index])


def aggregate_refresh_item_statuses(
    items: Sequence[tuple[PodcastRefreshRunItemStatus, int]],
) -> RefreshAggregation:
    counts = {status: 0 for status in _TERMINAL_ITEM_STATUSES | _ACTIVE_ITEM_STATUSES}
    new_episode_count = 0
    for status, new_count in items:
        counts[status] += 1
        new_episode_count += int(new_count)

    requested = len(items)
    finished = sum(counts[status] for status in _TERMINAL_ITEM_STATUSES)
    succeeded = counts["Complete"]
    source_limited = counts["SourceLimited"]
    failed = counts["Failed"]
    skipped = counts["Skipped"]
    effective_successes = succeeded + source_limited

    if counts["Pending"] or counts["Running"]:
        status: PodcastRefreshRunStatus = "Running"
    elif requested == 0:
        status = "Complete"
    elif failed == 0 and skipped == 0:
        status = "Complete"
    elif effective_successes > 0:
        status = "Partial"
    elif failed > 0:
        status = "Failed"
    else:
        status = "Complete"

    return RefreshAggregation(
        status=status,
        requested_count=requested,
        finished_count=finished,
        succeeded_count=succeeded,
        source_limited_count=source_limited,
        failed_count=failed,
        skipped_count=skipped,
        new_episode_count=new_episode_count,
    )


def recompute_refresh_runs_in_txn(db: Session, run_ids: Sequence[UUID]) -> None:
    for run_id in sorted(set(run_ids)):
        db.execute(
            text(
                """
                SELECT id
                FROM podcast_refresh_runs
                WHERE id = :run_id
                FOR UPDATE
                """
            ),
            {"run_id": run_id},
        ).one()
        rows = db.execute(
            text(
                """
                SELECT status, new_episode_count
                FROM podcast_refresh_run_items
                WHERE run_id = :run_id
                ORDER BY id
                """
            ),
            {"run_id": run_id},
        ).fetchall()
        aggregation = aggregate_refresh_item_statuses(
            [(cast(PodcastRefreshRunItemStatus, str(row[0])), int(row[1] or 0)) for row in rows]
        )
        terminal = aggregation.status != "Running"
        db.execute(
            text(
                """
                UPDATE podcast_refresh_runs
                SET
                    status = :status,
                    requested_count = :requested_count,
                    finished_count = :finished_count,
                    succeeded_count = :succeeded_count,
                    source_limited_count = :source_limited_count,
                    failed_count = :failed_count,
                    skipped_count = :skipped_count,
                    new_episode_count = :new_episode_count,
                    completed_at = CASE
                        WHEN :terminal THEN COALESCE(completed_at, now())
                        ELSE NULL
                    END,
                    updated_at = now()
                WHERE id = :run_id
                """
            ),
            {
                "run_id": run_id,
                "status": aggregation.status,
                "requested_count": aggregation.requested_count,
                "finished_count": aggregation.finished_count,
                "succeeded_count": aggregation.succeeded_count,
                "source_limited_count": aggregation.source_limited_count,
                "failed_count": aggregation.failed_count,
                "skipped_count": aggregation.skipped_count,
                "new_episode_count": aggregation.new_episode_count,
                "terminal": terminal,
            },
        )


def _lock_subscription(
    db: Session,
    *,
    subscription_id: UUID,
) -> Mapping[str, Any] | None:
    return (
        db.execute(
            text(
                """
                SELECT
                    id, user_id, podcast_id, sync_generation, sync_status,
                    sync_job_id, sync_job_attempt_no
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                FOR UPDATE
                """
            ),
            {"subscription_id": subscription_id},
        )
        .mappings()
        .first()
    )


def _require_subscription_identity(
    row: Mapping[str, Any] | None,
    *,
    subscription_id: UUID,
    user_id: UUID,
    podcast_id: UUID,
) -> Mapping[str, Any]:
    if (
        row is None
        or UUID(str(row["id"])) != subscription_id
        or UUID(str(row["user_id"])) != user_id
        or UUID(str(row["podcast_id"])) != podcast_id
    ):
        raise TransactionRestart("Podcast subscription epoch changed during refresh admission")
    return row


def admit_subscription_generation_in_txn(
    db: Session,
    *,
    subscription_id: UUID,
    user_id: UUID,
    podcast_id: UUID,
    priority: int,
    run_id: UUID | None = None,
) -> GenerationAdmission:
    """Join the active generation or start one terminal subscription generation.

    The caller owns the surrounding retryable transaction. An interactive join
    observes the current queue id, locks that row first, then re-reads the
    subscription to preserve the global queue -> subscription lock order.
    """
    preflight = (
        db.execute(
            text(
                """
                SELECT
                    id, user_id, podcast_id, sync_generation, sync_status,
                    sync_job_id, sync_job_attempt_no
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        )
        .mappings()
        .first()
    )
    preflight = _require_subscription_identity(
        preflight,
        subscription_id=subscription_id,
        user_id=user_id,
        podcast_id=podcast_id,
    )

    promoted = False
    preflight_status = str(preflight["sync_status"])
    preflight_job_id = preflight["sync_job_id"]
    if (
        preflight_status in _ACTIVE_SYNC_STATUSES
        and preflight_job_id is not None
        and priority == PODCAST_SYNC_INTERACTIVE_PRIORITY
    ):
        generation = int(preflight["sync_generation"])
        payload = podcast_sync_payload(
            subscription_id=subscription_id,
            user_id=user_id,
            podcast_id=podcast_id,
            sync_generation=generation,
        )
        promoted = promote_unclaimed_job(
            db,
            job_id=UUID(str(preflight_job_id)),
            kind=PODCAST_SYNC_JOB_KIND,
            payload=payload,
            dedupe_key=podcast_sync_dedupe_key(subscription_id, generation),
            priority=priority,
        )
        row = _require_subscription_identity(
            _lock_subscription(db, subscription_id=subscription_id),
            subscription_id=subscription_id,
            user_id=user_id,
            podcast_id=podcast_id,
        )
        if (
            str(row["sync_status"]) != preflight_status
            or int(row["sync_generation"]) != generation
            or row["sync_job_id"] != preflight_job_id
        ):
            raise TransactionRestart("Podcast sync generation changed during queue promotion")
    else:
        row = _require_subscription_identity(
            _lock_subscription(db, subscription_id=subscription_id),
            subscription_id=subscription_id,
            user_id=user_id,
            podcast_id=podcast_id,
        )

    status = str(row["sync_status"])
    generation = int(row["sync_generation"])
    if status in _TERMINAL_SYNC_STATUSES:
        generation += 1
        status = "Pending"
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    sync_generation = :sync_generation,
                    sync_status = 'Pending',
                    sync_error_code = NULL,
                    sync_error_message = NULL,
                    sync_started_at = NULL,
                    sync_completed_at = NULL,
                    sync_job_id = NULL,
                    sync_job_attempt_no = NULL,
                    sync_checkpoint_status = NULL,
                    sync_checkpoint_cutoff_at = NULL,
                    sync_checkpoint_new_episode_count = NULL,
                    sync_checkpoint_completed_at = NULL,
                    updated_at = now()
                WHERE id = :subscription_id
                """
            ),
            {
                "subscription_id": subscription_id,
                "sync_generation": generation,
            },
        )
        current_job_id: UUID | None = None
    elif status in _ACTIVE_SYNC_STATUSES:
        current_job_id = UUID(str(row["sync_job_id"])) if row["sync_job_id"] is not None else None
    else:
        raise RuntimeError(f"Unknown Podcast sync status {status!r}")

    payload = podcast_sync_payload(
        subscription_id=subscription_id,
        user_id=user_id,
        podcast_id=podcast_id,
        sync_generation=generation,
    )
    inserted_job = False
    if current_job_id is None:
        job, inserted_job = enqueue_unique_job(
            db,
            kind=PODCAST_SYNC_JOB_KIND,
            payload=payload,
            dedupe_key=podcast_sync_dedupe_key(subscription_id, generation),
            priority=priority,
        )
        if job.kind != PODCAST_SYNC_JOB_KIND or dict(job.payload) != payload:
            raise RuntimeError("Podcast sync dedupe key resolved to a different operation")
        current_job_id = job.id
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET sync_job_id = :job_id, updated_at = now()
                WHERE id = :subscription_id
                  AND sync_generation = :sync_generation
                """
            ),
            {
                "subscription_id": subscription_id,
                "sync_generation": generation,
                "job_id": current_job_id,
            },
        )

    if run_id is not None:
        db.execute(
            text(
                """
                INSERT INTO podcast_refresh_run_items (
                    id, run_id, podcast_id, subscription_id, sync_generation,
                    status, new_episode_count, created_at, updated_at
                )
                VALUES (
                    :id, :run_id, :podcast_id, :subscription_id, :sync_generation,
                    :status, 0, now(), now()
                )
                """
            ),
            {
                "id": uuid4(),
                "run_id": run_id,
                "podcast_id": podcast_id,
                "subscription_id": subscription_id,
                "sync_generation": generation,
                "status": status,
            },
        )

    return GenerationAdmission(
        subscription_id=subscription_id,
        user_id=user_id,
        podcast_id=podcast_id,
        sync_generation=generation,
        status=cast(PodcastSyncStatus, status),
        job_id=current_job_id,
        inserted_job=inserted_job,
        promoted_job=promoted,
    )


def bump_refresh_collections_in_txn(db: Session, viewer_ids: Sequence[UUID]) -> None:
    bump_collection_families(
        db,
        viewer_ids=tuple(sorted(set(viewer_ids))),
        families=(
            CollectionFamily.LibraryEntries,
            CollectionFamily.PodcastSubscriptions,
        ),
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
            db,
            viewer_id,
            scope.library_id,
            lock=False,
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


def create_manual_refresh_run(
    db: Session,
    *,
    viewer_id: UUID,
    scope: PodcastRefreshManualScope,
    idempotency_key: str,
) -> PodcastRefreshRunCreateOut:
    if not idempotency_key.strip():
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST, "Idempotency-Key must be nonblank"
        )

    api_scope = scope.model_dump(mode="json", by_alias=True)
    stored_scope = scope.model_dump(mode="json", by_alias=False)
    request_hash = hashlib.sha256(
        podcast_control_request_bytes(
            method="POST",
            path=PODCAST_REFRESH_CREATE_PATH,
            body=api_scope,
        )
    ).hexdigest()

    def attempt() -> PodcastRefreshRunCreateOut:
        with transaction(db):
            replay = (
                db.execute(
                    text(
                        """
                        SELECT id, request_hash
                        FROM podcast_refresh_runs
                        WHERE user_id = :viewer_id
                          AND idempotency_key = :idempotency_key
                        """
                    ),
                    {
                        "viewer_id": viewer_id,
                        "idempotency_key": idempotency_key,
                    },
                )
                .mappings()
                .first()
            )
            if replay is not None:
                if str(replay["request_hash"]) != request_hash:
                    raise ConflictError(
                        ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH,
                        "Idempotency-Key was reused with a different Podcast refresh scope",
                    )
                snapshot = _read_refresh_run_snapshot(
                    db,
                    run_id=UUID(str(replay["id"])),
                )
                return PodcastRefreshRunCreateOut(
                    refresh_run_handle=snapshot.refresh_run_handle,
                    status=snapshot.status,
                    requested_count=snapshot.requested_count,
                )

            subscriptions = _manual_scope_subscriptions(
                db,
                viewer_id=viewer_id,
                scope=scope,
            )
            run_id = uuid4()
            initial_status = "Running" if subscriptions else "Complete"
            db.execute(
                text(
                    """
                    INSERT INTO podcast_refresh_runs (
                        id, user_id, idempotency_key, request_hash, scope, status,
                        requested_count, finished_count, succeeded_count,
                        source_limited_count, failed_count, skipped_count,
                        new_episode_count, started_at, completed_at, created_at, updated_at
                    )
                    VALUES (
                        :id, :user_id, :idempotency_key, :request_hash,
                        CAST(:scope AS jsonb), :status,
                        :requested_count, 0, 0, 0, 0, 0, 0,
                        now(), CASE WHEN :terminal THEN now() ELSE NULL END, now(), now()
                    )
                    """
                ),
                {
                    "id": run_id,
                    "user_id": viewer_id,
                    "idempotency_key": idempotency_key,
                    "request_hash": request_hash,
                    "scope": json.dumps(
                        dict(stored_scope),
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    "status": initial_status,
                    "requested_count": len(subscriptions),
                    "terminal": not subscriptions,
                },
            )
            for subscription_id, user_id, podcast_id in subscriptions:
                admit_subscription_generation_in_txn(
                    db,
                    subscription_id=subscription_id,
                    user_id=user_id,
                    podcast_id=podcast_id,
                    priority=PODCAST_SYNC_INTERACTIVE_PRIORITY,
                    run_id=run_id,
                )
            if subscriptions:
                recompute_refresh_runs_in_txn(db, (run_id,))
                bump_refresh_collections_in_txn(db, (viewer_id,))
            snapshot = _read_refresh_run_snapshot(db, run_id=run_id)
            return PodcastRefreshRunCreateOut(
                refresh_run_handle=snapshot.refresh_run_handle,
                status=snapshot.status,
                requested_count=snapshot.requested_count,
            )

    return retry_serializable(db, "create_podcast_refresh_run", attempt)


def admit_due_refresh_runs(db: Session, *, limit: int) -> DueAdmissionResult:
    effective_limit = min(max(int(limit), 1), PODCAST_REFRESH_DUE_MAX_LIMIT)

    def attempt() -> DueAdmissionResult:
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
            grouped: dict[UUID, list[Mapping[str, Any]]] = defaultdict(list)
            for row in rows:
                grouped[UUID(str(row["user_id"]))].append(row)

            for viewer_id in sorted(grouped):
                run_id = uuid4()
                viewer_rows = grouped[viewer_id]
                db.execute(
                    text(
                        """
                        INSERT INTO podcast_refresh_runs (
                            id, user_id, idempotency_key, request_hash, scope, status,
                            requested_count, finished_count, succeeded_count,
                            source_limited_count, failed_count, skipped_count,
                            new_episode_count, started_at, completed_at, created_at, updated_at
                        )
                        VALUES (
                            :id, :user_id, NULL, NULL, '{"kind":"Due"}'::jsonb, 'Running',
                            :requested_count, 0, 0, 0, 0, 0, 0,
                            now(), NULL, now(), now()
                        )
                        """
                    ),
                    {
                        "id": run_id,
                        "user_id": viewer_id,
                        "requested_count": len(viewer_rows),
                    },
                )
                for row in viewer_rows:
                    admit_subscription_generation_in_txn(
                        db,
                        subscription_id=UUID(str(row["id"])),
                        user_id=viewer_id,
                        podcast_id=UUID(str(row["podcast_id"])),
                        priority=PODCAST_SYNC_BULK_PRIORITY,
                        run_id=run_id,
                    )
                recompute_refresh_runs_in_txn(db, (run_id,))
            if grouped:
                bump_refresh_collections_in_txn(db, tuple(grouped))
            return DueAdmissionResult(subscription_count=len(rows), run_count=len(grouped))

    return retry_serializable(db, "admit_due_podcast_refresh_runs", attempt)


def set_joined_items_running_in_txn(
    db: Session,
    *,
    subscription_id: UUID,
    sync_generation: int,
    started_at: datetime,
) -> None:
    run_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                """
                UPDATE podcast_refresh_run_items
                SET status = 'Running',
                    started_at = COALESCE(started_at, :started_at),
                    completed_at = NULL,
                    error_code = NULL,
                    error_message = NULL,
                    updated_at = now()
                WHERE subscription_id = :subscription_id
                  AND sync_generation = :sync_generation
                  AND status IN ('Pending', 'Running')
                RETURNING run_id
                """
            ),
            {
                "subscription_id": subscription_id,
                "sync_generation": sync_generation,
                "started_at": started_at,
            },
        ).fetchall()
    ]
    recompute_refresh_runs_in_txn(db, run_ids)


def finish_joined_items_in_txn(
    db: Session,
    *,
    subscription_id: UUID,
    sync_generation: int,
    status: PodcastRefreshRunItemStatus,
    new_episode_count: int,
    error_code: str | None = None,
    error_message: str | None = None,
    completed_at: datetime,
) -> None:
    if status not in _TERMINAL_ITEM_STATUSES:
        raise ValueError("Podcast refresh item completion status must be terminal")
    run_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                """
                UPDATE podcast_refresh_run_items
                SET status = :status,
                    new_episode_count = :new_episode_count,
                    error_code = :error_code,
                    error_message = :error_message,
                    completed_at = :completed_at,
                    updated_at = :completed_at
                WHERE subscription_id = :subscription_id
                  AND sync_generation = :sync_generation
                  AND status IN ('Pending', 'Running')
                RETURNING run_id
                """
            ),
            {
                "subscription_id": subscription_id,
                "sync_generation": sync_generation,
                "status": status,
                "new_episode_count": max(int(new_episode_count), 0),
                "error_code": error_code,
                "error_message": (
                    error_message[:PODCAST_REFRESH_ERROR_MESSAGE_MAX_LENGTH]
                    if error_message is not None
                    else None
                ),
                "completed_at": completed_at,
            },
        ).fetchall()
    ]
    recompute_refresh_runs_in_txn(db, run_ids)


def skip_subscription_epoch_in_txn(
    db: Session,
    *,
    subscription_id: UUID,
) -> None:
    run_ids = [
        UUID(str(row[0]))
        for row in db.execute(
            text(
                """
                UPDATE podcast_refresh_run_items
                SET status = 'Skipped',
                    completed_at = now(),
                    updated_at = now()
                WHERE subscription_id = :subscription_id
                  AND status IN ('Pending', 'Running')
                RETURNING run_id
                """
            ),
            {"subscription_id": subscription_id},
        ).fetchall()
    ]
    recompute_refresh_runs_in_txn(db, run_ids)


def assert_refresh_run_owner(db: Session, *, viewer_id: UUID, run_id: UUID) -> None:
    row = db.execute(
        text(
            """
            SELECT 1
            FROM podcast_refresh_runs
            WHERE id = :run_id AND user_id = :viewer_id
            """
        ),
        {"run_id": run_id, "viewer_id": viewer_id},
    ).first()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast refresh run not found")


def _read_refresh_run_snapshot(
    db: Session,
    *,
    run_id: UUID,
) -> PodcastRefreshRunSnapshotOut:
    row = (
        db.execute(
            text(
                """
                SELECT
                    id, status, requested_count, finished_count, succeeded_count,
                    source_limited_count, failed_count, skipped_count,
                    new_episode_count, started_at, completed_at
                FROM podcast_refresh_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id},
        )
        .mappings()
        .first()
    )
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast refresh run not found")
    return PodcastRefreshRunSnapshotOut(
        refresh_run_handle=seal_podcast_refresh_run(UUID(str(row["id"]))),
        status=cast(PodcastRefreshRunStatus, str(row["status"])),
        requested_count=int(row["requested_count"]),
        finished_count=int(row["finished_count"]),
        succeeded_count=int(row["succeeded_count"]),
        source_limited_count=int(row["source_limited_count"]),
        failed_count=int(row["failed_count"]),
        skipped_count=int(row["skipped_count"]),
        new_episode_count=int(row["new_episode_count"]),
        started_at=row["started_at"],
        completed_at=presence_from_nullable(row["completed_at"]),
    )


def get_refresh_run_snapshot(
    db: Session,
    *,
    viewer_id: UUID,
    run_id: UUID,
) -> PodcastRefreshRunSnapshotOut:
    assert_refresh_run_owner(db, viewer_id=viewer_id, run_id=run_id)
    return _read_refresh_run_snapshot(db, run_id=run_id)


def prune_terminal_refresh_runs(db: Session) -> int:
    with transaction(db):
        run_ids = [
            UUID(str(row[0]))
            for row in db.execute(
                text(
                    """
                    SELECT id
                    FROM podcast_refresh_runs
                    WHERE status IN ('Complete', 'Partial', 'Failed')
                      AND completed_at < now() - (:retention_days * interval '1 day')
                    ORDER BY completed_at, id
                    LIMIT :limit
                    FOR UPDATE SKIP LOCKED
                    """
                ),
                {
                    "retention_days": PODCAST_REFRESH_RUN_RETENTION_DAYS,
                    "limit": PODCAST_REFRESH_RUN_PRUNE_LIMIT,
                },
            ).fetchall()
        ]
        if not run_ids:
            return 0
        db.execute(
            text("DELETE FROM podcast_refresh_run_items WHERE run_id = ANY(:run_ids)"),
            {"run_ids": run_ids},
        )
        db.execute(
            text("DELETE FROM podcast_refresh_runs WHERE id = ANY(:run_ids)"),
            {"run_ids": run_ids},
        )
        return len(run_ids)
