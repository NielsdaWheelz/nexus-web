"""Podcast subscription poll orchestration and sync-run state management."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import partial
from typing import Any, Literal, cast
from uuid import UUID, uuid4

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from nexus.config import get_settings
from nexus.db.errors import integrity_constraint_name
from nexus.db.retries import retry_serializable
from nexus.db.session import get_session_factory, transaction
from nexus.errors import (
    ApiError,
    ApiErrorCode,
    InvalidRequestError,
    NotFoundError,
)
from nexus.jobs.queue import enqueue_job
from nexus.logging import get_logger
from nexus.schemas.podcast import (
    PodcastSubscriptionSyncRefreshOut,
)
from nexus.services.consumption import service as consumption_service
from nexus.services.contributors import MediaTarget, replace_observed_role_slices

from ._normalize import (
    parse_iso_datetime,
)
from .feed import (
    augment_provider_episodes_with_feed_pagination,
    hydrate_selected_episode_chapters_from_feed,
)
from .ingest import sync_subscription_ingest
from .provider import (
    PODCAST_INDEX_EPISODE_PAGE_SIZE,
    get_podcast_index_client,
)

logger = get_logger(__name__)

_PODCAST_ACTIVE_POLL_MAX_LIMIT = 1000
_PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE = ApiErrorCode.E_INTERNAL.value
_SYNC_RUNNING_STALE_SQL = """
COALESCE(sync_started_at, updated_at) < (
    now() - (CAST(:sync_lease_seconds AS integer) * interval '1 second')
)
""".strip()
# Fence-validation lease predicate: the running claim is still healthy. Uses
# clock_timestamp() (not the statement-stable now()) so a long ingest transaction
# is checked against real wall time immediately before commit (spec §5.3).
_SYNC_LEASE_VALID_CLOCK_SQL = """
COALESCE(sync_started_at, updated_at) >= (
    clock_timestamp() - (CAST(:sync_lease_seconds AS integer) * interval '1 second')
)
""".strip()


class StaleSubscriptionSyncClaim(Exception):
    """A worker's sync claim was reclaimed/expired: it must write nothing further
    and never clobber the replacement claim (spec §5.3). Handled by the caller as a
    skipped/stale run, not a failure."""


@dataclass(frozen=True)
class SubscriptionSyncClaim:
    """The persisted fence a sync claim returns: the exact attempt/start pair the
    worker owns. Every later status write matches this pair."""

    sync_attempts: int
    sync_started_at: datetime


@dataclass(frozen=True)
class SubscriptionPollPassResult:
    """Counts for one bounded active-subscription polling pass."""

    processed_count: int
    failed_count: int
    skipped_count: int
    scanned_count: int
    failure_code_breakdown: dict[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class SubscriptionPollResult:
    """Result of a scheduled active-subscription poll run."""

    status: Literal["skipped_singleton", "completed"]
    processed_count: int
    failed_count: int
    skipped_count: int
    scanned_count: int
    failure_code_breakdown: dict[str, int] = field(default_factory=dict)
    run_id: str | None = None


@dataclass(frozen=True)
class SubscriptionSyncResult:
    """Result of running one podcast subscription sync."""

    sync_status: PodcastSyncStatus | Literal["skipped"]
    ingested_episode_count: int
    reused_episode_count: int
    source_limited: bool
    reason: str | None = None
    error_code: str | None = None


PodcastSyncStatus = Literal["pending", "running", "partial", "complete", "source_limited", "failed"]


@dataclass(frozen=True)
class SubscriptionSyncSnapshot:
    """Current sync telemetry for a podcast subscription row."""

    auto_queue: bool
    sync_status: PodcastSyncStatus
    sync_error_code: str | None
    sync_error_message: str | None
    sync_attempts: int
    last_synced_at: datetime | None


def run_scheduled_active_subscription_poll(
    db: Session,
    *,
    limit: int,
    run_lease_seconds: int,
    sync_lease_seconds: int,
    scheduler_identity: str | None = None,
) -> SubscriptionPollResult:
    """Run scheduled active-subscription polling with singleton + durable run telemetry."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    effective_limit = min(limit, _PODCAST_ACTIVE_POLL_MAX_LIMIT)
    if effective_limit < limit:
        logger.warning(
            "podcast_active_poll_limit_clamped",
            requested_limit=limit,
            effective_limit=effective_limit,
            max_limit=_PODCAST_ACTIVE_POLL_MAX_LIMIT,
        )

    if run_lease_seconds <= 0:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Run lease seconds must be positive",
        )

    run_id = uuid4()
    claimed = _claim_subscription_poll_run_singleton(
        db,
        run_id=run_id,
        run_limit=effective_limit,
        run_lease_seconds=run_lease_seconds,
        scheduler_identity=scheduler_identity,
    )
    if not claimed:
        logger.info(
            "podcast_active_poll_run_skipped_singleton",
            scheduler_identity=scheduler_identity,
            run_limit=effective_limit,
        )
        return SubscriptionPollResult(
            status="skipped_singleton",
            processed_count=0,
            failed_count=0,
            skipped_count=0,
            scanned_count=0,
            failure_code_breakdown={},
        )

    logger.info(
        "podcast_active_poll_run_started",
        run_id=str(run_id),
        scheduler_identity=scheduler_identity,
        run_limit=effective_limit,
        run_lease_seconds=run_lease_seconds,
        sync_lease_seconds=sync_lease_seconds,
    )
    try:
        poll_result = poll_active_subscriptions_once(
            db,
            limit=effective_limit,
            sync_lease_seconds=sync_lease_seconds,
        )
    except Exception as exc:
        with transaction(db):
            _mark_subscription_poll_run_failed(
                db,
                run_id=run_id,
                now=datetime.now(UTC),
                error_code=_PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE,
                error_message=str(exc),
            )
        raise

    with transaction(db):
        _mark_subscription_poll_run_completed(
            db,
            run_id=run_id,
            now=datetime.now(UTC),
            poll_result=poll_result,
        )

    logger.info(
        "podcast_active_poll_run_completed",
        run_id=str(run_id),
        scheduler_identity=scheduler_identity,
        run_limit=effective_limit,
        processed_count=poll_result.processed_count,
        failed_count=poll_result.failed_count,
        skipped_count=poll_result.skipped_count,
        scanned_count=poll_result.scanned_count,
        failure_code_breakdown=poll_result.failure_code_breakdown,
    )
    return SubscriptionPollResult(
        status="completed",
        run_id=str(run_id),
        processed_count=poll_result.processed_count,
        failed_count=poll_result.failed_count,
        skipped_count=poll_result.skipped_count,
        scanned_count=poll_result.scanned_count,
        failure_code_breakdown=poll_result.failure_code_breakdown,
    )


