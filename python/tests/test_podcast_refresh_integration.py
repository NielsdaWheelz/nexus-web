"""Focused database proof for Podcast refresh admission and exact sync fencing."""

from __future__ import annotations

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text

from nexus.api.routes._sse import tail_snapshot_stream
from nexus.db.listen import open_stream_listener
from nexus.errors import ApiError, ApiErrorCode, ConflictError
from nexus.jobs.queue import (
    JobExecutionContext,
    claim_job,
    fail_job,
    get_job,
)
from nexus.schemas.podcast import (
    PodcastRefreshLibraryScope,
    PodcastRefreshPodcastScope,
    PodcastRefreshPodcastsScope,
)
from nexus.services.bootstrap import ensure_user_and_default_library
from nexus.services.collection_revisions import (
    CollectionFamily,
    read_collection_revision,
)
from nexus.services.net.safe_fetch import SafeFetchResult
from nexus.services.podcasts.feed import LiveFeedSnapshot
from nexus.services.podcasts.refresh import (
    PODCAST_REFRESH_NOTIFY_CHANNEL,
    PODCAST_SYNC_INTERACTIVE_PRIORITY,
    admit_due_refresh_runs,
    admit_subscription_generation_in_txn,
    create_manual_refresh_run,
    finish_joined_items_in_txn,
    get_refresh_run_snapshot,
    prune_terminal_refresh_runs,
    skip_subscription_epoch_in_txn,
)
from nexus.services.podcasts.subscriptions import unsubscribe_from_podcast
from nexus.services.podcasts.sync import (
    dead_letter_podcast_subscription_sync,
    run_podcast_subscription_sync_now,
)
from tests.utils.db import DirectSessionManager

pytestmark = pytest.mark.integration


class _ConnectedRequest:
    async def is_disconnected(self) -> bool:
        return False


def _seed_podcast(direct_db: DirectSessionManager) -> UUID:
    podcast_id = uuid4()
    direct_db.register_cleanup("podcasts", "id", podcast_id)
    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO podcasts (
                    id, provider, provider_podcast_id, title, feed_url, created_at, updated_at
                )
                VALUES (
                    :id, 'podcast_index', :provider_id, :title, :feed_url, now(), now()
                )
                """
            ),
            {
                "id": podcast_id,
                "provider_id": f"refresh-test-{podcast_id}",
                "title": f"Refresh test {podcast_id}",
                "feed_url": f"https://feeds.example.com/{podcast_id}.xml",
            },
        )
        db.commit()
    return podcast_id


def _seed_user_podcast(
    direct_db: DirectSessionManager,
    *,
    with_default_library: bool = False,
) -> tuple[UUID, UUID]:
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    with direct_db.session() as db:
        if with_default_library:
            ensure_user_and_default_library(db, user_id)
        else:
            db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
            db.commit()
    podcast_id = _seed_podcast(direct_db)
    return user_id, podcast_id


def _seed_subscription(
    direct_db: DirectSessionManager,
    *,
    user_id: UUID,
    podcast_id: UUID,
    status: str = "Complete",
    generation: int = 0,
    next_sync_at: datetime | None = None,
) -> UUID:
    subscription_id = uuid4()
    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO podcast_subscriptions (
                    id, user_id, podcast_id, auto_queue, sync_status,
                    sync_generation, next_sync_at, consecutive_sync_failures,
                    sync_attempts, created_at, updated_at
                )
                VALUES (
                    :id, :user_id, :podcast_id, false, :status,
                    :generation, :next_sync_at, 0, 0, now(), now()
                )
                """
            ),
            {
                "id": subscription_id,
                "user_id": user_id,
                "podcast_id": podcast_id,
                "status": status,
                "generation": generation,
                "next_sync_at": next_sync_at or datetime.now(UTC) + timedelta(days=2),
            },
        )
        db.commit()
    return subscription_id


def _register_jobs_for_subscription(
    direct_db: DirectSessionManager,
    subscription_id: UUID,
) -> None:
    with direct_db.session() as db:
        job_ids = list(
            db.execute(
                text(
                    """
                    SELECT id
                    FROM background_jobs
                    WHERE payload->>'subscription_id' = :subscription_id
                    """
                ),
                {"subscription_id": str(subscription_id)},
            ).scalars()
        )
    for job_id in job_ids:
        direct_db.register_cleanup("background_jobs", "id", job_id)


def _claim_sync_job(
    db,
    *,
    subscription_id: UUID,
    worker_id: str,
) -> tuple[dict[str, object], JobExecutionContext]:
    row = db.execute(
        text(
            """
            SELECT sync_job_id
            FROM podcast_subscriptions
            WHERE id = :subscription_id
            """
        ),
        {"subscription_id": subscription_id},
    ).one()
    job = claim_job(
        db,
        job_id=UUID(str(row[0])),
        worker_id=worker_id,
        lease_seconds=900,
        allowed_kinds=("podcast_sync_subscription_job",),
    )
    assert job is not None
    db.commit()
    return (
        job.payload,
        JobExecutionContext(
            job_id=job.id,
            worker_id=worker_id,
            attempt_no=job.attempts,
        ),
    )


