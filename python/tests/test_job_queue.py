"""Integration tests for Postgres-backed background job queue semantics."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import (
    claim_next_job,
    complete_job,
    dead_letter_expired_job,
    enqueue_job,
    enqueue_unique_job,
    fail_job,
    heartbeat_job,
    prune_terminal_jobs,
)
from tests.utils.db import DirectSessionManager, task_session_factory

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _isolate_background_jobs(db_session: Session):
    """Keep queue tests deterministic regardless of suite order."""
    db_session.execute(text("DELETE FROM background_jobs"))
    db_session.commit()
    yield
    db_session.execute(text("DELETE FROM background_jobs"))
    db_session.commit()


def _job_status(db: Session, job_id: UUID) -> str:
    status = db.execute(
        text("SELECT status FROM background_jobs WHERE id = :job_id"),
        {"job_id": job_id},
    ).scalar_one()
    return str(status)


def test_enqueue_unique_job_returns_existing_row_for_duplicate_dedupe_key(db_session: Session):
    first, first_inserted = enqueue_unique_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m1"},
        dedupe_key="dup:ingest_pdf:m1",
        max_attempts=3,
    )
    second, second_inserted = enqueue_unique_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m1"},
        dedupe_key="dup:ingest_pdf:m1",
        max_attempts=3,
    )
    db_session.commit()

    assert first_inserted is True
    assert second_inserted is False
    assert second.id == first.id, (
        "Expected enqueue_unique_job to return existing row when dedupe_key collides. "
        f"First job id={first.id}, second job id={second.id}"
    )
    row_count = db_session.execute(
        text("SELECT COUNT(*) FROM background_jobs WHERE dedupe_key = :dedupe_key"),
        {"dedupe_key": "dup:ingest_pdf:m1"},
    ).scalar_one()
    assert row_count == 1, (
        "Expected exactly one row for duplicate dedupe_key insertion. "
        f"Found {row_count} rows for dedupe_key dup:ingest_pdf:m1."
    )


def test_enqueue_unique_job_returns_existing_row_for_concurrent_dedupe_race(
    direct_db: DirectSessionManager,
):
    dedupe_key = "dup:test_concurrent_unique_job:m1"
    direct_db.register_cleanup("background_jobs", "dedupe_key", dedupe_key)

    with direct_db.session() as db:
        db.execute(
            text("DELETE FROM background_jobs WHERE dedupe_key = :dedupe_key"),
            {"dedupe_key": dedupe_key},
        )
        db.commit()

    with direct_db.session() as winner:
        first, first_inserted = enqueue_unique_job(
            winner,
            kind="test_concurrent_unique_job",
            payload={"media_id": "m1", "winner": True},
            dedupe_key=dedupe_key,
            max_attempts=1,
        )
        assert first_inserted is True

        def race_loser() -> tuple[UUID, bool]:
            with direct_db.session() as db:
                row, inserted = enqueue_unique_job(
                    db,
                    kind="test_concurrent_unique_job",
                    payload={"media_id": "m1", "winner": False},
                    dedupe_key=dedupe_key,
                    max_attempts=1,
                )
                db.commit()
                return row.id, inserted

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(race_loser)
            time.sleep(0.2)
            winner.commit()
            second_id, second_inserted = future.result(timeout=5)

    assert second_inserted is False
    assert second_id == first.id, (
        "Expected concurrent deduped enqueue to return the committed winner row. "
        f"winner={first.id}, loser={second_id}"
    )

    with direct_db.session() as db:
        row_count = db.execute(
            text("SELECT COUNT(*) FROM background_jobs WHERE dedupe_key = :dedupe_key"),
            {"dedupe_key": dedupe_key},
        ).scalar_one()

    assert row_count == 1, (
        f"Expected concurrent deduped enqueue to leave exactly one row. row_count={row_count}"
    )


def test_claim_next_job_orders_by_priority_then_available_time(db_session: Session):
    high_priority = enqueue_job(
        db_session,
        kind="job_high_priority",
        payload={},
        priority=10,
        max_attempts=1,
    )
    same_priority_early = enqueue_job(
        db_session,
        kind="job_same_priority_early",
        payload={},
        priority=20,
        max_attempts=1,
    )
    same_priority_late = enqueue_job(
        db_session,
        kind="job_same_priority_late",
        payload={},
        priority=20,
        available_at=db_session.execute(text("SELECT now() + interval '120 seconds'")).scalar_one(),
        max_attempts=1,
    )
    db_session.commit()

    first_claim = claim_next_job(db_session, worker_id="worker-a", lease_seconds=300)
    assert first_claim is not None, "Expected first claim to return a due job, got None."
    assert first_claim.id == high_priority.id, (
        "Expected lowest priority value to claim first. "
        f"Expected {high_priority.id}, got {first_claim.id}."
    )

    second_claim = claim_next_job(db_session, worker_id="worker-a", lease_seconds=300)
    assert second_claim is not None, "Expected second claim to return remaining due job, got None."
    assert second_claim.id == same_priority_early.id, (
        "Expected earlier available_at to win within equal priority. "
        f"Expected {same_priority_early.id}, got {second_claim.id}."
    )

    not_due_claim = claim_next_job(db_session, worker_id="worker-a", lease_seconds=300)
    assert not_due_claim is None, (
        "Expected no claim while only future-available jobs remain. "
        f"Got job id={getattr(not_due_claim, 'id', None)}."
    )

    db_session.execute(
        text(
            "UPDATE background_jobs SET available_at = now() - interval '1 second' WHERE id = :job_id"
        ),
        {"job_id": same_priority_late.id},
    )
    db_session.commit()

    third_claim = claim_next_job(db_session, worker_id="worker-a", lease_seconds=300)
    assert third_claim is not None, "Expected third claim to return now-due job, got None."
    assert third_claim.id == same_priority_late.id, (
        "Expected the deferred job to become claimable after available_at passed. "
        f"Expected {same_priority_late.id}, got {third_claim.id}."
    )


def test_claim_next_job_reclaims_stale_running_lease(db_session: Session):
    stale = enqueue_job(
        db_session,
        kind="ingest_epub",
        payload={"media_id": "m-stale"},
        max_attempts=3,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'running',
                attempts = 1,
                claimed_by = 'dead-worker',
                lease_expires_at = now() - interval '5 minutes'
            WHERE id = :job_id
            """
        ),
        {"job_id": stale.id},
    )
    db_session.commit()

    reclaimed = claim_next_job(db_session, worker_id="worker-b", lease_seconds=120)
    assert reclaimed is not None, "Expected stale running job to be reclaimed, got None."
    assert reclaimed.id == stale.id, (
        "Expected reclaimed job id to match stale running row. "
        f"Expected {stale.id}, got {reclaimed.id}."
    )
    assert reclaimed.attempts == 2, (
        "Expected reclaim to increment attempts count. "
        f"Expected attempts=2, got {reclaimed.attempts}."
    )
    assert reclaimed.claimed_by == "worker-b", (
        f"Expected claim ownership to move to reclaiming worker. claimed_by={reclaimed.claimed_by}"
    )