def poll_active_subscriptions_once(
    db: Session,
    *,
    limit: int = 100,
    sync_lease_seconds: int | None = None,
) -> SubscriptionPollPassResult:
    """Run one bounded polling pass over active subscriptions."""
    if limit <= 0:
        raise InvalidRequestError(ApiErrorCode.E_INVALID_REQUEST, "Limit must be positive")
    limit = min(limit, _PODCAST_ACTIVE_POLL_MAX_LIMIT)

    if sync_lease_seconds is None:
        sync_lease_seconds = get_settings().podcast_sync_running_lease_seconds
    if sync_lease_seconds <= 0:
        raise InvalidRequestError(
            ApiErrorCode.E_INVALID_REQUEST,
            "Sync lease seconds must be positive",
        )

    rows = db.execute(
        text(
            f"""
            SELECT user_id, podcast_id
            FROM podcast_subscriptions
            WHERE status = 'active'
              AND (
                  sync_status <> 'running'
                  OR ({_SYNC_RUNNING_STALE_SQL})
              )
            ORDER BY updated_at ASC, user_id ASC, podcast_id ASC
            LIMIT :limit
            """
        ),
        {
            "limit": limit,
            "sync_lease_seconds": sync_lease_seconds,
        },
    ).fetchall()

    enqueued_count = 0
    failed_count = 0
    skipped_count = 0
    failure_code_breakdown: dict[str, int] = {}

    # The poll is a pure scheduler: it claims each due subscription (sync_status ->
    # 'pending') and enqueues one durable per-subscription sync job, then returns. The
    # job's _claim_subscription_sync_pending makes exactly one sync run per claim, so a
    # second poll tick (or a manual refresh) can never double-write transcript state.
    for user_id, podcast_id in rows:
        try:
            with transaction(db):
                queued = db.execute(
                    text(
                        f"""
                        UPDATE podcast_subscriptions
                        SET
                            sync_status = 'pending',
                            sync_error_code = NULL,
                            sync_error_message = NULL,
                            sync_started_at = NULL,
                            sync_completed_at = NULL,
                            updated_at = now()
                        WHERE user_id = :user_id
                          AND podcast_id = :podcast_id
                          AND status = 'active'
                          AND (
                              sync_status <> 'running'
                              OR ({_SYNC_RUNNING_STALE_SQL})
                          )
                        RETURNING 1
                        """
                    ),
                    {
                        "user_id": user_id,
                        "podcast_id": podcast_id,
                        "sync_lease_seconds": sync_lease_seconds,
                    },
                ).fetchone()
                if queued is None:
                    skipped_count += 1
                    continue
                enqueue_podcast_subscription_sync(db, user_id=user_id, podcast_id=podcast_id)
            enqueued_count += 1
        except Exception as exc:  # justify-ignore-error: per-subscription enqueue boundary; one bad sub must not abort the poll batch
            logger.exception(
                "podcast_active_poll_enqueue_failed",
                user_id=str(user_id),
                podcast_id=str(podcast_id),
                error=str(exc),
            )
            failed_count += 1
            fallback_code = _PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE
            failure_code_breakdown[fallback_code] = failure_code_breakdown.get(fallback_code, 0) + 1

    return SubscriptionPollPassResult(
        processed_count=enqueued_count,
        failed_count=failed_count,
        skipped_count=skipped_count,
        scanned_count=len(rows),
        failure_code_breakdown={
            code: failure_code_breakdown[code] for code in sorted(failure_code_breakdown)
        },
    )


