"""Integration tests for Postgres worker execution + scheduler behavior."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from nexus.jobs.queue import enqueue_job
from nexus.jobs.registry import JobDefinition
from nexus.jobs.worker import JobWorker
from tests.utils.db import task_session_factory

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _isolate_background_jobs(db_session: Session):
    """Keep worker tests deterministic regardless of suite order."""
    db_session.execute(text("DELETE FROM background_jobs"))
    db_session.commit()
    yield
    db_session.execute(text("DELETE FROM background_jobs"))
    db_session.commit()


def _fetch_job_row(db: Session, job_id: UUID) -> dict[str, object]:
    row = (
        db.execute(
            text(
                """
            SELECT status, attempts, claimed_by, result, dedupe_key
            FROM background_jobs
            WHERE id = :job_id
            """
            ),
            {"job_id": job_id},
        )
        .mappings()
        .one()
    )
    return dict(row)


def test_worker_run_once_executes_handler_and_marks_job_succeeded(db_session: Session):
    observed_payloads: list[dict[str, object]] = []

    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        observed_payloads.append(payload)
        return {"ok": True, "payload_value": payload.get("value")}

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-success",
        registry={
            "test_success_job": JobDefinition(
                kind="test_success_job",
                handler=handler,
                max_attempts=3,
                retry_delays_seconds=(1, 5, 10),
                lease_seconds=60,
            )
        },
    )

    job = enqueue_job(
        db_session,
        kind="test_success_job",
        payload={"value": "abc"},
        max_attempts=3,
    )
    db_session.commit()

    processed = worker.run_once()
    assert processed is True, "Expected worker to process one queued job iteration."

    db_session.expire_all()
    row = _fetch_job_row(db_session, job.id)
    assert row["status"] == "succeeded", (
        f"Expected successful handler execution to mark job succeeded. Row state={row}"
    )
    assert observed_payloads == [{"value": "abc"}], (
        "Expected worker to pass payload through to handler unchanged. "
        f"Observed payloads={observed_payloads}"
    )


def test_worker_run_once_reclaims_stale_running_job_and_completes_it(db_session: Session):
    def handler(*, payload: dict[str, object]) -> dict[str, object]:
        return {"reclaimed": payload.get("reclaimed", False)}

    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-reclaim",
        registry={
            "test_reclaim_job": JobDefinition(
                kind="test_reclaim_job",
                handler=handler,
                max_attempts=3,
                retry_delays_seconds=(1, 5, 10),
                lease_seconds=60,
            )
        },
    )

    stale_job = enqueue_job(
        db_session,
        kind="test_reclaim_job",
        payload={"reclaimed": True},
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
                lease_expires_at = :expired_at
            WHERE id = :job_id
            """
        ),
        {"job_id": stale_job.id, "expired_at": datetime.now(UTC) - timedelta(minutes=3)},
    )
    db_session.commit()

    processed = worker.run_once()
    assert processed is True, "Expected worker to reclaim and process stale running job."

    db_session.expire_all()
    row = _fetch_job_row(db_session, stale_job.id)
    assert row["status"] == "succeeded", (
        f"Expected stale-running reclaim path to finish in succeeded state. Row state={row}"
    )
    assert int(row["attempts"]) == 2, (
        f"Expected reclaim claim to increment attempts counter from 1 to 2. Row state={row}"
    )
    assert row["claimed_by"] is None, (
        "Expected terminal transition to clear claim ownership after successful completion. "
        f"Row state={row}"
    )


def test_worker_scheduler_enqueues_periodic_jobs_with_slot_dedupe(db_session: Session):
    worker = JobWorker(
        session_factory=task_session_factory(db_session),
        worker_id="worker-test-scheduler",
        registry={
            "test_periodic_job": JobDefinition(
                kind="test_periodic_job",
                handler=lambda *, payload: {"ok": True},
                max_attempts=1,
                retry_delays_seconds=(1,),
                lease_seconds=60,
                periodic_interval_seconds=30,
            )
        },
    )

    slot_now = datetime(2026, 3, 23, 12, 0, 7, tzinfo=UTC)
    first_insert_count = worker.run_scheduler_once(now=slot_now)
    second_insert_count = worker.run_scheduler_once(now=slot_now + timedelta(seconds=10))
    db_session.commit()

    assert first_insert_count == 1, (
        "Expected scheduler to enqueue one row on first tick in a schedule slot. "
        f"first_insert_count={first_insert_count}"
    )
    assert second_insert_count == 0, (
        "Expected dedupe to prevent duplicate periodic enqueue in same slot. "
        f"second_insert_count={second_insert_count}"
    )
    row_count = db_session.execute(
        text("SELECT COUNT(*) FROM background_jobs WHERE kind = 'test_periodic_job'")
    ).scalar_one()
    assert row_count == 1, (
        "Expected exactly one periodic row for same slot after duplicate scheduler ticks. "
        f"row_count={row_count}"
    )