def test_dead_letter_expired_job_marks_stale_running_job_at_max_attempts(
    db_session: Session,
):
    job = enqueue_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m-dead-stale"},
        max_attempts=1,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'running',
                attempts = 1,
                claimed_by = 'dead-worker',
                lease_expires_at = now() - interval '1 minute'
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    db_session.commit()

    dead = dead_letter_expired_job(db_session)
    db_session.commit()

    assert dead is not None, "Expected max-attempt stale running job to dead-letter."
    assert dead.id == job.id
    row = db_session.execute(
        text(
            """
            SELECT status, claimed_by, lease_expires_at, finished_at, error_code
            FROM background_jobs
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    ).fetchone()
    assert row is not None
    assert row[0] == "dead"
    assert row[1] is None
    assert row[2] is None
    assert row[3] is not None
    assert row[4] == "E_JOB_LEASE_EXPIRED"


def test_dead_letter_expired_job_marks_one_stale_max_attempt_job_per_call(
    db_session: Session,
):
    first = enqueue_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m-dead-stale-a"},
        max_attempts=1,
    )
    second = enqueue_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m-dead-stale-b"},
        max_attempts=1,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'running',
                attempts = 1,
                claimed_by = 'dead-worker',
                lease_expires_at = now() - interval '1 minute'
            WHERE id IN (:first_id, :second_id)
            """
        ),
        {"first_id": first.id, "second_id": second.id},
    )
    db_session.commit()

    dead = dead_letter_expired_job(db_session)
    db_session.commit()

    assert dead is not None, "Expected one max-attempt stale running job to dead-letter."
    statuses = dict(
        db_session.execute(
            text("SELECT id, status FROM background_jobs WHERE id IN (:first_id, :second_id)"),
            {"first_id": first.id, "second_id": second.id},
        ).fetchall()
    )
    assert sorted(statuses.values()) == ["dead", "running"], (
        f"Expected stale reconciliation to be bounded to one row. Statuses={statuses}"
    )