def _is_singleton_poll_run_integrity_error(exc: IntegrityError) -> bool:
    orig = getattr(exc, "orig", None)
    sqlstate = (
        getattr(orig, "sqlstate", None)
        or getattr(orig, "pgcode", None)
        or getattr(getattr(orig, "diag", None), "sqlstate", None)
    )
    if sqlstate != "23505":
        return False

    constraint_name = integrity_constraint_name(exc)
    if constraint_name:
        return constraint_name == "uq_podcast_subscription_poll_runs_singleton_running"
    return "uq_podcast_subscription_poll_runs_singleton_running" in str(exc)


def _claim_subscription_poll_run_singleton(
    db: Session,
    *,
    run_id: UUID,
    run_limit: int,
    run_lease_seconds: int,
    scheduler_identity: str | None,
) -> bool:
    try:
        with transaction(db):
            db.execute(
                text(
                    """
                    UPDATE podcast_subscription_poll_runs
                    SET
                        status = 'expired',
                        completed_at = now(),
                        error_code = :error_code,
                        error_message = :error_message,
                        updated_at = now()
                    WHERE status = 'running'
                      AND lease_expires_at <= now()
                    """
                ),
                {
                    "error_code": _PODCAST_ACTIVE_POLL_UNEXPECTED_ERROR_CODE,
                    "error_message": "Polling run lease expired before completion",
                },
            )

            db.execute(
                text(
                    """
                    INSERT INTO podcast_subscription_poll_runs (
                        id,
                        orchestration_source,
                        scheduler_identity,
                        status,
                        run_limit,
                        started_at,
                        lease_expires_at,
                        processed_count,
                        failed_count,
                        skipped_count,
                        scanned_count,
                        created_at,
                        updated_at
                    )
                    VALUES (
                        :id,
                        'scheduled',
                        :scheduler_identity,
                        'running',
                        :run_limit,
                        now(),
                        now() + (CAST(:run_lease_seconds AS integer) * interval '1 second'),
                        0,
                        0,
                        0,
                        0,
                        now(),
                        now()
                    )
                    """
                ),
                {
                    "id": run_id,
                    "scheduler_identity": scheduler_identity,
                    "run_limit": run_limit,
                    "run_lease_seconds": run_lease_seconds,
                },
            )
    except IntegrityError as exc:
        if _is_singleton_poll_run_integrity_error(exc):
            return False
        raise
    return True