def test_manual_admission_replays_exactly_and_rejects_scope_mismatch(direct_db):
    user_id, podcast_id = _seed_user_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )

    with direct_db.session() as db:
        first = create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="manual-replay",
        )
        replay = create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="manual-replay",
        )
        assert replay == first
        with pytest.raises(ConflictError) as mismatch:
            create_manual_refresh_run(
                db,
                viewer_id=user_id,
                scope=PodcastRefreshPodcastScope(podcast_id=podcast_id),
                idempotency_key="manual-replay",
            )
        assert mismatch.value.code == ApiErrorCode.E_IDEMPOTENCY_KEY_REPLAY_MISMATCH

        subscription = db.execute(
            text(
                """
                SELECT sync_status, sync_generation, sync_job_id
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        run = db.execute(
            text(
                """
                SELECT status, requested_count, finished_count
                FROM podcast_refresh_runs
                WHERE user_id = :user_id AND idempotency_key = 'manual-replay'
                """
            ),
            {"user_id": user_id},
        ).one()
        item = db.execute(
            text(
                """
                SELECT status, sync_generation
                FROM podcast_refresh_run_items
                WHERE subscription_id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
    assert subscription[0:2] == ("Pending", 1)
    assert subscription[2] is not None
    assert run == ("Running", 1, 0)
    assert item == ("Pending", 1)
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_named_library_scope_admits_exactly_placed_subscriptions(direct_db):
    user_id, first_podcast_id = _seed_user_podcast(
        direct_db,
        with_default_library=True,
    )
    selected_podcast_id = _seed_podcast(direct_db)
    third_podcast_id = _seed_podcast(direct_db)
    subscriptions = {
        first_podcast_id: _seed_subscription(
            direct_db,
            user_id=user_id,
            podcast_id=first_podcast_id,
        ),
        selected_podcast_id: _seed_subscription(
            direct_db,
            user_id=user_id,
            podcast_id=selected_podcast_id,
        ),
        third_podcast_id: _seed_subscription(
            direct_db,
            user_id=user_id,
            podcast_id=third_podcast_id,
        ),
    }
    named_library_id = uuid4()
    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO libraries (id, owner_user_id, name, is_default)
                VALUES (:library_id, :user_id, 'Refresh selection', false)
                """
            ),
            {"library_id": named_library_id, "user_id": user_id},
        )
        db.execute(
            text(
                """
                INSERT INTO memberships (library_id, user_id, role)
                VALUES (:library_id, :user_id, 'admin')
                """
            ),
            {"library_id": named_library_id, "user_id": user_id},
        )
        db.execute(
            text(
                """
                INSERT INTO library_entries (library_id, podcast_id, position)
                VALUES (:library_id, :podcast_id, 0)
                """
            ),
            {
                "library_id": named_library_id,
                "podcast_id": selected_podcast_id,
            },
        )
        db.commit()

        created = create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshLibraryScope(library_id=named_library_id),
            idempotency_key="named-library-scope",
        )
        item_rows = db.execute(
            text(
                """
                SELECT item.podcast_id, item.subscription_id, item.status
                FROM podcast_refresh_run_items item
                JOIN podcast_refresh_runs run ON run.id = item.run_id
                WHERE run.user_id = :user_id
                  AND run.idempotency_key = 'named-library-scope'
                """
            ),
            {"user_id": user_id},
        ).all()
        subscription_rows = db.execute(
            text(
                """
                SELECT podcast_id, sync_status, sync_generation, sync_job_id
                FROM podcast_subscriptions
                WHERE user_id = :user_id
                ORDER BY podcast_id
                """
            ),
            {"user_id": user_id},
        ).all()

    assert created.requested_count == 1
    assert item_rows == [
        (
            selected_podcast_id,
            subscriptions[selected_podcast_id],
            "Pending",
        )
    ]
    by_podcast = {row[0]: row[1:] for row in subscription_rows}
    assert by_podcast[selected_podcast_id][0:2] == ("Pending", 1)
    assert by_podcast[selected_podcast_id][2] is not None
    assert by_podcast[first_podcast_id] == ("Complete", 0, None)
    assert by_podcast[third_podcast_id] == ("Complete", 0, None)
    _register_jobs_for_subscription(
        direct_db,
        subscriptions[selected_podcast_id],
    )


def test_concurrent_manual_admissions_linearize_to_one_active_generation_and_job(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    from nexus.services.podcasts import refresh as refresh_service

    user_id, podcast_id = _seed_user_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    original_lock_subscription = refresh_service._lock_subscription
    first_lock_calls = 0
    first_lock_calls_guard = threading.Lock()
    both_attempts_ready = threading.Barrier(2)

    def synchronized_first_lock(db, *, subscription_id):
        nonlocal first_lock_calls
        with first_lock_calls_guard:
            first_lock_calls += 1
            should_wait = first_lock_calls <= 2
        if should_wait:
            both_attempts_ready.wait(timeout=5)
        return original_lock_subscription(db, subscription_id=subscription_id)

    monkeypatch.setattr(
        refresh_service,
        "_lock_subscription",
        synchronized_first_lock,
    )

    def create(key: str):
        with direct_db.session() as db:
            return create_manual_refresh_run(
                db,
                viewer_id=user_id,
                scope=PodcastRefreshPodcastsScope(),
                idempotency_key=key,
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                create,
                ("concurrent-manual-a", "concurrent-manual-b"),
            )
        )

    with direct_db.session() as db:
        subscription = db.execute(
            text(
                """
                SELECT sync_generation, sync_status, sync_job_id
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        items = db.execute(
            text(
                """
                SELECT sync_generation, status
                FROM podcast_refresh_run_items
                WHERE subscription_id = :subscription_id
                ORDER BY run_id
                """
            ),
            {"subscription_id": subscription_id},
        ).all()
        job_count = db.execute(
            text(
                """
                SELECT count(*)
                FROM background_jobs
                WHERE payload->>'subscription_id' = :subscription_id
                """
            ),
            {"subscription_id": str(subscription_id)},
        ).scalar_one()

    assert [result.status for result in results] == ["Running", "Running"]
    assert subscription[0:2] == (1, "Pending")
    assert subscription[2] is not None
    assert items == [(1, "Pending"), (1, "Pending")]
    assert job_count == 1
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_resubscribe_uses_a_new_epoch_and_cannot_collide_with_retained_job_dedupe(
    direct_db,
):
    user_id, podcast_id = _seed_user_podcast(direct_db)
    old_subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    new_subscription_id = uuid4()

    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="old-epoch-refresh",
        )
        old_job_id = db.execute(
            text(
                """
                SELECT sync_job_id
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": old_subscription_id},
        ).scalar_one()

        skip_subscription_epoch_in_txn(
            db,
            subscription_id=old_subscription_id,
        )
        db.execute(
            text("DELETE FROM podcast_subscriptions WHERE id = :subscription_id"),
            {"subscription_id": old_subscription_id},
        )
        db.execute(
            text(
                """
                INSERT INTO podcast_subscriptions (
                    id, user_id, podcast_id, auto_queue, sync_status,
                    sync_generation, next_sync_at, consecutive_sync_failures,
                    sync_attempts, created_at, updated_at
                )
                VALUES (
                    :id, :user_id, :podcast_id, false, 'Pending',
                    1, now(), 0, 0, now(), now()
                )
                """
            ),
            {
                "id": new_subscription_id,
                "user_id": user_id,
                "podcast_id": podcast_id,
            },
        )
        admission = admit_subscription_generation_in_txn(
            db,
            subscription_id=new_subscription_id,
            user_id=user_id,
            podcast_id=podcast_id,
            priority=PODCAST_SYNC_INTERACTIVE_PRIORITY,
        )
        db.commit()
        dedupe_rows = db.execute(
            text(
                """
                SELECT id, dedupe_key
                FROM background_jobs
                WHERE id = ANY(:job_ids)
                ORDER BY id
                """
            ),
            {"job_ids": [old_job_id, admission.job_id]},
        ).all()

    assert admission.inserted_job is True
    assert admission.job_id != old_job_id
    assert {row[1] for row in dedupe_rows} == {
        f"podcast-sync:{old_subscription_id}:1",
        f"podcast-sync:{new_subscription_id}:1",
    }
    direct_db.register_cleanup("background_jobs", "id", UUID(str(old_job_id)))
    direct_db.register_cleanup("background_jobs", "id", admission.job_id)


def test_admission_rolls_back_run_epoch_job_and_revisions_then_commits_together(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    from nexus.services.podcasts import refresh as refresh_service

    user_id, podcast_id = _seed_user_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    original_enqueue = refresh_service.enqueue_unique_job

    def fail_enqueue(*_args, **_kwargs):
        raise RuntimeError("forced queue insertion failure")

    monkeypatch.setattr(refresh_service, "enqueue_unique_job", fail_enqueue)
    with direct_db.session() as db:
        before_revision = read_collection_revision(
            db,
            viewer_id=user_id,
            family=CollectionFamily.PodcastSubscriptions,
        )
        with pytest.raises(RuntimeError, match="forced queue insertion failure"):
            create_manual_refresh_run(
                db,
                viewer_id=user_id,
                scope=PodcastRefreshPodcastsScope(),
                idempotency_key="atomic-rollback",
            )
        rolled_back = db.execute(
            text(
                """
                SELECT sync_generation, sync_status, sync_job_id
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        run_count = db.execute(
            text(
                """
                SELECT count(*)
                FROM podcast_refresh_runs
                WHERE user_id = :user_id
                  AND idempotency_key = 'atomic-rollback'
                """
            ),
            {"user_id": user_id},
        ).scalar_one()
        after_rollback_revision = read_collection_revision(
            db,
            viewer_id=user_id,
            family=CollectionFamily.PodcastSubscriptions,
        )

    assert rolled_back == (0, "Complete", None)
    assert run_count == 0
    assert after_rollback_revision == before_revision

    monkeypatch.setattr(refresh_service, "enqueue_unique_job", original_enqueue)
    with direct_db.session() as db:
        result = create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="atomic-commit",
        )
        committed = db.execute(
            text(
                """
                SELECT
                    s.sync_generation, s.sync_status, s.sync_job_id,
                    r.status, i.status, j.status
                FROM podcast_subscriptions s
                JOIN podcast_refresh_run_items i ON i.subscription_id = s.id
                JOIN podcast_refresh_runs r ON r.id = i.run_id
                JOIN background_jobs j ON j.id = s.sync_job_id
                WHERE s.id = :subscription_id
                  AND r.idempotency_key = 'atomic-commit'
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        after_commit_revision = read_collection_revision(
            db,
            viewer_id=user_id,
            family=CollectionFamily.PodcastSubscriptions,
        )

    assert result.status == "Running"
    assert committed[0:2] == (1, "Pending")
    assert committed[2] is not None
    assert committed[3:] == ("Running", "Pending", "pending")
    assert after_commit_revision == before_revision + 1
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_empty_manual_scope_is_immediately_complete(direct_db):
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db.commit()
        result = create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="empty-scope",
        )
        row = db.execute(
            text(
                """
                SELECT status, requested_count, finished_count, completed_at
                FROM podcast_refresh_runs
                WHERE user_id = :user_id AND idempotency_key = 'empty-scope'
                """
            ),
            {"user_id": user_id},
        ).one()
    assert result.status == "Complete"
    assert row[0:3] == ("Complete", 0, 0)
    assert row[3] is not None


def test_due_admission_is_bounded_oldest_first_restart_safe_and_skips_ineligible(
    direct_db,
):
    user_id = uuid4()
    direct_db.register_cleanup("users", "id", user_id)
    with direct_db.session() as db:
        db.execute(text("INSERT INTO users (id) VALUES (:id)"), {"id": user_id})
        db.commit()

    now = datetime.now(UTC)
    seeded: list[tuple[UUID, UUID]] = []
    for offset_hours, status in (
        (-5, "Complete"),
        (-4, "Failed"),
        (-3, "SourceLimited"),
        (-2, "Pending"),
        (2, "Complete"),
    ):
        podcast_id = _seed_podcast(direct_db)
        subscription_id = _seed_subscription(
            direct_db,
            user_id=user_id,
            podcast_id=podcast_id,
            status=status,
            generation=1 if status == "Pending" else 0,
            next_sync_at=now + timedelta(hours=offset_hours),
        )
        seeded.append((subscription_id, podcast_id))

    with direct_db.session() as db:
        first = admit_due_refresh_runs(db, limit=2)
        first_selected = {
            UUID(str(row[0]))
            for row in db.execute(
                text(
                    """
                    SELECT subscription_id
                    FROM podcast_refresh_run_items
                    WHERE subscription_id = ANY(:subscription_ids)
                    """
                ),
                {"subscription_ids": [row[0] for row in seeded]},
            )
        }
        second = admit_due_refresh_runs(db, limit=2)
        all_selected = {
            UUID(str(row[0]))
            for row in db.execute(
                text(
                    """
                    SELECT subscription_id
                    FROM podcast_refresh_run_items
                    WHERE subscription_id = ANY(:subscription_ids)
                    """
                ),
                {"subscription_ids": [row[0] for row in seeded]},
            )
        }
        third = admit_due_refresh_runs(db, limit=2)

    assert first == type(first)(subscription_count=2, run_count=1)
    assert first_selected == {seeded[0][0], seeded[1][0]}
    assert second == type(second)(subscription_count=1, run_count=1)
    assert all_selected == {seeded[0][0], seeded[1][0], seeded[2][0]}
    assert third == type(third)(subscription_count=0, run_count=0)
    assert seeded[3][0] not in all_selected
    assert seeded[4][0] not in all_selected
    for subscription_id, _podcast_id in seeded:
        _register_jobs_for_subscription(direct_db, subscription_id)


def test_due_admission_and_manual_join_promote_one_exact_job(direct_db):
    user_id, podcast_id = _seed_user_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
        next_sync_at=datetime.now(UTC) - timedelta(hours=1),
    )
    with direct_db.session() as db:
        due = admit_due_refresh_runs(db, limit=100)
        assert due.subscription_count == 1
        assert due.run_count == 1
        before = db.execute(
            text(
                """
                SELECT s.sync_generation, s.sync_job_id, j.priority
                FROM podcast_subscriptions s
                JOIN background_jobs j ON j.id = s.sync_job_id
                WHERE s.id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        assert before[0] == 1
        assert before[2] == 100

        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="promote-join",
        )
        after = db.execute(
            text(
                """
                SELECT s.sync_generation, s.sync_job_id, j.priority, j.available_at <= now()
                FROM podcast_subscriptions s
                JOIN background_jobs j ON j.id = s.sync_job_id
                WHERE s.id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        job_count = db.execute(
            text(
                """
                SELECT count(*)
                FROM background_jobs
                WHERE payload->>'subscription_id' = :subscription_id
                """
            ),
            {"subscription_id": str(subscription_id)},
        ).scalar_one()
    assert after[0:2] == before[0:2]
    assert after[2:] == (75, True)
    assert job_count == 1
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_manual_join_rejects_terminal_queue_drift(direct_db):
    user_id, podcast_id = _seed_user_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
        next_sync_at=datetime.now(UTC) - timedelta(hours=1),
    )
    with direct_db.session() as db:
        admit_due_refresh_runs(db, limit=100)
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET status = 'succeeded', finished_at = now(), updated_at = now()
                WHERE id = (
                    SELECT sync_job_id
                    FROM podcast_subscriptions
                    WHERE id = :subscription_id
                )
                """
            ),
            {"subscription_id": subscription_id},
        )
        db.commit()
        with pytest.raises(RuntimeError, match="not an active unclaimed operation"):
            create_manual_refresh_run(
                db,
                viewer_id=user_id,
                scope=PodcastRefreshPodcastsScope(),
                idempotency_key="terminal-drift",
            )
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_reclaimed_queue_attempt_rejects_zombie_before_feed_io_or_domain_write(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id, podcast_id = _seed_user_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="zombie-attempt",
        )
        payload, zombie_context = _claim_sync_job(
            db,
            subscription_id=subscription_id,
            worker_id="zombie-worker",
        )
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    sync_status = 'Running',
                    sync_job_attempt_no = :attempt_no,
                    sync_attempts = 1,
                    sync_started_at = now(),
                    updated_at = now()
                WHERE id = :subscription_id
                """
            ),
            {
                "subscription_id": subscription_id,
                "attempt_no": zombie_context.attempt_no,
            },
        )
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET lease_expires_at = now() - interval '1 second', updated_at = now()
                WHERE id = :job_id
                """
            ),
            {"job_id": zombie_context.job_id},
        )
        db.commit()
        replacement = claim_job(
            db,
            job_id=zombie_context.job_id,
            worker_id="replacement-worker",
            lease_seconds=900,
            allowed_kinds=("podcast_sync_subscription_job",),
        )
        assert replacement is not None
        db.commit()
        before_revision = read_collection_revision(
            db,
            viewer_id=user_id,
            family=CollectionFamily.PodcastSubscriptions,
        )

        remote_calls = 0

        def unexpected_remote(*_args, **_kwargs):
            nonlocal remote_calls
            remote_calls += 1
            raise AssertionError("a reclaimed zombie must not perform feed I/O")

        monkeypatch.setattr(
            "nexus.services.podcasts.provider.PodcastIndexClient.fetch_recent_episodes",
            unexpected_remote,
        )
        monkeypatch.setattr("nexus.services.podcasts.feed.safe_get", unexpected_remote)
        result = run_podcast_subscription_sync_now(
            db,
            payload=payload,
            context=zombie_context,
        )
        subscription = db.execute(
            text(
                """
                SELECT sync_status, sync_job_attempt_no, sync_attempts
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        after_revision = read_collection_revision(
            db,
            viewer_id=user_id,
            family=CollectionFamily.PodcastSubscriptions,
        )

    assert replacement.attempts == zombie_context.attempt_no + 1
    assert result.status == "Stale"
    assert result.reason == "StaleEpochGenerationOrAttempt"
    assert remote_calls == 0
    assert subscription == ("Running", zombie_context.attempt_no, 1)
    assert after_revision == before_revision
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_exact_sync_happy_path_terminalizes_subscription_item_and_run(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id, podcast_id = _seed_user_podcast(direct_db, with_default_library=True)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="sync-happy",
        )
        payload, context = _claim_sync_job(
            db,
            subscription_id=subscription_id,
            worker_id="sync-happy-worker",
        )

        monkeypatch.setattr(
            "nexus.services.podcasts.provider.PodcastIndexClient.fetch_recent_episodes",
            lambda *_args, **_kwargs: [],
        )
        feed_xml = b"""<?xml version="1.0"?>
        <rss version="2.0"><channel><title>Fresh</title><item>
          <guid>fresh-episode</guid><title>Fresh episode</title>
          <pubDate>Thu, 30 Jul 2026 10:00:00 GMT</pubDate>
          <enclosure url="https://cdn.example.com/fresh.mp3" />
        </item></channel></rss>"""
        monkeypatch.setattr(
            "nexus.services.podcasts.feed.safe_get",
            lambda url, **_kwargs: SafeFetchResult(
                final_url=url,
                content_type="application/rss+xml",
                content=feed_xml,
                text=feed_xml.decode(),
            ),
        )

        result = run_podcast_subscription_sync_now(
            db,
            payload=payload,
            context=context,
        )
        row = db.execute(
            text(
                """
                SELECT
                    sync_status, sync_completed_at, last_checked_at, next_sync_at,
                    consecutive_sync_failures, sync_job_id, sync_checkpoint_status
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        run_row = db.execute(
            text(
                """
                SELECT r.status, r.finished_count, r.succeeded_count,
                       r.source_limited_count, r.new_episode_count, i.status
                FROM podcast_refresh_runs r
                JOIN podcast_refresh_run_items i ON i.run_id = r.id
                WHERE i.subscription_id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        media_ids = list(
            db.execute(
                text("SELECT media_id FROM podcast_episodes WHERE podcast_id = :podcast_id"),
                {"podcast_id": podcast_id},
            ).scalars()
        )
    assert result.status == "Complete"
    assert result.new_episode_count == 1
    assert row[0] == "Complete"
    assert row[1] == row[2]
    assert timedelta(hours=23) <= row[3] - row[1] <= timedelta(hours=23, minutes=30)
    assert row[4:] == (0, None, None)
    assert run_row == ("Complete", 1, 1, 0, 1, "Complete")

    for media_id in media_ids:
        direct_db.register_cleanup("media", "id", media_id)
        direct_db.register_cleanup("podcast_episodes", "media_id", media_id)
    _register_jobs_for_subscription(direct_db, subscription_id)
    with direct_db.session() as db:
        for job_id in db.execute(
            text(
                """
                SELECT id FROM background_jobs
                WHERE payload->>'media_id' = ANY(:media_ids)
                """
            ),
            {"media_ids": [str(media_id) for media_id in media_ids]},
        ).scalars():
            direct_db.register_cleanup("background_jobs", "id", job_id)


def test_manual_item_joined_after_worker_claim_is_terminalized_by_finalization(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id, podcast_id = _seed_user_podcast(direct_db, with_default_library=True)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="before-worker-claim",
        )
        payload, context = _claim_sync_job(
            db,
            subscription_id=subscription_id,
            worker_id="mid-flight-join-worker",
        )
        monkeypatch.setattr(
            "nexus.services.podcasts.provider.PodcastIndexClient.fetch_recent_episodes",
            lambda *_args, **_kwargs: [],
        )

        join_calls = 0

        def join_during_feed_snapshot(**_kwargs):
            nonlocal join_calls
            join_calls += 1
            with direct_db.session() as joining_db:
                joined = create_manual_refresh_run(
                    joining_db,
                    viewer_id=user_id,
                    scope=PodcastRefreshPodcastsScope(),
                    idempotency_key="after-worker-claim",
                )
                assert joined.status == "Running"
            return LiveFeedSnapshot(episodes=(), source_limited=False)

        monkeypatch.setattr(
            "nexus.services.podcasts.sync.fetch_live_feed_snapshot",
            join_during_feed_snapshot,
        )
        result = run_podcast_subscription_sync_now(
            db,
            payload=payload,
            context=context,
        )
        rows = db.execute(
            text(
                """
                SELECT r.idempotency_key, r.status, r.finished_count, i.status
                FROM podcast_refresh_runs r
                JOIN podcast_refresh_run_items i ON i.run_id = r.id
                WHERE i.subscription_id = :subscription_id
                ORDER BY r.idempotency_key
                """
            ),
            {"subscription_id": subscription_id},
        ).all()

    assert join_calls == 1
    assert result.status == "Complete"
    assert rows == [
        ("after-worker-claim", "Complete", 1, "Complete"),
        ("before-worker-claim", "Complete", 1, "Complete"),
    ]
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_source_limited_completion_is_healthy_and_aggregates_run_as_complete(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id, podcast_id = _seed_user_podcast(direct_db, with_default_library=True)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="source-limited",
        )
        payload, context = _claim_sync_job(
            db,
            subscription_id=subscription_id,
            worker_id="source-limited-worker",
        )
        monkeypatch.setattr(
            "nexus.services.podcasts.provider.PodcastIndexClient.fetch_recent_episodes",
            lambda *_args, **_kwargs: [],
        )
        monkeypatch.setattr(
            "nexus.services.podcasts.sync.fetch_live_feed_snapshot",
            lambda **_kwargs: LiveFeedSnapshot(episodes=(), source_limited=True),
        )
        result = run_podcast_subscription_sync_now(
            db,
            payload=payload,
            context=context,
        )
        row = db.execute(
            text(
                """
                SELECT
                    s.sync_status, s.consecutive_sync_failures,
                    r.status, r.finished_count, r.source_limited_count, i.status
                FROM podcast_subscriptions s
                JOIN podcast_refresh_run_items i ON i.subscription_id = s.id
                JOIN podcast_refresh_runs r ON r.id = i.run_id
                WHERE s.id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()

    assert result.status == "SourceLimited"
    assert result.source_limited is True
    assert row == ("SourceLimited", 0, "Complete", 1, 1, "SourceLimited")
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_modeled_feed_failure_uses_exact_completion_backoff(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id, podcast_id = _seed_user_podcast(direct_db, with_default_library=True)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="sync-failure",
        )
        payload, context = _claim_sync_job(
            db,
            subscription_id=subscription_id,
            worker_id="sync-failure-worker",
        )
        monkeypatch.setattr(
            "nexus.services.podcasts.provider.PodcastIndexClient.fetch_recent_episodes",
            lambda *_args, **_kwargs: [],
        )

        def unavailable(*_args, **_kwargs):
            raise ApiError(ApiErrorCode.E_INGEST_TIMEOUT, "remote timeout")

        monkeypatch.setattr("nexus.services.podcasts.feed.safe_get", unavailable)
        result = run_podcast_subscription_sync_now(
            db,
            payload=payload,
            context=context,
        )
        row = db.execute(
            text(
                """
                SELECT
                    sync_status, sync_error_code, sync_completed_at, last_checked_at,
                    next_sync_at, consecutive_sync_failures
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        run_row = db.execute(
            text(
                """
                SELECT r.status, r.failed_count, i.status, i.error_code
                FROM podcast_refresh_runs r
                JOIN podcast_refresh_run_items i ON i.run_id = r.id
                WHERE i.subscription_id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
    assert result.status == "Failed"
    assert result.error_code == ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE.value
    assert row[0:2] == ("Failed", ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE.value)
    assert row[2] == row[3]
    assert row[4] - row[2] == timedelta(minutes=15)
    assert row[5] == 1
    assert run_row == (
        "Failed",
        1,
        "Failed",
        ApiErrorCode.E_PODCAST_FEED_UNAVAILABLE.value,
    )
    _register_jobs_for_subscription(direct_db, subscription_id)


@pytest.mark.parametrize(
    ("item_results", "expected_run"),
    [
        (
            (("Failed", 0), ("Failed", 0)),
            ("Failed", 2, 0, 2, 0),
        ),
        (
            (("Complete", 3), ("Failed", 0)),
            ("Partial", 2, 1, 1, 3),
        ),
    ],
)
def test_concurrent_item_finalization_serializes_parent_aggregation(
    direct_db,
    item_results,
    expected_run,
):
    user_id, first_podcast_id = _seed_user_podcast(direct_db)
    second_podcast_id = _seed_podcast(direct_db)
    run_id = uuid4()
    subscription_ids = (uuid4(), uuid4())
    direct_db.register_cleanup("podcast_refresh_runs", "id", run_id)
    direct_db.register_cleanup("podcast_refresh_run_items", "run_id", run_id)

    with direct_db.session() as db:
        db.execute(
            text(
                """
                INSERT INTO podcast_refresh_runs (
                    id, user_id, scope, status, requested_count, finished_count,
                    succeeded_count, source_limited_count, failed_count,
                    skipped_count, new_episode_count, started_at, created_at, updated_at
                )
                VALUES (
                    :run_id, :user_id, '{"kind":"Due"}'::jsonb, 'Running',
                    2, 0, 0, 0, 0, 0, 0, now(), now(), now()
                )
                """
            ),
            {"run_id": run_id, "user_id": user_id},
        )
        for podcast_id, subscription_id in zip(
            (first_podcast_id, second_podcast_id),
            subscription_ids,
            strict=True,
        ):
            db.execute(
                text(
                    """
                    INSERT INTO podcast_refresh_run_items (
                        id, run_id, podcast_id, subscription_id, sync_generation,
                        status, new_episode_count, created_at, updated_at
                    )
                    VALUES (
                        :id, :run_id, :podcast_id, :subscription_id, 1,
                        'Running', 0, now(), now()
                    )
                    """
                ),
                {
                    "id": uuid4(),
                    "run_id": run_id,
                    "podcast_id": podcast_id,
                    "subscription_id": subscription_id,
                },
            )
        db.commit()

    workers_ready = threading.Barrier(3)
    worker_pids: list[int] = []
    worker_pids_guard = threading.Lock()

    def finalize(subscription_id, result):
        status, new_episode_count = result
        with direct_db.session() as db:
            backend_pid = int(db.execute(text("SELECT pg_backend_pid()")).scalar_one())
            with worker_pids_guard:
                worker_pids.append(backend_pid)
            workers_ready.wait(timeout=5)
            finish_joined_items_in_txn(
                db,
                subscription_id=subscription_id,
                sync_generation=1,
                status=status,
                new_episode_count=new_episode_count,
                completed_at=datetime.now(UTC),
            )
            db.commit()

    with direct_db.session() as blocker:
        blocker_pid = int(blocker.execute(text("SELECT pg_backend_pid()")).scalar_one())
        blocker.execute(
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
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [
                executor.submit(finalize, subscription_id, result)
                for subscription_id, result in zip(
                    subscription_ids,
                    item_results,
                    strict=True,
                )
            ]
            try:
                workers_ready.wait(timeout=5)
                deadline = time.monotonic() + 5
                blocked = False
                blockers_by_worker: dict[int, list[int]] = {}
                while time.monotonic() < deadline:
                    with direct_db.session() as observer:
                        blockers_by_worker = {
                            worker_pid: list(
                                observer.execute(
                                    text("SELECT pg_blocking_pids(:worker_pid)"),
                                    {"worker_pid": worker_pid},
                                ).scalar_one()
                            )
                            for worker_pid in worker_pids
                        }
                        blocked = (
                            len(worker_pids) == 2
                            and all(blockers_by_worker.values())
                            and any(
                                blocker_pid in blockers for blockers in blockers_by_worker.values()
                            )
                        )
                    if blocked:
                        break
                    time.sleep(0.01)
                assert blocked, blockers_by_worker
            finally:
                blocker.rollback()
            for future in futures:
                future.result(timeout=5)

    with direct_db.session() as db:
        run = db.execute(
            text(
                """
                SELECT
                    status, finished_count, succeeded_count, failed_count,
                    new_episode_count
                FROM podcast_refresh_runs
                WHERE id = :run_id
                """
            ),
            {"run_id": run_id},
        ).one()
        items = (
            db.execute(
                text(
                    """
                SELECT status
                FROM podcast_refresh_run_items
                WHERE run_id = :run_id
                ORDER BY status
                """
                ),
                {"run_id": run_id},
            )
            .scalars()
            .all()
        )

    assert run == expected_run
    assert items == sorted(result[0] for result in item_results)


def test_checkpoint_retry_skips_remote_io_and_does_not_recount(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id, podcast_id = _seed_user_podcast(direct_db, with_default_library=True)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="checkpoint-retry",
        )
        payload, first_context = _claim_sync_job(
            db,
            subscription_id=subscription_id,
            worker_id="checkpoint-worker-1",
        )
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    sync_status = 'Running',
                    sync_job_attempt_no = :attempt_no,
                    sync_attempts = 1,
                    sync_started_at = now(),
                    sync_checkpoint_status = 'Complete',
                    sync_checkpoint_cutoff_at = now(),
                    sync_checkpoint_new_episode_count = 3,
                    sync_checkpoint_completed_at = now()
                WHERE id = :subscription_id
                """
            ),
            {
                "subscription_id": subscription_id,
                "attempt_no": first_context.attempt_no,
            },
        )
        db.execute(
            text(
                """
                UPDATE podcast_refresh_run_items
                SET status = 'Running', started_at = now()
                WHERE subscription_id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        )
        transition = fail_job(
            db,
            job_id=first_context.job_id,
            worker_id=first_context.worker_id,
            error_code="E_TEST_CRASH_AFTER_CHECKPOINT",
            error_message="test crash",
            retry_delays_seconds=(0,),
        )
        assert transition is not None
        db.execute(
            text("UPDATE background_jobs SET available_at = now() WHERE id = :job_id"),
            {"job_id": first_context.job_id},
        )
        db.commit()
        claimed = claim_job(
            db,
            job_id=first_context.job_id,
            worker_id="checkpoint-worker-2",
            lease_seconds=900,
            allowed_kinds=("podcast_sync_subscription_job",),
        )
        assert claimed is not None
        db.commit()

        def unexpected_remote(*_args, **_kwargs):
            raise AssertionError("checkpoint retry must skip remote I/O")

        monkeypatch.setattr(
            "nexus.services.podcasts.provider.PodcastIndexClient.fetch_recent_episodes",
            unexpected_remote,
        )
        monkeypatch.setattr("nexus.services.podcasts.feed.safe_get", unexpected_remote)
        result = run_podcast_subscription_sync_now(
            db,
            payload=payload,
            context=JobExecutionContext(
                job_id=claimed.id,
                worker_id="checkpoint-worker-2",
                attempt_no=claimed.attempts,
            ),
        )
        run_row = db.execute(
            text(
                """
                SELECT r.status, r.new_episode_count, i.new_episode_count
                FROM podcast_refresh_runs r
                JOIN podcast_refresh_run_items i ON i.run_id = r.id
                WHERE i.subscription_id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
    assert result.status == "Complete"
    assert result.new_episode_count == 3
    assert run_row == ("Complete", 3, 3)
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_unsubscribe_skips_all_joined_items_keeps_live_job_and_stale_worker_does_no_io(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    user_id, podcast_id = _seed_user_podcast(direct_db, with_default_library=True)
    sibling_podcast_id = _seed_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    sibling_subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=sibling_podcast_id,
    )

    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastScope(podcast_id=podcast_id),
            idempotency_key="unsubscribe-all-skipped",
        )
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="unsubscribe-mixed",
        )
        target_job = (
            db.execute(
                text(
                    """
                SELECT j.*
                FROM podcast_subscriptions s
                JOIN background_jobs j ON j.id = s.sync_job_id
                WHERE s.id = :subscription_id
                """
                ),
                {"subscription_id": subscription_id},
            )
            .mappings()
            .one()
        )
        finish_joined_items_in_txn(
            db,
            subscription_id=sibling_subscription_id,
            sync_generation=1,
            status="Complete",
            new_episode_count=2,
            completed_at=datetime.now(UTC),
        )
        db.commit()

        result = unsubscribe_from_podcast(
            db,
            user_id,
            podcast_id,
            idempotency_key="unsubscribe-live-sync",
        )
        runs = db.execute(
            text(
                """
                SELECT
                    r.idempotency_key, r.status, r.finished_count,
                    r.succeeded_count, r.skipped_count,
                    array_agg(i.status ORDER BY i.status)
                FROM podcast_refresh_runs r
                JOIN podcast_refresh_run_items i ON i.run_id = r.id
                WHERE r.idempotency_key IN (
                    'unsubscribe-all-skipped',
                    'unsubscribe-mixed'
                )
                GROUP BY r.id, r.idempotency_key
                ORDER BY r.idempotency_key
                """
            )
        ).all()
        retained_job = get_job(db, UUID(str(target_job["id"])))
        assert retained_job is not None
        claimed = claim_job(
            db,
            job_id=retained_job.id,
            worker_id="stale-after-unsubscribe",
            lease_seconds=900,
            allowed_kinds=("podcast_sync_subscription_job",),
        )
        assert claimed is not None
        db.commit()

        remote_calls = 0

        def unexpected_remote(*_args, **_kwargs):
            nonlocal remote_calls
            remote_calls += 1
            raise AssertionError("an unsubscribed epoch must not fetch its feed")

        monkeypatch.setattr(
            "nexus.services.podcasts.provider.PodcastIndexClient.fetch_recent_episodes",
            unexpected_remote,
        )
        monkeypatch.setattr("nexus.services.podcasts.feed.safe_get", unexpected_remote)
        stale = run_podcast_subscription_sync_now(
            db,
            payload=dict(claimed.payload),
            context=JobExecutionContext(
                job_id=claimed.id,
                worker_id="stale-after-unsubscribe",
                attempt_no=claimed.attempts,
            ),
        )
        subscription_exists = db.execute(
            text(
                """
                SELECT EXISTS (
                    SELECT 1 FROM podcast_subscriptions WHERE id = :subscription_id
                )
                """
            ),
            {"subscription_id": subscription_id},
        ).scalar_one()

    assert result.outcome == "Unsubscribed"
    assert runs == [
        (
            "unsubscribe-all-skipped",
            "Complete",
            1,
            0,
            1,
            ["Skipped"],
        ),
        (
            "unsubscribe-mixed",
            "Partial",
            2,
            1,
            1,
            ["Complete", "Skipped"],
        ),
    ]
    assert retained_job.status == "pending"
    assert stale.status == "Stale"
    assert stale.reason == "StaleEpochGenerationOrAttempt"
    assert remote_calls == 0
    assert subscription_exists is False
    _register_jobs_for_subscription(direct_db, subscription_id)
    _register_jobs_for_subscription(direct_db, sibling_subscription_id)


def test_dead_letter_requires_exact_attempt_and_terminalizes_with_same_backoff(direct_db):
    user_id, podcast_id = _seed_user_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="dead-letter",
        )
        _payload, context = _claim_sync_job(
            db,
            subscription_id=subscription_id,
            worker_id="dead-letter-worker",
        )
        db.execute(
            text(
                """
                UPDATE background_jobs
                SET status = 'dead', attempts = max_attempts, error_code = 'E_JOB_LEASE_EXPIRED',
                    last_error = 'lease exhausted', lease_expires_at = NULL,
                    claimed_by = NULL, finished_at = now(), updated_at = now()
                WHERE id = :job_id
                """
            ),
            {"job_id": context.job_id},
        )
        db.execute(
            text(
                """
                UPDATE podcast_subscriptions
                SET
                    sync_status = 'Running',
                    sync_job_attempt_no = (
                        SELECT attempts FROM background_jobs WHERE id = :job_id
                    ),
                    sync_attempts = 1,
                    sync_started_at = now(),
                    updated_at = now()
                WHERE id = :subscription_id
                """
            ),
            {
                "job_id": context.job_id,
                "subscription_id": subscription_id,
            },
        )
        db.execute(
            text(
                """
                UPDATE podcast_refresh_run_items
                SET status = 'Running', started_at = now(), updated_at = now()
                WHERE subscription_id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        )
        db.commit()
        job = get_job(db, context.job_id)
        assert job is not None
        dead_letter_podcast_subscription_sync(
            db,
            replace(job, attempts=job.attempts + 1),
        )
        unchanged = db.execute(
            text(
                """
                SELECT sync_status, sync_job_id
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        assert unchanged == ("Running", context.job_id)

        dead_letter_podcast_subscription_sync(db, job)
        db.commit()
        row = db.execute(
            text(
                """
                SELECT sync_status, sync_error_code, sync_completed_at, next_sync_at
                FROM podcast_subscriptions
                WHERE id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
        run_row = db.execute(
            text(
                """
                SELECT r.status, i.status, i.error_code
                FROM podcast_refresh_runs r
                JOIN podcast_refresh_run_items i ON i.run_id = r.id
                WHERE i.subscription_id = :subscription_id
                """
            ),
            {"subscription_id": subscription_id},
        ).one()
    assert row[0:2] == ("Failed", ApiErrorCode.E_PODCAST_SYNC_RETRY_EXHAUSTED.value)
    assert row[3] - row[2] == timedelta(minutes=15)
    assert run_row == (
        "Failed",
        "Failed",
        ApiErrorCode.E_PODCAST_SYNC_RETRY_EXHAUSTED.value,
    )
    _register_jobs_for_subscription(direct_db, subscription_id)


@pytest.mark.asyncio
async def test_refresh_trigger_drives_initial_terminal_and_reconnect_snapshots_with_cleanup(
    direct_db,
):
    from nexus.db.listen import _listen_manager

    user_id, podcast_id = _seed_user_podcast(direct_db)
    subscription_id = _seed_subscription(
        direct_db,
        user_id=user_id,
        podcast_id=podcast_id,
    )
    with direct_db.session() as db:
        create_manual_refresh_run(
            db,
            viewer_id=user_id,
            scope=PodcastRefreshPodcastsScope(),
            idempotency_key="real-listener",
        )
        run_id = UUID(
            str(
                db.execute(
                    text(
                        """
                        SELECT id
                        FROM podcast_refresh_runs
                        WHERE user_id = :user_id
                          AND idempotency_key = 'real-listener'
                        """
                    ),
                    {"user_id": user_id},
                ).scalar_one()
            )
        )

    def read_snapshot() -> tuple[dict[str, object], bool]:
        with direct_db.session() as snapshot_db:
            snapshot = get_refresh_run_snapshot(
                snapshot_db,
                viewer_id=user_id,
                run_id=run_id,
            )
            return (
                snapshot.model_dump(mode="json", by_alias=True),
                snapshot.status != "Running",
            )

    active_before = _listen_manager.stats.active
    listener = await open_stream_listener(
        PODCAST_REFRESH_NOTIFY_CHANNEL,
        str(run_id),
        idle_timeout_seconds=30,
    )
    stream = tail_snapshot_stream(
        request=_ConnectedRequest(),
        listener=listener,
        read_snapshot=read_snapshot,
    )
    initial = await asyncio.wait_for(anext(stream), timeout=2)
    assert '"status":"Running"' in initial

    with direct_db.session() as db:
        finish_joined_items_in_txn(
            db,
            subscription_id=subscription_id,
            sync_generation=1,
            status="Complete",
            new_episode_count=4,
            completed_at=datetime.now(UTC),
        )
        db.commit()

    terminal_state = await asyncio.wait_for(anext(stream), timeout=2)
    done = await asyncio.wait_for(anext(stream), timeout=2)
    with pytest.raises(StopAsyncIteration):
        await anext(stream)
    assert '"status":"Complete"' in terminal_state
    assert '"newEpisodeCount":4' in terminal_state
    assert done.startswith("event: done")
    assert _listen_manager.stats.active == active_before

    reconnect_listener = await open_stream_listener(
        PODCAST_REFRESH_NOTIFY_CHANNEL,
        str(run_id),
        idle_timeout_seconds=30,
    )
    reconnect_chunks = [
        chunk
        async for chunk in tail_snapshot_stream(
            request=_ConnectedRequest(),
            listener=reconnect_listener,
            read_snapshot=read_snapshot,
        )
    ]
    assert len(reconnect_chunks) == 2
    assert reconnect_chunks[0] == terminal_state
    assert reconnect_chunks[1].startswith("event: done")
    assert _listen_manager.stats.active == active_before
    _register_jobs_for_subscription(direct_db, subscription_id)


def test_prune_deletes_terminal_runs_child_first_in_a_bounded_batch(
    direct_db,
    monkeypatch: pytest.MonkeyPatch,
):
    from nexus.services.podcasts import refresh as refresh_service

    monkeypatch.setattr(refresh_service, "PODCAST_REFRESH_RUN_PRUNE_LIMIT", 1)
    user_id, podcast_id = _seed_user_podcast(direct_db)
    old_run_id = uuid4()
    second_old_run_id = uuid4()
    recent_run_id = uuid4()
    old_item_id = uuid4()
    with direct_db.session() as db:
        for run_id, completed_at in (
            (old_run_id, datetime.now(UTC) - timedelta(days=32)),
            (second_old_run_id, datetime.now(UTC) - timedelta(days=31)),
            (recent_run_id, datetime.now(UTC) - timedelta(days=29)),
        ):
            db.execute(
                text(
                    """
                    INSERT INTO podcast_refresh_runs (
                        id, user_id, scope, status, requested_count, finished_count,
                        succeeded_count, source_limited_count, failed_count,
                        skipped_count, new_episode_count, started_at, completed_at,
                        created_at, updated_at
                    )
                    VALUES (
                        :id, :user_id, '{"kind":"Due"}'::jsonb, 'Complete',
                        :requested_count, :requested_count, :requested_count, 0, 0, 0, 0,
                        :completed_at, :completed_at, :completed_at, :completed_at
                    )
                    """
                ),
                {
                    "id": run_id,
                    "user_id": user_id,
                    "completed_at": completed_at,
                    "requested_count": 1 if run_id == old_run_id else 0,
                },
            )
        db.execute(
            text(
                """
                INSERT INTO podcast_refresh_run_items (
                    id, run_id, podcast_id, subscription_id, sync_generation,
                    status, new_episode_count, started_at, completed_at,
                    created_at, updated_at
                )
                VALUES (
                    :id, :run_id, :podcast_id, :subscription_id, 1,
                    'Complete', 0, now() - interval '31 days',
                    now() - interval '31 days', now() - interval '31 days',
                    now() - interval '31 days'
                )
                """
            ),
            {
                "id": old_item_id,
                "run_id": old_run_id,
                "podcast_id": podcast_id,
                "subscription_id": uuid4(),
            },
        )
        db.commit()
        assert prune_terminal_refresh_runs(db) == 1
        remaining = set(
            db.execute(
                text("SELECT id FROM podcast_refresh_runs WHERE user_id = :user_id"),
                {"user_id": user_id},
            ).scalars()
        )
        old_item_exists = db.execute(
            text(
                """
                SELECT EXISTS (
                    SELECT 1 FROM podcast_refresh_run_items WHERE id = :item_id
                )
                """
            ),
            {"item_id": old_item_id},
        ).scalar_one()
    assert remaining == {second_old_run_id, recent_run_id}
    assert old_item_exists is False