def test_dead_letter_expired_job_marks_only_allowed_stale_max_attempt_job(
    db_session: Session,
):
    blocked = enqueue_job(
        db_session,
        kind="maintenance_job",
        payload={"media_id": "blocked"},
        max_attempts=1,
    )
    allowed = enqueue_job(
        db_session,
        kind="user_job",
        payload={"media_id": "allowed"},
        max_attempts=1,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'running',
                attempts = 1,
                claimed_by = 'dead-worker',
                lease_expires_at = now() - interval '1 minute'
            WHERE id IN (:blocked_id, :allowed_id)
            """
        ),
        {"blocked_id": blocked.id, "allowed_id": allowed.id},
    )
    db_session.commit()

    dead = dead_letter_expired_job(
        db_session,
        allowed_kinds=["user_job"],
    )
    db_session.commit()

    assert dead is not None
    assert dead.id == allowed.id
    statuses = dict(
        db_session.execute(
            text("SELECT id, status FROM background_jobs WHERE id IN (:blocked_id, :allowed_id)"),
            {"blocked_id": blocked.id, "allowed_id": allowed.id},
        ).fetchall()
    )
    assert statuses[allowed.id] == "dead"
    assert statuses[blocked.id] == "running"


def test_claim_next_job_reclaims_lease_at_exact_expiry_boundary(db_session: Session):
    job = enqueue_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m-boundary"},
        max_attempts=3,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET
                status = 'running',
                attempts = 1,
                claimed_by = 'expired-worker',
                lease_expires_at = now()
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )

    reclaimed = claim_next_job(db_session, worker_id="worker-boundary", lease_seconds=120)
    assert reclaimed is not None, (
        "Expected lease to expire when lease_expires_at <= database now()."
    )
    assert reclaimed.id == job.id, (
        "Expected exact-boundary expired lease to be reclaimable. "
        f"Expected {job.id}, got {reclaimed.id}."
    )


def test_claim_next_job_respects_allowed_kinds(db_session: Session):
    blocked = enqueue_job(
        db_session,
        kind="maintenance_job",
        payload={},
        priority=1,
        max_attempts=1,
    )
    allowed = enqueue_job(
        db_session,
        kind="user_job",
        payload={},
        priority=10,
        max_attempts=1,
    )
    db_session.commit()

    claimed = claim_next_job(
        db_session,
        worker_id="worker-allowed-kinds",
        lease_seconds=120,
        allowed_kinds=["user_job"],
    )
    assert claimed is not None, "Expected allowed kind filter to claim user_job."
    assert claimed.id == allowed.id, (
        "Expected allowed kind filter to skip higher-priority disallowed job. "
        f"Blocked id={blocked.id}, claimed id={claimed.id}."
    )


def test_claim_next_job_empty_allowed_kinds_claims_nothing(db_session: Session):
    enqueue_job(
        db_session,
        kind="user_job",
        payload={},
        max_attempts=1,
    )
    db_session.commit()

    claimed = claim_next_job(
        db_session,
        worker_id="worker-empty-allowed-kinds",
        lease_seconds=120,
        allowed_kinds=[],
    )
    assert claimed is None, (
        "Expected empty allowed_kinds to disable claiming instead of falling back to all kinds."
    )


def test_worker_owner_transitions_reject_expired_lease(db_session: Session):
    job = enqueue_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m-expired-owner"},
        max_attempts=3,
    )
    db_session.commit()

    claimed = claim_next_job(db_session, worker_id="worker-a", lease_seconds=60)
    assert claimed is not None, "Expected initial claim to succeed."
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET lease_expires_at = now() - interval '1 second'
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    db_session.commit()

    assert heartbeat_job(db_session, job_id=job.id, worker_id="worker-a", lease_seconds=60) is False
    assert (
        complete_job(db_session, job_id=job.id, worker_id="worker-a", result_payload={"ok": True})
        is False
    )
    assert (
        fail_job(
            db_session,
            job_id=job.id,
            worker_id="worker-a",
            error_code="E_EXPIRED",
            error_message="expired owner",
            retry_delays_seconds=(0,),
        )
        is None
    )
    db_session.commit()

    row = db_session.execute(
        text(
            """
            SELECT status, claimed_by, result, error_code
            FROM background_jobs
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    ).fetchone()
    assert row is not None
    assert row[0] == "running"
    assert row[1] == "worker-a"
    assert row[2] is None
    assert row[3] is None