def _mark_subscription_poll_run_completed(
    db: Session,
    *,
    run_id: UUID,
    now: datetime,
    poll_result: SubscriptionPollPassResult,
) -> None:
    db.execute(
        text(
            """
            UPDATE podcast_subscription_poll_runs
            SET
                status = 'completed',
                completed_at = :now,
                processed_count = :processed_count,
                failed_count = :failed_count,
                skipped_count = :skipped_count,
                scanned_count = :scanned_count,
                error_code = NULL,
                error_message = NULL,
                updated_at = :now
            WHERE id = :run_id
            """
        ),
        {
            "run_id": run_id,
            "now": now,
            "processed_count": int(poll_result.processed_count),
            "failed_count": int(poll_result.failed_count),
            "skipped_count": int(poll_result.skipped_count),
            "scanned_count": int(poll_result.scanned_count),
        },
    )

    db.execute(
        text(
            """
            DELETE FROM podcast_subscription_poll_run_failures
            WHERE run_id = :run_id
            """
        ),
        {"run_id": run_id},
    )

    for error_code, failure_count in sorted(poll_result.failure_code_breakdown.items()):
        db.execute(
            text(
                """
                INSERT INTO podcast_subscription_poll_run_failures (
                    run_id,
                    error_code,
                    failure_count
                )
                VALUES (
                    :run_id,
                    :error_code,
                    :failure_count
                )
                """
            ),
            {
                "run_id": run_id,
                "error_code": error_code,
                "failure_count": int(failure_count),
            },
        )


def _mark_subscription_poll_run_failed(
    db: Session,
    *,
    run_id: UUID,
    now: datetime,
    error_code: str,
    error_message: str,
) -> None:
    db.execute(
        text(
            """
            UPDATE podcast_subscription_poll_runs
            SET
                status = 'failed',
                completed_at = :now,
                error_code = :error_code,
                error_message = :error_message,
                updated_at = :now
            WHERE id = :run_id
            """
        ),
        {
            "run_id": run_id,
            "now": now,
            "error_code": error_code,
            "error_message": error_message[:1000],
        },
    )


