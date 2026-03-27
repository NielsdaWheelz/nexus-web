"""Integration tests for Postgres-backed background job queue semantics."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import (
    claim_next_job,
    complete_job,
    enqueue_job,
    enqueue_unique_job,
    fail_job,
)

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
    first = enqueue_unique_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m1"},
        dedupe_key="dup:ingest_pdf:m1",
        max_attempts=3,
    )
    second = enqueue_unique_job(
        db_session,
        kind="ingest_pdf",
        payload={"media_id": "m1"},
        dedupe_key="dup:ingest_pdf:m1",
        max_attempts=3,
    )
    db_session.commit()

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


def test_claim_next_job_orders_by_priority_then_available_time(db_session: Session):
    now = datetime.now(UTC)
    high_priority = enqueue_job(
        db_session,
        kind="job_high_priority",
        payload={},
        priority=10,
        available_at=now,
        max_attempts=1,
    )
    same_priority_early = enqueue_job(
        db_session,
        kind="job_same_priority_early",
        payload={},
        priority=20,
        available_at=now,
        max_attempts=1,
    )
    same_priority_late = enqueue_job(
        db_session,
        kind="job_same_priority_late",
        payload={},
        priority=20,
        available_at=now + timedelta(seconds=120),
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