def test_prune_terminal_jobs_deletes_only_old_terminal_rows(db_session: Session):
    now = datetime.now(UTC)
    old_succeeded = enqueue_job(db_session, kind="old_succeeded", payload={}, max_attempts=1)
    old_succeeded_limited = enqueue_job(
        db_session, kind="old_succeeded_limited", payload={}, max_attempts=1
    )
    recent_succeeded = enqueue_job(db_session, kind="recent_succeeded", payload={}, max_attempts=1)
    old_dead = enqueue_job(db_session, kind="old_dead", payload={}, max_attempts=1)
    failed_retry = enqueue_job(db_session, kind="failed_retry", payload={}, max_attempts=2)
    pending = enqueue_job(db_session, kind="pending", payload={}, max_attempts=1)
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'succeeded', finished_at = :old_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": old_succeeded.id, "old_finished_at": now - timedelta(days=10)},
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'succeeded', finished_at = :old_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": old_succeeded_limited.id, "old_finished_at": now - timedelta(days=9)},
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'succeeded', finished_at = :recent_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": recent_succeeded.id, "recent_finished_at": now - timedelta(days=1)},
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'dead', finished_at = :old_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": old_dead.id, "old_finished_at": now - timedelta(days=40)},
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'failed', finished_at = :old_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": failed_retry.id, "old_finished_at": now - timedelta(days=40)},
    )
    db_session.commit()

    deleted = prune_terminal_jobs(
        db_session,
        succeeded_after_days=7,
        dead_after_days=30,
        limit=2,
    )
    db_session.commit()

    assert deleted == 2, f"Expected prune to respect limit=2, deleted={deleted}."
    remaining_ids = {
        UUID(str(row[0]))
        for row in db_session.execute(text("SELECT id FROM background_jobs")).fetchall()
    }
    assert old_succeeded.id not in remaining_ids
    assert old_dead.id not in remaining_ids
    assert old_succeeded_limited.id in remaining_ids
    assert recent_succeeded.id in remaining_ids
    assert failed_retry.id in remaining_ids
    assert pending.id in remaining_ids