def run_podcast_subscription_sync_now(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
) -> SubscriptionSyncResult:
    settings = get_settings()
    sync_lease_seconds = settings.podcast_sync_running_lease_seconds

    with transaction(db):
        claim = _claim_subscription_sync_pending(
            db,
            user_id=user_id,
            podcast_id=podcast_id,
            sync_lease_seconds=sync_lease_seconds,
        )

    if claim is None:
        snapshot = get_subscription_sync_snapshot(db, user_id, podcast_id)
        return SubscriptionSyncResult(
            sync_status=snapshot.sync_status if snapshot is not None else "skipped",
            reason="not_pending",
            ingested_episode_count=0,
            reused_episode_count=0,
            source_limited=False,
        )

    # The database-authored claim start is the auto-subscription cutoff: episodes
    # already published at claim time are eligible; it is not an idempotency key.
    sync_cutoff_at = claim.sync_started_at

    try:
        window_size = settings.podcast_initial_episode_window
        prefetch_limit = max(window_size, settings.podcast_ingest_prefetch_limit)

        podcast = _get_podcast_sync_metadata(db, podcast_id)
        client = get_podcast_index_client()
        provider_episode_candidates = client.fetch_recent_episodes(
            podcast["provider_podcast_id"], prefetch_limit
        )
        episode_candidates = augment_provider_episodes_with_feed_pagination(
            provider_episode_candidates=provider_episode_candidates,
            feed_url=podcast["feed_url"],
            prefetch_limit=prefetch_limit,
        )
        selected_episodes = sorted(
            episode_candidates,
            key=lambda ep: parse_iso_datetime(ep.get("published_at"))
            or datetime.min.replace(tzinfo=UTC),
            reverse=True,
        )[:window_size]
        selected_episodes = hydrate_selected_episode_chapters_from_feed(
            selected_episodes=selected_episodes,
            feed_url=podcast["feed_url"],
        )
        source_limited = (
            len(provider_episode_candidates) >= PODCAST_INDEX_EPISODE_PAGE_SIZE
            and len(episode_candidates) < prefetch_limit
        )

        logger.info(
            "podcast_sync_episode_selection",
            viewer_id=str(user_id),
            podcast_id=str(podcast_id),
            prefetch_limit=prefetch_limit,
            provider_candidate_count=len(provider_episode_candidates),
            candidate_count=len(episode_candidates),
            window_size=window_size,
            selected_count=len(selected_episodes),
            source_limited=source_limited,
        )

        sync_now = datetime.now(UTC)
        with transaction(db):
            ingest_result = sync_subscription_ingest(
                db=db,
                viewer_id=user_id,
                podcast_id=podcast_id,
                feed_url=podcast["feed_url"],
                selected_episodes=selected_episodes,
                now=sync_now,
            )
            # Immediately before commit, revalidate this worker's exact claim under
            # a subscription row lock retained through commit (spec §5.3). A
            # reclaimed/expired claim rolls back the whole ingest transaction.
            _revalidate_sync_fence_for_ingest(
                db,
                user_id=user_id,
                podcast_id=podcast_id,
                claim=claim,
                sync_lease_seconds=sync_lease_seconds,
            )

        # The ingest transaction is closed; now apply each touched episode's author
        # slice through the facade in a fresh session (spec 2.4, D-16). This gates
        # completion: a failed author op raises, the sync is marked failed below,
        # and the JOB completes without a job-level retry (the failed result is not
        # in failed_result_statuses and a retry could not re-claim a 'failed' sync
        # anyway). Durable convergence (AC 9) is the next periodic poll — it
        # re-marks any non-running sync 'pending' — or a user refresh; both re-run
        # the sync, rebuild observations for reused episodes, and re-apply them,
        # which the resolver's determinism + no-DML-when-unchanged make safe.
        for media_id, observation in ingest_result.author_observations:
            replace_observed_role_slices(
                target=MediaTarget(media_id),
                observation=observation,
                source="rss",
            )

        sync_status: str = "source_limited" if source_limited else "complete"
        # One fresh, top-level serializable step (never inside an open txn): revalidate
        # the fence, lock viewer, ensure eligible auto-subscription episodes, advance
        # the watermark, and complete the exact claim — all one commit (spec §5.3).
        _advance_auto_subscription_after_sync(
            user_id=user_id,
            podcast_id=podcast_id,
            claim=claim,
            sync_cutoff_at=sync_cutoff_at,
            sync_status_on_complete=sync_status,
            sync_lease_seconds=sync_lease_seconds,
            initial_episode_window=window_size,
            now=sync_now,
        )

        return SubscriptionSyncResult(
            sync_status=sync_status,
            ingested_episode_count=ingest_result.ingested_episode_count,
            reused_episode_count=ingest_result.reused_episode_count,
            source_limited=source_limited,
        )
    except StaleSubscriptionSyncClaim:
        # A replacement claim owns the row; write nothing further (spec §5.3).
        logger.info(
            "podcast_sync_stale_claim_skipped",
            user_id=str(user_id),
            podcast_id=str(podcast_id),
            sync_attempts=claim.sync_attempts,
        )
        return SubscriptionSyncResult(
            sync_status="skipped",
            reason="stale_claim",
            ingested_episode_count=0,
            reused_episode_count=0,
            source_limited=False,
        )
    except ApiError as exc:
        error_code = exc.code.value
        error_message = exc.message
    except Exception as exc:  # justify-ignore-error: per-subscription sync boundary; record failure code for ops without aborting upstream poll
        logger.exception(
            "podcast_sync_unexpected_error",
            user_id=str(user_id),
            podcast_id=str(podcast_id),
            error=str(exc),
        )
        error_code = ApiErrorCode.E_INTERNAL.value
        error_message = "Internal podcast sync failure"

    with transaction(db):
        _mark_subscription_sync_failed(
            db,
            user_id=user_id,
            podcast_id=podcast_id,
            now=datetime.now(UTC),
            error_code=error_code,
            error_message=error_message,
            claim=claim,
        )

    return SubscriptionSyncResult(
        sync_status="failed",
        ingested_episode_count=0,
        reused_episode_count=0,
        source_limited=False,
        error_code=error_code,
    )


def refresh_subscription_sync_for_viewer(
    db: Session,
    *,
    viewer_id: UUID,
    podcast_id: UUID,
) -> PodcastSubscriptionSyncRefreshOut:
    settings = get_settings()
    sync_lease_seconds = settings.podcast_sync_running_lease_seconds
    should_enqueue = False

    with transaction(db):
        row = db.execute(
            text(
                f"""
                SELECT
                    status,
                    (
                        sync_status = 'running'
                        AND NOT ({_SYNC_RUNNING_STALE_SQL})
                    ) AS running_and_healthy
                FROM podcast_subscriptions
                WHERE user_id = :user_id AND podcast_id = :podcast_id
                """
            ),
            {
                "user_id": viewer_id,
                "podcast_id": podcast_id,
                "sync_lease_seconds": sync_lease_seconds,
            },
        ).fetchone()
        if row is None or row[0] != "active":
            raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

        if not bool(row[1]):
            updated = db.execute(
                text(
                    f"""
                    UPDATE podcast_subscriptions
                    SET
                        sync_status = 'pending',
                        sync_error_code = NULL,
                        sync_error_message = NULL,
                        sync_started_at = NULL,
                        sync_completed_at = NULL,
                        updated_at = now()
                    WHERE user_id = :user_id
                      AND podcast_id = :podcast_id
                      AND status = 'active'
                      AND (
                          sync_status <> 'running'
                          OR ({_SYNC_RUNNING_STALE_SQL})
                      )
                    RETURNING 1
                    """
                ),
                {
                    "user_id": viewer_id,
                    "podcast_id": podcast_id,
                    "sync_lease_seconds": sync_lease_seconds,
                },
            ).fetchone()
            should_enqueue = updated is not None

    sync_enqueued = False
    if should_enqueue:
        sync_enqueued = enqueue_podcast_subscription_sync(
            db,
            user_id=viewer_id,
            podcast_id=podcast_id,
        )

    snapshot = get_subscription_sync_snapshot(db, viewer_id, podcast_id)
    if snapshot is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast subscription not found")

    return PodcastSubscriptionSyncRefreshOut(
        podcast_id=podcast_id,
        sync_status=snapshot.sync_status,
        sync_error_code=snapshot.sync_error_code,
        sync_error_message=snapshot.sync_error_message,
        sync_attempts=snapshot.sync_attempts,
        sync_enqueued=sync_enqueued,
    )


def enqueue_podcast_subscription_sync(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    request_id: str | None = None,
) -> bool:
    try:
        enqueue_job(
            db,
            kind="podcast_sync_subscription_job",
            payload={
                "user_id": str(user_id),
                "podcast_id": str(podcast_id),
                "request_id": request_id,
            },
        )
        return True
    except SQLAlchemyError as exc:
        logger.error(
            "podcast_sync_enqueue_failed",
            user_id=str(user_id),
            podcast_id=str(podcast_id),
            error=str(exc),
        )
        raise ApiError(ApiErrorCode.E_INTERNAL, "Failed to enqueue podcast sync job.") from exc