def test_prune_background_jobs_task_forwards_settings_and_commits(
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
):
    from nexus.tasks.prune_background_jobs import prune_background_jobs_job

    now = datetime.now(UTC)
    default_only_succeeded = enqueue_job(
        db_session,
        kind="task_default_only_succeeded",
        payload={},
        max_attempts=1,
    )
    default_only_dead = enqueue_job(
        db_session,
        kind="task_default_only_dead",
        payload={},
        max_attempts=1,
    )
    custom_old_succeeded = enqueue_job(
        db_session,
        kind="task_custom_old_succeeded",
        payload={},
        max_attempts=1,
    )
    custom_old_dead = enqueue_job(
        db_session,
        kind="task_custom_old_dead",
        payload={},
        max_attempts=1,
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'succeeded', finished_at = :old_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": default_only_succeeded.id, "old_finished_at": now - timedelta(days=8)},
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'dead', finished_at = :old_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": default_only_dead.id, "old_finished_at": now - timedelta(days=31)},
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'succeeded', finished_at = :old_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": custom_old_succeeded.id, "old_finished_at": now - timedelta(days=20)},
    )
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET status = 'dead', finished_at = :old_finished_at
            WHERE id = :job_id
            """
        ),
        {"job_id": custom_old_dead.id, "old_finished_at": now - timedelta(days=70)},
    )
    db_session.commit()
    monkeypatch.setattr(
        "nexus.tasks.prune_background_jobs.get_session_factory",
        lambda: task_session_factory(db_session),
    )
    monkeypatch.setattr(
        "nexus.tasks.prune_background_jobs.get_settings",
        lambda: SimpleNamespace(
            background_job_prune_succeeded_after_days=14,
            background_job_prune_dead_after_days=60,
            background_job_prune_batch_size=1,
        ),
    )

    result = prune_background_jobs_job(request_id="req-prune-task")

    assert result == {"deleted_count": 1}
    remaining_ids = {
        UUID(str(row[0]))
        for row in db_session.execute(text("SELECT id FROM background_jobs")).fetchall()
    }
    assert default_only_succeeded.id in remaining_ids
    assert default_only_dead.id in remaining_ids
    assert custom_old_succeeded.id in remaining_ids
    assert custom_old_dead.id not in remaining_ids


def test_fail_job_parks_retry_then_transitions_to_dead(db_session: Session):
    enqueue_job(
        db_session,
        kind="podcast_transcribe_episode_job",
        payload={"media_id": "m-retry"},
        max_attempts=2,
    )
    db_session.commit()

    first_claim = claim_next_job(db_session, worker_id="worker-c", lease_seconds=120)
    assert first_claim is not None, "Expected first claim to return pending job, got None."
    fail_job(
        db_session,
        job_id=first_claim.id,
        worker_id="worker-c",
        error_code="E_TRANSIENT",
        error_message="first failure",
        retry_delays_seconds=(0,),
    )
    db_session.commit()
    assert _job_status(db_session, first_claim.id) == "failed", (
        "Expected first failure below max_attempts to park as failed for retry."
    )

    second_claim = claim_next_job(db_session, worker_id="worker-c", lease_seconds=120)
    assert second_claim is not None, "Expected parked retry job to be claimable again, got None."
    fail_job(
        db_session,
        job_id=second_claim.id,
        worker_id="worker-c",
        error_code="E_TRANSIENT",
        error_message="second failure",
        retry_delays_seconds=(0,),
    )
    db_session.commit()
    assert _job_status(db_session, second_claim.id) == "dead", (
        "Expected failure at max_attempts to transition to dead."
    )


def test_complete_job_rejects_stale_worker_after_reclaim(db_session: Session):
    job = enqueue_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m-reclaim-complete"},
        max_attempts=3,
    )
    db_session.commit()

    first_claim = claim_next_job(db_session, worker_id="worker-a", lease_seconds=60)
    assert first_claim is not None, "Expected initial claim to succeed, got None."
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET lease_expires_at = now() - interval '5 minutes'
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    db_session.commit()

    reclaimed = claim_next_job(db_session, worker_id="worker-b", lease_seconds=60)
    assert reclaimed is not None, "Expected stale running row to be reclaimed, got None."
    assert reclaimed.claimed_by == "worker-b", (
        f"Expected reclaimed ownership to transfer to worker-b. claimed_by={reclaimed.claimed_by}"
    )

    stale_complete = complete_job(
        db_session,
        job_id=job.id,
        worker_id="worker-a",
        result_payload={"ok": False},
    )
    db_session.commit()
    assert stale_complete is False, (
        "Expected stale worker terminal update to be rejected after reclaim."
    )
    assert _job_status(db_session, job.id) == "running", (
        "Expected row to remain running for active owner after stale complete attempt."
    )

    owner_complete = complete_job(
        db_session,
        job_id=job.id,
        worker_id="worker-b",
        result_payload={"ok": True},
    )
    db_session.commit()
    assert owner_complete is True, "Expected active owner complete to succeed."
    assert _job_status(db_session, job.id) == "succeeded", (
        "Expected active owner to move running row to succeeded."
    )


def test_fail_job_rejects_stale_worker_after_reclaim(db_session: Session):
    job = enqueue_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m-reclaim-fail"},
        max_attempts=3,
    )
    db_session.commit()

    first_claim = claim_next_job(db_session, worker_id="worker-a", lease_seconds=60)
    assert first_claim is not None, "Expected initial claim to succeed, got None."
    db_session.execute(
        text(
            """
            UPDATE background_jobs
            SET lease_expires_at = now() - interval '5 minutes'
            WHERE id = :job_id
            """
        ),
        {"job_id": job.id},
    )
    db_session.commit()

    reclaimed = claim_next_job(db_session, worker_id="worker-b", lease_seconds=60)
    assert reclaimed is not None, "Expected stale running row to be reclaimed, got None."
    assert reclaimed.claimed_by == "worker-b", (
        f"Expected reclaimed ownership to transfer to worker-b. claimed_by={reclaimed.claimed_by}"
    )

    stale_fail = fail_job(
        db_session,
        job_id=job.id,
        worker_id="worker-a",
        error_code="E_STALE_WORKER",
        error_message="stale worker should not transition row",
        retry_delays_seconds=(0,),
    )
    db_session.commit()
    assert stale_fail is None, (
        "Expected stale worker failure transition to be rejected after reclaim."
    )
    assert _job_status(db_session, job.id) == "running", (
        "Expected row to remain running for active owner after stale fail attempt."
    )

    owner_fail = fail_job(
        db_session,
        job_id=job.id,
        worker_id="worker-b",
        error_code="E_HANDLER_FAILED",
        error_message="active owner failure",
        retry_delays_seconds=(0,),
    )
    db_session.commit()
    assert owner_fail == "failed", "Expected active owner fail transition to park row for retry."
    assert _job_status(db_session, job.id) == "failed", (
        "Expected active owner to move running row to failed."
    )