def get_subscription_sync_snapshot(
    db: Session,
    user_id: UUID,
    podcast_id: UUID,
) -> SubscriptionSyncSnapshot | None:
    row = db.execute(
        text(
            """
            SELECT auto_queue, sync_status, sync_error_code, sync_error_message, sync_attempts, last_synced_at
            FROM podcast_subscriptions
            WHERE user_id = :user_id AND podcast_id = :podcast_id
            """
        ),
        {"user_id": user_id, "podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        return None
    return SubscriptionSyncSnapshot(
        auto_queue=bool(row[0]),
        sync_status=cast(PodcastSyncStatus, row[1]),
        sync_error_code=row[2],
        sync_error_message=row[3],
        sync_attempts=int(row[4] or 0),
        last_synced_at=row[5],
    )


def _claim_subscription_sync_pending(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    sync_lease_seconds: int,
) -> SubscriptionSyncClaim | None:
    """Claim a due subscription and RETURN its persisted fence (the exact
    attempt/start the worker owns). ``None`` when nothing was claimable."""
    row = db.execute(
        text(
            f"""
            UPDATE podcast_subscriptions
            SET
                sync_status = 'running',
                sync_error_code = NULL,
                sync_error_message = NULL,
                sync_started_at = now(),
                sync_completed_at = NULL,
                sync_attempts = sync_attempts + 1,
                updated_at = now()
            WHERE user_id = :user_id
              AND podcast_id = :podcast_id
              AND status = 'active'
              AND (
                  sync_status = 'pending'
                  OR (
                      sync_status = 'running'
                      AND ({_SYNC_RUNNING_STALE_SQL})
                  )
              )
            RETURNING sync_attempts, sync_started_at
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "sync_lease_seconds": sync_lease_seconds,
        },
    ).fetchone()
    if row is None:
        return None
    return SubscriptionSyncClaim(sync_attempts=int(row[0]), sync_started_at=row[1])


def _mark_subscription_sync_completed(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    now: datetime,
    sync_status: str,
    claim: SubscriptionSyncClaim,
) -> None:
    """Complete the EXACT claim. The attempt/start fence guarantees a reclaimed
    worker never clobbers the replacement claim's state (spec §5.3)."""
    db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET
                sync_status = :sync_status,
                sync_error_code = NULL,
                sync_error_message = NULL,
                sync_completed_at = :now,
                last_synced_at = :now,
                updated_at = :now
            WHERE user_id = :user_id AND podcast_id = :podcast_id
              AND sync_attempts = :sync_attempts
              AND sync_started_at = :sync_started_at
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "sync_status": sync_status,
            "now": now,
            "sync_attempts": claim.sync_attempts,
            "sync_started_at": claim.sync_started_at,
        },
    )


def _mark_subscription_sync_failed(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    now: datetime,
    error_code: str,
    error_message: str,
    claim: SubscriptionSyncClaim,
) -> None:
    """Fail the EXACT claim (attempt/start fenced), never clobbering a replacement."""
    db.execute(
        text(
            """
            UPDATE podcast_subscriptions
            SET
                sync_status = 'failed',
                sync_error_code = :error_code,
                sync_error_message = :error_message,
                sync_completed_at = :now,
                updated_at = :now
            WHERE user_id = :user_id AND podcast_id = :podcast_id
              AND sync_attempts = :sync_attempts
              AND sync_started_at = :sync_started_at
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "error_code": error_code,
            "error_message": error_message[:1000],
            "now": now,
            "sync_attempts": claim.sync_attempts,
            "sync_started_at": claim.sync_started_at,
        },
    )


def _revalidate_sync_fence_for_ingest(
    db: Session,
    *,
    user_id: UUID,
    podcast_id: UUID,
    claim: SubscriptionSyncClaim,
    sync_lease_seconds: int,
) -> None:
    """Lock the subscription row and confirm this worker still owns a healthy claim
    (exact attempt/start + unexpired lease vs clock_timestamp()). The lock is
    retained through the caller's commit; a stale/reclaimed claim raises so the
    whole ingest transaction rolls back (spec §5.3)."""
    row = db.execute(
        text(
            f"""
            SELECT 1
            FROM podcast_subscriptions
            WHERE user_id = :user_id
              AND podcast_id = :podcast_id
              AND status = 'active'
              AND sync_status = 'running'
              AND sync_attempts = :sync_attempts
              AND sync_started_at = :sync_started_at
              AND ({_SYNC_LEASE_VALID_CLOCK_SQL})
            FOR UPDATE
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "sync_attempts": claim.sync_attempts,
            "sync_started_at": claim.sync_started_at,
            "sync_lease_seconds": sync_lease_seconds,
        },
    ).fetchone()
    if row is None:
        raise StaleSubscriptionSyncClaim(
            f"sync claim {user_id}/{podcast_id} attempt {claim.sync_attempts} is stale"
        )


def _advance_auto_subscription_after_sync(
    *,
    user_id: UUID,
    podcast_id: UUID,
    claim: SubscriptionSyncClaim,
    sync_cutoff_at: datetime,
    sync_status_on_complete: str,
    sync_lease_seconds: int,
    initial_episode_window: int,
    now: datetime,
) -> None:
    """Run the fenced watermark step on a fresh serializable transaction (spec §5.3).

    A reclaimed claim (fence invalid at this point) raises
    :class:`StaleSubscriptionSyncClaim` and writes nothing. ``E_MEDIA_DELETING`` /
    ``E_LIMIT`` from the ensure abort the step (no watermark advance) and propagate
    to the caller's failure path."""
    fresh = get_session_factory()()
    try:
        retry_serializable(
            fresh,
            "podcast_auto_subscription_advance",
            partial(
                _advance_auto_subscription_op,
                fresh,
                user_id,
                podcast_id,
                claim,
                sync_cutoff_at,
                sync_status_on_complete,
                sync_lease_seconds,
                initial_episode_window,
                now,
            ),
        )
    finally:
        fresh.close()


def _advance_auto_subscription_op(
    db: Session,
    user_id: UUID,
    podcast_id: UUID,
    claim: SubscriptionSyncClaim,
    sync_cutoff_at: datetime,
    sync_status_on_complete: str,
    sync_lease_seconds: int,
    initial_episode_window: int,
    now: datetime,
) -> None:
    row = db.execute(
        text(
            f"""
            SELECT auto_queue, auto_queue_watermark_at
            FROM podcast_subscriptions
            WHERE user_id = :user_id
              AND podcast_id = :podcast_id
              AND status = 'active'
              AND sync_status = 'running'
              AND sync_attempts = :sync_attempts
              AND sync_started_at = :sync_started_at
              AND ({_SYNC_LEASE_VALID_CLOCK_SQL})
            FOR UPDATE
            """
        ),
        {
            "user_id": user_id,
            "podcast_id": podcast_id,
            "sync_attempts": claim.sync_attempts,
            "sync_started_at": claim.sync_started_at,
            "sync_lease_seconds": sync_lease_seconds,
        },
    ).fetchone()
    if row is None:
        raise StaleSubscriptionSyncClaim(
            f"sync claim {user_id}/{podcast_id} attempt {claim.sync_attempts} is stale"
        )
    auto_queue = bool(row[0])
    watermark: datetime | None = row[1]

    # Lock the viewer row before any Lectern read/write so auto-sync linearizes with
    # manual Lectern commands (invariant 7).
    db.execute(text("SELECT 1 FROM users WHERE id = :user_id FOR UPDATE"), {"user_id": user_id})

    # Disabled auto-queue neither inserts nor advances (watermark preserved so a
    # re-enable resumes its interval); an older/equal cutoff skips ensure/advance.
    if auto_queue and (watermark is None or watermark < sync_cutoff_at):
        eligible = _eligible_auto_subscription_media(
            db,
            podcast_id=podcast_id,
            sync_cutoff_at=sync_cutoff_at,
            watermark=watermark,
            initial_episode_window=initial_episode_window,
        )
        if eligible:
            consumption_service.ensure_missing_items_in_txn(
                db, viewer_id=user_id, media_ids=eligible, source="AutoSubscription"
            )
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET auto_queue_watermark_at =
                        GREATEST(COALESCE(auto_queue_watermark_at, :cutoff), :cutoff)
                WHERE user_id = :user_id
                  AND podcast_id = :podcast_id
                  AND sync_attempts = :sync_attempts
                  AND sync_started_at = :sync_started_at
                """
            ),
            {
                "user_id": user_id,
                "podcast_id": podcast_id,
                "cutoff": sync_cutoff_at,
                "sync_attempts": claim.sync_attempts,
                "sync_started_at": claim.sync_started_at,
            },
        )

    _mark_subscription_sync_completed(
        db,
        user_id=user_id,
        podcast_id=podcast_id,
        now=now,
        sync_status=sync_status_on_complete,
        claim=claim,
    )
    db.commit()


def _eligible_auto_subscription_media(
    db: Session,
    *,
    podcast_id: UUID,
    sync_cutoff_at: datetime,
    watermark: datetime | None,
    initial_episode_window: int,
) -> list[UUID]:
    """Episodes eligible for auto-subscription at this cutoff (published_at bound).

    Null watermark selects the most recent ``initial_episode_window`` episodes at or
    before the cutoff; later runs select ``watermark < published_at <= cutoff``.
    Missing ``published_at`` is ineligible. Ordered oldest-first for insertion."""
    if watermark is None:
        rows = db.execute(
            text(
                """
                SELECT media_id
                FROM podcast_episodes
                WHERE podcast_id = :podcast_id
                  AND published_at IS NOT NULL
                  AND published_at <= :cutoff
                ORDER BY published_at DESC, media_id DESC
                LIMIT :window
                """
            ),
            {
                "podcast_id": podcast_id,
                "cutoff": sync_cutoff_at,
                "window": initial_episode_window,
            },
        ).fetchall()
        return [UUID(str(row[0])) for row in reversed(rows)]

    rows = db.execute(
        text(
            """
            SELECT media_id
            FROM podcast_episodes
            WHERE podcast_id = :podcast_id
              AND published_at IS NOT NULL
              AND published_at > :watermark
              AND published_at <= :cutoff
            ORDER BY published_at ASC, media_id ASC
            """
        ),
        {"podcast_id": podcast_id, "cutoff": sync_cutoff_at, "watermark": watermark},
    ).fetchall()
    return [UUID(str(row[0])) for row in rows]


def _get_podcast_sync_metadata(db: Session, podcast_id: UUID) -> dict[str, Any]:
    row = db.execute(
        text(
            """
            SELECT id, provider_podcast_id, feed_url
            FROM podcasts
            WHERE id = :podcast_id
            """
        ),
        {"podcast_id": podcast_id},
    ).fetchone()
    if row is None:
        raise NotFoundError(ApiErrorCode.E_NOT_FOUND, "Podcast not found")
    return {
        "id": row[0],
        "provider_podcast_id": row[1],
        "feed_url": row[2],
    }
